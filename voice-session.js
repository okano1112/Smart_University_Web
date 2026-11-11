'use strict';
const { randomUUID } = require('node:crypto');

class VoiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Sessions isolate concurrent browser activations and MQTT destinations.
class VoiceSessions {
  constructor({ now = Date.now, limit = 256 } = {}) {
    this.now = now;
    this.limit = limit;
    this.sessions = new Map();
  }
  prune() {
    for (const [id, session] of this.sessions) {
      if (this.now() - session.touched > 30 * 60_000) this.cancel(id);
    }
  }
  create(device) {
    this.prune();
    if (typeof device !== 'string' || !device || device.length > 512) throw new VoiceError('อุปกรณ์เป้าหมายไม่ถูกต้อง');
    if (this.sessions.size >= this.limit) throw new VoiceError('ระบบรับเสียงมีผู้ใช้งานเต็ม กรุณาลองใหม่', 503);
    const id = randomUUID();
    this.sessions.set(id, { device, touched: this.now(), jobs: new Map(), busy: false });
    return id;
  }
  get(id, device) {
    this.prune();
    const session = this.sessions.get(id);
    if (!session || session.device !== device) throw new VoiceError('เซสชันเสียงหมดอายุ กรุณาเปิดไมค์ใหม่', 410);
    session.touched = this.now();
    return session;
  }
  issueWake(session) {
    const token = randomUUID();
    session.wake = { token, armBy: this.now() + 15000, expires: 0, claimed: false };
    return token;
  }
  arm(session, token) {
    const wake = session.wake;
    if (!wake || wake.token !== token || wake.expires || this.now() > wake.armBy) throw new VoiceError('คำเรียกหมดอายุ กรุณาเรียกเอ็นจี้ใหม่', 409);
    wake.expires = this.now() + 9000;
    return { listeningMs: 9000 };
  }
  claim(session, token) {
    const wake = session.wake;
    if (!wake || wake.token !== token || !wake.expires || wake.claimed || this.now() > wake.expires) throw new VoiceError('หมดเวลารับคำสั่ง กรุณาเรียกเอ็นจี้ใหม่', 409);
    wake.claimed = true; wake.expires = this.now() + 60000;
    return { success: true };
  }
  consume(session, token) {
    const wake = session.wake;
    if (!wake || wake.token !== token || !wake.claimed || this.now() > wake.expires) throw new VoiceError('กรุณาเรียกเอ็นจี้ก่อนพูดคำสั่ง', 409);
    session.wake = null;
  }
  cancel(id) {
    const session = this.sessions.get(id);
    if (session) for (const job of session.jobs.values()) job.controller.abort();
    this.sessions.delete(id);
  }
  async run(session, requestId, operation) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new VoiceError('รหัสคำขอเสียงไม่ถูกต้อง');
    const existing = session.jobs.get(requestId);
    if (existing) return existing.promise;
    if (session.busy) throw new VoiceError('กำลังประมวลผลคำสั่งก่อนหน้า', 409);
    session.busy = true;
    const controller = new AbortController();
    const job = { controller };
    session.jobs.set(requestId, job);
    const timer = setTimeout(() => controller.abort(), 35_000);
    job.promise = Promise.resolve().then(() => operation(controller.signal)).then(result => {
      controller.signal.throwIfAborted();
      return { ...result, requestId };
    }).finally(() => {
      clearTimeout(timer);
      session.busy = false;
      session.touched = this.now();
      while (session.jobs.size > 32) session.jobs.delete(session.jobs.keys().next().value);
    });
    return job.promise;
  }
}

function validAc(next) {
  return !!next && typeof next.power === 'boolean' && Number.isInteger(next.temp) && next.temp >= 21 && next.temp <= 27 && Number.isInteger(next.mode) && next.mode >= 0 && next.mode <= 2 && Number.isInteger(next.fan) && next.fan >= 0 && next.fan <= 3;
}
module.exports = { VoiceSessions, VoiceError, validAc };
