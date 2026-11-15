'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { phrases, preloadKeys, describe, variant, answerQuestion } = require('../public/js/voice-feedback');
test('each spoken phrase has a nonempty bundled 24 kHz PCM audio file', () => {
  for (const key of Object.keys(phrases)) {
    const wav = fs.readFileSync(path.join(__dirname, '../public/audio/voice', key + '.wav'));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    const chunks = new Map();
    for (let p = 12; p + 8 <= wav.length;) {
      const bytes = wav.readUInt32LE(p + 4);
      assert.ok(p + 8 + bytes <= wav.length, key);
      chunks.set(wav.toString('ascii', p, p + 4), wav.subarray(p + 8, p + 8 + bytes));
      p += 8 + bytes + bytes % 2;
    }
    const fmt = chunks.get('fmt '), data = chunks.get('data');
    assert.equal(fmt.readUInt16LE(0), 1, key);
    assert.equal(fmt.readUInt16LE(2), 1, key);
    assert.equal(fmt.readUInt32LE(4), 24000, key);
    assert.equal(fmt.readUInt16LE(14), 16, key);
    assert.ok(data.length > 3600 && data.length % 2 === 0, key);
    let peak = 0;
    for (let i = 0; i < data.length; i += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
    assert.ok(peak > 120, key);
  }
});

test('feedback speaks requested values even if unchanged and supports every valid device value', () => {
 const current = { power: true, temp: 24, mode: 0, fan: 2 };
 for (let temp=21;temp<=27;temp++) assert.deepEqual(describe({...current,temp},current,['temp']).clips,[`temp-${temp}`]);
 for(let fan=0;fan<=3;fan++) assert.deepEqual(describe({...current,fan},current,['fan']).clips,[`fan-${fan}`]);
 for(let mode=0;mode<=2;mode++) assert.deepEqual(describe({...current,mode},current,['mode']).clips,[`mode-${mode}`]);
 assert.deepEqual(describe({...current,power:false},current,['power']).clips,['power-off']);
 assert.equal(describe({...current,temp:18}),null);
 assert.deepEqual(variant(describe(current,current,['power'])).clips,['power-on-alt']);
});

test('spoken readings match dashboard rounding and use the right Thai units', () => {
    assert.deepEqual(answerQuestion('room_temperature', 25.46), {
        text: 'อุณหภูมิห้องตอนนี้ 25.5 องศาเซลเซียสครับ',
        clips: ['answer-room-temperature', 'num-20', 'num-5', 'num-point', 'num-5', 'answer-degrees']
    });
    assert.deepEqual(answerQuestion('room_temperature', -9.25).clips,
        ['answer-room-temperature', 'num-minus', 'num-9', 'num-point', 'num-3', 'answer-degrees']);
    assert.deepEqual(answerQuestion('room_temperature', -0.01).clips, ['answer-room-temperature', 'num-0', 'answer-degrees']);
    assert.match(answerQuestion('room_temperature', 21).text, /21\.0/);
    assert.deepEqual(answerQuestion('ac_setpoint', 21).clips, ['answer-ac-setpoint', 'num-20', 'num-et', 'answer-degrees']);
    assert.deepEqual(answerQuestion('room_humidity', 99.5), {
        text: 'ความชื้นในห้องตอนนี้ 100 เปอร์เซ็นต์ครับ',
        clips: ['answer-room-humidity', 'num-100', 'answer-percent']
    });
});

test('people reports cover zero, Thai tens and hundreds, and one thousand with bundled clips', () => {
    const spokenNumber = n => answerQuestion('people_count', n).clips.slice(1, -1).map(key => phrases[key]).join('');
    assert.equal(spokenNumber(0), 'ศูนย์');
    assert.equal(spokenNumber(1), 'หนึ่ง');
    assert.equal(spokenNumber(11), 'สิบเอ็ด');
    assert.equal(spokenNumber(21), 'ยี่สิบเอ็ด');
    assert.equal(spokenNumber(101), 'หนึ่งร้อยเอ็ด');
    assert.equal(spokenNumber(211), 'สองร้อยสิบเอ็ด');
    assert.equal(spokenNumber(1000), 'หนึ่งพัน');
    assert.match(answerQuestion('people_count', 0).text, /ตรวจพบ 0 คน/);
    for (let n = 0; n <= 1000; n++) {
        assert.ok(spokenNumber(n), String(n));
        assert.ok(answerQuestion('people_count', n).clips.every(key => Object.hasOwn(phrases, key)), String(n));
    }
});

test('missing or invalid readings never become fabricated zero or OFF and new files load only on demand', () => {
    const queries = ['room_temperature', 'room_humidity', 'people_count', 'ac_setpoint', 'ac_power'];
    for (const query of queries) {
        for (const value of [null, undefined, NaN, '0']) assert.deepEqual(answerQuestion(query, value).clips, ['answer-unavailable']);
    }
    for (const [query, value] of [['room_temperature', -10.1], ['room_humidity', 100.01], ['people_count', 1001], ['people_count', .1], ['ac_setpoint', 0], ['ac_power', 0]]) {
        assert.deepEqual(answerQuestion(query, value).clips, ['answer-unavailable']);
    }
    assert.deepEqual(answerQuestion('ac_power', true).clips, ['answer-ac-on']);
    assert.deepEqual(answerQuestion('ac_power', false).clips, ['answer-ac-off']);
    assert.equal(answerQuestion('__proto__', 2), null);
    assert.equal(preloadKeys.length, 27);
    assert.ok(preloadKeys.includes('wake-ready'));
    assert.ok(preloadKeys.every(key => !/^(num|answer)-/.test(key)));
});
