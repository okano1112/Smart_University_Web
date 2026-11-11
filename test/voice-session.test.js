'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceSessions, validAc } = require('../voice-session');
test('same request executes once; another concurrent request is rejected', async () => {
  const sessions = new VoiceSessions(); const session = sessions.get(sessions.create('a'), 'a');
  let release, calls = 0;
  const operation = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = sessions.run(session, 'request-111111111111', operation);
  const duplicate = sessions.run(session, 'request-111111111111', operation);
  await Promise.resolve();
  await assert.rejects(sessions.run(session, 'request-222222222222', operation), /ก่อนหน้า/);
  release({ success: true });
  assert.deepEqual(await first, await duplicate); assert.equal(calls, 1);
  await sessions.run(session, 'request-111111111111', operation); assert.equal(calls, 1);
});
test('cancel aborts running work and invalidates its session', async () => {
  const sessions = new VoiceSessions(); const id = sessions.create('a'), session = sessions.get(id, 'a');
  const promise = sessions.run(session, 'request-111111111111', signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
  }));
  await Promise.resolve(); sessions.cancel(id);
  await assert.rejects(promise, /cancelled/); assert.throws(() => sessions.get(id, 'a'));
});
test('session capacity and stale session cleanup bound memory', () => {
  let now = 0; const sessions = new VoiceSessions({ now: () => now, limit: 1 });
  sessions.create('a'); assert.throws(() => sessions.create('b'));
  now = 31 * 60_000; assert.ok(sessions.create('b'));
});
test('command schema rejects string booleans, missing values and out-of-range values', () => {
  const good = { power: true, temp: 24, mode: 0, fan: 3 };
  assert.ok(validAc(good));
  for (const bad of [{ power: 'false' }, { temp: 24.5 }, { temp: 28 }, { mode: '0' }, { fan: 4 }, { power: undefined }]) assert.equal(validAc({ ...good, ...bad }), false);
});

test('sessions cannot be used with another MQTT destination', () => {
 const sessions = new VoiceSessions(); const id = sessions.create('room-a');
 assert.throws(() => sessions.get(id, 'room-b')); assert.ok(sessions.get(id, 'room-a'));
});

test('wake tickets require arm then claim, expire, and cannot be replayed',()=>{
 let now=1000;const sessions=new VoiceSessions({now:()=>now});const session=sessions.get(sessions.create('a'),'a');
 let token=sessions.issueWake(session);assert.throws(()=>sessions.claim(session,token));
 now+=15001;assert.throws(()=>sessions.arm(session,token));token=sessions.issueWake(session);
 sessions.arm(session,token);now+=9001;assert.throws(()=>sessions.claim(session,token));
 token=sessions.issueWake(session);sessions.arm(session,token);sessions.claim(session,token);assert.throws(()=>sessions.claim(session,token));
 sessions.consume(session,token);assert.throws(()=>sessions.consume(session,token));
});
