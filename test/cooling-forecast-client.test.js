'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ForecastClient, duration, clockTime, remainingMinutes } = require('../public/js/cooling-forecast-client');

const NOW = Date.parse('2026-11-11T14:30:00+07:00');
const telemetry = (patch = {}) => ({
  roomTemp: 28, target: 25, power: true, mode: 0, sensorAt: NOW,
  statusAt: NOW, statusFresh: true, pending: false, assumedRate: .1, ...patch,
});
const estimate = (patch = {}) => ({
  kind: 'estimate', source: 'assumed', method: 'local_trend', generatedAt: NOW,
  arrivalAt: NOW + 30 * 60_000, earliestAt: NOW + 23 * 60_000,
  latestAt: NOW + 43 * 60_000, minutes: 30,
  points: [{ time: NOW, temp: 28 }, { time: NOW + 30 * 60_000, temp: 25 }], ...patch,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = () => new Promise(resolve => setImmediate(resolve));
const transport = () => {
  const requests = [];
  return {
    requests,
    fetch: (url, options) => {
      const wait = deferred();
      requests.push({ url, options, ...wait });
      return wait.promise; // Intentionally ignores abort: the client must also guard response identity.
    },
  };
};

test('forecast client samples only spaced readings for the current AC setting', () => {
  const client = new ForecastClient({ fetch: async () => response(estimate()) });
  client.record({ time: NOW, temp: 28, context: 'ac-a' });
  client.record({ time: NOW, temp: 27.9, context: 'ac-a' });
  client.record({ time: NOW + 24_999, temp: 27.9, context: 'ac-a' });
  assert.equal(client.samples.length, 1);
  client.record({ time: NOW + 25_000, temp: 27.9, context: 'ac-a' });
  assert.equal(client.samples.length, 2);
  client.record({ time: NOW + 50_000, temp: 27.8, context: 'ac-b' });
  assert.equal(client.context, 'ac-b');
  assert.deepEqual(client.samples, [{ time: NOW + 50_000, temp: 27.8 }]);
  client.record({ time: NOW + 170_001, temp: 27.5, context: 'ac-b' });
  assert.deepEqual(client.samples, [{ time: NOW + 170_001, temp: 27.5 }]);
});

test('forecast observation history is bounded and rejects invalid or out-of-order samples', () => {
  const client = new ForecastClient({ fetch: async () => response(estimate()) });
  for (let i = 0; i < 80; i++) client.record({ time: NOW + i * 25_000, temp: 28 - i * .01, context: 'ac-a' });
  const previous = structuredClone(client.samples);
  for (const sample of [
    { time: NOW, temp: 28 }, { time: NaN, temp: 28 },
    { time: NOW + 2_000_000, temp: Infinity }, { time: NOW + 2_000_000, temp: 61 },
  ]) client.record({ ...sample, context: 'ac-a' });
  assert.deepEqual(client.samples, previous);
  assert.ok(client.samples.length <= 40);
  assert.ok(client.samples.at(-1).time - client.samples[0].time <= 15 * 60_000);
});

test('per-second rendering reuses one server request and sends current-setting observations', async () => {
  const net = transport();
  let time = NOW;
  const client = new ForecastClient({ fetch: net.fetch, now: () => time });
  client.record({ time: NOW - 30_000, temp: 28.1, context: 'ac-a' });
  client.record({ time: NOW, temp: 28, context: 'ac-a' });
  assert.equal(client.sync(telemetry(), 'ac-a').kind, 'loading');
  for (let i = 0; i < 10; i++) {
    time += 1_000;
    client.sync(telemetry(), 'ac-a');
  }
  assert.equal(net.requests.length, 1);
  const request = net.requests[0];
  assert.equal(request.url, '/api/cooling-forecast');
  assert.equal(request.options.method, 'POST');
  const body = JSON.parse(request.options.body);
  assert.equal(body.target, 25);
  assert.equal(body.clientNow, NOW);
  assert.deepEqual(body.samples, client.samples);
  request.resolve(response(estimate()));
  await settle();
  assert.equal(client.sync(telemetry(), 'ac-a').arrivalAt, NOW + 30 * 60_000);
  assert.equal(net.requests.length, 1);
});

test('late response for a previous temperature cannot overwrite a newer result', async () => {
  const net = transport(), published = [];
  let client;
  client = new ForecastClient({ fetch: net.fetch, now: () => NOW, onChange: () => published.push(client?.result) });
  client.sync(telemetry(), 'ac-a');
  client.sync(telemetry({ target: 24 }), 'ac-a');
  assert.equal(net.requests.length, 2);
  assert.equal(net.requests[0].options.signal.aborted, true);
  const latest = estimate({ arrivalAt: NOW + 40 * 60_000, minutes: 40 });
  net.requests[1].resolve(response(latest));
  await settle();
  net.requests[0].resolve(response(estimate()));
  await settle();
  assert.equal(client.result.arrivalAt, latest.arrivalAt);
  assert.ok(!published.some(result => result?.arrivalAt === NOW + 30 * 60_000));
});

test('changing device context and resetting both invalidate requests even if abort is ignored', async () => {
  const net = transport();
  const client = new ForecastClient({ fetch: net.fetch, now: () => NOW });
  client.record({ time: NOW, temp: 28, context: 'ac-a' });
  client.sync(telemetry(), 'ac-a');
  client.sync(telemetry(), 'ac-b');
  assert.equal(net.requests.length, 2);
  assert.deepEqual(JSON.parse(net.requests[1].options.body).samples, []);
  net.requests[0].resolve(response(estimate()));
  await settle();
  assert.equal(client.sync(telemetry(), 'ac-b').kind, 'loading');
  client.reset();
  assert.equal(net.requests[1].options.signal.aborted, true);
  assert.equal(client.context, null);
  assert.deepEqual(client.samples, []);
  net.requests[1].resolve(response(estimate()));
  await settle();
  assert.notEqual(client.result?.kind, 'estimate');
});

test('server failure removes the previous curve and retries only after five seconds', async () => {
  let time = NOW;
  const net = transport();
  const client = new ForecastClient({ fetch: net.fetch, now: () => time });
  client.sync(telemetry(), 'ac-a');
  net.requests[0].resolve(response(estimate()));
  await settle();
  const changed = telemetry({ assumedRate: .2 });
  const loading = client.sync(changed, 'ac-a');
  assert.equal(loading.kind, 'loading');
  assert.deepEqual(loading.points, []);
  net.requests[1].resolve(response({ message: 'Unavailable' }, 503));
  await settle();
  assert.equal(client.result.kind, 'unavailable');
  assert.deepEqual(client.result.points, []);
  assert.ok(!client.result.arrivalAt);
  time += 4_999;
  client.sync(changed, 'ac-a');
  assert.equal(net.requests.length, 2);
  time += 1;
  assert.equal(client.sync(changed, 'ac-a').kind, 'loading');
  assert.equal(net.requests.length, 3);
  net.requests[2].reject(new Error('offline'));
  await settle();
  assert.equal(client.result.kind, 'unavailable');
  assert.deepEqual(client.result.points, []);
});

test('a cached forecast disappears when its sensor or ESP32 status becomes stale', async () => {
  for (const scenario of [
    { input: telemetry(), elapsed: 30_001 },
    { input: telemetry({ statusAt: NOW - 70_000 }), elapsed: 5_001 },
  ]) {
    let time = NOW;
    const client = new ForecastClient({ fetch: async () => response(estimate()), now: () => time });
    client.sync(scenario.input, 'ac-a');
    await settle();
    assert.equal(client.result.kind, 'estimate');
    time += scenario.elapsed;
    const stale = client.sync(scenario.input, 'ac-a');
    assert.equal(stale.kind, 'unavailable');
    assert.deepEqual(stale.points, []);
    assert.ok(!stale.arrivalAt);
  }
});

test('loss of device freshness immediately hides an estimate', async () => {
  const client = new ForecastClient({ fetch: async () => response(estimate()), now: () => NOW });
  client.sync(telemetry(), 'ac-a');
  await settle();
  const result = client.sync(telemetry({ statusFresh: false }), 'ac-a');
  assert.equal(result.kind, 'unavailable');
  assert.deepEqual(result.points, []);
  assert.ok(!result.arrivalAt);
});

test('server time anchors a stable arrival while the remaining duration counts down', async () => {
  let clientTime = NOW;
  const serverTime = NOW + 5_000;
  const arrivalAt = serverTime + 30 * 60_000;
  const client = new ForecastClient({ fetch: async () => response(estimate({ generatedAt: serverTime, arrivalAt })), now: () => clientTime });
  client.sync(telemetry(), 'ac-a');
  await settle();
  assert.equal(client.nowOnServer(), serverTime);
  assert.equal(remainingMinutes(client.result, client.nowOnServer()), 30);
  clientTime += 10_000;
  assert.equal(client.nowOnServer(), serverTime + 10_000);
  assert.equal(remainingMinutes(client.result, client.nowOnServer()), 30 - 1 / 6);
  assert.equal(client.result.arrivalAt, arrivalAt);
});

test('browsers ahead of or behind the server retain fresh forecasts and canonical arrival times', async () => {
  for (const skew of [-2 * 60 * 60_000, 2 * 60 * 60_000]) {
    let browserTime = NOW + skew;
    const input = telemetry({ sensorAt: browserTime - 2_000, statusAt: browserTime - 10_000 });
    const requests = [];
    const client = new ForecastClient({
      now: () => browserTime,
      fetch: async (_, options) => {
        requests.push(JSON.parse(options.body));
        return response(estimate()); // Server response timestamps are canonical server time.
      },
    });
    client.record({ time: browserTime - 30_000, temp: 28.1, context: 'ac-a' });
    client.record({ time: input.sensorAt, temp: 28, context: 'ac-a' });
    assert.equal(client.sync(input, 'ac-a').kind, 'loading');
    await settle();
    const result = client.sync(input, 'ac-a');
    assert.equal(result.kind, 'estimate');
    assert.equal(result.arrivalAt, NOW + 30 * 60_000);
    assert.equal(client.nowOnServer(), NOW);
    assert.equal(remainingMinutes(result, client.nowOnServer()), 30);
    assert.equal(requests[0].clientNow, NOW + skew);
    assert.equal(requests[0].sensorAt, input.sensorAt);
    assert.equal(requests[0].statusAt, input.statusAt);
    assert.deepEqual(requests[0].samples, client.samples);
    browserTime += 10_000;
    assert.equal(client.sync(input, 'ac-a').kind, 'estimate');
    assert.equal(requests.length, 1);
    assert.equal(remainingMinutes(result, client.nowOnServer()), 30 - 1 / 6);
    browserTime = input.sensorAt + 30_001;
    assert.equal(client.sync(input, 'ac-a').kind, 'unavailable');
  }
});

test('ESP32 status freshness uses the browser clock under positive and negative server skew', async () => {
  for (const skew of [-2 * 60 * 60_000, 2 * 60 * 60_000]) {
    let browserTime = NOW + skew;
    const input = telemetry({ sensorAt: browserTime, statusAt: browserTime - 70_000 });
    const client = new ForecastClient({ now: () => browserTime, fetch: async () => response(estimate()) });
    client.sync(input, 'ac-a');
    await settle();
    assert.equal(client.sync(input, 'ac-a').kind, 'estimate');
    browserTime += 5_001;
    const result = client.sync(input, 'ac-a');
    assert.equal(result.kind, 'unavailable');
    assert.deepEqual(result.points, []);
  }
});

test('Thai arrival clock uses Bangkok dates and distinguishes tomorrow', () => {
  assert.equal(duration(30), '30 นาที');
  assert.equal(duration(90), '1 ชม. 30 นาที');
  assert.equal(clockTime(Date.parse('2026-11-11T15:00:00+07:00'), NOW), '15:00 น.');
  const beforeMidnight = Date.parse('2026-11-11T23:50:00+07:00');
  assert.equal(clockTime(Date.parse('2026-11-12T00:15:00+07:00'), beforeMidnight), 'พรุ่งนี้ 00:15 น.');
  assert.equal(remainingMinutes({ arrivalAt: NOW - 60_000 }, NOW), 0);
});
