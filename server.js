require('dotenv').config({ path: require('node:path').join(__dirname, 'database.env'), quiet: true });
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { readFile } = require('node:fs/promises');
const { promisify } = require('node:util');
const gzip = promisify(require('node:zlib').gzip);
const { installRoomLogin } = require('./room-login');
const { createAuthStore } = require('./auth-store');
const { VoiceSessions, VoiceError, validAc } = require('./voice-session');
const voiceSessions = new VoiceSessions();
const { LocalVoice, commandFor } = require('./offline-voice');
const { parseSpeech, verifiedWakeTranscript, agreedBrowserIntent } = require('./local-commands');
const localVoice = new LocalVoice();
const { describe: describeVoiceCommand } = require('./public/js/voice-feedback');
const { createCoolingForecastRouter } = require('./cooling-forecast-route');
const { createComfortHandler } = require('./comfort-route');
const { AcScheduler } = require('./ac-scheduler');
const { SchedulerMqtt } = require('./ac-scheduler-mqtt');
const { createScheduleRouter } = require('./ac-scheduler-route');
const scheduleMqtt = new SchedulerMqtt();
const acScheduler = new AcScheduler({
  storePath: path.join(__dirname, 'data', 'ac-schedules.json'),
  publish: payload => scheduleMqtt.publish(payload),
  connection: () => scheduleMqtt.status(),
  destination: () => scheduleMqtt.config
});

const app = express();
const authStore = installRoomLogin(app, { store: createAuthStore({ accountFile: process.env.BIMCLUB_LOGIN_ACCOUNT_FILE }) });
app.use(express.json({ limit: '100kb' }));
app.use('/api/cooling-forecast', createCoolingForecastRouter());
app.use('/api/schedules', createScheduleRouter({ scheduler: acScheduler }));
app.get('/api/cira/logs', require('./cira-logs-route').readCiraLogs);
app.post('/api/comfort/recommendation', createComfortHandler());

// Serve the same installed MQTT.js bundle to browsers without a third-party CDN.
app.get('/vendor/mqtt.min.js', (req, res) => res.sendFile(path.join(path.dirname(require.resolve('mqtt/package.json')), 'dist', 'mqtt.min.js')));

const vadDirectory = 'node_modules/@ricky0123/vad-web/dist';
const ortDirectory = 'node_modules/onnxruntime-web/dist';
function serveVoiceAsset(url, file, mime, compress = false) {
  const source = path.join(__dirname, file);
  let compressed;
  // The login middleware must run before the browser can revalidate these files.
  app.get(url, async (req, res) => {
    res.type(mime).set({ 'Cache-Control': 'private, no-cache', 'Cloudflare-CDN-Cache-Control': 'no-store' });
    if (compress) res.vary('Accept-Encoding');
    if (!compress || req.get('Range') || req.acceptsEncodings('gzip', 'identity') !== 'gzip') {
      return res.sendFile(source, { cacheControl: false });
    }
    if (!compressed) {
      compressed = readFile(source).then(data => gzip(data)).catch(error => { compressed = null; throw error; });
    }
    const body = await compressed;
    return res.set('Content-Encoding', 'gzip').send(body);
  });
}
serveVoiceAsset('/ort/ort.wasm.min.js', `${ortDirectory}/ort.wasm.min.js`, 'text/javascript');
serveVoiceAsset('/ort/ort-wasm-simd-threaded.mjs', `${ortDirectory}/ort-wasm-simd-threaded.mjs`, 'text/javascript');
serveVoiceAsset('/ort/ort-wasm-simd-threaded.wasm', `${ortDirectory}/ort-wasm-simd-threaded.wasm`, 'application/wasm', true);
serveVoiceAsset('/vad-web/bundle.min.js', `${vadDirectory}/bundle.min.js`, 'text/javascript');
serveVoiceAsset('/vad-web/vad.worklet.bundle.min.js', `${vadDirectory}/vad.worklet.bundle.min.js`, 'text/javascript');
serveVoiceAsset('/vad-web/silero_vad.onnx', `${vadDirectory}/silero_vad.onnx`, 'application/octet-stream', true);
serveVoiceAsset('/js/voice-audio-worklet.js', 'public/js/voice-audio-worklet.js', 'text/javascript');
app.use('/vad-web', express.static(path.join(__dirname, vadDirectory)));
app.use('/ort', express.static(path.join(__dirname, ortDirectory)));
const browserModelFiles = new Set(['manifest.json', 'encoder.q4.onnx', 'predictor.fp32.onnx', 'joint.fp32.onnx', 'frontend.json', 'tokenizer.json']);
app.get('/voice-model/typhoon-q4-v1/:file', (req, res) => {
  if (!browserModelFiles.has(req.params.file)) return res.sendStatus(404);
  res.sendFile(req.params.file, {
    root: path.join(__dirname, 'models', 'typhoon-q4-v1'),
    cacheControl: false,
    headers: { 'Cache-Control': 'private, max-age=86400, immutable', 'Cloudflare-CDN-Cache-Control': 'no-store' }
  });
});
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function voiceRoute(handler) {
  return async (req, res) => {
    try {
      const response = await handler(req, res);
      if (!res.destroyed) res.json(response);
    }
    catch (error) {
      if (res.destroyed) return;
      const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
      res.status(timedOut ? 504 : error.status || 500).json({ success: false,
        message: timedOut ? 'ประมวลผลเสียงนานเกินไป กรุณาลองใหม่' : error.status ? error.message : 'ระบบเสียงขัดข้อง กรุณาลองใหม่' });
    }
  };
}
app.post('/api/voice-session', voiceRoute(async (req, res) => {
  const browserRecognition = req.body.browserRecognition === true;
  if (!browserRecognition) await localVoice.start();
  if (res.destroyed) return;
  return { sessionId: voiceSessions.create(req.body.device), engine: browserRecognition ? 'LOCAL_BROWSER' : 'LOCAL_WHISPER', wakeWord: true, duration: 12 };
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
function validateVoiceStage(stage) {
  if (!['continuous', 'command', 'direct'].includes(stage)) throw new VoiceError('สถานะรับเสียงไม่ถูกต้อง');
}
function validateVoiceAc(currentAc) {
  if (!currentAc || !validAc({ ...currentAc, power: currentAc.power === null ? true : currentAc.power })) throw new VoiceError('สถานะอุปกรณ์ไม่ถูกต้อง');
}
function expectingVoiceTemperature(session) {
  return Date.now() < (session.temperatureUntil || 0);
}
function voiceIntentResponse({ session, stage, currentAc, result, transcript, intent, latencyMs }) {
  const engine = result.engine || 'LOCAL_WHISPER';
  const waitingForWake = stage === 'continuous';
  if (waitingForWake && !intent?.hasWakeWord) return { success:false, ignored:true, waitingForWake:true, engine, latencyMs };
  const wakeEvidence = waitingForWake ? { wakeVerified: true } : {};
  // The browser reads the requested live value after recognition. A query
  // never constructs an AC state or uses the command mapping fallback.
  if (intent?.query) {
    session.temperatureUntil = 0;
    session.wake = null;
    return { success: true, query: intent.query, ...wakeEvidence, engine, transcript, latencyMs };
  }
  const ticket = () => stage === 'direct' ? {} : { wakeToken: voiceSessions.issueWake(session) };
  if (intent?.wakeOnly) return { success: false, wakeOnly: true, ...ticket(), ...wakeEvidence, engine, transcript, latencyMs,
    feedback: { text: 'ครับ พูดได้เลยครับ', clips: ['wake-ready'] } };
  if (intent?.askTemperature) {
    session.temperatureUntil = Date.now() + 20000;
    return { success: false, followUp: 'temperature', ...ticket(), ...wakeEvidence, engine, transcript, latencyMs,
      message: 'ต้องการกี่องศาครับ', feedback: { text: 'ต้องการกี่องศาครับ', clips: ['ask-temperature'] } };
  }
  const parsed = commandFor(intent?.commands ? { accepted: true, commands: intent.commands } : intent ? {} : result, currentAc);
  if (!parsed) {
    const tooLong = result.reason === 'too_long';
    const negated = intent?.reason === 'negated';
    if (negated) session.temperatureUntil = 0;
    const message = negated ? 'รับทราบครับ ยังไม่ส่งคำสั่ง' : tooLong ? 'กรุณาพูดคำสั่งให้สั้นลง ไม่เกินสิบสองวินาทีครับ' : transcript ? `ได้ยินว่า “${transcript}” กรุณาระบุคำสั่งอีกครั้ง` : 'ได้ยินเสียงไม่ชัด กรุณาพูดใหม่';
    return { success: false, ...wakeEvidence, engine, transcript, latencyMs, message,
      feedback: { text: message, clips: [negated ? 'cancelled' : tooLong ? 'too-long' : 'not-understood'] } };
  }
  if (parsed.unsupported) return { success: false, ...wakeEvidence, engine, transcript, latencyMs,
    message: parsed.message, feedback: parsed.feedback };
  session.temperatureUntil = 0; session.wake = null;
  return { success: true, ...wakeEvidence, transcript: transcript || parsed.text, label: `คำสั่งในเครื่อง: ${parsed.text}`,
    engine, latencyMs, nextState: parsed.next,
    feedback: describeVoiceCommand(parsed.next, currentAc, parsed.fields) };
}
app.post('/api/voice-command', upload.single('audio'), voiceRoute(async req => {
  const session = voiceSessions.get(req.body.sessionId, req.body.device);
  return voiceSessions.run(session, req.body.requestId, async signal => {
    const startTime = Date.now();
    const { stage, wakeToken } = req.body;
    validateVoiceStage(stage);
    const waitingForWake = stage === 'continuous';
    if (stage === 'command') voiceSessions.consume(session, wakeToken);
    const audio = req.file?.buffer;
    if (!audio || audio.length < 1644 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.length > 16_000 * 2 * 16 + 44) {
      throw new VoiceError('ไฟล์เสียงไม่ถูกต้องหรือยาวเกินไป กรุณาพูดใหม่');
    }
    let currentAc;
    try { currentAc = JSON.parse(req.body.currentAc); } catch (_) { }
    validateVoiceAc(currentAc);
    const result = await localVoice.classify(audio, signal, { wake: waitingForWake });
    signal.throwIfAborted();
    const latencyMs = Date.now() - startTime;
    // A PCM request still needs acoustic wake evidence from Whisper before
    // ordinary grammar can produce a command or open a follow-up window.
    const wakeTranscript = waitingForWake ? verifiedWakeTranscript(result) : null;
    const transcript = wakeTranscript || result.transcript || '';
    const intent = (!waitingForWake || wakeTranscript) && result.engine === 'LOCAL_WHISPER' && result.accepted
      ? parseSpeech(transcript, { expectingTemperature: expectingVoiceTemperature(session) }) : null;
    return voiceIntentResponse({ session, stage, currentAc, result, transcript, intent, latencyMs });
  });
}));
app.post('/api/voice-transcript', voiceRoute(req => {
  const startTime = Date.now();
  const { sessionId, device, requestId, stage, wakeToken, currentAc, transcripts } = req.body;
  const session = voiceSessions.get(sessionId, device);
  validateVoiceStage(stage);
  validateVoiceAc(currentAc);
  const recognition = agreedBrowserIntent(transcripts, {
    waitingForWake: stage === 'continuous',
    expectingTemperature: expectingVoiceTemperature(session)
  });
  // Decline before allocating a job or consuming the ticket. The browser can
  // submit the original audio with the same request ID and wake token.
  if (!recognition) return { useServer: true };
  return voiceSessions.run(session, requestId, () => {
    if (stage === 'command') voiceSessions.consume(session, wakeToken);
    return voiceIntentResponse({ session, stage, currentAc, result: { engine: 'LOCAL_BROWSER' },
      ...recognition, latencyMs: Date.now() - startTime });
  });
}));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (req.path.startsWith('/api/voice')) return res.status(400).json({ success: false, message: 'ไม่สามารถรับไฟล์เสียงได้ กรุณาพูดใหม่' });
  const status = error.status >= 400 && error.status < 500 ? error.status : 500;
  return res.status(status).json({ success: false, message: status === 500 ? 'ระบบขัดข้อง กรุณาลองใหม่' : 'คำขอไม่ถูกต้อง' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, '127.0.0.1', () => {
  acScheduler.start().then(() => scheduleMqtt.start()).catch(error => console.error('[Schedule]', error.message));
  // Warm the local model once; no external AI endpoint is used.
  localVoice.start().then(() => console.log('Local Whisper พร้อมรับคำสั่ง • ไม่ใช้ AI API ภายนอก')).catch(error => console.error(error.message));
  console.log('================================================================');
  console.log(`Smart Classroom Voice Server พร้อมทำงานที่: http://localhost:${PORT}`);
  console.log('โมเดลคำสั่งเสียง: models/whisper-th-small (CPU INT8)');
  console.log('================================================================');
});
module.exports = { app, voiceSessions, localVoice, acScheduler, scheduleMqtt, authStore };

if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    localVoice.close();
    await authStore.close();
    await acScheduler.close(); await scheduleMqtt.close();
    process.exit(0);
  });
}
