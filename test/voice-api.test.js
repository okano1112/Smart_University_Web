'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync } = require('node:fs');
const { writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { wav } = require('../public/js/voice-audio');
const { makeLoginAccount } = require('../room-login');
const loginDirectory = mkdtempSync(path.join(tmpdir(), 'bimclub-voice-login-'));
process.env.BIMCLUB_LOGIN_ACCOUNT_FILE = path.join(loginDirectory, 'account.json');
process.env.BIMCLUB_AUTH_MODE = 'file';
const { app, voiceSessions, localVoice } = require('../server');
const { commandFor } = require('../offline-voice');

test('offline API: local inference, no external fetch, deduplication and rejection', async t => {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const testFetch = global.fetch, classify = localVoice.classify, start = localVoice.start;
  const base = `http://127.0.0.1:${server.address().port}`;
  const password = 'voice-integration-test-only';
  await writeFile(process.env.BIMCLUB_LOGIN_ACCOUNT_FILE, JSON.stringify(await makeLoginAccount('voice-test', password)));
  const login = await testFetch(base + '/login', { method: 'POST', headers: { Origin: base },
    body: new URLSearchParams({ username: 'voice-test', password }), redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const fetchHttp = (url, options = {}) => testFetch(url, { ...options, headers: { ...options.headers, Origin: base, Cookie: cookie } });
  localVoice.start = async () => {};
  global.fetch = () => { throw new Error('External fetch forbidden'); };
  let calls = 0, inferenceOptions, prediction = { accepted: true, label: '00_POWER_ON', confidence: 0.99, margin: 0.98 };
  localVoice.classify = async (_audio, _signal, options) => { calls++; inferenceOptions = options; return prediction; };
  const wakePrediction = transcript => ({ accepted:true, engine:'LOCAL_WHISPER', transcript,
    noSpeechProbability:.01, wakeCandidates:[{transcript,score:-.2}] });
  let sequence = 0;
  const json = async (route, body) => {
    const r = await fetchHttp(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, ...await r.json() };
  };
  const audio = await wav(new Float32Array(16000).fill(0.1));
  const command = async (sessionId, stage = 'direct', id = `request-${String(++sequence).padStart(16, '0')}`, current = { power: false, temp: 24, mode: 2, fan: 2 }, wakeToken) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ sessionId, device: 'room-a', stage, requestId: id, currentAc: JSON.stringify(current) })) form.append(k, v);
    if (wakeToken) form.append('wakeToken', wakeToken);
    form.append('audio', audio, 'voice.wav');
    const r = await fetchHttp(base + '/api/voice-command', { method: 'POST', body: form });
    return { status: r.status, ...await r.json() };
  };
  const transcript = (sessionId, transcripts, options = {}) => json('/api/voice-transcript', {
    sessionId, device: 'room-a', stage: 'continuous', requestId: `request-${String(++sequence).padStart(16, '0')}`,
    currentAc: { power: false, temp: 24, mode: 2, fan: 2 }, transcripts, ...options
  });
  try {
    const session = await json('/api/voice-session', { device: 'room-a' });
    assert.equal(session.engine, 'LOCAL_WHISPER'); assert.equal(session.wakeWord, true);
    await t.test('command is evaluated once and repeated ID returns identical result', async () => {
      const a = await command(session.sessionId, 'direct', 'request-deduplicated-1111');
      const b = await command(session.sessionId, 'direct', 'request-deduplicated-1111');
      assert.deepEqual(a, b); assert.equal(calls, 1); assert.equal(a.success, true);
      assert.equal(inferenceOptions.wake, false);
      assert.deepEqual(a.nextState, { power: true, temp: 24, mode: 2, fan: 2 });
      assert.deepEqual(a.feedback.clips, ['power-on']);
    });
    await t.test('name plus command executes directly without an extra greeting', async () => {
      prediction=wakePrediction('เอ็นจี้ปิดแอร์'); const r = await command(session.sessionId, 'continuous');
      assert.equal(inferenceOptions.wake, true);
      assert.equal(r.nextState.power, false); assert.equal(r.wakeOnly, undefined); assert.equal(r.wakeVerified, true);
    });
    await t.test('hands-free remains silent without trusted wake evidence, even when the transcript spells Engi', async () => {
      const baseWake = wakePrediction('เอ็นจี้เปิดแอร์');
      for (const result of [
        {accepted:true, engine:'LOCAL_WHISPER', transcript:'เอ็นจี้'},
        {...baseWake, noSpeechProbability:.9},
        {...baseWake, wakeCandidates:[{transcript:'เอ็นจี้เปิดแอร์',score:-.9}]},
        {...baseWake, wakeCandidates:[{transcript:'เอ็นที่เปิดแอร์',score:-.3},{transcript:'เอ็นจี้ปิดแอร์',score:-.4}]},
        {...baseWake, wakeCandidates:[{transcript:'เปิดแอร์',score:-.2},{transcript:'เอ็นจี้เปิดแอร์',score:-.3}]},
        {...baseWake, wakeCandidates:[{transcript:'เอ็นที่',score:-.3}]},
        wakePrediction('เอ็นจินเปิดแอร์'), wakePrediction('มีคนชื่อเอ็นจี้ เปิดแอร์')
      ]) {
        prediction = result;
        const r = await command(session.sessionId, 'continuous');
        assert.equal(r.status,200); assert.equal(r.ignored,true); assert.equal(r.waitingForWake,true);
        for (const key of ['feedback','wakeToken','wakeVerified','nextState','transcript']) assert.equal(r[key],undefined,key);
      }
    });
    await t.test('background and uncertain output never produce a state change', async () => {
      for (const result of [{ accepted: false }, { accepted: true, label: '29_BACKGROUND', confidence: 1, margin: 1 }, { accepted: true, label: '00_POWER_ON', confidence: 0.6, margin: 0.5 }]) {
        prediction = result;
        const r = await command(session.sessionId); assert.equal(r.success, false); assert.equal(r.nextState, undefined);
        assert.equal((await command(session.sessionId, 'continuous')).ignored, true);
      }
    });
    await t.test('long continuous utterance remains silent without wake', async () => {
      prediction = {accepted:false,reason:'too_long'};
      const r = await command(session.sessionId,'continuous');
      assert.equal(r.success,false); assert.equal(r.ignored,true); assert.equal(r.nextState,undefined);
      assert.equal(r.feedback,undefined);
    });
    await t.test('unsupported direct commands respond with speech and no nextState', async () => {
      for (const label of ['04_SET_18','16_SET_30','22_MODE_SLEEP','27_SWING_ON','28_SWING_OFF']) {
        prediction = {accepted:true,label,confidence:0.99,margin:0.98};
        const r = await command(session.sessionId,'direct');
        assert.equal(r.success,false); assert.equal(r.nextState,undefined); assert.ok(r.feedback.clips.length); assert.ok(!r.ignored);
      }
    });
    await t.test('local transcripts understand the user examples and ask for a missing temperature', async () => {
      for (const [transcript,power] of [['เปิดแอร์ให้ผมหน่อย',true],['เปิดแอร์',true],['ปิดแอร์',false],['ปิดแอร์ให้ผมหน่อย',false],['เอ็นจี้เปิดแอร์ให้ผมหน่อย',true]]) {
        prediction={accepted:true,engine:'LOCAL_WHISPER',transcript};
        const r=await command(session.sessionId,'direct');assert.equal(r.nextState.power,power,transcript);
      }
      prediction={accepted:true,engine:'LOCAL_WHISPER',transcript:'ปรับอุณหภูมิ'};
      const question=await command(session.sessionId,'direct');assert.equal(question.followUp,'temperature');assert.equal(question.nextState,undefined);
      assert.deepEqual(question.feedback.clips,['ask-temperature']);
      prediction.transcript='ยี่สิบห้าองศา';const answer=await command(session.sessionId,'direct');assert.equal(answer.nextState.temp,25);
      prediction=wakePrediction('เอ็นจี้');assert.equal((await command(session.sessionId,'continuous')).wakeOnly,true);
      prediction.transcript='ไม่ต้องเปิดแอร์';assert.equal((await command(session.sessionId,'continuous')).success,false);
    });
    await t.test('continuous mode ignores commands without Engi; name ticket is one-shot and browser-bound', async () => {
      prediction={accepted:true,engine:'LOCAL_WHISPER',transcript:'เปิดแอร์ให้ผมหน่อย'};
      const unnamed=await command(session.sessionId,'continuous');assert.equal(unnamed.ignored,true);assert.equal(unnamed.nextState,undefined);
      prediction=wakePrediction('เอนจี้');const wake=await command(session.sessionId,'continuous');assert.equal(wake.wakeOnly,true);assert.equal(wake.wakeVerified,true);assert.ok(wake.wakeToken);
      const other=await json('/api/voice-session',{device:'room-a'});
      assert.equal((await json('/api/voice-session/arm',{sessionId:other.sessionId,device:'room-a',wakeToken:wake.wakeToken})).status,409);
      const body={sessionId:session.sessionId,device:'room-a',wakeToken:wake.wakeToken};
      await json('/api/voice-session/arm',body);await json('/api/voice-session/claim',body);
      prediction=wakePrediction('เปิดแอร์');
      const form=new FormData();for(const [k,v] of Object.entries({...body,stage:'command',requestId:'request-ticket-command-1111',currentAc:JSON.stringify({power:false,temp:24,mode:0,fan:3})}))form.append(k,v);form.append('audio',audio,'voice.wav');
      const response=await fetchHttp(base+'/api/voice-command',{method:'POST',body:form});const result=await response.json();assert.equal(result.success,true);
      assert.equal((await json('/api/voice-session/claim',body)).status,409);
      assert.equal((await command(session.sessionId,'continuous')).ignored,true);
    });
    await t.test('room questions return only an intent after the same wake and one-use ticket checks', async () => {
      const noControl = (response, query) => {
        assert.equal(response.status, 200); assert.equal(response.success, true); assert.equal(response.query, query);
        for (const key of ['nextState', 'feedback', 'wakeToken', 'followUp']) assert.equal(response[key], undefined, key);
      };
      prediction = wakePrediction('ตอนนี้อุณหภูมิเท่าไหร่');
      assert.equal((await command(session.sessionId, 'continuous')).ignored, true);
      noControl(await command(session.sessionId), 'room_temperature');
      prediction = wakePrediction('เอ็นจี้ในห้องมีกี่คน');
      const named = await command(session.sessionId, 'continuous');
      noControl(named, 'people_count'); assert.equal(named.wakeVerified, true);
      prediction = wakePrediction('เอ็นจี้');
      const wake = await command(session.sessionId, 'continuous');
      const ticket = { sessionId: session.sessionId, device: 'room-a', wakeToken: wake.wakeToken };
      await json('/api/voice-session/arm', ticket); await json('/api/voice-session/claim', ticket);
      prediction = wakePrediction('แอร์เปิดอยู่ไหม');
      noControl(await command(session.sessionId, 'command', undefined, undefined, wake.wakeToken), 'ac_power');
      assert.equal((await command(session.sessionId, 'command', undefined, undefined, wake.wakeToken)).status, 409);
    });
    await t.test('verified named follow-up and errors carry proof; direct prompts cannot mint a wake token', async () => {
      prediction=wakePrediction('เอ็นจี้ปรับอุณหภูมิ');
      const followUp=await command(session.sessionId,'continuous');
      assert.equal(followUp.followUp,'temperature');assert.equal(followUp.wakeVerified,true);assert.ok(followUp.wakeToken);
      prediction=wakePrediction('เอ็นจี้สวัสดี');
      const unclear=await command(session.sessionId,'continuous');
      // No word boundary before สวัสดี. Even a confident spelling is ignored.
      assert.equal(unclear.ignored,true);assert.equal(unclear.feedback,undefined);
      prediction=wakePrediction('เอ็นจี้ สวัสดี');
      const named=await command(session.sessionId,'continuous');
      assert.equal(named.wakeVerified,true);assert.deepEqual(named.feedback.clips,['not-understood']);
      prediction=wakePrediction('เอ็นจี้ โหมดนอน');
      const unsupported=await command(session.sessionId,'continuous');
      assert.equal(unsupported.wakeVerified,true);assert.deepEqual(unsupported.feedback.clips,['unsupported']);
      prediction={accepted:true,engine:'LOCAL_WHISPER',transcript:'ปรับอุณหภูมิ'};
      const direct=await command(session.sessionId,'direct');
      assert.equal(direct.followUp,'temperature');assert.equal(direct.wakeToken,undefined);assert.equal(direct.wakeVerified,undefined);
    });
    await t.test('ready browser can start without Python and transcript/model routes require login', async () => {
      const offline = localVoice.start;
      localVoice.start = async () => { throw Object.assign(new Error('Python unavailable'), { status: 503 }); };
      try {
        assert.equal((await json('/api/voice-session', { device: 'room-a' })).status, 503);
        const browser = await json('/api/voice-session', { device: 'room-a', browserRecognition: true });
        assert.equal(browser.status, 200);
        assert.equal(browser.engine, 'LOCAL_BROWSER');
        assert.equal(browser.wakeWord, true);
        assert.equal((await transcript(browser.sessionId, ['เอ็นจี้', 'เอ็นจี้'])).wakeOnly, true);
      } finally { localVoice.start = offline; }

      const route = base + '/api/voice-transcript';
      const body = JSON.stringify({ sessionId: session.sessionId });
      const headers = { 'Content-Type': 'application/json' };
      assert.equal((await testFetch(route, { method: 'POST', headers: { ...headers, Origin: base }, body })).status, 401);
      assert.equal((await testFetch(route, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example', Cookie: cookie }, body })).status, 403);
      assert.equal((await testFetch(base + '/voice-model/typhoon-q4-v1/manifest.json')).status, 401);
      assert.equal((await fetchHttp(base + '/voice-model/typhoon-q4-v1/unknown.txt')).status, 404);
    });
    await t.test('matching literal browser transcripts reuse queries and AC mapping without invoking Python', async () => {
      const priorCalls = calls;
      const power = await transcript(session.sessionId, ['เอ็นจี้เปิดแอร์ให้ผมหน่อย', 'เอ็นจี้ เปิดแอร์ครับ']);
      assert.equal(power.wakeVerified, true);
      assert.equal(power.engine, 'LOCAL_BROWSER');
      assert.deepEqual(power.nextState, { power: true, temp: 24, mode: 2, fan: 2 });
      assert.deepEqual(power.feedback.clips, ['power-on']);
      const off = await transcript(session.sessionId, ['Hey Engi, turn off the AC.', 'Engi turn the AC off']);
      assert.equal(off.nextState.power, false);
      const query = await transcript(session.sessionId, ['เอ็นจี้ ตอนนี้กี่องศา', 'เอ็นจี้ อุณหภูมิห้องเท่าไหร่']);
      assert.equal(query.query, 'room_temperature');
      assert.equal(query.nextState, undefined);
      assert.equal(calls, priorCalls);
    });
    await t.test('uncertain or nonliteral browser results yield to PCM without locking the request', async () => {
      const priorCalls = calls;
      for (const candidates of [
        ['เปิดแอร์', 'เปิดแอร์'],
        ['เอ็นที่เปิดแอร์', 'เอ็นจี้เปิดแอร์'],
        ['Andy turn on AC', 'Engi turn on AC'],
        ['เอ็นจี้เปิดแอร์', 'เอ็นจี้ปิดแอร์'],
        ['เอ็นจี้เปิดแอร์', 'เอ็นจี้ไม่ต้องเปิดแอร์'],
        ['Engi open the door next to the AC', 'Engi open the door next to the AC'],
        ['เอ็นจี้เปิดประตูให้แอร์เข้าหน่อย', 'เอ็นจี้เปิดประตูให้แอร์เข้าหน่อย'],
        ['เอ็นจี้เปิดแอร์แล้วตั้ง 25 องศา', 'เอ็นจี้เปิดแอร์แล้วตั้ง 25 องศา'],
        ['เอ็นจี้เปิดแอร์'],
        ['เอ็นจี้เปิดแอร์', null]
      ]) {
        const response = await transcript(session.sessionId, candidates);
        assert.deepEqual(response, { status: 200, useServer: true }, JSON.stringify(candidates));
      }
      assert.equal(calls, priorCalls);
      assert.equal((await transcript(session.sessionId, ['เอ็นจี้', 'เอ็นจี้'], { device: 'room-b' })).status, 410);
      assert.equal((await transcript(session.sessionId, ['เอ็นจี้', 'เอ็นจี้'], { currentAc: { power: true, temp: 40 } })).status, 400);
      const requestId = 'request-browser-fallback-1111';
      const wake = await transcript(session.sessionId, ['เอ็นจี้', 'เอ็นจี้']);
      assert.ok(wake.wakeToken);
      const ticket = { sessionId: session.sessionId, device: 'room-a', wakeToken: wake.wakeToken };
      await json('/api/voice-session/arm', ticket);
      await json('/api/voice-session/claim', ticket);
      const declined = await transcript(session.sessionId, ['ยี่สิบห้าองศา', 'ยี่สิบหกองศา'], { stage: 'command', requestId, wakeToken: wake.wakeToken });
      assert.deepEqual(declined, { status: 200, useServer: true });
      prediction = wakePrediction('ยี่สิบห้าองศา');
      const fallback = await command(session.sessionId, 'command', requestId, undefined, wake.wakeToken);
      assert.equal(fallback.nextState.temp, 25);
      assert.equal(fallback.engine, 'LOCAL_WHISPER');
      assert.equal(calls, priorCalls + 1);
      assert.equal((await transcript(session.sessionId, ['25 องศา', 'ยี่สิบห้าองศา'], { stage: 'command', wakeToken: wake.wakeToken })).status, 409);
    });
    await t.test('accepted browser follow-up is one use and repeated request IDs are idempotent', async () => {
      const wake = await transcript(session.sessionId, ['เฮ้ เอ็นจี้', 'เอ็นจี้ครับ']);
      const ticket = { sessionId: session.sessionId, device: 'room-a', wakeToken: wake.wakeToken };
      assert.equal((await transcript(session.sessionId, ['25 องศา', 'ยี่สิบห้าองศา'], { stage: 'command', wakeToken: wake.wakeToken })).status, 409);
      await json('/api/voice-session/arm', ticket);
      await json('/api/voice-session/claim', ticket);
      const options = { stage: 'command', requestId: 'request-browser-consumed-1111', wakeToken: wake.wakeToken };
      const result = await transcript(session.sessionId, ['25 องศา', 'ยี่สิบห้าองศา'], options);
      assert.equal(result.nextState.temp, 25);
      assert.equal(result.engine, 'LOCAL_BROWSER');
      assert.deepEqual(await transcript(session.sessionId, ['25 องศา', 'ยี่สิบห้าองศา'], options), result);
      assert.equal((await transcript(session.sessionId, ['25 องศา', 'ยี่สิบห้าองศา'], { ...options, requestId: 'request-browser-replayed-1111' })).status, 409);
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
    global.fetch = testFetch; localVoice.classify = classify; localVoice.start = start;
    for (const id of voiceSessions.sessions.keys()) voiceSessions.cancel(id);
    server.closeAllConnections(); await new Promise(r => server.close(r));
    await rm(loginDirectory, { recursive: true, force: true });
  }
});

test('30 metadata classes map only to supported hardware commands', () => {
  const metadata = require('../models/ac_command_metadata.json');
  const current = { power: true, temp: 24, mode: 2, fan: 2 };
  const classify = (label, state = current) => commandFor({ label, accepted: true, confidence: 0.99, margin: 0.98 }, state);
  for (const entry of Object.values(metadata.classes)) {
    const result = classify(entry.class_name);
    const cmd = entry.mqtt_command;
    if (cmd === 'NONE') { assert.equal(result,null); continue; }
    const outOfRange = /^TEMP:\d+$/.test(cmd) && (Number(cmd.split(':')[1]) <21 || Number(cmd.split(':')[1])>27);
    if(outOfRange || /SWING|SLEEP/.test(cmd)) { assert.equal(result.unsupported,true,cmd); assert.equal(result.next,undefined); continue; }
    assert.ok(result.next,cmd);
    if(cmd.startsWith('FAN:')) { assert.equal(result.next.temp,24); assert.equal(result.next.mode,2); }
    if(cmd==='OFF') assert.deepEqual(result.next,{...current,power:false});
    if(/^TEMP:\d+$/.test(cmd)) assert.equal(result.next.temp,Number(cmd.split(':')[1]));
  }
  assert.equal(classify('02_TEMP_UP',{...current,temp:27}).next.temp,27);
  assert.equal(classify('03_TEMP_DOWN',{...current,temp:21}).next.temp,21);
  assert.equal(classify('02_TEMP_UP',{...current,power:null}).unsupported,true);
  assert.equal(classify('unknown'),null);
  assert.equal(commandFor({accepted:true,label:'00_POWER_ON',confidence:NaN,margin:1},current),null);
});
