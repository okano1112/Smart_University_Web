'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AcOccupancy } = require('../ac-occupancy');

const OFF = { power: false, temp: 23, mode: 1, fan: 3 };
const ON = { ...OFF, power: true };
const START = Date.parse('2026-11-20T08:00:00+07:00');
const BOTH = { offWhenEmpty: true, onWhenOccupied: true, emptyDelayMinutes: 1 };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bimclub-occupancy-'));
  const destination = {
    brokerUrl: 'mqtt://room-test:1883',
    commandTopic: 'room/ac',
    statusTopic: 'room/status',
    peopleTopic: 'room/people'
  };
  const connection = { brokerConnected: true, deviceOnline: true, deviceState: ON };
  const published = [];
  const storePath = path.join(directory, 'occupancy.json');
  let now = START;
  let failed = false;
  const engines = [];
  const create = () => {
    const engine = new AcOccupancy({
      storePath, now: () => now, connection: () => connection, destination: () => destination,
      publish: async payload => {
        published.push(payload);
        if (failed) throw new Error('offline');
      }
    });
    engines.push(engine);
    return engine;
  };
  const engine = create();
  t.after(async () => {
    await Promise.all(engines.map(item => item.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    engine, create, connection, destination, published, storePath,
    async configure(settings = BOTH) {
      const { status } = await engine.read();
      return engine.update({ ...settings, destinationFingerprint: status.destination.fingerprint });
    },
    advance(ms) { now += ms; },
    async count(people, advanceMs = 1000) {
      now += advanceMs;
      engine.observe(Buffer.from(JSON.stringify({ total_people: people, timestamp: now })));
      await engine.tick();
    },
    failPublish() { failed = true; }
  };
}

test('continuous zero starts a delay, a person cancels it, and the next sustained zero issues one off command', async t => {
  const f = await fixture(t);
  await f.configure();
  await f.count(0);
  const countdown = (await f.engine.read()).status;
  assert.equal(countdown.phase, 'empty-countdown');
  assert.equal(countdown.offDueAt, START + 61_000);
  await f.count(0, 20_000);
  await f.count(1, 20_000);
  assert.equal((await f.engine.read()).status.offDueAt, null);
  assert.equal(f.published.length, 0);

  await f.count(0, 1000);
  await f.count(0, 20_000);
  await f.count(0, 20_000);
  await f.count(0, 19_999);
  assert.equal(f.published.length, 0);
  await f.count(0, 1);
  await f.count(0);
  assert.deepEqual(f.published, [{ POWER: 0, TEMP: 23, MODE: 1, FAN: 3 }]);
  assert.equal((await f.engine.read()).status.lastAction.outcome, 'sent');
});

test('retained, stale, malformed and out-of-order camera reports cannot extend vacancy or activate a rule', async t => {
  const f = await fixture(t);
  await f.configure();
  f.engine.observe('0', true);
  f.engine.observe({ total_people: 0, people: 1 });
  f.engine.observe({ total_people: 0, timestamp: START - 31_000 });
  assert.equal((await f.engine.read()).status.phase, 'awaiting-reading');

  await f.count(0);
  f.advance(25_000);
  f.engine.observe({ total_people: 1, timestamp: START + 500 });
  f.engine.observe({ total_people: 0, timestamp: START + 1000 });
  assert.equal((await f.engine.read()).status.offDueAt, START + 61_000);

  f.advance(6000);
  await f.engine.tick();
  assert.equal((await f.engine.read()).status.phase, 'awaiting-reading');
  await f.count(0);
  assert.equal((await f.engine.read()).status.offDueAt, START + 93_000);
  f.engine.disconnect();
  assert.equal((await f.engine.read()).status.phase, 'awaiting-reading');
  await f.count(0);
  assert.equal((await f.engine.read()).status.offDueAt, START + 94_000);
  assert.equal(f.published.length, 0);
});

test('detection waits for a ready device and sends once using its current AC settings', async t => {
  const f = await fixture(t);
  await f.configure();
  f.connection.deviceOnline = false;
  f.connection.deviceState = OFF;
  await f.count(1);
  assert.equal((await f.engine.read()).status.phase, 'waiting-device');
  assert.equal(f.published.length, 0);
  f.connection.deviceOnline = true;
  f.connection.deviceState = { ...OFF, temp: 0 };
  await f.engine.tick();
  assert.equal(f.published.length, 0);

  f.connection.deviceState = OFF;
  await f.engine.tick();
  await f.count(3);
  f.engine.disconnect();
  await f.count(1);
  await f.count(2, 31_000);
  assert.deepEqual(f.published, [{ POWER: 1, TEMP: 23, MODE: 1, FAN: 3 }]);
});

test('zero-minute rules run after a fresh reading and no-op or failed attempts consume the episode', async t => {
  const f = await fixture(t);
  await f.configure({ ...BOTH, emptyDelayMinutes: 0 });
  await f.count(1); // Already on.
  f.connection.deviceState = OFF;
  await f.count(2); // Manual power change does not reopen the occupied episode.
  await f.count(0); // Already off.
  assert.equal(f.published.length, 0);
  f.failPublish();
  await f.count(1);
  await f.count(2);
  assert.equal(f.published.length, 1);
  assert.equal((await f.engine.read()).status.lastAction.outcome, 'failed');
});

test('settings default to disabled, persist, and require explicit rebind after the camera topic changes', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.engine.read()).settings, { offWhenEmpty: false, onWhenOccupied: false, emptyDelayMinutes: 5 });
  await assert.rejects(f.engine.update(BOTH), { status: 409 });
  await assert.rejects(f.configure({ ...BOTH, emptyDelayMinutes: 1.5 }), { status: 400 });
  await f.count(0);
  assert.equal(f.published.length, 0);

  const { status } = await f.configure();
  const restarted = f.create();
  assert.deepEqual((await restarted.read()).settings, BOTH);
  assert.equal((await restarted.read()).status.phase, 'awaiting-reading');

  f.destination.peopleTopic = 'other-room/people';
  restarted.observe('1');
  await restarted.tick();
  assert.equal((await restarted.read()).status.phase, 'destination-changed');
  assert.equal(f.published.length, 0);
  await assert.rejects(restarted.update({ ...BOTH, destinationFingerprint: status.destination.fingerprint }), { status: 409 });
  const { status: updated } = await restarted.read();
  await restarted.update({ ...BOTH, destinationFingerprint: updated.destination.fingerprint });
  assert.equal((await restarted.read()).status.phase, 'awaiting-reading');
  await restarted.update({ ...BOTH, offWhenEmpty: false, onWhenOccupied: false });
  assert.equal((await restarted.read()).status.phase, 'disabled');
});

test('a damaged settings file prevents commands until a new configuration is saved', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.storePath, '{broken');
  await f.count(0);
  assert.equal((await f.engine.read()).status.phase, 'storage-error');
  assert.deepEqual(f.published, []);
  await f.configure();
  assert.equal((await f.engine.read()).status.phase, 'awaiting-reading');
});
