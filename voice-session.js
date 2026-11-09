'use strict';
const { randomUUID } = require('node:crypto');

class VoiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// A capability belongs to one browser activation and one MQTT destination.
// Wake time starts only after the browser acknowledges that its chime finished.
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
    this.sessions.set(id, { device, touched: this.now(), wake: null, jobs: new Map(), busy: false });
    return id;
  }
  get(id, device) {
    this.prune();
    const session = this.sessions.get(id);
    if (!session || session.device !== device) throw new VoiceError('เซสชันเสียงหมดอายุ กรุณาเปิดไมค์ใหม่', 410);
    session.touched = this.now();
    return session;
  }
  wake(session) {
    const token = randomUUID();
    session.wake = { token, armBy: this.now() + 15_000, expires: 0, claimed: false };
    return token;
  }
  arm(session, token) {
    const wake = session.wake;
    if (!wake || wake.token !== token || wake.expires || this.now() > wake.armBy) throw new VoiceError('คำเรียกหมดอายุ กรุณาเรียก Engi อีกครั้ง', 409);
    wake.expires = this.now() + 8000;
    return { listeningMs: 8000 };
  }
  claim(session, token) {
    const wake = session.wake;
    if (!wake || wake.token !== token || !wake.expires || wake.claimed || this.now() > wake.expires) throw new VoiceError('หมดเวลารับคำสั่ง กรุณาเรียก Engi อีกครั้ง', 409);
    wake.claimed = true;
    // A sentence started within the window may finish after it.
    wake.expires = this.now() + 17_000;
  }
  consume(session, token) {
    const wake = session.wake;
    if (!wake || wake.token !== token || !wake.claimed || this.now() > wake.expires) throw new VoiceError('หมดเวลารับคำสั่ง กรุณาเรียก Engi อีกครั้ง', 409);
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
    const timer = setTimeout(() => controller.abort(), 12_000);
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

function detectAndStripWakeWord(rawText) {
  const text = String(rawText || '').normalize('NFC').trim();
  // Only the actual name at the beginning; Thai commands need no separating space.
  const match = text.match(/^(?:(?:hey|hello|hi|เฮ้|เฮ|เฮ่|เฮ่ย|แฮ|ฮัลโหล|สวัสดี|หวัดดี|นี่|น้อง|พี่|คุณ)[\s,.!…-]*)?(?:เอ็?นจ[ีิ][่้๊๋]?|เอนจ[ีิ][่้๊๋]?|engi)(?=$|\s|[,.!?…:，。！？]|ครับ|ค่ะ|คะ|จ๋า|เอ้ย|ช่วย|รบกวน|เปิด|ปิด|ปรับ|ตั้ง|ขอ|เอา|แอร์|ลด|เพิ่ม|ร้อน|หนาว|โหมด|พัดลม)/i);
  if (!match) return { hasWakeWord: false, commandText: text };
  const commandText = text.slice(match[0].length).replace(/^[\s,.!?…:，。！？]+/, '').replace(/^(?:(?:ครับ|ค่ะ|คะ|จ๋า|เอ้ย|ช่วย|รบกวน|หน่อย)\s*)+/, '').replace(/^[\s,.!?…:，。！？]+/, '').trim();
  return { hasWakeWord: true, commandText };
}
function validAc(next) {
  return !!next && typeof next.power === 'boolean' && Number.isInteger(next.temp) && next.temp >= 21 && next.temp <= 27 && Number.isInteger(next.mode) && next.mode >= 0 && next.mode <= 2 && Number.isInteger(next.fan) && next.fan >= 0 && next.fan <= 3;
}
function ambiguousSpeech(text) {
  const english = text.toLowerCase().replace(/[’]/g, "'");
  if (/\b(?:don't|do\s+not|never|not|stop\s+trying)\b/.test(english)) return true;
  const on = /เปิด/.test(text) || /\b(?:open|turn\s+on|switch\s+on|power\s+on)\b|\b(?:ac|air\s*conditioner|it)\s+on\b/i.test(text);
  const off = /(?<!เ)ปิด/.test(text) || /\b(?:close|shut\s+down|turn\s+off|switch\s+off|power\s+off)\b|\b(?:ac|air\s*conditioner|it)\s+off\b/i.test(text);
  if (on && off) return true;
  const compact = text.replace(/\s+/g, '');
  return /อย่า|ห้าม|ไม่ต้อง|ยังไม่|ไม่อยาก|ไม่ได้สั่ง|ไม่ให้|ไม่(?:เปิด|ปิด|ปรับ|ตั้ง|ลด|เพิ่ม|เอา|ขอ|สั่ง|เปลี่ยน)/.test(compact) || (/เปิด/.test(compact) && /(?<!เ)ปิด/.test(compact));
}
module.exports = { VoiceSessions, VoiceError, detectAndStripWakeWord, validAc, ambiguousSpeech };
