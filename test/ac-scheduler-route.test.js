'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AcScheduler } = require('../ac-scheduler');
const { createScheduleRouter } = require('../ac-scheduler-route');

test('schedule API validates and persists create/edit/delete without actuating hardware', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bimclub-schedule-api-'));
  const scheduler = new AcScheduler({ storePath: path.join(directory, 'schedules.json'), now: () => Date.parse('2026-11-13T09:00:00+07:00'), publish: () => assert.fail('API CRUD must never publish') });
  const app = express(); app.use(express.json()); app.use('/api/schedules', createScheduleRouter({ scheduler }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await scheduler.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/api/schedules`;
  const call = (suffix = '', method = 'GET', body) => fetch(url + suffix, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const empty = await call(); assert.equal(empty.headers.get('cache-control'), 'no-store'); assert.equal((await empty.json()).timezone, 'Asia/Bangkok');
  const bad = await call('', 'POST', { power: 'ON', time: '09:01', repeat: 'daily' }); assert.equal(bad.status, 400);
  const created = await call('', 'POST', { power: true, time: '09:01', repeat: 'daily', temp: 25, mode: 0, fan: 2, enabled: true });
  assert.equal(created.status, 201); const item = (await created.json()).schedule;
  const edited = await call(`/${item.id}`, 'PATCH', { enabled: false }); assert.equal((await edited.json()).schedule.nextRunAt, null);
  assert.equal((await (await call()).json()).schedules.length, 1);
  assert.equal((await call(`/${item.id}`, 'DELETE')).status, 200);
  assert.equal((await call(`/${item.id}`, 'PATCH', { enabled: true })).status, 404);
  assert.equal((await (await call()).json()).schedules.length, 0);
});
