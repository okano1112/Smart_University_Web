'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { phrases, describe } = require('../public/js/voice-feedback');
const { parseWithDictionaryAndRules: parse, normalizeAndRepairThaiText: normalize, extractCoreThaiMeaning: core, loadIntentDictionary } = require('../server');
const current = { power: true, temp: 24, mode: 2, fan: 2 };
const dictionary = loadIntentDictionary();
function command(text, state = current) { const normalized = normalize(text); return parse(normalized, core(normalized), state, dictionary); }
for (const [speech, fan] of [
  ['ปรับพัดลม กลาง', 2], ['ปรับพัดลม ปานกลาง', 2], ['ปรับพัดลม แรง', 3], ['ปรับพัดลม เบา', 1],
  ['ปรับพัดลมให้แรง', 3], ['ปรับพัดลมเป็นระดับกลาง', 2], ['เพิ่มพัดลมเป็นกลาง', 2],
  ['เบาลมลงหน่อย', 1], ['ลดพัดลมหน่อย', 1], ['เพิ่มพัดลมหน่อย', 3], ['เพิ่มลมหน่อย', 3],
  ['พัดลมแรงขึ้นหน่อย', 3], ['ปรับพัดลมให้เบาลง', 1], ['ปรับพัดลมให้แรงขึ้น', 3],
  ['ปรับพัดลมอัตโนมัติ', 0], ['พัดลมเบอร์สอง', 2]
]) test(`fan command without unintended temperature/mode change: ${speech}`, () => {
  const result = command(speech); assert.equal(result.matched, true); assert.equal(result.next.fan, fan);
  assert.equal(result.next.temp, 24); assert.equal(result.next.mode, 2);
  assert.deepEqual(result.fields, ['fan']);
  assert.deepEqual(describe(result.next, current, result.fields).clips, [`fan-${fan}`]);
});
test('relative fan speeds step once, clamp at boundaries and resolve AUTO predictably', () => {
  for (const [fan, speech, expected] of [[3, 'เบาลมลงหน่อย', 2], [1, 'เบาลมลง', 1], [3, 'เพิ่มพัดลม', 3], [0, 'เพิ่มพัดลม', 3], [0, 'ลดพัดลม', 1]]) {
    assert.equal(command(speech, { ...current, fan }).next.fan, expected);
  }
});
test('fan numbers never become relative temperature adjustments', () => {
  const result = command('เพิ่มพัดลมอีก 1 ระดับ');
  assert.equal(result.next.fan, 3); assert.equal(result.next.temp, 24);
});
test('combined temperature and fan command speaks both requested values', () => {
  const result = command('ปรับ 27 องศา พัดลมกลาง');
  assert.equal(result.next.temp, 27); assert.equal(result.next.fan, 2);
  assert.deepEqual(describe(result.next, current, result.fields).clips, ['temp-27', 'fan-2']);
});
test('repeating a temperature already set still speaks the requested temperature', () => {
  const result = command('ตั้ง 24 องศา');
  assert.equal(describe(result.next, current, result.fields).text, 'ตั้งอุณหภูมิ 24 องศาครับ');
});
test('each spoken phrase has a nonempty bundled 24 kHz PCM audio file', () => {
  for (const key of Object.keys(phrases)) {
    const wav = fs.readFileSync(path.join(__dirname, '../public/audio/voice', key + '.wav'));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.ok(wav.length > 10000, key);
  }
});

for (const [power, utterances] of [[true, ['เปิด', 'เปิด แอร์', 'ช่วยเปิดแอร์ให้ผมหน่อย', 'open', 'open air conditioner', 'please turn on the AC', 'switch the AC on', 'power on']], [false, ['ปิด', 'ปิด แอร์', 'ช่วยปิดแอร์ให้ผมหน่อย', 'close', 'close air conditioner', 'turn off the AC', 'switch the AC off', 'shut down the aircon']]]) {
  for (const speech of utterances) test(`explicit power preserves settings: ${speech}`, () => {
    for (const previous of [true, false, null]) {
      const state = { ...current, power: previous };
      const result = command(speech, state);
      assert.equal(result.matched, true);
      assert.deepEqual(result.next, { ...state, power });
      assert.deepEqual(describe(result.next, state, result.fields).clips, [power ? 'power-on' : 'power-off']);
    }
  });
}
test('normalizer does not guess unrelated words as power commands', () => {
  for (const speech of ['เป็ดแอร์', 'เกิดแอร์', 'ผิดแอร์', 'open the door', 'close the window']) {
    assert.doesNotMatch(normalize(speech), /เปิดแอร์|ปิดแอร์/);
  }
});
