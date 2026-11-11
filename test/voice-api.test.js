'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { wav } = require('../public/js/voice-audio');
const { app, voiceSessions, localVoice } = require('../server');
const { commandFor } = require('../offline-voice');

test('offline API: local inference, no external fetch, deduplication and rejection', async t => {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fetchHttp = global.fetch, classify = localVoice.classify, start = localVoice.start;
  localVoice.start = async () => {};
  global.fetch = () => { throw new Error('External fetch forbidden'); };
  const base = `http://127.0.0.1:${server.address().port}`;
  let calls = 0, prediction = { accepted: true, label: '00_POWER_ON', confidence: 0.99, margin: 0.98 };
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
    assert.equal(session.engine, 'LOCAL_WHISPER'); assert.equal(session.wakeWord, true);
    await t.test('command is evaluated once and repeated ID returns identical result', async () => {
      const a = await command(session.sessionId, 'direct', 'request-deduplicated-1111');
      const b = await command(session.sessionId, 'direct', 'request-deduplicated-1111');
      assert.deepEqual(a, b); assert.equal(calls, 1); assert.equal(a.success, true);
      assert.deepEqual(a.nextState, { power: true, temp: 24, mode: 2, fan: 2 });
      assert.deepEqual(a.feedback.clips, ['power-on']);
    });
    await t.test('name plus command executes directly without an extra greeting', async () => {
      prediction={accepted:true,engine:'LOCAL_WHISPER',transcript:'เอ็นจี้ปิดแอร์'}; const r = await command(session.sessionId, 'continuous');
      assert.equal(r.nextState.power, false); assert.equal(r.wakeOnly, undefined);
    });
    await t.test('background and uncertain output never produce a state change', async () => {
      for (const result of [{ accepted: false }, { accepted: true, label: '29_BACKGROUND', confidence: 1, margin: 1 }, { accepted: true, label: '00_POWER_ON', confidence: 0.6, margin: 0.5 }]) {
        prediction = result;
        const r = await command(session.sessionId); assert.equal(r.success, false); assert.equal(r.nextState, undefined);
        assert.equal((await command(session.sessionId, 'continuous')).ignored, true);
      }
    });
    await t.test('long continuous utterance explains the local recording limit without sending', async () => {
      prediction = {accepted:false,reason:'too_long'};
      const r = await command(session.sessionId,'continuous');
      assert.equal(r.success,false); assert.equal(r.ignored,true); assert.equal(r.nextState,undefined);
    });
    await t.test('unsupported commands respond with speech and no nextState in continuous mode', async () => {
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
      prediction.transcript='เอ็นจี้';assert.equal((await command(session.sessionId,'continuous')).wakeOnly,true);
      prediction.transcript='ไม่ต้องเปิดแอร์';assert.equal((await command(session.sessionId,'continuous')).success,false);
    });
    await t.test('continuous mode ignores commands without Engi; name ticket is one-shot and browser-bound', async () => {
      prediction={accepted:true,engine:'LOCAL_WHISPER',transcript:'เปิดแอร์ให้ผมหน่อย'};
      const unnamed=await command(session.sessionId,'continuous');assert.equal(unnamed.ignored,true);assert.equal(unnamed.nextState,undefined);
      prediction.transcript='เอนจี้';const wake=await command(session.sessionId,'continuous');assert.equal(wake.wakeOnly,true);assert.ok(wake.wakeToken);
      const other=await json('/api/voice-session',{device:'room-a'});
      assert.equal((await json('/api/voice-session/arm',{sessionId:other.sessionId,device:'room-a',wakeToken:wake.wakeToken})).status,409);
      const body={sessionId:session.sessionId,device:'room-a',wakeToken:wake.wakeToken};
      await json('/api/voice-session/arm',body);await json('/api/voice-session/claim',body);
      prediction.transcript='เปิดแอร์';
      const form=new FormData();for(const [k,v] of Object.entries({...body,stage:'command',requestId:'request-ticket-command-1111',currentAc:JSON.stringify({power:false,temp:24,mode:0,fan:3})}))form.append(k,v);form.append('audio',audio,'voice.wav');
      const response=await fetchHttp(base+'/api/voice-command',{method:'POST',body:form});const result=await response.json();assert.equal(result.success,true);
      assert.equal((await json('/api/voice-session/claim',body)).status,409);
      assert.equal((await command(session.sessionId,'continuous')).ignored,true);
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
    global.fetch = fetchHttp; localVoice.classify = classify; localVoice.start = start;
    for (const id of voiceSessions.sessions.keys()) voiceSessions.cancel(id);
    server.closeAllConnections(); await new Promise(r => server.close(r));
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
