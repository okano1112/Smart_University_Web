require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { VoiceSessions, VoiceError, validAc } = require('./voice-session');
const voiceSessions = new VoiceSessions();
const { LocalVoice, commandFor } = require('./offline-voice');
const { parseSpeech } = require('./local-commands');
const localVoice = new LocalVoice();
const { describe: describeVoiceCommand } = require('./public/js/voice-feedback');
const { createCoolingForecastRouter } = require('./cooling-forecast-route');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api/cooling-forecast', createCoolingForecastRouter());

// เสิร์ฟไฟล์โมเดล Silero VAD และ ONNX Runtime จากเครื่องตัวเอง
app.use('/vad-web', express.static(path.join(__dirname, 'node_modules/@ricky0123/vad-web/dist')));
app.use('/ort', express.static(path.join(__dirname, 'node_modules/onnxruntime-web/dist')));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function voiceRoute(handler) {
  return async (req, res) => {
    try { res.json(await handler(req)); }
    catch (error) {
      const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
      res.status(timedOut ? 504 : error.status || 500).json({ success: false,
        message: timedOut ? 'ประมวลผลเสียงนานเกินไป กรุณาลองใหม่' : error.status ? error.message : 'ระบบเสียงขัดข้อง กรุณาลองใหม่' });
    }
  };
}
app.post('/api/voice-session', voiceRoute(async req => {
  await localVoice.start();
  return { sessionId: voiceSessions.create(req.body.device), engine: 'LOCAL_WHISPER', wakeWord: true, duration: 12 };
}));
app.post('/api/voice-session/cancel', voiceRoute(req => {
  voiceSessions.cancel(req.body.sessionId); return { success: true };
}));
app.post('/api/voice-session/ping', voiceRoute(req => {
  voiceSessions.get(req.body.sessionId, req.body.device); return { success: true };
}));
for (const action of ['arm', 'claim']) {
  app.post(`/api/voice-session/${action}`, voiceRoute(req => {
    const session = voiceSessions.get(req.body.sessionId, req.body.device);
    return voiceSessions[action](session, req.body.wakeToken);
  }));
}
app.post('/api/voice-command', upload.single('audio'), voiceRoute(async req => {
  const session = voiceSessions.get(req.body.sessionId, req.body.device);
  return voiceSessions.run(session, req.body.requestId, async signal => {
    const startTime = Date.now();
    const stage = req.body.stage;
    if (!['continuous', 'command', 'direct'].includes(stage)) throw new VoiceError('สถานะรับเสียงไม่ถูกต้อง');
    if (stage === 'command') voiceSessions.consume(session, req.body.wakeToken);
    const audio = req.file?.buffer;
    if (!audio || audio.length < 1644 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.length > 16_000 * 2 * 16 + 44) {
      throw new VoiceError('ไฟล์เสียงไม่ถูกต้องหรือยาวเกินไป กรุณาพูดใหม่');
    }
    let currentAc;
    try { currentAc = JSON.parse(req.body.currentAc); } catch (_) { }
    if (!currentAc || !validAc({ ...currentAc, power: currentAc.power === null ? true : currentAc.power })) throw new VoiceError('สถานะอุปกรณ์ไม่ถูกต้อง');
    const result = await localVoice.classify(audio, signal);
    signal.throwIfAborted();
    const engine = result.engine || 'LOCAL_WHISPER';
    const transcript = result.transcript || '';
    const intent = result.engine === 'LOCAL_WHISPER' && result.accepted
      ? parseSpeech(transcript, { expectingTemperature: Date.now() < (session.temperatureUntil || 0) }) : null;
    const latencyMs = Date.now() - startTime;
    // The server enforces name-first in continuous mode, not just the UI.
    if (stage === 'continuous' && !intent?.hasWakeWord) return { success:false, ignored:true, waitingForWake:true, engine, latencyMs };
    if (intent?.wakeOnly) return { success: false, wakeOnly: true, wakeToken:voiceSessions.issueWake(session), engine, transcript, latencyMs,
      feedback: { text: 'ครับ พูดได้เลยครับ', clips: ['wake-ready'] } };
    if (intent?.askTemperature) {
      session.temperatureUntil = Date.now() + 20000;
      return { success: false, followUp: 'temperature', wakeToken:voiceSessions.issueWake(session), engine, transcript, latencyMs,
        message: 'ต้องการกี่องศาครับ', feedback: { text: 'ต้องการกี่องศาครับ', clips: ['ask-temperature'] } };
    }
    const parsed = commandFor(intent?.commands ? { accepted: true, commands: intent.commands } : intent ? {} : result, currentAc);
    if (!parsed) {
      const tooLong = result.reason === 'too_long';
      const negated = intent?.reason === 'negated';
      if (negated) session.temperatureUntil = 0;
      const commandLike = /แอร์|อุณหภูมิ|พัดลม|เอ็น|\b(?:engi|ac|temperature)\b/i.test(transcript);
      const message = negated ? 'รับทราบครับ ยังไม่ส่งคำสั่ง' : tooLong ? 'กรุณาพูดคำสั่งให้สั้นลง ไม่เกินสิบสองวินาทีครับ' : transcript ? `ได้ยินว่า “${transcript}” กรุณาระบุคำสั่งอีกครั้ง` : 'ได้ยินเสียงไม่ชัด กรุณาพูดใหม่';
      return { success: false, ignored: stage === 'continuous' && !tooLong && !negated && !commandLike,
        engine, transcript, latencyMs, message,
        feedback: { text: message, clips: [negated ? 'cancelled' : tooLong ? 'too-long' : 'not-understood'] } };
    }
    if (parsed.unsupported) return { success: false, engine, transcript, latencyMs,
      message: parsed.message, feedback: parsed.feedback };
    session.temperatureUntil = 0; session.wake = null;
    return { success: true, transcript: transcript || parsed.text, label: `คำสั่งในเครื่อง: ${parsed.text}`,
      engine, latencyMs, nextState: parsed.next,
      feedback: describeVoiceCommand(parsed.next, currentAc, parsed.fields) };
  });
}));
app.use((error, req, res, next) => {
  if (req.path.startsWith('/api/voice')) return res.status(400).json({ success: false, message: 'ไม่สามารถรับไฟล์เสียงได้ กรุณาพูดใหม่' });
  next(error);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => {
  // Warm the local model once; no external AI endpoint is used.
  localVoice.start().then(() => console.log('Local Whisper พร้อมรับคำสั่ง • ไม่ใช้ AI API ภายนอก')).catch(error => console.error(error.message));
  console.log('================================================================');
  console.log(`Smart Classroom Voice Server พร้อมทำงานที่: http://localhost:${PORT}`);
  console.log('โมเดลคำสั่งเสียง: models/whisper-th-small (CPU INT8)');
  console.log('================================================================');
});
module.exports = { app, voiceSessions, localVoice };

if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { localVoice.close(); process.exit(0); });
}
