'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { VoiceError, validAc } = require('./voice-session');

class LocalVoice {
  constructor() { this.pending = new Map(); this.child = null; this.ready = null; }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const python = process.env.VOICE_PYTHON || path.join(__dirname, '.venv-voice', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const child = spawn(python, ['-u', path.join(__dirname, 'offline-voice/worker.py')], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      this.child = child;
      const failure = () => {
        if (this.child !== child) return;
        this.child = null; this.ready = null;
        clearTimeout(startTimer);
        const error = new VoiceError('โมเดลเสียงในเครื่องไม่พร้อม ตรวจ Python และ dependencies ในคู่มือติดตั้ง', 503);
        reject(error);
        for (const job of this.pending.values()) job.finish(error);
        this.pending.clear();
        child.kill();
      };
      const startTimer = setTimeout(failure, 90000);
      child.on('error', failure); child.on('exit', failure); child.stdin.on('error', failure);
      // TensorFlow logs belong on stderr, never in the JSON protocol.
      child.stderr.on('data', data => { if (process.env.VOICE_DEBUG === '1') process.stderr.write(data); });
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        let data;
        try { data = JSON.parse(line); } catch (_) { failure(); return; }
        if (data.ready) { clearTimeout(startTimer); resolve(); return; }
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        job.finish(data.error ? new VoiceError('ไฟล์เสียงไม่ถูกต้องหรือประมวลผลไม่ได้ กรุณาพูดใหม่', 400) : null, data);
      });
    });
    return this.ready;
  }
  async classify(audio, signal) {
    signal?.throwIfAborted();
    if (this.pending.size >= 4) throw new VoiceError('โมเดลกำลังรับคำสั่งจากเครื่องอื่น กรุณาลองอีกครั้ง', 503);
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason || new Error('CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
      this.start().then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
    signal?.throwIfAborted();
    if (this.pending.size >= 4) throw new VoiceError('โมเดลกำลังรับคำสั่งจากเครื่องอื่น กรุณาลองอีกครั้ง', 503);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => reject(signal.reason || new Error('CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { this.close(); }, 12000);
      const finish = (error, data) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(data);
      };
      this.pending.set(id, { finish });
      this.child.stdin.write(JSON.stringify({ id, audio: audio.toString('base64') }) + '\n');
    });
  }
  close() {
    const child = this.child; this.child = null; this.ready = null;
    for (const job of this.pending.values()) job.finish(new VoiceError('หยุดประมวลผลเสียง กรุณาลองใหม่', 503));
    this.pending.clear(); child?.kill();
  }
}

function commandFor(result, current) {
  if (!result.accepted || !Number.isFinite(result.confidence) || !Number.isFinite(result.margin) || result.confidence < 0.90 || result.margin < 0.25) return null;
  const next = { ...current };
  if (next.power === null) next.power = false;
  let text, fields;
  switch (result.label) {
    case '0_ON': next.power = true; text = 'เปิดแอร์'; fields = ['power']; break;
    case '1_OFF': next.power = false; text = 'ปิดแอร์'; fields = ['power']; break;
    case '2_TEMP_UP': next.power = true; next.temp = Math.min(27, next.temp + 1); text = 'เพิ่มอุณหภูมิ'; fields = ['temp']; break;
    case '3_TEMP_DOWN': next.power = true; next.temp = Math.max(21, next.temp - 1); text = 'ลดอุณหภูมิ'; fields = ['temp']; break;
    case '4_PRESET_TURBO': Object.assign(next, { power: true, temp: 21, mode: 0, fan: 3 }); text = 'โหมดเทอร์โบ'; fields = ['power', 'temp', 'mode', 'fan']; break;
    case '5_PRESET_ECO': Object.assign(next, { power: true, temp: 25, mode: 0, fan: 0 }); text = 'โหมดประหยัด'; fields = ['power', 'temp', 'mode', 'fan']; break;
    default: return null;
  }
  return validAc(next) ? { next, text, fields } : null;
}
module.exports = { LocalVoice, commandFor };
