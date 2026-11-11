'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { VoiceError, validAc } = require('./voice-session');

class LocalVoice {
  constructor({ engine = 'whisper' } = {}) { this.engine = engine; this.pending = new Map(); this.child = null; this.ready = null; }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const python = process.env.VOICE_PYTHON || path.join(__dirname, '.venv-voice', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const child = spawn(python, ['-u', path.join(__dirname, this.engine === 'tflite' ? 'offline-voice/worker.py' : 'offline-voice/asr_worker.py')], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
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
    if (this.pending.size >= 2) throw new VoiceError('โมเดลกำลังรับคำสั่งจากเครื่องอื่น กรุณาลองอีกครั้ง', 503);
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason || new Error('CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
      this.start().then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
    signal?.throwIfAborted();
    if (this.pending.size >= 2) throw new VoiceError('โมเดลกำลังรับคำสั่งจากเครื่องอื่น กรุณาลองอีกครั้ง', 503);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => reject(signal.reason || new Error('CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { this.close(); }, 30000);
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
