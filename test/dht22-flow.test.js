'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { buildDht22Flow } = require('../node-red/build-dht22-flow');

const INPUT = 'spu/classroom/environment/dht22';
const OUTPUT = 'spu/classroom/environment';
const START = 1794470400000;

function fixture() {
    const nodes = buildDht22Flow();
    const byId = new Map(nodes.map(node => [node.id, node]));
    const input = nodes.find(node => node.type === 'mqtt in');
    const live = byId.get(input.wires[0][0]);
    const memory = new Map();
    const scope = {
        get: key => memory.get(key),
        set: (key, value) => memory.set(key, value)
    };
    let now = START;
    const box = vm.createContext({
        Buffer,
        context: scope,
        node: { status() {} },
        Date: class extends Date { static now() { return now; } }
    });
    vm.runInContext(live.initialize || '', box);
    const execute = (node, msg) => {
        box.msg = msg;
        return JSON.parse(JSON.stringify(vm.runInContext(`(function (msg) {${node.func}\n})(msg)`, box)) ?? 'null');
    };
    const send = (reading, extra) => execute(live, {
        topic: INPUT,
        payload: typeof reading === 'string' ? reading : JSON.stringify(reading),
        ...extra
    });
    return { nodes, byId, live, execute, send, now: () => now, advance: ms => { now += ms; } };
}

function sample(sensor_id, captured_at, temperature = 25, humidity = 50) {
    return { sensor_id, captured_at, temperature, humidity };
}

function snapshot(result) {
    assert.equal(result[0].topic, OUTPUT);
    const data = JSON.parse(result[0].payload);
    assert.equal(data.source, 'dht22');
    return data;
}

test('the additive import is deterministic and uses neither CiRA nodes nor AC topics', () => {
    const project = path.resolve(__dirname, '..');
    const readFlow = filename => JSON.parse(fs.readFileSync(path.join(project, filename), 'utf8'));
    const nodes = buildDht22Flow();
    const ciraIds = new Set(readFlow('node_red_cira_bridge_flow.json').map(node => node.id));
    assert.deepEqual(readFlow('node_red_dht22_environment_flow.json'), nodes);
    assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
    assert.ok(nodes.every(node => !ciraIds.has(node.id)));

    const tabs = nodes.filter(node => node.type === 'tab');
    const brokers = nodes.filter(node => node.type === 'mqtt-broker');
    const inputs = nodes.filter(node => node.type === 'mqtt in');
    const outputs = nodes.filter(node => node.type === 'mqtt out');
    assert.equal(tabs.length, 1);
    assert.equal(brokers.length, 1);
    assert.equal(inputs.length, 1);
    assert.equal(outputs.length, 1);
    assert.equal(inputs[0].topic, INPUT);
    assert.equal(outputs[0].topic, OUTPUT);
    assert.equal(String(outputs[0].qos), '0');
    assert.equal(String(outputs[0].retain), 'false');
    assert.ok(nodes.every(node => !node.z || node.z === tabs[0].id));
    assert.ok(nodes.every(node => !/^(?:http|link)\b/.test(node.type)));
    assert.deepEqual([inputs[0].broker, outputs[0].broker], [brokers[0].id, brokers[0].id]);
    const ownIds = new Set(nodes.map(node => node.id));
    assert.ok(nodes.every(node => (node.wires || []).flat().every(id => ownIds.has(id))));
});

test('only two fresh and sufficiently close readings produce a combined room reading', () => {
    const h = fixture();
    const a = snapshot(h.send(sample('A', h.now(), 24, 48)));
    assert.equal(a.state, 'waiting');
    assert.equal(a.room, null);
    assert.deepEqual(a.sensors.B, { state: 'waiting', reading: null });

    h.advance(1000);
    const paired = snapshot(h.send(sample('B', h.now(), 26, 60)));
    assert.equal(paired.state, 'ready');
    assert.equal(paired.generated_at, h.now());
    assert.deepEqual(paired.room, { temperature: 25, humidity: 54 });
    assert.deepEqual(paired.sensors.A, {
        state: 'fresh', reading: { temperature: 24, humidity: 48, captured_at: START }
    });
    assert.equal(paired.sensors.B.reading.captured_at, START + 1000);

    h.advance(1000);
    const split = snapshot(h.send(sample('B', h.now(), 27)));
    assert.equal(split.state, 'divergent');
    assert.equal(split.room, null);
    assert.equal(split.sensors.A.reading.temperature, 24);
    assert.equal(split.sensors.B.reading.temperature, 27);
});

test('invalid and old deliveries leave live readings intact', () => {
    const h = fixture();
    h.send(sample('A', START, 25, 51));
    h.advance(3000);
    const bad = [
        ['{invalid'], [sample('B', h.now()), { retain: true }], [sample('C', h.now())],
        [sample('B', h.now(), '26')], [sample('B', h.now(), null)], [sample('B', h.now(), 81)],
        [sample('B', h.now(), 25, -1)], [sample('B', h.now(), 25, true)],
        [sample('B', h.now() - 30000)], [sample('B', h.now() + 5001)], [sample('B', h.now() + 0.5)],
        [sample('A', START, 26)], [sample('A', START - 1, 27)]
    ];
    for (const [reading, options] of bad) {
        const result = h.send(reading, options);
        assert.equal(result?.[0] ?? null, null, JSON.stringify(reading));
        assert.equal(result[1].payload.event, 'dht22_rejected');
    }
    const combined = snapshot(h.send(sample('B', h.now(), 25, 49)));
    assert.deepEqual(combined.room, { temperature: 25, humidity: 50 });
    assert.equal(combined.sensors.A.reading.captured_at, START);
});

test('watchdog suspends combined data when a point expires and sends the transition once', () => {
    const h = fixture();
    const watchdog = h.nodes.find(node => node.type === 'inject' && node.repeat === '5');
    assert.deepEqual(watchdog.wires, [[h.live.id]]);
    assert.deepEqual(watchdog.props, [{ p: '_dht22Watchdog', v: 'true', vt: 'bool' }]);
    const tick = () => h.execute(h.live, { [watchdog.props[0].p]: true });
    assert.equal(tick(), null);
    h.send(sample('A', h.now()));
    h.advance(5000);
    h.send(sample('B', h.now()));
    h.advance(25000);
    const expired = snapshot(tick());
    assert.equal(expired.state, 'stale');
    assert.equal(expired.room, null);
    assert.equal(expired.sensors.A.state, 'stale');
    assert.equal(expired.sensors.A.reading.captured_at, START);
    assert.equal(expired.sensors.B.state, 'fresh');
    assert.equal(tick(), null);
    assert.equal(snapshot(h.send(sample('A', h.now()))).state, 'ready');
});

test('test scenarios send results only to Debug and never change live samples', () => {
    const h = fixture();
    h.send(sample('A', h.now(), 24, 46));
    const scenarios = { ready: 'ready', missing: 'waiting', divergent: 'divergent' };
    for (const [scenario, expected] of Object.entries(scenarios)) {
        const inject = h.nodes.find(node => node.type === 'inject' && node.payload === scenario);
        assert.equal(inject.once, false);
        assert.equal(inject.repeat, '');
        const targets = inject.wires.flat().map(id => h.byId.get(id));
        assert.equal(targets.length, 1);
        assert.equal(targets[0].type, 'function');
        assert.notEqual(targets[0].id, h.live.id);
        const outputs = targets[0].wires.flat().map(id => h.byId.get(id));
        assert.ok(outputs.length > 0 && outputs.every(node => node.type === 'debug'));
        const result = h.execute(targets[0], { payload: scenario });
        assert.equal(result.payload.event, 'dht22_test');
        assert.equal(result.payload.scenario, scenario);
        assert.equal(result.payload.snapshot.state, expected);
    }
    const combined = snapshot(h.send(sample('B', h.now(), 26, 60)));
    assert.equal(combined.sensors.A.reading.temperature, 24);
    assert.deepEqual(combined.room, { temperature: 25, humidity: 53 });
});
