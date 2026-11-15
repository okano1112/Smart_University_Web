'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { buildFlow } = require('../node-red/build-flow');

function fixture(overrides = {}) {
    const nodes = buildFlow(), inputNode = nodes.find(n => n.type === 'mqtt in');
    const functionNode = nodes.find(n => n.id === inputNode.wires[0][0]);
    const httpNode = nodes.find(n => n.type === 'http in' && n.url === '/cira-observability');
    const readNode = nodes.find(n => n.id === httpNode.wires[0][0]);
    const memory = new Map(), shared = new Map(), statuses = [];
    const env = Object.fromEntries(nodes.find(n => n.type === 'tab').env.map(e => [e.name, e.value]));
    Object.assign(env, overrides);
    let now = Date.parse('2026-11-12T10:00:00Z');
    const sandbox = { context: { get: key => memory.get(key), set: (key, value) => memory.set(key, value) },
        flow: { get: key => shared.get(key), set: (key, value) => shared.set(key, value) },
        env: { get: key => env[key] }, node: { status: s => statuses.push(s) },
        Date: class extends Date { static now() { return now; } } };
    vm.runInNewContext(functionNode.initialize, sandbox);
    const execute = (node, msg) => JSON.parse(JSON.stringify(vm.runInNewContext(`(function(msg){${node.func}\n})(msg)`, { ...sandbox, msg })));
    const run = msg => execute(functionNode, msg);
    const http = (remoteAddress = '127.0.0.1', headers = {}) => execute(readNode, { req: { socket: { remoteAddress }, headers } });
    const logs = () => JSON.parse(http().payload);
    return { run, http, logs, statuses, memory, advance: ms => now += ms, now: () => now };
}

test('importable flow forwards the user CiRA payload to web telemetry only', () => {
    const flow = buildFlow(), h = fixture();
    assert.deepEqual(JSON.parse(fs.readFileSync('node_red_cira_bridge_flow.json', 'utf8')), flow);
    assert.equal(flow.find(n => n.type === 'mqtt in').topic, 'spu/classroom/room/person');
    assert.equal(flow.find(n => n.type === 'mqtt-broker').broker, 'broker.emqx.io');
    const result = h.run({ topic: 'spu/classroom/room/person', payload: '{"total_people":2}', retain: false });
    assert.equal(result[0].topic, 'spu/classroom/cira');
    assert.equal(result[0].retain, false); assert.equal(result[0].qos, 0);
    const body = JSON.parse(result[0].payload);
    assert.equal(body.total_people, 2); assert.equal(body.timestamp, h.now());
    assert.equal(body.source, 'cira-core'); assert.equal(h.memory.get('lastValidAt'), h.now());
    assert.equal(Object.hasOwn(body, 'POWER'), false);
});

test('retained, malformed and old messages cannot overwrite the live count', () => {
    const h = fixture();
    for (const msg of [
        { payload: '{"total_people":99}', retain: true }, { payload: '{"total_people":false}' },
        { payload: '{"total_people":-1}' }, { payload: '{broken' },
        { payload: JSON.stringify({ total_people: 2, timestamp: h.now() - 31000 }) }
    ]) {
        const result = h.run({ topic: 'spu/classroom/room/person', ...msg });
        assert.equal(result[0], null); assert.equal(result[1].payload.event, 'cira_rejected');
        h.advance(1000);
    }
    assert.equal(h.memory.get('lastValidAt'), 0);
    assert.equal(JSON.parse(h.run({ topic: 'spu/classroom/room/person', payload: '{"total_people":0}' })[0].payload).total_people, 0);
});

test('watchdog reports stale once without republishing old counts', () => {
    const h = fixture();
    h.run({ topic: 'spu/classroom/room/person', payload: '{"total_people":2}' });
    h.advance(31000);
    const stale = h.run({ _ciraWatchdog: true });
    assert.equal(stale[0], null); assert.equal(stale[1].payload.event, 'cira_stale');
    assert.equal(h.run({ _ciraWatchdog: true }), null);
    assert.equal(h.statuses.at(-1).fill, 'red');
    h.run({ topic: 'spu/classroom/room/person', payload: '{"total_people":3}' });
    assert.equal(h.statuses.at(-1).fill, 'green');
});

test('manual format test publishes nothing and does not pretend CiRA is live', () => {
    const h = fixture();
    const result = h.run({ topic: 'local-test', _ciraTest: true, payload: { total_people: 2 } });
    assert.equal(result[0], null); assert.equal(result[1].payload.event, 'cira_test_only');
    assert.equal(h.memory.get('lastValidAt'), 0);
});

test('matching input/output topics are rejected before forwarding', () => {
    const h = fixture({ CIRA_OUTPUT_TOPIC: 'spu/classroom/room/person' });
    const result = h.run({ topic: 'spu/classroom/room/person', payload: { total_people: 2 } });
    assert.equal(result[0], null); assert.equal(result[1].payload.code, 'topic_loop');
});

test('zero confidence threshold remains a valid numeric flow setting', () => {
    const h = fixture({ CIRA_MIN_CONFIDENCE: 0 });
    const result = h.run({ topic: 'spu/classroom/room/person', payload: { detections: [{ label: 'person', score: 0 }] } });
    assert.equal(JSON.parse(result[0].payload).total_people, 1);
});

test('local logs correlate receive, validation and MQTT output without changing telemetry', () => {
    const h = fixture();
    const payload = { total_people: 2, captured_at: h.now(), secretMarker: 'raw-camera-payload' };
    const forwarded = h.run({ topic: 'spu/classroom/room/person', payload: JSON.stringify(payload) });
    assert.deepEqual(JSON.parse(forwarded[0].payload), { total_people: 2, source: 'cira-core', timestamp: h.now(), received_at: new Date(h.now()).toISOString() });
    const logs = h.logs();
    assert.equal(logs.source, 'cira'); assert.equal(logs.serverTime, h.now());
    assert.deepEqual(logs.counters, { received: 1, forwarded: 1, rejected: 0, tests: 0 });
    assert.deepEqual(logs.events.map(event => event.stage), ['capture', 'validate', 'forward']);
    assert.equal(new Set(logs.events.map(event => event.frameId)).size, 1);
    assert.equal(new Set(logs.events.map(event => event.id)).size, 3);
    assert.deepEqual(logs.events[1].details, { totalPeople: 2, sampleAt: h.now(), sampleTimeSource: 'camera', latencyMs: 0 });
    assert.doesNotMatch(JSON.stringify(logs), /raw-camera-payload|secretMarker/);
    h.advance(1000);
    h.run({ topic: 'spu/classroom/room/person', payload: '0' });
    assert.equal(h.logs().events.at(-1).details.sampleTimeSource, 'received');
    assert.equal(h.logs().events.at(-1).details.totalPeople, 0);
});

test('logging and Debug are sampled while every live message counts and valid telemetry still forwards', () => {
    const h = fixture();
    let debugCount = 0;
    for (let i = 0; i < 8; i++) {
        const result = h.run({ topic: 'spu/classroom/room/person', payload: { total_people: i } });
        assert.equal(JSON.parse(result[0].payload).total_people, i);
        if (result[1]) debugCount++;
        h.advance(100);
    }
    for (let i = 0; i < 8; i++) {
        const result = h.run({ topic: 'spu/classroom/room/person', payload: { total_people: -1 } });
        assert.equal(result[0], null);
        if (result[1]) debugCount++;
        h.advance(100);
    }
    const logs = h.logs();
    assert.equal(debugCount, 2);
    assert.deepEqual(logs.counters, { received: 16, forwarded: 8, rejected: 8, tests: 0 });
    assert.deepEqual(logs.events.map(event => event.stage), ['capture', 'validate', 'forward', 'capture', 'rejected']);
    assert.equal(logs.events.at(-1).details.code, 'INVALID_COUNT');
    assert.equal(logs.events.at(-1).level, 'warning');
});

test('logs are bounded and evict a complete frame together', () => {
    const h = fixture();
    for (let i = 0; i < 50; i++) {
        h.run({ topic: 'spu/classroom/room/person', payload: i }); h.advance(1100);
    }
    h.run({ topic: 'local-test', _ciraTest: true, payload: { total_people: 2 } });
    h.advance(31000);
    h.run({ _ciraWatchdog: true });
    h.run({ _ciraWatchdog: true });
    const logs = h.logs();
    assert.ok(logs.events.length <= 60);
    assert.equal(logs.events[0].stage, 'capture');
    assert.equal(logs.events.at(-1).stage, 'stale');
    assert.equal(logs.events.filter(event => event.stage === 'stale').length, 1);
    assert.equal(logs.events.at(-2).stage, 'test');
    assert.deepEqual(logs.counters, { received: 50, forwarded: 50, rejected: 0, tests: 1 });
});

test('CiRA logs endpoint is read-only, noncacheable JSON and uses socket address for loopback', () => {
    const flow = buildFlow(), h = fixture();
    const input = flow.find(node => node.type === 'http in' && node.url === '/cira-observability');
    assert.equal(input.method, 'get'); assert.equal(input.url, '/cira-observability');
    const reader = flow.find(node => node.id === input.wires[0][0]);
    assert.equal(flow.find(node => node.id === reader.wires[0][0]).type, 'http response');
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const result = h.http(address);
        assert.equal(result.statusCode, 200); assert.equal(result.headers['cache-control'], 'no-store');
        assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
        assert.deepEqual(JSON.parse(result.payload).events, []);
    }
    assert.equal(h.http('192.0.2.8', { 'x-forwarded-for': '127.0.0.1' }).statusCode, 403);
    assert.deepEqual(h.logs().counters, { received: 0, forwarded: 0, rejected: 0, tests: 0 });
});
