'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { destinationIdentity } = require('./ac-scheduler-destination');
const { parsePeopleReading } = require('./public/js/cira-telemetry');

const READING_MAX_AGE_MS = 30_000;
const DEFAULT_SETTINGS = Object.freeze({ offWhenEmpty: false, onWhenOccupied: false, emptyDelayMinutes: 5 });
const SETTING_FIELDS = Object.keys(DEFAULT_SETTINGS);
const UPDATE_FIELDS = [...SETTING_FIELDS, 'destinationFingerprint'];

class OccupancyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function validSettings(settings) {
  return settings && Object.keys(settings).length === SETTING_FIELDS.length &&
    typeof settings.offWhenEmpty === 'boolean' && typeof settings.onWhenOccupied === 'boolean' &&
    Number.isInteger(settings.emptyDelayMinutes) && settings.emptyDelayMinutes >= 0 && settings.emptyDelayMinutes <= 1440;
}

function enabled(settings) {
  return settings.offWhenEmpty || settings.onWhenOccupied;
}

function validDevice(state) {
  return state && typeof state.power === 'boolean' &&
    Number.isInteger(state.temp) && state.temp >= 21 && state.temp <= 27 &&
    Number.isInteger(state.mode) && state.mode >= 0 && state.mode <= 2 &&
    Number.isInteger(state.fan) && state.fan >= 0 && state.fan <= 3;
}

class AcOccupancy {
  constructor({ storePath, publish, connection, destination, now = Date.now }) {
    this.storePath = storePath;
    this.publish = publish;
    this.connection = connection;
    this.destination = destination;
    this.now = now;
    this.settings = DEFAULT_SETTINGS;
    this.boundFingerprint = null;
    this.storageError = null;
    this.latest = null;
    this.lastCaptureAt = null;
    this.episode = null;
    this.lastAction = null;
    this.queue = Promise.resolve();
    this.loading = null;
    this.pendingTick = null;
    this.timer = null;
  }

  currentDestination() {
    const current = this.destination();
    const { peopleTopic } = current;
    const ac = destinationIdentity(current);
    const fingerprint = createHash('sha256').update(JSON.stringify([ac.fingerprint, peopleTopic])).digest('hex');
    return { ...ac, peopleTopic, fingerprint };
  }

  init() {
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const saved = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
          if (saved?.version !== 1 || !validSettings(saved.settings) ||
              (enabled(saved.settings) ? !/^[a-f0-9]{64}$/.test(saved.destinationFingerprint || '') : saved.destinationFingerprint !== null)) {
            throw new Error('Invalid occupancy settings');
          }
          this.settings = saved.settings;
          this.boundFingerprint = saved.destinationFingerprint;
        } catch (error) {
          if (error.code !== 'ENOENT') this.storageError = 'อ่านการตั้งค่าจำนวนคนไม่ได้ กรุณาบันทึกการตั้งค่าใหม่';
        }
      })();
    }
    return this.loading;
  }

  locked(action) {
    const result = this.queue.then(async () => {
      await this.init();
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async persist(settings, destinationFingerprint) {
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, settings, destinationFingerprint }, null, 2) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, this.storePath);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  observe(raw, retained = false) {
    const now = this.now();
    const reading = parsePeopleReading(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw, { now, retained, maxAgeMs: READING_MAX_AGE_MS });
    if (!reading || (this.lastCaptureAt !== null && reading.at <= this.lastCaptureAt)) return;
    this.lastCaptureAt = reading.at;
    const occupied = reading.people > 0;
    if (this.episode?.occupied !== occupied) {
      this.episode = { occupied, since: now, consumed: false };
    } else if (!this.latest || now - this.latest.at >= READING_MAX_AGE_MS) {
      this.episode.since = now;
    }
    this.latest = reading;
  }

  disconnect() {
    this.latest = null;
  }

  assess() {
    const serverNow = this.now();
    const destination = this.currentDestination();
    const connection = this.connection();
    const reading = connection.brokerConnected && this.latest && serverNow - this.latest.at < READING_MAX_AGE_MS ? this.latest : null;
    const status = {
      phase: 'disabled', people: reading?.people ?? null, offDueAt: null,
      lastAction: this.lastAction && { ...this.lastAction }, destination, serverNow, storageError: this.storageError
    };
    const result = { status, target: null };

    if (this.storageError) status.phase = 'storage-error';
    else if (!enabled(this.settings)) status.phase = 'disabled';
    else if (this.boundFingerprint !== destination.fingerprint) status.phase = 'destination-changed';
    else if (!reading) status.phase = 'awaiting-reading';
    else {
      const { occupied, since, consumed } = this.episode;
      status.phase = occupied ? 'occupied' : 'empty';
      if (!consumed && (occupied ? this.settings.onWhenOccupied : this.settings.offWhenEmpty)) {
        if (!occupied) status.offDueAt = since + this.settings.emptyDelayMinutes * 60_000;
        if (status.offDueAt !== null && serverNow < status.offDueAt) status.phase = 'empty-countdown';
        else if (!connection.deviceOnline || !validDevice(connection.deviceState)) status.phase = 'waiting-device';
        else {
          result.target = { occupied, device: connection.deviceState };
        }
      }
    }
    return result;
  }

  snapshot() {
    return { settings: { ...this.settings }, status: this.assess().status };
  }

  read() {
    return this.locked(() => this.snapshot());
  }

  update(input) {
    return this.locked(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !UPDATE_FIELDS.includes(key))) {
        throw new OccupancyError('ข้อมูลการควบคุมแอร์ตามจำนวนคนไม่ถูกต้อง');
      }
      const { destinationFingerprint, ...settings } = input;
      if (!validSettings(settings)) throw new OccupancyError('ระบุเงื่อนไขเปิด–ปิดและเวลารอเป็นจำนวนนาทีเต็มระหว่าง 0 ถึง 1440');
      const fingerprint = enabled(settings) ? this.currentDestination().fingerprint : null;
      if (fingerprint && destinationFingerprint !== fingerprint) {
        throw new OccupancyError('ปลายทาง MQTT เปลี่ยนไป กรุณาตรวจสอบแล้วบันทึกใหม่', 409);
      }
      if (this.storageError || fingerprint !== this.boundFingerprint || SETTING_FIELDS.some(key => settings[key] !== this.settings[key])) {
        try { await this.persist(settings, fingerprint); }
        catch (_) {
          this.storageError = 'บันทึกการตั้งค่าจำนวนคนไม่ได้ กรุณาตรวจสอบเซิร์ฟเวอร์แล้วบันทึกใหม่';
          throw new OccupancyError(this.storageError, 503);
        }
        this.settings = settings;
        this.boundFingerprint = fingerprint;
        this.storageError = null;
        this.latest = null;
        this.episode = null;
      }
      return this.snapshot();
    });
  }

  tick() {
    if (!this.pendingTick) {
      this.pendingTick = this.locked(async () => {
        const { status, target } = this.assess();
        if (!target) return;
        this.episode.consumed = true;
        const { occupied, device } = target;
        if (device.power === occupied) return;
        const payload = { POWER: occupied ? 1 : 0, TEMP: device.temp, MODE: device.mode, FAN: device.fan };
        let outcome = 'sent';
        try { await this.publish(payload); }
        catch (_) { outcome = 'failed'; }
        this.lastAction = { at: status.serverNow, power: occupied, outcome };
      }).finally(() => { this.pendingTick = null; });
    }
    return this.pendingTick;
  }

  async start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.tick().catch(error => console.error('[Occupancy]', error.message)), 1000);
      this.timer.unref?.();
    }
    await this.init();
  }

  async close() {
    clearInterval(this.timer);
    this.timer = null;
    await this.queue;
  }
}

module.exports = { AcOccupancy, OccupancyError };
