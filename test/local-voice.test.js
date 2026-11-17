'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalVoice } = require('../offline-voice');
const { wav } = require('../public/js/voice-audio');

test('a server missing the configured Python interpreter reports a setup error', async () => {
  const worker = new LocalVoice();
  const original = process.env.VOICE_PYTHON;
  process.env.VOICE_PYTHON = path.join(__dirname, 'nonexistent-python');
  try {
    await assert.rejects(worker.start(), { status: 503, message: 'เซิร์ฟเวอร์ไม่พบ Python สำหรับระบบเสียง' });
    assert.equal(worker.child, null);
  } finally {
    if (original === undefined) delete process.env.VOICE_PYTHON;
    else process.env.VOICE_PYTHON = original;
    worker.close();
  }
});

test('closing a worker during boot releases all readiness waits and permits a clean restart', { timeout: 100000 }, async () => {
  const worker = new LocalVoice({ engine: 'tflite' });
  try {
    const starting = worker.start();
    const waiting = worker.classify(Buffer.from('voice'));
    const other = worker.classify(Buffer.from('other'));
    const queued = Promise.all([assert.rejects(waiting, { status: 503 }), assert.rejects(other, { status: 503 })]);
    // A cold restart must obey the same queue limit as a warm worker.
    await assert.rejects(worker.classify(Buffer.from('overflow')), { status: 503 });
    const closed = assert.rejects(starting, { status: 503 });
    worker.close();
    await Promise.all([closed, queued]);
    await worker.start();
    assert.ok(worker.child);
  } finally { worker.close(); }
});

test('real local TFLite worker: command fixtures, silence, invalid audio, cancellation and recovery', { timeout: 100000 }, async () => {
  const worker = new LocalVoice({engine:'tflite'});
  try {
    await worker.start();
    const signal = new AbortController().signal;
    for (const [file, label] of [['on.wav', '00_POWER_ON'], ['off.wav', '01_POWER_OFF'], ['temp25.wav', '11_SET_25']]) {
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
    const silent = Buffer.from(await (await wav(new Float32Array(32000))).arrayBuffer());
    assert.equal((await worker.classify(silent, signal)).reason, 'silence');
    await assert.rejects(worker.classify(Buffer.from('not a wav'), signal), error => error.status === 400);
    const cancel = new AbortController(); cancel.abort();
    await assert.rejects(worker.classify(silent, cancel.signal));
    assert.equal((await worker.classify(silent, signal)).accepted, false);
  } finally { worker.close(); }
});

test('aborted queued speech is never sent to Python and frees capacity for the next capture', { timeout: 100000 }, async t => {
  const worker = new LocalVoice({ engine: 'tflite' });
  try {
    await worker.start();
    const { stdin, stdout } = worker.child;
    const writes = [];
    t.mock.method(stdin, 'write', chunk => { writes.push(JSON.parse(chunk)); return true; });
    const nextTurn = () => new Promise(resolve => setImmediate(resolve));
    const first = worker.classify(Buffer.from('first'));
    const queuedController = new AbortController();
    const queued = worker.classify(Buffer.from('queued'), queuedController.signal);
    const canceled = assert.rejects(queued, { name: 'AbortError' });
    await nextTurn();
    assert.equal(writes.length, 1);
    await assert.rejects(worker.classify(Buffer.from('occupied')), { status: 503 });
    queuedController.abort();
    await canceled;
    const next = worker.classify(Buffer.from('next'));
    await nextTurn();
    assert.equal(writes.length, 1);
    stdout.emit('data', `${JSON.stringify({ id: writes[0].id, accepted: true })}\n`);
    assert.equal((await first).accepted, true);
    assert.deepEqual(writes.map(request => Buffer.from(request.audio, 'base64').toString()), ['first', 'next']);
    stdout.emit('data', `${JSON.stringify({ id: writes[1].id, accepted: true })}\n`);
    assert.equal((await next).accepted, true);
  } finally { worker.close(); }
});
