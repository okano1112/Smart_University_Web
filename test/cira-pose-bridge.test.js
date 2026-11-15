'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { buildFlow } = require('../node-red/build-flow');
const { httpNodeMiddleware } = require('../node-red/settings');

function fixture() {
    const nodes = buildFlow();
    const post = nodes.find(n => n.type === 'http in' && n.url === '/cira-pose-frame');
    const get = nodes.find(n => n.type === 'http in' && n.url === '/cira-activity');
    const writer = nodes.find(n => n.id === post.wires[0][0]);
    const reader = nodes.find(n => n.id === get.wires[0][0]);
    const expire = nodes.find(n => n.type === 'inject' && n.props.some(p => p.p === '_poseExpiry'));
    const state = new Map();
    let clock = Date.parse('2026-11-14T08:00:00Z');
    const sandbox = vm.createContext({ flow: { get: key => state.get(key), set: (key, value) => state.set(key, value) },
        Date: class extends Date { static now() { return clock; } }, Buffer });
    vm.runInContext(writer.initialize, sandbox);
    const execute = (node, msg) => {
        sandbox.msg = msg;
        const value = vm.runInContext(`(function(msg){${node.func}\n})(msg)`, sandbox);
        return value && JSON.parse(JSON.stringify(value));
    };
    const req = (headers, address) => ({ socket: { remoteAddress: address || '127.0.0.1' }, headers });
    const read = () => execute(reader, { req: req({}) });
    const send = (payload, headers = {}, address) => execute(writer, { req: req({ 'content-type': 'application/json', ...headers }, address), payload });
    return { post, get, expire, writer, reader, nodes, read, snapshot: () => JSON.parse(read().payload), send, state,
        tick: () => execute(writer, { _poseExpiry: true }), advance: ms => { clock += ms; }, now: () => clock };
}

function poseFrame(h, people = []) { return { captured_at: h.now(), width: 640, height: 480, people }; }

test('pose nodes expose only localhost aggregate HTTP and have no wire to MQTT or command output', () => {
    const h = fixture();
    assert.equal(h.post.method, 'post'); assert.equal(h.get.method, 'get');
    assert.equal(h.reader.wires[0][0], h.writer.wires[0][0]);
    assert.equal(h.nodes.find(n => n.id === h.reader.wires[0][0]).type, 'http response');
    assert.deepEqual(h.expire.wires, [[h.writer.id]]);
    assert.equal(h.nodes.filter(n => n.type === 'mqtt in').length, 1);
    assert.equal(h.nodes.filter(n => n.type === 'mqtt out').length, 1);
    assert.deepEqual(h.snapshot(), { source: 'cira', serverTime: h.now(), lastReceivedAt: null,
        stale: true, activity: null, activityWindow: [], events: [] });
    assert.equal(h.read().headers['cache-control'], 'no-store');
    const peer = '192.0.2.1';
    assert.equal(h.send(poseFrame(h), { 'x-forwarded-for': '127.0.0.1' }, peer).statusCode, 403);
    assert.equal(h.send(poseFrame(h), { origin: 'https://unrelated.test' }).statusCode, 403);
    assert.equal(h.send(poseFrame(h), { 'sec-fetch-site': 'same-origin' }).statusCode, 403);
    assert.equal(h.send(poseFrame(h), { 'content-type': 'text/plain' }).statusCode, 415);
    assert.equal(h.send(poseFrame(h), { 'content-length': 200000 }).statusCode, 413);
    assert.equal(h.send({ ...poseFrame(h), oversized: 'x'.repeat(140000) }).statusCode, 413);
});

test('valid pose flows through embedded classifier, with no raw keypoints or IDs in response or logs', () => {
    const h = fixture();
    const body = poseFrame(h, [{ id: 'PRIVATE_TRACK_ID', keypoints: Array.from({ length: 17 }, () => ({ x: .44, y: .43, score: .01 })) }]);
    const result = h.send(body);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.payload), { ok: true });
    const snapshot = h.snapshot();
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.lastReceivedAt, h.now());
    assert.deepEqual(snapshot.activity, { captured_at: h.now(), total_people: 1, seated: 0, standing: 0, walking: 0, running: 0, unknown: 1 });
    assert.deepEqual(snapshot.events.map(e => e.stage), ['received', 'classified']);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_TRACK_ID|keypoints|0\.44|0\.43/);
});

test('rejection cannot replace accepted aggregate; stale state is cleared once and duplicate timestamps remain invalid', () => {
    const h = fixture();
    const first = poseFrame(h);
    assert.equal(h.send(first).statusCode, 200);
    h.advance(100);
    assert.equal(h.send(first).statusCode, 400);
    assert.equal(h.send({ ...poseFrame(h), width: 8 }).statusCode, 400);
    assert.equal(h.send({ ...poseFrame(h), captured_at: h.now() - 6000 }).statusCode, 400);
    assert.equal(h.snapshot().activity.captured_at, first.captured_at);
    assert.equal(h.snapshot().events.filter(e => e.stage === 'rejected').length, 1);
    h.advance(5001);
    assert.equal(h.tick(), null);
    assert.equal(h.tick(), null);
    const old = h.snapshot();
    assert.equal(old.stale, true); assert.equal(old.activity, null);
    assert.deepEqual(old.activityWindow, []);
    assert.equal(old.events.filter(e => e.stage === 'stale').length, 1);
    assert.equal(h.send(first).statusCode, 400);
    assert.equal(h.send(poseFrame(h)).statusCode, 200);
});

test('aggregate evidence is sampled to 1 Hz, bounded, and reset after camera or receipt gap', () => {
    const h = fixture();
    for (let i = 0; i < 61; i++) {
        assert.equal(h.send(poseFrame(h)).statusCode, 200);
        h.advance(500);
    }
    let snapshot = h.snapshot();
    assert.equal(snapshot.activityWindow.length, 31);
    assert.ok(snapshot.events.length <= 20);
    h.advance(500);
    for (let i = 0; i < 20; i++) {
        assert.equal(h.send(poseFrame(h)).statusCode, 200);
        h.advance(1000);
    }
    snapshot = h.snapshot();
    assert.equal(snapshot.activityWindow.length, 36);
    assert.equal(snapshot.activityWindow.at(-1).captured_at - snapshot.activityWindow[0].captured_at, 35000);
    h.advance(2800);
    assert.equal(h.send(poseFrame(h)).statusCode, 200);
    assert.equal(h.snapshot().activityWindow.length, 1);
});

test('Node-RED middleware bounds and parses only the pose ingress without logging malformed data', async () => {
    const invoke = (body, extra = {}, path = '/cira-pose-frame', method = 'POST') => new Promise(resolve => {
        const bytes = Buffer.from(body);
        const req = Object.assign(Readable.from([bytes]), { path, method, socket: { remoteAddress: '127.0.0.1' },
            headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': `${bytes.length}`, ...extra } });
        let status;
        const res = { status(code) { status = code; return this; }, set() { return this; }, json(data) { resolve({ status, data }); } };
        httpNodeMiddleware(req, res, () => resolve({ status: 200, body: req.body }));
    });
    assert.deepEqual(await invoke('{"people":[]}'), { status: 200, body: { people: [] } });
    assert.deepEqual(await invoke('{ PRIVATE_BROKEN_JSON'), { status: 400, data: { ok: false, code: 'INVALID_JSON' } });
    assert.deepEqual(await invoke('[]', { 'content-length': '140000' }), { status: 413, data: { ok: false, code: 'TOO_LARGE' } });
    assert.deepEqual(await invoke('[]', { 'content-length': undefined, 'transfer-encoding': 'chunked' }), { status: 411, data: { ok: false, code: 'LENGTH_REQUIRED' } });
    assert.deepEqual(await invoke('[]', { 'content-encoding': 'gzip' }), { status: 415, data: { ok: false, code: 'CONTENT_TYPE' } });
    assert.deepEqual(await invoke('[]', { origin: 'https://elsewhere.invalid' }), { status: 403, data: { ok: false, code: 'LOCAL_ONLY' } });
    assert.deepEqual(await invoke('not JSON', {}, '/some-unrelated-route'), { status: 200, body: undefined });
});
