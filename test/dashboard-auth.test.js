'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function dashboard() {
    const windowEvents = new EventEmitter(), form = new EventEmitter(), locationChanges = [];
    const location = { href: 'http://localhost:3000/', origin: 'http://localhost:3000', replace: value => locationChanges.push(value) };
    const requests = [], clients = [], published = [];
    const window = { addEventListener: windowEvents.on.bind(windowEvents), location };
    const document = { addEventListener() {}, hidden: false, getElementById: () => ({
        setAttribute() {}, closest: () => ({ addEventListener: form.on.bind(form) })
    }) };
    let voicePaused = 0, voiceDestroyed = 0;
    const mqtt = { connect() {
        const client = new EventEmitter();
        client.connected = true;
        client.end = () => { client.connected = false; };
        client.subscribe = (_, __, callback) => callback();
        client.publish = (topic, raw) => published.push({ topic, payload: JSON.parse(raw) });
        clients.push(client);
        return client;
    } };
    window.mqtt = mqtt;
    const context = vm.createContext({
        document, window, location, mqtt, URL, DOMException, AbortSignal, AbortController,
        fetch: (resource, options) => new Promise(resolve => requests.push({
            resource, options, reply: (status, url = '', body) => resolve({ status, url, ok: status >= 200 && status < 300, json: async () => body })
        })),
        setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
        SmartCoolingForecastClient: { ForecastClient: class { reset() {} } },
        SmartVoiceController: class { constructor(options) { this.options = options; } deviceResult() {} },
        SmartVoiceAudio: {}, SmartVoiceFeedback: {},
        SmartHandsFreeStartup: class {
            install() {} resume() {} pause() { voicePaused++; } destroy() { voiceDestroyed++; }
        },
        SmartAcSchedules: { install: () => ({ refresh() {}, destroy() {} }) }
    });
    const run = code => vm.runInContext(code, context);
    run(source);
    run(`for (const name of ['loadSettings', 'updateClock', 'initChart', 'renderAll', 'renderThermostat', 'renderEnvironment', 'renderConnection', 'notice', 'logEvent']) globalThis[name] = () => {};`);
    function start() { windowEvents.emit('DOMContentLoaded'); }
    function connect(client = clients.at(-1)) {
        client.emit('connect');
        run("state.ac = { power: true, temp: 24, mode: 0, fan: 3 }; state.deviceOnline = true;");
    }
    async function authorize() {
        start(); requests.at(-1).reply(204); await tick(); connect();
    }
    return { run, windowEvents, form, clients, published, requests, locationChanges, start, connect, authorize,
        voicePaused: () => voicePaused, voiceDestroyed: () => voiceDestroyed };
}

test('dashboard boots and restores MQTT only after a fresh authenticated session probe', async () => {
    const h = dashboard();
    h.start();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].resource, '/api/auth/session');
    assert.equal(h.requests[0].options.cache, 'no-store');
    assert.equal(h.clients.length, 0);
    assert.equal(h.run('voiceController.options.canStart()'), false);
    h.requests[0].reply(204); await tick(); h.connect();
    assert.equal(h.run('voiceController.options.canStart()'), true);
    h.windowEvents.emit('pagehide', { persisted: true });
    assert.equal(h.clients[0].connected, false);
    assert.equal(h.voicePaused(), 1);
    h.windowEvents.emit('pageshow', { persisted: true });
    assert.equal(h.clients.length, 1);
    assert.equal(h.run('voiceController.options.canStart()'), false);
    h.requests.at(-1).reply(204); await tick();
    assert.equal(h.clients.length, 2);
    assert.equal(h.run('voiceController.options.canStart()'), true);
});

test('manual MQTT changes await individual session checks and rapid temperature increments compose', async () => {
    const h = dashboard(); await h.authorize();
    h.run('adjustTemperature(1); adjustTemperature(1);'); await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.published.length, 0);
    h.requests.at(-1).reply(204); await tick();
    assert.equal(h.requests.length, 3);
    assert.equal(h.published[0].payload.TEMP, 25);
    h.requests.at(-1).reply(204); await h.run('commandQueue');
    assert.deepEqual(h.published.map(item => item.payload.TEMP), [25, 26]);
});

test('count advice can be applied without pose or ambient readings after a fresh authenticated check', async () => {
    const h = dashboard(); await h.authorize();
    h.run(`state.statusQuality = 'fresh'; state.lastStatusAt = Date.now();
        state.people = 6; state.sensorAt.people = Date.now(); voiceController.state = 'OFF';`);
    const apply = h.run("applyComfort({ target: 25, mode: 'count', isCurrent: () => true })");
    const request = h.requests.at(-1);
    assert.equal(request.resource, '/api/comfort/recommendation');
    const { recommendationMode, includePose, sensorFresh, people } = JSON.parse(request.options.body);
    assert.equal(recommendationMode, 'count');
    assert.equal(includePose, false);
    assert.equal(sensorFresh, false);
    assert.equal(people.value, 6);
    request.reply(200, '', { pose: null, recommendation: { mode: 'count', status: 'suggested', target: 25, currentTarget: 24 } });
    await tick();
    assert.equal(h.requests.at(-1).resource, '/api/auth/session');
    assert.equal(h.published.length, 0);
    h.run('state.people = 5; state.sensorAt.people = Date.now();');
    h.requests.at(-1).reply(204);
    assert.equal(await apply, true);
    assert.equal(h.published[0].payload.TEMP, 25);
});

test('count advice cannot send MQTT if the selected mode changes while authorization is pending', async () => {
    const h = dashboard(); await h.authorize();
    h.run(`state.statusQuality = 'fresh'; state.lastStatusAt = Date.now();
        state.people = 6; state.sensorAt.people = Date.now(); voiceController.state = 'OFF';
        globalThis.countSelected = true;`);
    const apply = h.run("applyComfort({ target: 25, mode: 'count', isCurrent: () => countSelected })");
    h.requests.at(-1).reply(200, '', { pose: null, recommendation: { mode: 'count', status: 'suggested', target: 25, currentTarget: 24 } });
    await tick();
    assert.equal(h.requests.at(-1).resource, '/api/auth/session');
    h.run('countSelected = false');
    h.requests.at(-1).reply(204);
    assert.equal(await apply, false);
    assert.equal(h.published.length, 0);
});

test('same-origin 401 closes resources; late authorized payloads and queued commands cannot publish', async () => {
    const h = dashboard(); await h.authorize();
    h.run('handlePowerToggle(); handlePowerToggle();'); await tick();
    const pending = h.requests.at(-1);
    const unrelated = h.run("appFetch('/api/schedules')");
    h.requests.at(-1).reply(401, 'http://localhost:3000/api/schedules'); await unrelated;
    assert.deepEqual(h.locationChanges, ['/login']);
    assert.equal(h.voiceDestroyed(), 1);
    assert.equal(h.clients[0].connected, false);
    pending.reply(204); await h.run('commandQueue');
    assert.equal(h.published.length, 0);
    assert.equal(h.requests.length, 3);
});

test('logout stops publication synchronously and the page cannot resume on a cached restore', async () => {
    const h = dashboard(); await h.authorize();
    h.run('handlePowerToggle()'); await tick();
    const pending = h.requests.at(-1);
    h.form.emit('submit');
    assert.equal(h.clients[0].connected, false);
    assert.equal(h.voiceDestroyed(), 1);
    pending.reply(204); await h.run('commandQueue');
    h.windowEvents.emit('pageshow', { persisted: true });
    assert.deepEqual(h.locationChanges, ['/login']);
    assert.equal(h.published.length, 0);
});

test('auth probe failure, abort, and reconnect block physical MQTT without retries or foreign redirects', async () => {
    const h = dashboard(); await h.authorize();
    h.run('handlePowerToggle()'); await tick(); h.requests.at(-1).reply(503); await h.run('commandQueue');
    h.run('handlePowerToggle()'); await tick();
    h.clients[0].emit('offline'); h.connect(h.clients[0]);
    h.requests.at(-1).reply(204); await h.run('commandQueue');
    const voiceCommand = h.run(`globalThis.abortCommand = new AbortController();
        sendAcCommand({power:true,temp:25,mode:0,fan:3}, 'voice', {signal:abortCommand.signal});`);
    await tick(); h.run('abortCommand.abort()'); h.requests.at(-1).reply(204);
    assert.equal(await voiceCommand, false);
    const foreign = h.run("appFetch('https://example.test/resource')"); h.requests.at(-1).reply(401, 'https://example.test/resource'); await foreign;
    assert.equal(h.published.length, 0); assert.deepEqual(h.locationChanges, []);
});
