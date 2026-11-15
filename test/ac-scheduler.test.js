'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AcScheduler, occurrence, bangkokDate, nextOccurrence, validateSchedule } = require('../ac-scheduler');
const { DEFAULT_DESTINATION, destinationIdentity } = require('../ac-scheduler-destination');

const START = Date.parse('2026-11-13T09:00:00+07:00');
const schedule = extra => ({ label: 'เริ่มประชุม', power: true, time: '09:01', date: '2026-11-13', repeat: 'once', temp: 25, mode: 0, fan: 2, enabled: true, ...extra });

async function fixture(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bimclub-schedule-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = START, connection = { brokerConnected: true, deviceOnline: true, lastStatusAt: START - 1 }, published = [];
  const options = { storePath: path.join(directory, 'schedules.json'), now: () => now, connection: () => connection,
    publish: async payload => published.push(payload), ...extra };
  const core = new AcScheduler(options);
  t.after(() => core.close());
  await core.init();
  return { core, options, published, setTime: value => { now = value; }, setConnection: value => { connection = value; } };
}

test('Bangkok dates and daily occurrences are independent of host timezone and cross midnight correctly', () => {
  assert.equal(bangkokDate(Date.parse('2026-11-13T18:00:00Z')), '2026-11-14');
  assert.equal(occurrence('2026-11-13', '09:01'), START + 60000);
  assert.ok(Number.isNaN(occurrence('2026-02-29', '09:00')));
  assert.ok(Number.isFinite(occurrence('2028-02-29', '23:59')));
  assert.ok(Number.isNaN(occurrence('2026-11-13', '24:00')));
  assert.equal(nextOccurrence(schedule({ repeat: 'daily', time: '09:00' }), START), START + 86400000);
  assert.equal(nextOccurrence(schedule({ repeat: 'daily', time: '09:01' }), START), START + 60000);
});

test('schedule validation rejects ambiguous power, unsupported AC settings, invalid dates and nonfuture activations', () => {
  for (const invalid of [{ power: 'ON' }, { temp: 28 }, { temp: 20 }, { fan: 4 }, { mode: 3 }, { mode: '0' }, { time: '9:01' }, { date: '2026-02-30' }, { date: '2026-11-12' }, { time: '09:00' }, { repeat: 'weekly' }, { enabled: 1 }, { arbitrary: true }]) {
    assert.throws(() => validateSchedule(schedule(invalid), START));
  }
  assert.equal(validateSchedule(schedule({ enabled: false, date: '2026-11-12' }), START).enabled, false);
});

test('once schedule persists its claim before an exact payload publish and never repeats after restart', async t => {
  const f = await fixture(t);
  const item = await f.core.create(schedule());
  f.core.publish = async payload => {
    const saved = JSON.parse(await fs.readFile(f.options.storePath, 'utf8')).schedules[0];
    assert.equal(saved.enabled, false); assert.equal(saved.nextRunAt, null); assert.equal(saved.lastRun.status, 'sending');
    f.published.push(payload);
  };
  f.setTime(START + 60000);
  await Promise.all([f.core.tick(), f.core.tick(), f.core.tick()]);
  assert.deepEqual(f.published, [{ POWER: 1, TEMP: 25, MODE: 0, FAN: 2 }]);
  const stored = (await f.core.list()).schedules[0];
  assert.equal(stored.id, item.id); assert.equal(stored.enabled, false); assert.equal(stored.lastRun.status, 'sent');
  const restarted = new AcScheduler(f.options); await restarted.init(); await restarted.tick(); await restarted.close();
  assert.equal(f.published.length, 1);
});

test('daily schedule advances to tomorrow and executes each occurrence once', async t => {
  const f = await fixture(t);
  await f.core.create(schedule({ repeat: 'daily', power: false }));
  f.setTime(START + 60000); await f.core.tick(); await f.core.tick();
  assert.equal((await f.core.list()).schedules[0].nextRunAt, START + 86400000 + 60000);
  f.setTime(START + 86400000 + 60000); await f.core.tick(); await f.core.tick();
  assert.equal(f.published.length, 2); assert.deepEqual(f.published[0], { POWER: 0, TEMP: 25, MODE: 0, FAN: 2 });
});

test('broker failure or stale ESP32 fails the occurrence without queuing a future activation', async t => {
  for (const connection of [{ brokerConnected: false, deviceOnline: false }, { brokerConnected: true, deviceOnline: false }]) {
    const f = await fixture(t); await f.core.create(schedule());
    f.setConnection(connection); f.setTime(START + 60000); await f.core.tick();
    assert.equal((await f.core.list()).schedules[0].lastRun.status, 'failed');
    f.setConnection({ brokerConnected: true, deviceOnline: true }); await f.core.tick();
    assert.equal(f.published.length, 0);
  }
});

test('missed process ticks and all overdue restarts are skipped instead of caught up', async t => {
  const f = await fixture(t); await f.core.create(schedule());
  f.setTime(START + 121000); await f.core.tick();
  assert.equal((await f.core.list()).schedules[0].lastRun.status, 'missed'); assert.equal(f.published.length, 0);
  const restartFixture = await fixture(t); await restartFixture.core.create(schedule({ repeat: 'daily' }));
  restartFixture.setTime(START + 60001);
  const restarted = new AcScheduler(restartFixture.options); await restarted.init(); await restarted.tick();
  const restored = (await restarted.list()).schedules[0]; await restarted.close();
  assert.equal(restored.lastRun.status, 'missed'); assert.equal(restored.nextRunAt, START + 86400000 + 60000);
  assert.equal(restartFixture.published.length, 0);
});

test('a process interrupted after durable claim does not republish on restart', async t => {
  const f = await fixture(t); await f.core.create(schedule());
  const saved = JSON.parse(await fs.readFile(f.options.storePath, 'utf8'));
  Object.assign(saved.schedules[0], { enabled: false, nextRunAt: null, lastRun: { status: 'sending', scheduledAt: START + 60000, startedAt: START + 60000, finishedAt: null, message: 'กำลังส่งคำสั่ง', payload: { POWER: 1, TEMP: 25, MODE: 0, FAN: 2 } } });
  await fs.writeFile(f.options.storePath, JSON.stringify(saved));
  f.setTime(START + 61000);
  const restarted = new AcScheduler(f.options); await restarted.init(); await restarted.tick();
  assert.equal((await restarted.list()).schedules[0].lastRun.status, 'failed'); assert.equal(f.published.length, 0);
  await restarted.close();
});

test('publish errors are recorded once and only a newer matching device report confirms a sent command', async t => {
  const f = await fixture(t); await f.core.create(schedule());
  f.core.publish = async () => { throw new Error('network'); };
  f.setTime(START + 60000); await f.core.tick(); await f.core.tick();
  assert.equal((await f.core.list()).schedules[0].lastRun.status, 'failed');
  await f.core.create(schedule({ time: '09:02' }));
  f.core.publish = async payload => f.published.push(payload);
  f.setTime(START + 120000); await f.core.tick();
  const deviceState = { power: true, temp: 25, mode: 0, fan: 2 };
  f.setConnection({ brokerConnected: true, deviceOnline: true, lastStatusAt: START + 119999, deviceState }); await f.core.tick();
  assert.equal((await f.core.list()).schedules[1].lastRun.confirmedAt, undefined);
  f.setConnection({ brokerConnected: true, deviceOnline: true, lastStatusAt: START + 120001, deviceState }); await f.core.tick();
  assert.equal((await f.core.list()).schedules[1].lastRun.confirmedAt, START + 120001);
});

test('editing, pausing and deleting persist, and malformed storage is never overwritten', async t => {
  const f = await fixture(t); const item = await f.core.create(schedule());
  const changed = await f.core.update(item.id, { enabled: false, label: 'หยุดไว้ก่อน' });
  assert.equal(changed.nextRunAt, null); f.setTime(START + 60000); await f.core.tick(); assert.equal(f.published.length, 0);
  await f.core.remove(item.id); assert.equal((await f.core.list()).schedules.length, 0);
  await assert.rejects(f.core.remove(item.id), { status: 404 });
  await fs.writeFile(f.options.storePath, 'corrupt-data');
  const restarted = new AcScheduler(f.options);
  await assert.rejects(restarted.init(), { status: 503 });
  assert.equal(await fs.readFile(f.options.storePath, 'utf8'), 'corrupt-data');
});

test('opposing or duplicate schedules cannot race at the same time', async t => {
  const f = await fixture(t); await f.core.create(schedule({ repeat: 'daily' }));
  await assert.rejects(f.core.create(schedule({ power: false })), { status: 409 });
  const paused = await f.core.create(schedule({ power: false, enabled: false }));
  await assert.rejects(f.core.update(paused.id, { enabled: true }), { status: 409 });
  assert.equal((await f.core.list()).schedules[1].enabled, false);
});

test('late matching reports cannot retroactively confirm an old schedule send', async t => {
  const f = await fixture(t); await f.core.create(schedule());
  f.setTime(START + 60000); await f.core.tick();
  f.setTime(START + 71000);
  f.setConnection({ brokerConnected: true, deviceOnline: true, lastStatusAt: START + 71000, deviceState: { power: true, temp: 25, mode: 0, fan: 2 } });
  await f.core.tick();
  const run = (await f.core.list()).schedules[0].lastRun;
  assert.equal(run.confirmedAt, undefined); assert.equal(run.verification, 'timeout'); assert.equal(f.published.length, 1);
});

test('restored schedules fail closed for missing serialized control fields, null controls, and overlapping enabled times', async t => {
  for (const change of [item => { delete item.temp; }, item => { delete item.repeat; }, item => { item.temp = null; }]) {
    const f = await fixture(t); await f.core.create(schedule());
    const saved = JSON.parse(await fs.readFile(f.options.storePath, 'utf8')); change(saved.schedules[0]);
    const text = JSON.stringify(saved); await fs.writeFile(f.options.storePath, text);
    const restored = new AcScheduler(f.options); await assert.rejects(restored.init(), { status: 503 });
    assert.equal(await fs.readFile(f.options.storePath, 'utf8'), text); assert.equal(f.published.length, 0);
  }
  const f = await fixture(t); await f.core.create(schedule()); await f.core.create(schedule({ time: '09:02' }));
  const saved = JSON.parse(await fs.readFile(f.options.storePath, 'utf8')); saved.schedules[1].time = '09:01'; saved.schedules[1].nextRunAt = START + 60000;
  await fs.writeFile(f.options.storePath, JSON.stringify(saved));
  await assert.rejects(new AcScheduler(f.options).init(), { status: 503 }); assert.equal(f.published.length, 0);
});

test('a failed prepublish disk write records failure without sending, and disk recovery never replays it', async t => {
  const f = await fixture(t); await f.core.create(schedule());
  const persist = f.core.persist.bind(f.core);
  f.core.persist = async () => { throw new Error('disk full'); };
  f.setTime(START + 60000); await f.core.tick();
  let state = await f.core.list(), run = state.schedules[0].lastRun;
  assert.equal(run.status, 'failed'); assert.equal(run.finishedAt, START + 60000); assert.equal(state.status.storageReady, false);
  assert.match(state.status.storageError, /ดิสก์/); assert.equal(f.published.length, 0);
  f.core.persist = persist; await f.core.tick();
  state = await f.core.list(); assert.equal(state.status.storageReady, true); assert.equal(state.schedules[0].lastRun.status, 'failed');
  const restored = new AcScheduler(f.options); await restored.init(); await restored.tick(); await restored.close();
  assert.equal(f.published.length, 0);
});

test('a changed MQTT destination pauses old schedules and only explicit reenable binds the new room', async t => {
  const oldDestination = { ...DEFAULT_DESTINATION, commandTopic: 'room-a/ac', statusTopic: 'room-a/status' };
  const newDestination = { ...DEFAULT_DESTINATION, commandTopic: 'room-b/ac', statusTopic: 'room-b/status' };
  const packets = [];
  const f = await fixture(t, { destination: oldDestination, publish: async payload => packets.push({ topic: oldDestination.commandTopic, payload }) });
  const original = await f.core.create(schedule());
  const restored = new AcScheduler({ ...f.options, destination: newDestination, publish: async payload => packets.push({ topic: newDestination.commandTopic, payload }) });
  await restored.init();
  let item = (await restored.list()).schedules[0];
  assert.equal(item.enabled, false); assert.equal(item.nextRunAt, null); assert.equal(item.destinationMismatch, true); assert.match(item.pauseReason, /ปลายทาง/);
  assert.deepEqual(item.destination, original.destination);
  await restored.update(item.id, { label: 'แก้เฉพาะชื่อ' });
  item = (await restored.list()).schedules[0]; assert.equal(item.destinationMismatch, true); assert.deepEqual(item.destination, original.destination);
  f.setTime(START + 60000); await restored.tick(); assert.equal(packets.length, 0);
  item = await restored.update(item.id, { enabled: true, time: '09:02' });
  assert.equal(item.destinationMismatch, false); assert.equal(item.pauseReason, null); assert.equal(item.destination.fingerprint, destinationIdentity(newDestination).fingerprint);
  f.setTime(START + 120000); await restored.tick(); await restored.close();
  assert.deepEqual(packets, [{ topic: 'room-b/ac', payload: { POWER: 1, TEMP: 25, MODE: 0, FAN: 2 } }]);
});

test('daily schedules and legacy unbound schedules also pause across destination changes', async t => {
  const f = await fixture(t); const original = await f.core.create(schedule({ repeat: 'daily' }));
  const saved = JSON.parse(await fs.readFile(f.options.storePath, 'utf8')); delete saved.schedules[0].destination;
  await fs.writeFile(f.options.storePath, JSON.stringify(saved));
  const newDestination = { ...DEFAULT_DESTINATION, brokerUrl: 'mqtt://another-room.example:1883' };
  const restored = new AcScheduler({ ...f.options, destination: newDestination }); await restored.init();
  let item = (await restored.list()).schedules[0]; assert.equal(item.enabled, false); assert.equal(item.destination, null);
  f.setTime(START + 60000); await restored.tick(); assert.equal(f.published.length, 0);
  item = await restored.update(original.id, { enabled: true });
  assert.equal(item.nextRunAt, START + 86400000 + 60000); assert.equal(item.destination.brokerUrl, newDestination.brokerUrl);
  f.setTime(START + 86400000 + 60000); await restored.tick(); await restored.close(); assert.equal(f.published.length, 1);
});

test('malformed persisted destination cannot silently normalize or redirect a schedule', async t => {
  const f = await fixture(t); await f.core.create(schedule());
  const saved = JSON.parse(await fs.readFile(f.options.storePath, 'utf8'));
  saved.schedules[0].destination.commandTopic = 'room/#'; await fs.writeFile(f.options.storePath, JSON.stringify(saved));
  await assert.rejects(new AcScheduler(f.options).init(), { status: 503 }); assert.equal(f.published.length, 0);
});
