'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Recognizer = require('../public/js/voice-local-recognizer');

function fixture(overrides = {}) {
    const workers = [];
    class Worker {
        constructor(url) { this.url = url; workers.push(this); }
        postMessage(data) { this.request = data; }
        terminate() { this.terminated = true; }
        reply(data) { this.onmessage({ data }); }
    }
    const recognizer = new Recognizer({
        Worker, navigator: {},
        fetch: async () => Response.json({ id: 'typhoon-q4-v1', schemaVersion: 1 }),
        ...overrides
    });
    return { recognizer, workers };
}

test('unavailable model and small or metered devices preserve the server path', async () => {
    for (const overrides of [
        { fetch: async () => new Response('Not found', { status: 404 }) },
        { fetch: async () => new Response('<html>Login required</html>', { headers: { 'Content-Type': 'text/html' } }) },
        { fetch: async () => Response.json({ id: 'other-model', schemaVersion: 1 }) },
        { navigator: { deviceMemory: 2 } },
        { navigator: { connection: { saveData: true } } },
        { navigator: { connection: { effectiveType: '2g' } } },
        { Worker: undefined }
    ]) {
        const { recognizer, workers } = fixture(overrides);
        await recognizer.prepare();
        assert.equal(recognizer.ready, false);
        assert.equal(workers.length, 0);
        assert.equal(await recognizer.recognize(new Float32Array(32000)), null);
        recognizer.close();
    }
});

test('worker initializes once and inference preserves the original recording', async () => {
    const { recognizer, workers } = fixture();
    try {
        await recognizer.prepare(); await recognizer.prepare();
        assert.equal(workers.length, 1);
        const [worker] = workers;
        assert.equal(worker.url, '/js/voice-local-worker.js');
        assert.deepEqual(worker.request, { type: 'init' });
        assert.equal(recognizer.ready, false);
        worker.reply({ type: 'ready' });
        const samples = new Float32Array(16000).fill(.1);
        const pending = recognizer.recognize(samples);
        assert.notEqual(worker.request.samples, samples);
        assert.deepEqual(worker.request.samples, samples);
        assert.equal(recognizer.canRecognize(samples), false);
        const transcripts = ['เอ็นจี้เปิดแอร์', 'เอ็นจี้ เปิดแอร์'];
        worker.reply({ type: 'result', id: worker.request.id, transcripts });
        assert.deepEqual(await pending, transcripts);
        assert.equal(recognizer.canRecognize(samples), true);
        assert.equal(recognizer.canRecognize(new Float32Array(80001)), false);
    } finally { recognizer.close(); }
});

test('a cancelled request cannot overlap the still-running inference', async () => {
    const { recognizer, workers } = fixture();
    await recognizer.prepare();
    const [worker] = workers;
    worker.reply({ type: 'ready' });
    const signal = new AbortController();
    const samples = new Float32Array(16000);
    const pending = recognizer.recognize(samples, signal.signal);
    const id = worker.request.id;
    signal.abort();
    assert.equal(await pending, null);
    assert.equal(recognizer.canRecognize(samples), false);
    worker.reply({ type: 'result', id, transcripts: ['เอ็นจี้', 'เอ็นจี้'] });
    assert.equal(recognizer.canRecognize(samples), true);
    recognizer.close();
    worker.reply({ type: 'ready' });
    assert.equal(recognizer.ready, false);
});

test('slow or failed client inference terminates the worker for a bounded fallback', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { recognizer, workers } = fixture();
    await recognizer.prepare();
    const [worker] = workers;
    worker.reply({ type: 'ready' });
    const pending = recognizer.recognize(new Float32Array(16000));
    t.mock.timers.tick(1800);
    assert.equal(await pending, null);
    assert.equal(worker.terminated, true);
    assert.equal(recognizer.ready, false);
});

test('stop releases initialization and pending jobs', async () => {
    let complete;
    const { recognizer, workers } = fixture({
        fetch: () => new Promise(resolve => { complete = resolve; })
    });
    const loading = recognizer.prepare();
    recognizer.close();
    complete(Response.json({ id: 'typhoon-q4-v1', schemaVersion: 1 }));
    await loading;
    assert.equal(workers.length, 0);
    assert.equal(recognizer.ready, false);
});
