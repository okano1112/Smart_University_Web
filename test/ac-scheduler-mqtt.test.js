'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SchedulerMqtt, readConfig, safeBrokerUrl, parseReport } = require('../ac-scheduler-mqtt');

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = true; this.published = []; this.subscriptions = []; }
  subscribe(topic, options, callback) { this.subscriptions.push({ topic, options }); callback(); }
  publish(topic, payload, options, callback) { this.published.push({ topic, payload, options }); callback(); }
  end(force, options, callback) { callback(); }
}
const report = Buffer.from(JSON.stringify({ power: 'ON', temp: 25, mode: 'COOL', fan: 'MED' }));

test('only live messages on the configured people topic reach occupancy control', async () => {
  const client = new FakeClient();
  const config = readConfig({ MQTT_PEOPLE_TOPIC: 'room/camera/people' });
  const samples = [], resets = [];
  const adapter = new SchedulerMqtt({ config, connect: () => client,
    onPeople: raw => samples.push(raw.toString()), onPeopleDisconnect: () => resets.push(samples.length) });
  adapter.start(); client.emit('connect');
  assert.deepEqual(client.subscriptions, [
    { topic: config.statusTopic, options: { qos: 0 } },
    { topic: config.peopleTopic, options: { qos: 0 } }
  ]);
  client.emit('message', config.peopleTopic, Buffer.from('0'), { retain: true });
  client.emit('message', 'room/other/people', Buffer.from('0'), { retain: false });
  client.emit('message', config.statusTopic, report, { retain: false });
  client.emit('message', config.peopleTopic, Buffer.from('1'), { retain: false });
  client.emit('close');
  client.emit('message', config.peopleTopic, Buffer.from('0'), { retain: false });
  client.emit('connect');
  client.emit('message', config.peopleTopic, Buffer.from('2'), { retain: false });
  assert.deepEqual(samples, ['1', '2']);
  assert.deepEqual(resets, [0, 1, 1]);
  await adapter.close();
});

test('adapter separates broker and fresh ESP32 status, ignores retained/malformed reports, and clears freshness on reconnect', async () => {
  const client = new FakeClient(); let options, now = 100000;
  const adapter = new SchedulerMqtt({ config: readConfig({}), now: () => now, connect: (url, value) => { options = value; return client; } });
  adapter.start(); client.emit('connect');
  assert.equal(options.queueQoSZero, false); assert.equal(options.clean, true); assert.equal(options.resubscribe, false);
  assert.equal(adapter.status().brokerConnected, true); assert.equal(adapter.status().deviceOnline, false);
  assert.deepEqual(client.published[0].options, { qos: 0, retain: false }); assert.equal(client.published[0].payload, 'STATUS');
  client.emit('message', adapter.config.statusTopic, report, { retain: true });
  client.emit('message', adapter.config.statusTopic, Buffer.from('{"power":"ON"}'), { retain: false });
  assert.equal(adapter.status().deviceOnline, false);
  client.emit('message', adapter.config.statusTopic, report, { retain: false });
  assert.equal(adapter.status().deviceOnline, true); assert.deepEqual(adapter.status().deviceState, { power: true, temp: 25, mode: 0, fan: 2 });
  now += 75000; assert.equal(adapter.status().deviceOnline, false); assert.equal(adapter.status().brokerConnected, true);
  client.emit('close'); assert.equal(adapter.status().brokerConnected, false);
  client.emit('connect'); assert.equal(adapter.status().lastStatusAt, null); assert.equal(adapter.status().deviceOnline, false);
  await adapter.close();
});

test('commands use exact JSON, qos zero and retain false, and never queue while broker/device is unavailable', async () => {
  const client = new FakeClient();
  const adapter = new SchedulerMqtt({ config: readConfig({}), now: () => 100000, connect: () => client });
  adapter.start(); client.emit('connect');
  await assert.rejects(adapter.publish({ POWER: 1, TEMP: 25, MODE: 0, FAN: 2 }));
  client.emit('message', adapter.config.statusTopic, report, { retain: false });
  await adapter.publish({ POWER: 1, TEMP: 25, MODE: 0, FAN: 2 });
  assert.deepEqual(client.published[1], { topic: 'spu/classroom/remote/air', payload: '{"POWER":1,"TEMP":25,"MODE":0,"FAN":2}', options: { qos: 0, retain: false } });
  client.emit('message', adapter.config.statusTopic, Buffer.from('{"status":"Engine offline"}'), { retain: false });
  assert.equal(adapter.status().deviceOnline, false);
  await assert.rejects(adapter.publish({ POWER: 0, TEMP: 25, MODE: 0, FAN: 2 }));
  assert.equal(client.published.length, 2); await adapter.close();
});

test('firmware offline variants are accepted without treating unrelated status text as offline', () => {
  for (const status of ['offline', 'Engine offline', 'ENGINE OFFLINE', ' ESP32 offline ', 'Device offline']) assert.deepEqual(parseReport(Buffer.from(JSON.stringify({ status }))), { offline: true });
  for (const status of ['online', 'Engine online', 'not offline', 'offline soon']) assert.equal(parseReport(Buffer.from(JSON.stringify({ status }))), null);
});

test('configuration only exposes sanitized URLs and status parser rejects invalid ranges', () => {
  assert.equal(safeBrokerUrl('mqtt://user:secret@example.com:1883'), 'mqtt://example.com:1883');
  assert.equal(safeBrokerUrl('wss://user:secret@example.com/mqtt?token=secret#secret'), 'wss://example.com/mqtt');
  assert.equal(readConfig({ MQTT_URL: 'mqtt://local.example:1883', MQTT_COMMAND_TOPIC: 'room/ac' }).commandTopic, 'room/ac');
  assert.throws(() => readConfig({ MQTT_URL: 'https://example.com' }));
  assert.throws(() => readConfig({ MQTT_STATUS_TOPIC: 'room/#' }));
  assert.throws(() => readConfig({ MQTT_PEOPLE_TOPIC: 'room/+/people' }));
  for (const value of [{ power: 'ON', temp: 40, mode: 'COOL', fan: 'MED' }, { power: 'OFF', temp: null, mode: 'COOL', fan: 'MED' }, { power: 'ON', temp: 25, mode: 'HEAT', fan: 'MED' }]) assert.equal(parseReport(Buffer.from(JSON.stringify(value))), null);
});

test('a publish without a callback times out instead of blocking every later schedule', async () => {
  const client = new FakeClient();
  const adapter = new SchedulerMqtt({ config: readConfig({}), now: () => 100000, connect: () => client, publishTimeoutMs: 10 });
  adapter.start(); client.emit('connect'); client.emit('message', adapter.config.statusTopic, report, { retain: false });
  client.publish = () => {};
  await assert.rejects(adapter.publish({ POWER: 1, TEMP: 25, MODE: 0, FAN: 2 }), /หมดเวลา/);
  await adapter.close();
});
