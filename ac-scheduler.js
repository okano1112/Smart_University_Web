'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { destinationIdentity, validSavedDestination, DEFAULT_DESTINATION } = require('./ac-scheduler-destination');

const TIMEZONE = 'Asia/Bangkok';
const DAY = 24 * 60 * 60 * 1000;
const MAX_LATE_MS = 60 * 1000;
const REPORT_WAIT_MS = 10 * 1000;
const FIELDS = ['label', 'power', 'time', 'date', 'repeat', 'temp', 'mode', 'fan', 'enabled'];
const DESTINATION_PAUSE_REASON = 'ปลายทาง MQTT ของเซิร์ฟเวอร์เปลี่ยนไปหรือยังไม่ได้ผูกกับตาราง กรุณาตรวจสอบปลายทางแล้วเปิดใช้งานตารางอีกครั้ง';

class ScheduleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function bangkokDate(now) {
  return new Date(now + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function occurrence(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) return NaN;
  const instant = Date.parse(`${date}T${time}:00+07:00`);
  return Number.isFinite(instant) && bangkokDate(instant) === date ? instant : NaN;
}

function nextOccurrence(schedule, now) {
  if (!schedule.enabled) return null;
  if (schedule.repeat === 'once') return occurrence(schedule.date, schedule.time);
  const today = occurrence(bangkokDate(now), schedule.time);
  return today > now ? today : today + DAY;
}

function validateSchedule(input, now, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !FIELDS.includes(key))) {
    throw new ScheduleError('ข้อมูลการตั้งเวลาไม่ถูกต้อง');
  }
  const value = Object.fromEntries(FIELDS.map(key => [key, existing?.[key]]));
  Object.assign(value, input);
  value.repeat ??= 'once'; value.enabled ??= true; value.temp ??= 25; value.mode ??= 0; value.fan ??= 2;
  if (typeof value.power !== 'boolean' || typeof value.enabled !== 'boolean') throw new ScheduleError('กรุณาระบุเปิดหรือปิดและสถานะตารางให้ถูกต้อง');
  if (!['once', 'daily'].includes(value.repeat) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time || '')) throw new ScheduleError('กรุณาระบุเวลาในรูปแบบ ชั่วโมง:นาที');
  if (!Number.isInteger(value.temp) || value.temp < 21 || value.temp > 27 || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 2 || !Number.isInteger(value.fan) || value.fan < 0 || value.fan > 3) {
    throw new ScheduleError('อุณหภูมิต้องอยู่ที่ 21–27 องศา และโหมดกับพัดลมต้องอยู่ในช่วงที่รองรับ');
  }
  value.label ??= value.power ? 'เปิดเครื่องปรับอากาศ' : 'ปิดเครื่องปรับอากาศ';
  if (typeof value.label !== 'string' || value.label.trim().length > 80) throw new ScheduleError('ชื่อตารางต้องไม่เกิน 80 ตัวอักษร');
  value.label = value.label.trim() || (value.power ? 'เปิดเครื่องปรับอากาศ' : 'ปิดเครื่องปรับอากาศ');
  if (value.repeat === 'once') {
    const at = occurrence(value.date, value.time);
    if (!Number.isFinite(at)) throw new ScheduleError('กรุณาระบุวันที่ที่ถูกต้อง');
    if (value.enabled && at <= now) throw new ScheduleError('กรุณาเลือกวันและเวลาในอนาคต ตามเวลาไทย');
  } else value.date = null;
  return value;
}

function payloadFor(schedule) {
  return { POWER: schedule.power ? 1 : 0, TEMP: schedule.temp, MODE: schedule.mode, FAN: schedule.fan };
}

function matchesReport(payload, report) {
  return report && payload.POWER === (report.power ? 1 : 0) && payload.TEMP === report.temp && payload.MODE === report.mode && payload.FAN === report.fan;
}

function conflictsAtSameTime(candidate, other) {
  return candidate.enabled && other.enabled && candidate.time === other.time &&
    (candidate.repeat === 'daily' || other.repeat === 'daily' || candidate.date === other.date);
}

function validSavedRun(run) {
  if (run === null) return true;
  const p = run?.payload;
  return run && ['sending', 'sent', 'failed', 'missed'].includes(run.status) && Number.isFinite(run.scheduledAt) && Number.isFinite(run.startedAt) &&
    (run.status === 'sending' ? run.finishedAt === null : Number.isFinite(run.finishedAt)) && typeof run.message === 'string' &&
    p && Object.keys(p).length === 4 && [0, 1].includes(p.POWER) && Number.isInteger(p.TEMP) && p.TEMP >= 21 && p.TEMP <= 27 &&
    Number.isInteger(p.MODE) && p.MODE >= 0 && p.MODE <= 2 && Number.isInteger(p.FAN) && p.FAN >= 0 && p.FAN <= 3;
}

class AcScheduler {
  constructor({ storePath, now = Date.now, publish, connection = () => ({ brokerConnected: false, deviceOnline: false }), destination, intervalMs = 1000 } = {}) {
    if (!storePath || typeof publish !== 'function') throw new TypeError('storePath and publish are required');
    this.storePath = storePath; this.now = now; this.publish = publish; this.connection = connection; this.intervalMs = intervalMs;
    this.schedules = []; this.queue = Promise.resolve(); this.initialized = false; this.initializing = null; this.timer = null;
    this.destination = destination || (() => {
      const status = this.connection();
      return { ...DEFAULT_DESTINATION, ...Object.fromEntries(['brokerUrl', 'commandTopic', 'statusTopic'].filter(key => status[key]).map(key => [key, status[key]])) };
    });
    this.storageError = null; this.needsRecoveryWrite = false;
  }

  currentDestination() { return destinationIdentity(typeof this.destination === 'function' ? this.destination() : this.destination); }

  pauseForDestination(item) {
    const scheduledAt = item.nextRunAt, wasEnabled = item.enabled;
    item.enabled = false; item.nextRunAt = null; item.destinationMismatch = true; item.pauseReason = DESTINATION_PAUSE_REASON;
    if (wasEnabled && Number.isFinite(scheduledAt)) {
      const now = this.now();
      item.lastRun = { scheduledAt, startedAt: now, finishedAt: now, status: 'failed', message: DESTINATION_PAUSE_REASON, payload: payloadFor(item) };
    }
  }

  async pauseChangedDestinations() {
    const current = this.currentDestination(); let changed = false;
    for (const item of this.schedules) {
      if (item.destination?.fingerprint !== current.fingerprint && (!item.destinationMismatch || item.enabled)) {
        this.pauseForDestination(item); changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async init() {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      try {
        const saved = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.schedules) || saved.schedules.length > 100) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
        const ids = new Set();
        for (const item of saved.schedules) {
          if (!item || typeof item !== 'object' || FIELDS.some(key => !Object.hasOwn(item, key))) throw new Error('ข้อมูลตารางไม่ครบ');
          if (typeof item.label !== 'string' || typeof item.time !== 'string' || !['once', 'daily'].includes(item.repeat) ||
            typeof item.power !== 'boolean' || typeof item.enabled !== 'boolean' || ![item.temp, item.mode, item.fan].every(Number.isInteger) ||
            (item.repeat === 'daily' ? item.date !== null : typeof item.date !== 'string')) throw new Error('ชนิดข้อมูลตารางไม่ถูกต้อง');
          const data = Object.fromEntries(FIELDS.map(key => [key, item[key]]));
          const validated = validateSchedule({ ...data, enabled: false }, this.now());
          if (typeof item.id !== 'string' || !/^[a-z0-9-]{36}$/i.test(item.id) || ids.has(item.id) || typeof item.enabled !== 'boolean' ||
            (item.enabled ? !Number.isFinite(item.nextRunAt) : item.nextRunAt !== null) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) || !validSavedRun(item.lastRun)) throw new Error('ข้อมูลตารางไม่ถูกต้อง');
          if (item.enabled && (item.repeat === 'once' ? item.nextRunAt !== occurrence(item.date, item.time) : new Date(item.nextRunAt + 7 * 60 * 60 * 1000).toISOString().slice(11, 16) !== item.time)) throw new Error('เวลาตารางไม่ถูกต้อง');
          if (Object.hasOwn(item, 'destination') && !validSavedDestination(item.destination)) throw new Error('ปลายทางตารางไม่ถูกต้อง');
          Object.assign(item, validated, { enabled: data.enabled });
          ids.add(item.id);
        }
        if (saved.schedules.some((item, index) => saved.schedules.slice(index + 1).some(other => conflictsAtSameTime(item, other)))) throw new Error('มีตารางที่ทำงานเวลาเดียวกัน');
        this.schedules = saved.schedules;
        let recovered = false;
        for (const item of this.schedules) {
          if (!Object.hasOwn(item, 'destination')) { item.destination = null; recovered = true; }
          if (item.destination?.fingerprint !== this.currentDestination().fingerprint || (item.destinationMismatch && item.enabled)) {
            this.pauseForDestination(item); recovered = true;
          }
          if (item.lastRun?.status === 'sending') {
            item.lastRun.status = 'failed'; item.lastRun.finishedAt = this.now();
            item.lastRun.message = 'เซิร์ฟเวอร์หยุดระหว่างส่งคำสั่ง จึงไม่ส่งซ้ำโดยอัตโนมัติ'; recovered = true;
          }
          if (item.enabled && Number.isFinite(item.nextRunAt) && item.nextRunAt <= this.now()) {
            const now = this.now(), scheduledAt = item.nextRunAt;
            item.lastRun = { scheduledAt, startedAt: now, finishedAt: now, status: 'missed', message: 'เซิร์ฟเวอร์ไม่ได้ทำงานในเวลาที่กำหนด จึงไม่ส่งคำสั่งย้อนหลัง', payload: payloadFor(item) };
            if (item.repeat === 'once') { item.enabled = false; item.nextRunAt = null; }
            else item.nextRunAt = nextOccurrence(item, now);
            recovered = true;
          }
        }
        if (recovered) await this.persist();
      } catch (error) {
        if (error.code !== 'ENOENT') throw new ScheduleError('อ่านไฟล์ตารางเวลาไม่ได้ กรุณาตรวจสอบเซิร์ฟเวอร์ก่อนใช้งาน', 503);
      }
      this.initialized = true;
    })();
    return this.initializing;
  }

  async persist() {
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    let file;
    try {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      file = await fs.open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ version: 1, schedules: this.schedules }, null, 2) + '\n');
      await file.sync(); await file.close(); file = null;
      await fs.rename(temporary, this.storePath);
      this.storageError = null; this.needsRecoveryWrite = false;
    } catch (error) {
      this.storageError = 'บันทึกตารางเวลาลงดิสก์ไม่ได้ ระบบจะไม่ส่งคำสั่งที่ยังไม่ได้บันทึก'; this.needsRecoveryWrite = true;
      throw error;
    } finally {
      if (file) await file.close();
      await fs.unlink(temporary).catch(() => {});
    }
  }

  locked(action) {
    const result = this.queue.then(async () => { await this.init(); return action(); });
    this.queue = result.catch(() => {}); return result;
  }

  snapshot() {
    return { schedules: structuredClone(this.schedules), status: { ...this.connection(), serverTime: this.now(), storageReady: !this.storageError, storageError: this.storageError, destination: this.currentDestination() }, timezone: TIMEZONE };
  }

  async list() { return this.locked(async () => { await this.pauseChangedDestinations(); return this.snapshot(); }); }

  async create(input) {
    return this.locked(async () => {
      await this.pauseChangedDestinations();
      if (this.schedules.length >= 100) throw new ScheduleError('บันทึกตารางได้สูงสุด 100 รายการ');
      const now = this.now(), value = validateSchedule(input, now);
      if (this.schedules.some(other => conflictsAtSameTime(value, other))) throw new ScheduleError('มีตารางอื่นเปิดใช้อยู่ในเวลาเดียวกัน กรุณาเลือกเวลาต่างกัน', 409);
      const item = { ...value, id: randomUUID(), createdAt: now, updatedAt: now, nextRunAt: nextOccurrence(value, now), lastRun: null,
        destination: this.currentDestination(), destinationMismatch: false, pauseReason: null };
      this.schedules.push(item);
      try { await this.persist(); } catch (error) { this.schedules.pop(); throw error; }
      return structuredClone(item);
    });
  }

  async update(id, input) {
    return this.locked(async () => {
      await this.pauseChangedDestinations();
      const index = this.schedules.findIndex(item => item.id === id);
      if (index < 0) throw new ScheduleError('ไม่พบตารางเวลานี้', 404);
      const previous = this.schedules[index], now = this.now(), value = validateSchedule(input, now, previous);
      if (this.schedules.some(other => other.id !== id && conflictsAtSameTime(value, other))) throw new ScheduleError('มีตารางอื่นเปิดใช้อยู่ในเวลาเดียวกัน กรุณาเลือกเวลาต่างกัน', 409);
      const explicitlyEnabled = Object.hasOwn(input, 'enabled') && input.enabled === true;
      const destination = explicitlyEnabled ? this.currentDestination() : previous.destination;
      const mismatch = (!explicitlyEnabled && previous.destinationMismatch) || destination?.fingerprint !== this.currentDestination().fingerprint;
      if (mismatch) value.enabled = false;
      const item = { ...previous, ...value, updatedAt: now, nextRunAt: nextOccurrence(value, now), destination,
        destinationMismatch: mismatch, pauseReason: mismatch ? DESTINATION_PAUSE_REASON : null };
      this.schedules[index] = item;
      try { await this.persist(); } catch (error) { this.schedules[index] = previous; throw error; }
      return structuredClone(item);
    });
  }

  async remove(id) {
    return this.locked(async () => {
      const index = this.schedules.findIndex(item => item.id === id);
      if (index < 0) throw new ScheduleError('ไม่พบตารางเวลานี้', 404);
      const [item] = this.schedules.splice(index, 1);
      try { await this.persist(); } catch (error) { this.schedules.splice(index, 0, item); throw error; }
      return { success: true };
    });
  }

  async tick() {
    return this.locked(async () => {
      const now = this.now();
      if (this.needsRecoveryWrite) { try { await this.persist(); } catch (_) { return; } }
      await this.pauseChangedDestinations();
      for (const item of this.schedules) {
        const connection = this.connection();
        if (!item.destinationMismatch && item.lastRun?.status === 'sent' && !item.lastRun.confirmedAt && !item.lastRun.verification && connection.deviceOnline && connection.lastStatusAt > item.lastRun.startedAt && connection.lastStatusAt <= item.lastRun.startedAt + REPORT_WAIT_MS && matchesReport(item.lastRun.payload, connection.deviceState)) {
          item.lastRun.confirmedAt = connection.lastStatusAt;
          item.lastRun.message = 'ESP32 รายงานสถานะตรงกับคำสั่ง (ยังไม่ใช่การยืนยันจากตัวแอร์)';
          await this.persist();
        }
        if (!item.destinationMismatch && item.lastRun?.status === 'sent' && !item.lastRun.confirmedAt && !item.lastRun.verification && now > item.lastRun.startedAt + REPORT_WAIT_MS) {
          item.lastRun.verification = 'timeout';
          item.lastRun.message = 'ส่ง MQTT แล้ว แต่ยังไม่ได้รับสถานะตรงกันจาก ESP32 ภายใน 10 วินาที';
          await this.persist();
        }
        if (!item.enabled || !Number.isFinite(item.nextRunAt) || item.nextRunAt > now) continue;
        const scheduledAt = item.nextRunAt;
        item.nextRunAt = item.repeat === 'daily' ? nextOccurrence(item, now) : null;
        if (item.repeat === 'once') item.enabled = false;
        const payload = payloadFor(item);
        item.lastRun = { scheduledAt, startedAt: now, finishedAt: null, status: 'sending', message: 'กำลังส่งคำสั่ง', payload };
        if (now - scheduledAt > MAX_LATE_MS) {
          Object.assign(item.lastRun, { status: 'missed', finishedAt: now, message: 'เลยกำหนดเวลาแล้ว จึงไม่ส่งคำสั่งย้อนหลัง' });
        } else if (!connection.brokerConnected || !connection.deviceOnline) {
          Object.assign(item.lastRun, { status: 'failed', finishedAt: now, message: !connection.brokerConnected ? 'MQTT ไม่เชื่อมต่อในเวลาที่กำหนด จึงไม่ส่งคำสั่งซ้ำภายหลัง' : 'ESP32 ไม่มีสถานะล่าสุดในเวลาที่กำหนด จึงไม่ส่งคำสั่งซ้ำภายหลัง' });
        }
        // Persist the occurrence claim BEFORE publishing. A restart may lose a send,
        // but must never replay an AC activation whose outcome is uncertain.
        try { await this.persist(); }
        catch (_) {
          Object.assign(item.lastRun, { status: 'failed', finishedAt: this.now(), message: 'บันทึกการเริ่มงานลงดิสก์ไม่สำเร็จ จึงไม่ส่งคำสั่งและไม่ส่งซ้ำภายหลัง' });
          this.needsRecoveryWrite = true;
          this.storageError = 'บันทึกตารางเวลาลงดิสก์ไม่ได้ ระบบจะไม่ส่งคำสั่งที่ยังไม่ได้บันทึก';
          return;
        }
        if (item.lastRun.status !== 'sending') continue;
        try {
          await this.publish(payload);
          Object.assign(item.lastRun, { status: 'sent', finishedAt: this.now(), message: 'ส่งคำสั่ง MQTT แล้ว รอ ESP32 รายงานสถานะ' });
        } catch (error) {
          Object.assign(item.lastRun, { status: 'failed', finishedAt: this.now(), message: 'ส่งคำสั่ง MQTT ไม่สำเร็จ จึงไม่ส่งซ้ำโดยอัตโนมัติ' });
        }
        await this.persist();
      }
    });
  }

  async start() {
    await this.init();
    if (this.timer) return;
    await this.tick();
    this.timer = setInterval(() => this.tick().catch(error => console.error('[Schedule]', error.message)), this.intervalMs);
    this.timer.unref?.();
  }

  async close() { clearInterval(this.timer); this.timer = null; await this.queue; }
}

module.exports = { AcScheduler, ScheduleError, validateSchedule, nextOccurrence, occurrence, bangkokDate, payloadFor, TIMEZONE, MAX_LATE_MS };
