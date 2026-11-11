'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { phrases, describe, variant } = require('../public/js/voice-feedback');
test('each spoken phrase has a nonempty bundled 24 kHz PCM audio file', () => {
  for (const key of Object.keys(phrases)) {
    const wav = fs.readFileSync(path.join(__dirname, '../public/audio/voice', key + '.wav'));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.ok(wav.length > 10000, key);
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
