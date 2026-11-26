'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const publicDir = path.join(__dirname, '../public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const environmentTopic = 'spu/classroom/environment';
const flush = () => new Promise(resolve => setImmediate(resolve));

function element(hidden = false) {
    return {
        hidden, textContent: '', dataset: {}, style: {},
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        append() {}, setAttribute() {}, getContext() { return {}; }, closest() { return null; }
    };
}

async function dashboard({ serverClockOffset = 0 } = {}) {
    const events = new EventEmitter();
    const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)]
        .map(([tag, id]) => [id, element(/\shidden(?:\s|>)/.test(tag))]));
    const document = {
        hidden: false,
        getElementById: id => elements.get(id) || null,
        querySelectorAll: () => [],
        createElement: () => element(),
        addEventListener() {}
    };
    const client = new EventEmitter();
    const subscriptions = [];
    client.subscribe = (topics, _options, done) => {
        subscriptions.push(...(Array.isArray(topics) ? topics : [topics]));
        done();
    };
    client.end = () => {};
    client.publish = () => assert.fail('chart telemetry must not publish a command');
    let chart;
    class Chart {
        static defaults = { font: {} };
        constructor(_canvas, config) {
            this.data = config.data;
            this.options = config.options;
            chart = this;
        }
        update() {}
    }
    const location = { href: 'http://localhost:3000/', origin: 'http://localhost:3000' };
    const intervals = new Map();
    const forecastInputs = [];
    const heldForecasts = [];
    let holdForecasts = false;
    let now = Date.parse('2026-11-20T03:00:00Z');
    const sandbox = {
        document, location, URL, DOMException, AbortSignal, AbortController, Chart,
        Date: class extends Date {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
        },
        mqtt: { connect: () => client },
        addEventListener: events.on.bind(events),
        setTimeout: () => 1,
        clearTimeout() {},
        setInterval: (callback, delay) => intervals.set(delay, callback),
        fetch: async (resource, options) => {
            if (resource === '/api/auth/session') return { status: 204 };
            assert.equal(resource, '/api/cooling-forecast');
            const input = JSON.parse(options.body);
            forecastInputs.push(input);
            const at = (input.sensorAt || now) + serverClockOffset;
            const generatedAt = now + serverClockOffset;
            const result = {
                ok: true,
                json: async () => ({
                    kind: 'estimate', source: 'measured', generatedAt,
                    arrivalAt: at + 120000, earliestAt: at + 90000, latestAt: at + 150000, rate: 0.1,
                    points: [
                        { time: at, temp: input.roomTemp, lower: input.roomTemp, upper: input.roomTemp },
                        { time: at + 120000, temp: 24, lower: 23, upper: 25 }
                    ]
                })
            };
            if (!holdForecasts) return result;
            return new Promise(resolve => heldForecasts.push({
                signal: options.signal, release: () => resolve(result)
            }));
        },
        SmartAcSchedules: { install: () => ({ refresh() {} }) },
        SmartVoiceController: class {},
        SmartVoiceAudio: {},
        SmartVoiceFeedback: {},
        SmartHandsFreeStartup: class {
            install() {}
            resume() {}
        }
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    const scripts = [...html.matchAll(/<script defer src="\/js\/([^"]+)"/g)].map(match => match[1]);
    const required = ['cooling-forecast-client.js', 'dht22-telemetry.js', 'dashboard.js'];
    assert.deepEqual(scripts.filter(file => required.includes(file)), required);
    for (const file of required) {
        vm.runInContext(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'), context, { filename: file });
    }
    events.emit('DOMContentLoaded');
    await flush();
    client.emit('connect');
    const send = (topic, payload, retain = false) => client.emit('message', topic, Buffer.from(JSON.stringify(payload)), { retain });
    const snapshot = ({ A = null, B = null, state = 'waiting' }, retained = false) => {
        const sensor = reading => ({ state: reading ? 'fresh' : 'waiting', reading });
        send(environmentTopic, {
            source: 'dht22', generated_at: now, state, sensors: { A: sensor(A), B: sensor(B) }, room: null
        }, retained);
    };
    const visible = index => {
        const data = chart.data.datasets[index];
        return data && !data.hidden ? JSON.parse(JSON.stringify(data.data)) : [];
    };
    return {
        send, snapshot, subscriptions, forecastInputs, visible, client,
        holdForecasts: () => { holdForecasts = true; },
        heldForecasts,
        markers: () => chart.coolingTimes,
        axisEnd: () => chart.options.scales.x.max,
        sample: temperature => ({ temperature, humidity: 45, captured_at: now }),
        advance: ms => { now += ms; intervals.get(1000)(); },
        text: id => elements.get(id).textContent,
        status: () => elements.get('dht22-chart-status').textContent,
        legendHidden: id => elements.get(id).hidden
    };
}

for (const id of ['A', 'B']) {
    test(`dashboard shows only DHT22 ${id} and keeps the previous forecast curve`, async () => {
        const h = await dashboard();
        assert.ok(h.subscriptions.includes(environmentTopic));
        h.send('spu/classroom/status', { power: 'ON', temp: 24, mode: 'COOL', fan: 'HIGH' });
        h.send('spu/classroom/middle/temp', 29);
        await flush();
        assert.deepEqual(h.visible(0).map(point => point.y), [29]);
        assert.equal(h.legendHidden('legend-legacy-temp'), false);
        const forecast = h.visible(4);
        assert.ok(forecast.length > 0);
        const sample = h.sample(27);
        h.snapshot({ [id]: sample });
        const [present, absent] = id === 'A' ? [6, 7] : [7, 6];
        assert.deepEqual(h.visible(present), [{ x: sample.captured_at, y: 27 }]);
        assert.deepEqual(h.visible(absent), []);
        assert.deepEqual(h.visible(0), []);
        assert.deepEqual(h.visible(4), forecast);
        assert.equal(h.forecastInputs.at(-1).roomTemp, 29);
        assert.match(h.status(), new RegExp(`ตรวจพบ DHT22 1 ตัว.*\\b${id}\\b`));
        assert.equal(h.legendHidden('legend-dht22-a'), id !== 'A');
        assert.equal(h.legendHidden('legend-dht22-b'), id !== 'B');
        assert.equal(h.legendHidden('legend-legacy-temp'), true);
    });
}

test('fresh legacy temperature counts as one point only while no identified DHT22 is fresh', async () => {
    const h = await dashboard();
    const legacy = 'spu/classroom/middle/temp';
    h.send(legacy, 25.3, true);
    assert.match(h.status(), /รอข้อมูล DHT22/);
    h.send(legacy, 25.3);
    assert.equal(h.status(), 'ตรวจพบเซนเซอร์ 1 ตัว (ช่องเดิม)');
    assert.deepEqual(h.visible(0).map(point => point.y), [25.3]);
    assert.deepEqual(h.visible(6), []);
    assert.deepEqual(h.visible(7), []);

    h.snapshot({ A: h.sample(27) });
    assert.equal(h.status(), 'ตรวจพบ DHT22 1 ตัว (A)');
    assert.deepEqual(h.visible(0), []);
    h.advance(15000);
    h.send(legacy, 25.7);
    h.advance(15000);
    assert.equal(h.status(), 'ตรวจพบเซนเซอร์ 1 ตัว (ช่องเดิม)');
    assert.deepEqual(h.visible(6), []);
    assert.equal(h.visible(0).at(-1).y, 25.7);
    assert.equal(h.legendHidden('legend-legacy-temp'), false);

    h.advance(15000);
    assert.match(h.status(), /รอข้อมูล DHT22/);
    assert.deepEqual(h.visible(0), []);
});

test('legacy chart keeps the forecast and timestamps stable while fresh readings queue for a response', async () => {
    const serverClockOffset = 6000;
    const h = await dashboard({ serverClockOffset });
    const legacy = 'spu/classroom/middle/temp';
    const statusTopic = 'spu/classroom/status';
    const status = { power: 'ON', temp: 24, mode: 'COOL', fan: 'HIGH' };
    h.send(statusTopic, status);
    h.send(legacy, 26.3);
    await flush();

    const series = () => [2, 3, 4, 5].map(h.visible);
    const original = series();
    const originalArrival = h.markers().arrivalAt;
    const originalEnd = h.axisEnd();
    const firstReading = h.visible(0)[0];
    const requestCount = h.forecastInputs.length;
    assert.ok(original.every(points => points.length > 0));

    h.holdForecasts();
    h.advance(7000);
    h.send(legacy, 26.1);
    assert.equal(h.heldForecasts.length, 1);
    assert.deepEqual(series(), original);
    assert.equal(h.markers().arrivalAt, originalArrival);
    assert.equal(h.axisEnd(), originalEnd);
    assert.deepEqual(h.visible(0).at(-1), { x: h.sample(26.1).captured_at + serverClockOffset, y: 26.1 });
    assert.deepEqual(h.visible(0)[0], firstReading);

    h.advance(2000);
    h.send(statusTopic, status);
    assert.equal(h.forecastInputs.length, requestCount + 1);
    h.advance(3000);
    h.send(legacy, 25.9);
    const latestAt = h.sample(25.9).captured_at;
    assert.equal(h.forecastInputs.length, requestCount + 1);
    assert.equal(h.heldForecasts[0].signal.aborted, false);
    assert.deepEqual(series(), original);
    assert.equal(h.markers().arrivalAt, originalArrival);
    assert.equal(h.axisEnd(), originalEnd);
    assert.deepEqual(h.visible(0).at(-1), { x: latestAt + serverClockOffset, y: 25.9 });

    h.heldForecasts[0].release();
    await flush();
    assert.equal(h.heldForecasts.length, 2);
    assert.equal(h.forecastInputs.at(-1).roomTemp, 25.9);
    assert.equal(h.forecastInputs.at(-1).sensorAt, latestAt);
    h.heldForecasts[1].release();
    await flush();
    assert.notDeepEqual(series(), original);
    assert.deepEqual(h.visible(4)[0], { x: latestAt + serverClockOffset, y: 25.9 });
    assert.equal(h.markers().arrivalAt, latestAt + serverClockOffset + 120_000);
    assert.equal(h.axisEnd(), h.markers().arrivalAt);
    assert.deepEqual(h.visible(0).at(-1), h.visible(4)[0]);

    const updated = series();
    h.advance(1000);
    h.send(statusTopic, status);
    assert.equal(h.forecastInputs.length, requestCount + 2);
    assert.deepEqual(series(), updated);
});

test('legacy chart labels recent history during an MQTT outage and resumes live readings after reconnect', async () => {
    const h = await dashboard();
    const legacy = 'spu/classroom/middle/temp';
    const statusTopic = 'spu/classroom/status';
    const status = { power: 'ON', temp: 24, mode: 'COOL', fan: 'HIGH' };
    h.send(statusTopic, status);
    h.send(legacy, 26.2);
    h.advance(10_000);
    h.send(legacy, 26.3);
    await flush();
    h.send(legacy, 28, true);
    assert.equal(h.text('forecast-current'), '26.3°C');
    assert.equal(h.text('forecast-target'), '24°C');
    assert.ok(h.visible(4).length > 0);

    h.advance(1000);
    h.client.emit('offline');
    assert.equal(h.text('forecast-current'), '26.3°C');
    assert.match(h.text('forecast-current-note'), /ข้อมูลย้อนหลัง/);
    assert.equal(h.text('forecast-target'), '24°C');
    assert.match(h.text('forecast-target-note'), /ข้อมูลย้อนหลัง/);
    assert.match(h.status(), /ข้อมูลย้อนหลัง/);
    assert.equal(h.visible(0).at(-1).y, 26.3);
    assert.ok(h.visible(1).some(point => point.y === 24));
    assert.deepEqual(h.visible(4), []);
    assert.equal(h.markers(), null);
    assert.equal(h.legendHidden('legend-forecast'), true);
    assert.equal(h.text('forecast-arrival'), '—');

    h.advance(5000);
    h.client.emit('connect');
    h.send(statusTopic, status);
    h.send(legacy, 25.8);
    await flush();
    assert.equal(h.text('forecast-current'), '25.8°C');
    assert.doesNotMatch(h.text('forecast-current-note'), /ข้อมูลย้อนหลัง/);
    assert.equal(h.text('forecast-target'), '24°C');
    assert.doesNotMatch(h.text('forecast-target-note'), /ข้อมูลย้อนหลัง/);
    assert.equal(h.status(), 'ตรวจพบเซนเซอร์ 1 ตัว (ช่องเดิม)');
    assert.deepEqual(h.visible(0).slice(-3).map(point => point.y), [26.3, null, 25.8]);
    assert.ok(h.visible(4).length > 0);
});

test('legacy temperature becomes historical after 30 seconds and ages out of the chart', async () => {
    const h = await dashboard();
    h.send('spu/classroom/status', { power: 'ON', temp: 24, mode: 'COOL', fan: 'HIGH' });
    h.send('spu/classroom/middle/temp', 26.3);
    await flush();
    assert.ok(h.visible(4).length > 0);

    h.advance(30_000);
    assert.equal(h.text('forecast-current'), '26.3°C');
    assert.match(h.text('forecast-current-note'), /ข้อมูลย้อนหลัง/);
    assert.equal(h.text('forecast-target'), '24°C');
    assert.doesNotMatch(h.text('forecast-target-note'), /ข้อมูลย้อนหลัง/);
    assert.match(h.status(), /ข้อมูลย้อนหลัง/);
    assert.deepEqual(h.visible(0).map(point => point.y), [26.3]);
    assert.deepEqual(h.visible(4), []);

    h.advance(50_000);
    assert.match(h.text('forecast-target-note'), /ข้อมูลย้อนหลัง/);
    const targetEnd = h.visible(1).findLast(point => point.y === 24);
    assert.equal(targetEnd.x, h.visible(0)[0].x + 75_000);
    assert.equal(h.visible(1).at(-1).y, null);

    h.advance(15 * 60_000 - 80_000 + 1);
    assert.deepEqual(h.visible(0), []);
    assert.equal(h.text('forecast-current'), '—');
    assert.deepEqual(h.visible(4), []);
});

test('dashboard shows two fresh DHT22 lines even when divergent, then removes them independently', async () => {
    const h = await dashboard();
    const A = h.sample(26);
    h.snapshot({ A });
    h.advance(5000);
    const B = h.sample(31);
    h.snapshot({ A, B, state: 'divergent' });
    assert.deepEqual(h.visible(6), [{ x: A.captured_at, y: 26 }]);
    assert.deepEqual(h.visible(7), [{ x: B.captured_at, y: 31 }]);
    assert.match(h.status(), /ตรวจพบ DHT22 2 ตัว/);
    assert.equal(h.legendHidden('legend-dht22-a'), false);
    assert.equal(h.legendHidden('legend-dht22-b'), false);

    h.advance(25000);
    assert.deepEqual(h.visible(6), []);
    assert.deepEqual(h.visible(7), [{ x: B.captured_at, y: 31 }]);
    assert.match(h.status(), /ตรวจพบ DHT22 1 ตัว.*\bB\b/);
    assert.equal(h.legendHidden('legend-dht22-a'), true);
    assert.equal(h.legendHidden('legend-dht22-b'), false);

    h.advance(5000);
    assert.deepEqual(h.visible(7), []);
    assert.match(h.status(), /รอข้อมูล DHT22/);
    assert.equal(h.legendHidden('legend-dht22-b'), true);
});

test('retained DHT22 snapshots and previous data after an MQTT disconnect stay hidden', async () => {
    const h = await dashboard();
    h.snapshot({ A: h.sample(27) }, true);
    assert.deepEqual(h.visible(6), []);
    h.snapshot({ A: h.sample(27) });
    assert.equal(h.visible(6).length, 1);
    h.client.emit('offline');
    assert.deepEqual(h.visible(6), []);
    assert.match(h.status(), /รอข้อมูล DHT22/);
    h.client.emit('connect');
    assert.deepEqual(h.visible(6), []);
    h.advance(1000);
    const B = h.sample(25);
    h.snapshot({ B });
    assert.deepEqual(h.visible(6), []);
    assert.deepEqual(h.visible(7), [{ x: B.captured_at, y: 25 }]);
});
