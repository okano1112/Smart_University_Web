'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { VoiceError, validAc } = require('./voice-session');

class LocalVoice {
  constructor({ engine = 'whisper' } = {}) {
    this.engine = engine; this.pending = new Map(); this.activeId = null;
    this.child = null; this.ready = null; this.failWorker = null;
  }
  start() {
    if (this.ready) return this.ready;
    const unavailable = new VoiceError('โมเดลเสียงเปิดไม่สำเร็จ กรุณาตรวจ Python และไฟล์โมเดลบนเซิร์ฟเวอร์', 503);
    const python = process.env.VOICE_PYTHON || path.join(__dirname, '.venv-voice', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const script = path.join(__dirname, this.engine === 'tflite' ? 'offline-voice/worker.py' : 'offline-voice/asr_worker.py');
    let child;
    try {
      child = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (error) {
      if (process.env.VOICE_DEBUG === '1') console.error('[Voice]', error);
      return Promise.reject(unavailable);
    }
    this.child = child;
    this.ready = new Promise((resolve, reject) => {
      const failure = (error = unavailable) => {
        if (this.child !== child) return;
        this.child = null; this.ready = null; this.failWorker = null; this.activeId = null;
        clearTimeout(startTimer);
        reject(error);
        for (const job of this.pending.values()) job.finish(error);
        this.pending.clear();
        lines.close();
        child.kill();
      };
      this.failWorker = failure;
      const startTimer = setTimeout(() => failure(new VoiceError('เซิร์ฟเวอร์ใช้เวลาโหลดโมเดลเสียงเกิน 90 วินาที', 504)), 90000);
      child.on('error', error => {
        if (process.env.VOICE_DEBUG === '1') console.error('[Voice]', error);
        failure(error.code === 'ENOENT' ? new VoiceError('เซิร์ฟเวอร์ไม่พบ Python สำหรับระบบเสียง', 503) : unavailable);
      });
      child.on('exit', () => failure()); child.stdin.on('error', () => failure());
      // Python diagnostics belong on stderr, outside the JSON protocol.
      child.stderr.on('data', data => { if (process.env.VOICE_DEBUG === '1') process.stderr.write(data); });
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (this.child !== child) return;
        let data;
        try { data = JSON.parse(line); } catch (_) { failure(); return; }
        if (data.ready) { clearTimeout(startTimer); resolve(); return; }
        if (data.id !== this.activeId) return;
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        this.activeId = null;
        job.finish(data.error ? new VoiceError('ไฟล์เสียงไม่ถูกต้องหรือประมวลผลไม่ได้ กรุณาพูดใหม่', 400) : null, data);
        this.dispatch();
      });
    });
    return this.ready;
  }
  async classify(audio, signal, { wake = false } = {}) {
    signal?.throwIfAborted();
    if (this.pending.size >= 2) throw new VoiceError('โมเดลกำลังรับคำสั่งจากเครื่องอื่น กรุณาลองอีกครั้ง', 503);
    const readiness = this.start();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => {
        const reason = signal.reason || new Error('CANCELLED');
        // Python finishes an active inference. A queued request has not yet
        // reached the worker and can release its slot immediately.
        if (this.activeId === id) reject(reason);
        else { this.pending.delete(id); finish(reason); }
      };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        const error = new VoiceError('ประมวลผลเสียงนานเกินไป กรุณาลองใหม่', 504);
        if (this.activeId === id) this.failWorker?.(error);
        else { this.pending.delete(id); finish(error); }
      }, 30000);
      const finish = (error, data) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(data);
      };
      this.pending.set(id, { audio, wake, finish });
      readiness.then(() => {
        if (this.ready === readiness && this.pending.has(id)) this.dispatch();
      }, error => {
        // Synchronous spawn failures have no worker lifecycle to clear the queue.
        if (this.pending.delete(id)) finish(error);
      });
    });
  }
  dispatch() {
    if (this.activeId || !this.pending.size || !this.child) return;
    const [id, job] = this.pending.entries().next().value;
    this.activeId = id;
    const failure = this.failWorker;
    try {
      this.child.stdin.write(JSON.stringify({ id, audio: job.audio.toString('base64'), wake: job.wake }) + '\n', error => { if (error) failure(); });
      job.audio = null;
    } catch (_) { failure(); }
  }
  close() {
    this.failWorker?.(new VoiceError('หยุดประมวลผลเสียง กรุณาลองใหม่', 503));
  }
}

const metadata = require('./models/ac_command_metadata.json');
const runtime = require('./models/ac_voice_model.json');
const classes = new Map(Object.values(metadata.classes).map(entry => [entry.class_name, entry]));
function unsupported(message, clip) {
  return { unsupported: true, message, feedback: { text: message, clips: [clip] } };
}
function commandFor(result, current) {
  if (Array.isArray(result.commands)) {
    if (!result.accepted || !result.commands.length || result.commands.length > 6) return null;
    let state={...current}; const fields=new Set(); const texts=[];
    for(const command of result.commands) {
      if (command==='FAN:UP'||command==='FAN:DOWN') {
        const fan=Math.max(1,Math.min(3,(state.fan===0?2:state.fan)+(command==='FAN:UP'?1:-1)));
        state={...state,power:true,fan};fields.add('fan');texts.push('ปรับพัดลม');continue;
      }
      const entry=[...classes.values()].find(e=>e.mqtt_command===command);
      if(!entry)return null;
      const parsed=commandFor({accepted:true,label:entry.class_name,confidence:1,margin:1},state);
      if(!parsed||parsed.unsupported)return parsed;
      state=parsed.next;parsed.fields.forEach(f=>fields.add(f));texts.push(parsed.text);
    }
    return validAc(state)?{next:state,fields:[...fields],text:texts.join(' • ')}:null;
  }
  if (!result.accepted || !Number.isFinite(result.confidence) || !Number.isFinite(result.margin) || result.confidence < runtime.threshold || result.margin < runtime.margin) return null;
  const entry = classes.get(result.label);
  if (!entry || entry.mqtt_command === 'NONE') return null;
  const next = { ...current };
  if (next.power === null) next.power = false;
  let text, fields;
  const command = entry.mqtt_command;
  if (command === 'ON' || command === 'OFF') {
    next.power = command === 'ON'; text = next.power ? 'เปิดแอร์' : 'ปิดแอร์'; fields = ['power'];
  } else if (/^TEMP:(UP|DOWN)$/.test(command)) {
    // A relative change needs an actual device baseline, not unknown startup defaults.
    if (current.power === null) return unsupported('ยังไม่ทราบอุณหภูมิปัจจุบัน กรุณารอสถานะอุปกรณ์หรือระบุอุณหภูมิครับ', 'need-status');
    next.power = true;
    next.temp = Math.max(21, Math.min(27, next.temp + (command === 'TEMP:UP' ? 1 : -1)));
    text = `ตั้งอุณหภูมิ ${next.temp} องศา`; fields = ['temp'];
  } else if (/^TEMP:\d+$/.test(command)) {
    const temp = Number(command.split(':')[1]);
    if (temp < 21 || temp > 27) return unsupported('ระบบอุปกรณ์ปัจจุบันรองรับอุณหภูมิ 21 ถึง 27 องศาครับ', 'temp-range');
    next.power = true; next.temp = temp; text = `ตั้งอุณหภูมิ ${temp} องศา`; fields = ['temp'];
  } else if (command === 'PRESET:TURBO' || command === 'PRESET:ECO') {
    const turbo = command === 'PRESET:TURBO';
    Object.assign(next, { power: true, temp: turbo ? 21 : 25, mode: 0, fan: turbo ? 3 : 0 });
    text = turbo ? 'โหมดเทอร์โบ' : 'โหมดประหยัด'; fields = ['temp', 'mode', 'fan'];
  } else if (/^MODE:(COOL|DRY|FAN)$/.test(command)) {
    next.power = true; next.mode = ['COOL', 'DRY', 'FAN'].indexOf(command.split(':')[1]);
    fields = ['mode']; text = `โหมด ${command.split(':')[1]}`;
  } else if (/^FAN:(AUTO|LOW|MED|HIGH)$/.test(command)) {
    next.power = true; next.fan = ['AUTO', 'LOW', 'MED', 'HIGH'].indexOf(command.split(':')[1]);
    fields = ['fan']; text = `พัดลม ${command.split(':')[1]}`;
  } else {
    return unsupported('อุปกรณ์ปัจจุบันยังไม่รองรับคำสั่งสวิงและโหมดนอนครับ', 'unsupported');
  }
  return validAc(next) ? { next, text, fields } : null;
}
module.exports = { LocalVoice, commandFor };
