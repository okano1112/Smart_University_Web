'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceSessions, detectAndStripWakeWord, validAc, ambiguousSpeech } = require('../voice-session');

for (const name of ['Engi', 'เอ็นจี้', 'เอ็นจี', 'เฮ้ เอ็นจี้', 'Engi!', 'เอ็นจี้ครับ', 'เอ็นจี้ค่ะ', 'เอ็นจี้ครับ.', 'เอ็นจี้ ครับ!', 'Hey Engi', 'hey engi!', 'HEY ENGI', 'Hey, Engi', 'เฮ้เอ็นจี้', 'เฮ้ เอ็นจี้', 'หวัดดีเอ็นจี้']) {
  test(`wake-only: ${name}`, () => assert.deepEqual(detectAndStripWakeWord(name), { hasWakeWord: true, commandText: '' }));
}
for (const [text, command] of [['เอ็นจี้เปิดแอร์', 'เปิดแอร์'], ['Engi เปิดแอร์', 'เปิดแอร์'], ['เฮเอ็นจี้ปรับแอร์เป็น 23 องศา', 'ปรับแอร์เป็น 23 องศา'], ['เอ็นจี้ช่วยปิดแอร์', 'ปิดแอร์'], ['Hey Engi เปิดแอร์ให้ผมหน่อย', 'เปิดแอร์ให้ผมหน่อย'], ['เฮ้เอ็นจี้เปิดแอร์', 'เปิดแอร์']]) {
  test(`wake and command: ${text}`, () => assert.deepEqual(detectAndStripWakeWord(text), { hasWakeWord: true, commandText: command }));
}
for (const text of ['คิม เปิดแอร์', 'วิน', 'film', 'tim', 'engibo', 'มีคนชื่อเอ็นจี้', 'เอ็นจี้าน', 'beamforming', 'คุยกับเอ็นจี้ เปิดแอร์', 'Hey engibo', 'hey คิม', 'Hibernation', 'hey beamforming']) {
  test(`do not wake: ${text}`, () => assert.equal(detectAndStripWakeWord(text).hasWakeWord, false));
}
test('wake readiness is isolated per browser and device, and starts at arm', () => {
  let now = 1000;
  const sessions = new VoiceSessions({ now: () => now });
  const first = sessions.get(sessions.create('device-a'), 'device-a');
  const second = sessions.get(sessions.create('device-a'), 'device-a');
  const token = sessions.wake(first);
  now += 7000; sessions.arm(first, token);
  assert.throws(() => sessions.claim(second, token));
  assert.throws(() => sessions.get([...sessions.sessions.keys()][0], 'device-b'));
  now += 7999; sessions.claim(first, token);
  now += 12000; sessions.consume(first, token); // finishing after the listening window is valid
  assert.throws(() => sessions.consume(first, token));
});
test('wake expiry, unarmed token, duplicate arm and claim reject', () => {
  let now = 0; const sessions = new VoiceSessions({ now: () => now });
  const session = sessions.get(sessions.create('a'), 'a'), token = sessions.wake(session);
  assert.throws(() => sessions.claim(session, token));
  sessions.arm(session, token); assert.throws(() => sessions.arm(session, token));
  now = 8001; assert.throws(() => sessions.claim(session, token));
  const next = sessions.wake(session); sessions.arm(session, next); sessions.claim(session, next);
  assert.throws(() => sessions.claim(session, next));
});
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
test('negation and conflicting commands are never executed', () => {
  for (const speech of ['อย่าเปิดแอร์', 'ไม่ต้องปรับแอร์ 24', 'ยังไม่เปิด', 'เปิดแอร์แล้วปิดแอร์', 'ไม่ เปิด แอร์', 'ไม่ปรับแอร์ 24 องศา', 'ไม่เพิ่มอุณหภูมิ']) assert.ok(ambiguousSpeech(speech), speech);
  for (const speech of ['เปิดแอร์', 'ปิดแอร์', 'แอร์ไม่เย็น', 'เอ็นจี้ ตั้ง 24']) assert.equal(ambiguousSpeech(speech), false, speech);
});

test('Engi replaces the previous name without matching engineer or engineering', () => {
  for (const name of ['Bim', 'บิม', 'บีม', 'beam', 'engineer', 'engineering', 'Engines']) assert.equal(detectAndStripWakeWord(name + ' เปิดแอร์').hasWakeWord, false);
  for (const name of ['Engi', 'เอ็นจี้', 'เอ็นจี', 'เอนจี้']) assert.deepEqual(detectAndStripWakeWord(name + ' close AC'), { hasWakeWord: true, commandText: 'close AC' });
});
test('English and mixed negations and conflicts are rejected', () => {
  for (const speech of ["don't open AC", 'do not close AC', 'never turn on AC', 'open and close AC', 'turn on AC แล้วปิดแอร์', 'turn AC on and turn AC off']) assert.equal(ambiguousSpeech(speech), true, speech);
});
