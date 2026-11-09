'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const VoiceController = require('../public/js/voice-controller');
const { describe } = require('../public/js/voice-feedback');
const { wav, resample } = require('../public/js/voice-audio');
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  let count = 0, endpoint = 'device-a', current = { power: true, temp: 24, mode: 0, fan: 3 };
  const events = [], requests = [], notices = [], sent = [];
  let responder = async form => ({ success: true, requestId: form.get('requestId'), transcript: 'เปิดแอร์', label: 'เปิดแอร์', nextState: current, latencyMs: 1 });
  const audio = { start: async () => {}, close: () => events.push('closed'), beep: async type => events.push(type), reply: async feedback => events.push({ spoken: feedback.text, clips: feedback.clips }), kind: 'silero' };
  const controller = new VoiceController({
    feedback: describe, device: () => endpoint, current: () => current, pending: () => false,
    audio: () => audio, wav, id: () => `request-${String(++count).padStart(16, '0')}`,
    render: (state, handsFree) => events.push({ state, handsFree }), notice: (...notice) => notices.push(notice), log: () => {},
    send: (...args) => { sent.push(args); return { id: 'device-command' }; },
    fetch: async (url, options) => {
      requests.push({ url, options }); let data;
      if (url === '/api/voice-session') data = { sessionId: 'session-a' };
      else if (url === '/api/voice-command') data = await responder(options.body);
      else data = { success: true, listeningMs: 8000 };
      return { ok: true, json: async () => data };
    }
  });
  return { controller, events, requests, notices, sent, audio, setResponder: fn => responder = fn,
    changeDevice: () => { endpoint = 'device-b'; }, changeCurrent: () => { current = { ...current, temp: 25 }; } };
}
const samples = () => new Float32Array(16000).fill(0.03);

test('wake-only -> spoken greeting -> command -> spoken reply -> listen again before device report', async () => {
  const h = setup(), c = h.controller;
  h.setResponder(async form => form.get('stage') === 'wake'
    ? { requestId: form.get('requestId'), wakeOnly: true, wakeToken: 'token' }
    : { requestId: form.get('requestId'), success: true, nextState: { power: true, temp: 24, mode: 0, fan: 3 }, label: 'เปิดแอร์' });
  try {
    await c.start(true); assert.equal(c.state, 'WAIT_WAKE'); assert.ok(!h.events.includes('ready'));
    c.onStart(c.epoch); await c.onEnd(samples(), c.epoch);
    assert.equal(c.state, 'WAIT_COMMAND'); assert.ok(h.events.some(event => event.spoken === 'มีอะไรให้ช่วยครับ'));
    assert.equal(h.requests.at(-1).url, '/api/voice-session/arm');
    c.onStart(c.epoch); assert.equal(c.state, 'CAPTURE_COMMAND'); assert.equal(c.listenTimer, null);
    await c.onEnd(samples(), c.epoch);
    assert.equal(c.state, 'WAIT_WAKE'); assert.equal(h.sent.length, 1); assert.ok(!h.events.includes('confirmed'));
    await c.deviceResult('wrong-id', true, 'wrong'); assert.equal(c.state, 'WAIT_WAKE');
    await c.deviceResult('device-command', true, 'ESP32 ตอบแล้ว');
    assert.equal(c.state, 'WAIT_WAKE'); assert.ok(h.events.includes('confirmed'));
  } finally { c.stop(); }
});
test('cancel while ASR is pending cannot publish a late response', async () => {
  const h = setup(), c = h.controller; let release;
  h.setResponder(form => new Promise(resolve => { release = () => resolve({ requestId: form.get('requestId'), success: true, nextState: {} }); }));
  await c.start(false); const epoch = c.epoch; c.onStart(epoch);
  const processing = c.onEnd(samples(), epoch); await tick();
  c.stop(); release(); await processing;
  assert.equal(h.sent.length, 0); assert.equal(c.state, 'OFF');
});
test('destination or manual state changes invalidate a pending ASR result', async t => {
  for (const action of ['changeDevice', 'changeCurrent']) await t.test(action, async () => {
    const h = setup(), c = h.controller; let release;
    h.setResponder(form => new Promise(resolve => { release = () => resolve({ requestId: form.get('requestId'), success: true, nextState: {} }); }));
    try {
      await c.start(false); c.onStart(c.epoch); const processing = c.onEnd(samples(), c.epoch);
      await tick(); h[action](); release(); await processing; assert.equal(h.sent.length, 0);
    } finally { c.stop(); }
  });
});
test('concurrent VAD callbacks and the same audio object do not duplicate commands', async () => {
  const h = setup(), c = h.controller;
  try {
    await c.start(false); c.onStart(c.epoch); const audio = samples();
    await Promise.all([c.onEnd(audio, c.epoch), c.onEnd(audio, c.epoch), c.onEnd(samples(), c.epoch)]);
    assert.equal(h.sent.length, 1);
    assert.equal(h.requests.filter(request => request.url === '/api/voice-command').length, 1);
  } finally { c.stop(); }
});
test('hands-free network failures are visible and back off before listening again', async () => {
  const h = setup(), c = h.controller;
  h.setResponder(async () => { throw new Error('network down'); });
  try {
    await c.start(true); c.onStart(c.epoch); await c.onEnd(samples(), c.epoch);
    assert.equal(c.state, 'RECOVERING'); assert.ok(c.listenTimer); assert.ok(h.notices.some(([text]) => text.includes('network down')));
  } finally { c.stop(); }
});
test('a command spoken during wake lookup is buffered once and sent after arm', async () => {
  const h = setup(), c = h.controller; let wakeRelease;
  h.setResponder(form => form.get('stage') === 'wake' ? new Promise(resolve => {
    wakeRelease = () => resolve({ requestId: form.get('requestId'), wakeOnly: true, wakeToken: 'token' });
  }) : Promise.resolve({ requestId: form.get('requestId'), success: true, nextState: {}, label: 'เปิดแอร์' }));
  try {
    await c.start(true); c.onStart(c.epoch); const wakeRequest = c.onEnd(samples(), c.epoch); await tick();
    c.onStart(c.epoch); await c.onEnd(samples(), c.epoch); assert.equal(h.sent.length, 0);
    wakeRelease(); await wakeRequest; await tick();
    assert.equal(h.sent.length, 1); assert.equal(c.state, 'WAIT_WAKE');
    assert.ok(h.requests.findIndex(request => request.url.endsWith('/arm')) < h.requests.findIndex(request => request.url.endsWith('/claim')));
  } finally { c.stop(); }
});
test('HTTP error and malformed response cannot publish', async t => {
  for (const failure of ['http', 'wrong-id']) await t.test(failure, async () => {
    const h = setup(), c = h.controller;
    h.setResponder(async () => failure === 'http' ? Promise.reject(new Error('HTTP 503')) : ({ requestId: 'old', success: true }));
    try { await c.start(false); c.onStart(c.epoch); await c.onEnd(samples(), c.epoch); assert.equal(h.sent.length, 0); assert.equal(c.state, 'OFF'); }
    finally { c.stop(); }
  });
});
test('microphone loss and late startup are cleaned up', async () => {
  const h = setup(), c = h.controller; let release;
  h.audio.start = () => new Promise(resolve => { release = resolve; });
  const starting = c.start(true); c.stop(); release(); await starting;
  assert.equal(c.state, 'OFF'); assert.equal(h.requests.filter(request => request.url === '/api/voice-session').length, 0);
});
test('VAD misfire releases command capture rather than hanging', async () => {
  const h = setup(), c = h.controller;
  try { await c.start(true); c.setState('CAPTURE_COMMAND'); c.onMisfire(c.epoch); assert.equal(c.state, 'WAIT_WAKE'); }
  finally { c.stop(); }
});
test('device timeout cannot emit a success tone', async () => {
  const h = setup(), c = h.controller;
  try {
    await c.start(false); c.onStart(c.epoch); await c.onEnd(samples(), c.epoch);
    await c.deviceResult('device-command', false, 'timeout');
    assert.equal(c.state, 'OFF'); assert.ok(!h.events.includes('confirmed'));
  } finally { c.stop(); }
});
test('WAV and sample conversion preserve duration and declare the correct rate', async () => {
  for (const rate of [44100, 48000]) {
    const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 440 * i / rate) * 0.2);
    const converted = resample(input, rate); assert.equal(converted.length, 16000);
    const encoded = new DataView(await wav(converted).arrayBuffer());
    assert.equal(encoded.getUint32(24, true), 16000); assert.equal(encoded.getUint32(40, true), 32000);
    assert.ok(Math.abs(converted[100] - Math.sin(2 * Math.PI * 440 * 100 / 16000) * 0.2) < 0.04);
  }
});

test('speech started during the push-to-talk chime is captured before the listening timeout', async () => {
  const h = setup(), c = h.controller; let release;
  h.audio.beep = () => new Promise(resolve => { release = resolve; });
  try {
    const starting = c.start(false); await tick();
    assert.equal(c.state, 'READY'); c.onStart(c.epoch);
    release(); await starting;
    assert.equal(c.state, 'CAPTURE_COMMAND'); assert.equal(c.listenTimer, null);
    await c.onEnd(samples(), c.epoch); assert.equal(h.sent.length, 1);
  } finally { c.stop(); }
});

test('spoken interpretation is immediate, blocks echo, and resumes without waiting for ESP32', async () => {
  const h = setup(), c = h.controller; let finishReply;
  h.audio.reply = feedback => new Promise(resolve => { h.events.push({ spoken: feedback.text }); finishReply = resolve; });
  h.setResponder(async form => ({ requestId: form.get('requestId'), success: true,
    nextState: { power: true, temp: 27, mode: 0, fan: 3 }, label: '27 องศา', feedback: describe({ power: true, temp: 27, mode: 0, fan: 3 }, {}, ['temp']) }));
  try {
    await c.start(true); c.onStart(c.epoch); const request = c.onEnd(samples(), c.epoch); await tick();
    assert.equal(c.state, 'SPEAKING'); assert.equal(h.events.at(-1).spoken, 'ตั้งอุณหภูมิ 27 องศาครับ');
    c.onStart(c.epoch); await c.onEnd(samples(), c.epoch); assert.equal(h.sent.length, 1);
    finishReply(); await request;
    assert.equal(c.state, 'WAIT_WAKE'); assert.equal(c.commandId, 'device-command');
    assert.ok(c.deviceTimer, 'device is still monitored independently');
  } finally { c.stop(); }
});
test('reply playback failure never closes a working hands-free microphone', async () => {
  const h = setup(), c = h.controller;
  h.audio.reply = async () => { throw new Error('speaker unavailable'); };
  try {
    await c.start(true); c.onStart(c.epoch); await c.onEnd(samples(), c.epoch);
    assert.equal(c.state, 'WAIT_WAKE'); assert.ok(h.notices.some(([text]) => text.includes('เสียงตอบกลับเล่นไม่ได้')));
  } finally { c.stop(); }
});

test('wake window is armed after spoken greeting ends, and self-echo is ignored', async () => {
  const h = setup(), c = h.controller; let finishGreeting;
  h.audio.reply = feedback => new Promise(resolve => { h.events.push({ spoken: feedback.text }); finishGreeting = resolve; });
  h.setResponder(async form => ({ requestId: form.get('requestId'), wakeOnly: true, wakeToken: 'wake-token' }));
  try {
    await c.start(true); c.onStart(c.epoch);
    const waking = c.onEnd(samples(), c.epoch); await tick();
    assert.equal(c.state, 'ACKNOWLEDGING'); assert.equal(c.listenTimer, null);
    assert.ok(!h.requests.some(request => request.url.endsWith('/arm')));
    c.onStart(c.epoch); await c.onEnd(samples(), c.epoch);
    assert.equal(h.requests.filter(request => request.url === '/api/voice-command').length, 1);
    finishGreeting(); await waking;
    assert.equal(c.state, 'WAIT_COMMAND'); assert.ok(c.listenTimer);
    assert.equal(h.requests.at(-1).url, '/api/voice-session/arm');
  } finally { c.stop(); }
});
test('name and command in one utterance bypass the greeting and execute once', async () => {
  const h = setup(), c = h.controller;
  h.setResponder(async form => ({ requestId: form.get('requestId'), success: true,
    nextState: { power: true, temp: 27, mode: 0, fan: 3 }, feedback: { text: 'ตั้งอุณหภูมิ 27 องศาครับ', clips: ['temp-27'] } }));
  try {
    await c.start(true); c.onStart(c.epoch); await c.onEnd(samples(), c.epoch);
    assert.equal(h.sent.length, 1); assert.equal(c.state, 'WAIT_WAKE');
    assert.ok(!h.events.some(event => event.clips?.includes('wake-help')));
    assert.ok(!h.requests.some(request => request.url.endsWith('/arm')));
  } finally { c.stop(); }
});
test('blocked automatic audio startup requests one gesture instead of reporting a microphone failure', async () => {
  const h = setup(), c = h.controller;
  h.audio.start = async options => { assert.equal(options.automatic, true); throw Object.assign(new Error('gesture needed'), { code: 'VOICE_GESTURE_REQUIRED' }); };
  assert.equal(await c.start(true, { automatic: true }), false);
  assert.equal(c.state, 'OFF'); assert.equal(h.notices.length, 0);
  assert.equal(c.lastStartError.code, 'VOICE_GESTURE_REQUIRED');
});
