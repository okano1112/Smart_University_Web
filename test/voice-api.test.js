'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { wav } = require('../public/js/voice-audio');
const { app, voiceSessions, localVoice } = require('../server');
const { commandFor } = require('../offline-voice');

test('offline API: local inference, no external fetch, deduplication and rejection', async t => {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fetchHttp = global.fetch, classify = localVoice.classify;
  global.fetch = () => { throw new Error('External fetch forbidden'); };
  const base = `http://127.0.0.1:${server.address().port}`;
  let calls = 0, prediction = { accepted: true, label: '0_ON', confidence: 0.99, margin: 0.98 };
  localVoice.classify = async () => { calls++; return prediction; };
  let sequence = 0;
  const json = async (route, body) => {
    const r = await fetchHttp(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, ...await r.json() };
  };
  const audio = await wav(new Float32Array(16000).fill(0.1));
  const command = async (sessionId, stage = 'direct', id = `request-${String(++sequence).padStart(16, '0')}`, current = { power: false, temp: 24, mode: 2, fan: 2 }) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ sessionId, device: 'room-a', stage, requestId: id, currentAc: JSON.stringify(current) })) form.append(k, v);
    form.append('audio', audio, 'voice.wav');
    const r = await fetchHttp(base + '/api/voice-command', { method: 'POST', body: form });
    return { status: r.status, ...await r.json() };
  };
  try {
    const session = await json('/api/voice-session', { device: 'room-a' });
    assert.equal(session.engine, 'LOCAL_TFLITE'); assert.equal(session.wakeWord, false);
    await t.test('command is evaluated once and repeated ID returns identical result', async () => {
      const a = await command(session.sessionId, 'direct', 'request-deduplicated-1111');
      const b = await command(session.sessionId, 'direct', 'request-deduplicated-1111');
      assert.deepEqual(a, b); assert.equal(calls, 1); assert.equal(a.success, true);
      assert.deepEqual(a.nextState, { power: true, temp: 24, mode: 2, fan: 2 });
      assert.deepEqual(a.feedback.clips, ['power-on']);
    });
    await t.test('explicit continuous mode handles commands directly without wake greeting', async () => {
      prediction.label = '1_OFF'; const r = await command(session.sessionId, 'wake');
      assert.equal(r.nextState.power, false); assert.equal(r.wakeOnly, undefined);
    });
    await t.test('background and uncertain output never produce a state change', async () => {
      for (const result of [{ accepted: false }, { accepted: true, label: '6_BACKGROUND', confidence: 1, margin: 1 }, { accepted: true, label: '0_ON', confidence: 0.6, margin: 0.5 }]) {
        prediction = result;
        const r = await command(session.sessionId); assert.equal(r.success, false); assert.equal(r.nextState, undefined);
        assert.equal((await command(session.sessionId, 'wake')).ignored, true);
      }
    });
    await t.test('unavailable local engine fails visibly, never falls back to cloud', async () => {
      localVoice.classify = async () => { throw Object.assign(new Error('local unavailable'), { status: 503 }); };
      assert.equal((await command(session.sessionId)).status, 503);
    });
    await t.test('bad current state and cancelled sessions are rejected', async () => {
      assert.equal((await command(session.sessionId, 'direct', 'request-invalid-state-111', { power: 'false' })).status, 400);
      await json('/api/voice-session/cancel', { sessionId: session.sessionId });
      assert.equal((await command(session.sessionId)).status, 410);
    });
  } finally {
    global.fetch = fetchHttp; localVoice.classify = classify;
    for (const id of voiceSessions.sessions.keys()) voiceSessions.cancel(id);
    server.closeAllConnections(); await new Promise(r => server.close(r));
  }
});

test('all six classes map deterministically; relative temperature clamps; invalid results reject', () => {
  const current = { power: true, temp: 24, mode: 2, fan: 2 };
  const classify = (label, state = current) => commandFor({ label, accepted: true, confidence: 0.99, margin: 0.98 }, state);
  assert.equal(classify('0_ON').next.power, true);
  assert.deepEqual(classify('1_OFF').next, { ...current, power: false });
  assert.equal(classify('2_TEMP_UP').next.temp, 25); assert.equal(classify('3_TEMP_DOWN').next.temp, 23);
  assert.equal(classify('2_TEMP_UP', { ...current, temp: 27 }).next.temp, 27);
  assert.equal(classify('3_TEMP_DOWN', { ...current, temp: 21 }).next.temp, 21);
  assert.deepEqual(classify('4_PRESET_TURBO').next, { power: true, temp: 21, mode: 0, fan: 3 });
  assert.deepEqual(classify('5_PRESET_ECO').next, { power: true, temp: 25, mode: 0, fan: 0 });
  assert.equal(classify('6_BACKGROUND'), null); assert.equal(classify('unknown'), null);
  assert.equal(commandFor({ accepted: true, label: '0_ON', confidence: NaN, margin: 1 }, current), null);
});
