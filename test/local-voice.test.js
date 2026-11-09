'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalVoice } = require('../offline-voice');
const { wav } = require('../public/js/voice-audio');

test('real local TFLite worker: command fixtures, silence, invalid audio, cancellation and recovery', { timeout: 100000 }, async () => {
  const worker = new LocalVoice();
  try {
    await worker.start();
    const signal = new AbortController().signal;
    for (const [file, label] of [['on.wav', '0_ON'], ['off.wav', '1_OFF']]) {
      const data = fs.readFileSync(path.join(__dirname, 'fixtures/local-voice', file));
      const result = await worker.classify(data, signal);
      assert.equal(result.accepted, true); assert.equal(result.label, label);
      // The browser WAV encoder must preserve the training waveform including DC/padding.
      const pcm = new Float32Array((data.length - 44) / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(44 + i * 2) / 32768;
      const encoded = Buffer.from(await (await wav(pcm)).arrayBuffer());
      assert.deepEqual(encoded, data);
      assert.equal((await worker.classify(encoded, signal)).label, label);
    }
    const silent = Buffer.from(await (await wav(new Float32Array(24000))).arrayBuffer());
    assert.equal((await worker.classify(silent, signal)).reason, 'silence');
    await assert.rejects(worker.classify(Buffer.from('not a wav'), signal), error => error.status === 400);
    const cancel = new AbortController(); cancel.abort();
    await assert.rejects(worker.classify(silent, cancel.signal));
    assert.equal((await worker.classify(silent, signal)).accepted, false);
  } finally { worker.close(); }
});
