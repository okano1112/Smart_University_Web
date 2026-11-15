'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { install, connectionMatches, formatDateTime, bangkokDate, validateDraft } = require('../public/js/ac-schedules');

const NOW = Date.parse('2026-11-13T00:30:00+07:00');
const status = { brokerConnected: true, deviceOnline: true, lastStatusAt: NOW,
    brokerUrl: 'mqtt://broker.emqx.io:1883', commandTopic: 'room/ac/set', statusTopic: 'room/ac/status' };
const connection = { mqttUrl: 'wss://broker.emqx.io:8084/mqtt', command: 'room/ac/set', status: 'room/ac/status' };
const draft = patch => ({ label: 'เปิดตอนเช้า', power: true, repeat: 'once', date: '2026-11-13', time: '08:30', temp: 25, mode: 0, fan: 2, enabled: true, ...patch });
const schedule = patch => ({ id: 'first', ...draft({ date: '2099-01-01' }), nextRunAt: Date.parse('2099-01-01T08:30:00+07:00'), lastRun: null, ...patch });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const response = (data, ok = true) => ({ ok, json: async () => data });

test('schedule connection guard matches broker host and exact command/status topics', () => {
    assert.equal(connectionMatches(connection, status), true);
    assert.equal(connectionMatches({ ...connection, mqttUrl: 'ws://BROKER.EMQX.IO.:8083/mqtt' }, status), true);
    for (const patch of [{ mqttUrl: 'wss://other.example/mqtt' }, { command: 'room/ac/set/' }, { status: 'other/status' }, { mqttUrl: 'not a url' }]) {
        assert.equal(connectionMatches({ ...connection, ...patch }, status), false);
    }
    assert.equal(connectionMatches(connection, null), false);
});

test('schedule date and display use Bangkok regardless of the client clock zone', () => {
    assert.equal(bangkokDate(NOW), '2026-11-13');
    const text = formatDateTime(NOW);
    assert.match(text, /00:30/);
    assert.match(text, /13/);
    assert.equal(formatDateTime('not a date'), '—');
    assert.equal(formatDateTime(null), '—');
});

test('schedule draft validates dates and supported hardware values before saving', () => {
    assert.deepEqual(validateDraft(draft({}), { now: NOW }).value, draft({}));
    assert.equal(validateDraft(draft({ date: '2026-11-12' }), { now: NOW }).value, undefined);
    assert.ok(validateDraft(draft({ date: '2026-11-12', enabled: false }), { now: NOW }).value);
    for (const patch of [{ date: '2026-02-30' }, { time: '24:00' }, { time: '8:30' }, { temp: 28 }, { mode: 3 }, { fan: -1 }, { repeat: 'weekly' }, { enabled: 'true' }, { power: 1 }, { label: 'a'.repeat(81) }]) {
        assert.ok(validateDraft(draft(patch), { now: NOW }).error, JSON.stringify(patch));
    }
    const daily = validateDraft(draft({ repeat: 'daily', date: '' }), { now: NOW }).value;
    assert.equal(daily.date, undefined);
    assert.equal(daily.repeat, 'daily');
});

class Element extends EventTarget {
    constructor(document, tag = 'div') {
        super(); this.document = document; this.tagName = tag; this.children = []; this.attributes = {};
        this.value = ''; this.textContent = ''; this.checked = false; this.disabled = false; this.hidden = false; this.dataset = {};
    }
    set id(value) { this._id = value; this.document.elements.set(value, this); }
    get id() { return this._id || ''; }
    append(...elements) { for (const element of elements) { element.parent = this; this.children.push(element); } }
    replaceChildren(...elements) { this.children.forEach(element => { element.parent = null; }); this.children = []; this.append(...elements); }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.document.activeElement = this; }
    reportValidity() { return true; }
}
function fixture({ state = status, list = [schedule()], handler } = {}) {
    const document = new EventTarget(); document.elements = new Map(); document.hidden = false;
    document.getElementById = id => document.elements.get(id) || null;
    document.createElement = tag => new Element(document, tag);
    const ids = ['schedule-list', 'schedule-status', 'schedule-server-detail', 'schedule-message', 'btn-add-schedule',
        'schedule-editor', 'schedule-form', 'schedule-id', 'schedule-label', 'schedule-power', 'schedule-repeat',
        'schedule-date', 'schedule-time', 'schedule-temp', 'schedule-mode', 'schedule-fan', 'schedule-enabled',
        'btn-save-schedule', 'btn-cancel-schedule', 'schedule-date-field', 'schedule-ac-fields'];
    ids.forEach(id => { const element = new Element(document); element.id = id; });
    const $ = id => document.getElementById(id), requests = [], notices = [];
    $('schedule-editor').hidden = true;
    const client = install({ document, notice: (...args) => notices.push(args), connection: () => connection,
        current: () => ({ temp: 24, mode: 1, fan: 3 }),
        fetch: async (url, options) => {
            const call = { url, ...options }; requests.push(call);
            if (handler) { const result = handler(call, requests.length); if (result) return result; }
            return response({ schedules: list, status: state, timezone: 'Asia/Bangkok' });
        } });
    return { client, document, $, requests, notices, click: id => $(id).dispatchEvent(new Event('click')), submit: () => $('schedule-form').dispatchEvent(new Event('submit', { cancelable: true })) };
}

test('schedule polls update the list without overwriting an unsaved form', async () => {
    const h = fixture();
    try {
        await tick(); h.click('btn-add-schedule');
        assert.equal(h.$('schedule-editor').hidden, false);
        assert.equal(h.$('schedule-temp').value, '24');
        h.$('schedule-label').value = 'ยังไม่ได้บันทึก';
        h.$('schedule-time').value = '14:45';
        await h.client.refresh();
        assert.equal(h.$('schedule-label').value, 'ยังไม่ได้บันทึก');
        assert.equal(h.$('schedule-time').value, '14:45');
        assert.equal(h.$('schedule-editor').hidden, false);
        assert.equal(h.requests.filter(request => request.method).length, 0);
    } finally { h.client.destroy(); }
});

test('schedule save sends a validated snapshot then reloads and closes its editor', async () => {
    const h = fixture();
    try {
        await tick(); h.click('btn-add-schedule');
        h.$('schedule-label').value = 'เปิดห้องเรียน'; h.$('schedule-date').value = '2099-01-01'; h.$('schedule-time').value = '09:10';
        h.submit(); await tick(); await tick();
        const save = h.requests.find(request => request.method === 'POST');
        assert.equal(save.url, '/api/schedules');
        assert.deepEqual(JSON.parse(save.body), { label: 'เปิดห้องเรียน', power: true, repeat: 'once', date: '2099-01-01', time: '09:10', temp: 24, mode: 1, fan: 3, enabled: true });
        assert.equal(h.$('schedule-editor').hidden, true);
        assert.equal(h.requests.at(-1).url, '/api/schedules');
        assert.match(h.$('schedule-message').textContent, /บันทึกกำหนดเวลาแล้ว/);
    } finally { h.client.destroy(); }
});

test('schedule mismatch blocks enabling but permits pausing and storing a disabled draft', async () => {
    const h = fixture({ state: { ...status, commandTopic: 'another/room' } });
    try {
        await tick();
        assert.match(h.$('schedule-status').textContent, /ปลายทางไม่ตรงกัน/);
        h.click('btn-add-schedule'); h.$('schedule-date').value = '2099-01-01'; h.submit(); await tick();
        assert.equal(h.requests.some(request => request.method === 'POST'), false);
        h.$('schedule-enabled').checked = false; h.submit(); await tick(); await tick();
        assert.equal(JSON.parse(h.requests.find(request => request.method === 'POST').body).enabled, false);
        h.click('schedule-first-toggle'); await tick(); await tick();
        assert.deepEqual(JSON.parse(h.requests.find(request => request.method === 'PATCH').body), { enabled: false });
    } finally { h.client.destroy(); }
});

test('schedule delete requires an inline second confirmation', async () => {
    const h = fixture();
    try {
        await tick(); h.click('schedule-first-delete'); await tick();
        assert.equal(h.requests.some(request => request.method === 'DELETE'), false);
        assert.equal(h.$('schedule-first-delete-confirm').textContent, 'ยืนยันลบ');
        h.click('schedule-first-delete-cancel');
        assert.equal(h.requests.some(request => request.method === 'DELETE'), false);
        h.click('schedule-first-delete'); h.click('schedule-first-delete-confirm'); await tick(); await tick();
        assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1);
    } finally { h.client.destroy(); }
});

test('schedule write invalidates a slow earlier poll and hidden pages pause refreshing', async () => {
    const oldPoll = deferred(); let reads = 0;
    const h = fixture({ handler: request => {
        if (!request.method && ++reads === 2) return oldPoll.promise;
    } });
    try {
        await tick(); const pending = h.client.refresh();
        h.click('schedule-first-toggle'); await tick(); await tick();
        oldPoll.resolve(response({ schedules: [], status: { ...status, brokerConnected: false } })); await pending;
        assert.match(h.$('schedule-status').textContent, /พร้อมส่งคำสั่ง/);
        assert.equal(h.$('schedule-list').children.length, 1);
        h.document.hidden = true; h.document.dispatchEvent(new Event('visibilitychange'));
        const previous = h.requests.length; await h.client.refresh(); assert.equal(h.requests.length, previous);
        h.document.hidden = false; h.document.dispatchEvent(new Event('visibilitychange')); await tick();
        assert.equal(h.requests.length, previous + 1);
    } finally { h.client.destroy(); }
});

test('schedule failed write leaves edited values available and reports the error', async () => {
    const h = fixture({ handler: request => request.method === 'POST' ? response({ error: 'บันทึกไฟล์ไม่ได้' }, false) : null });
    try {
        await tick(); h.click('btn-add-schedule'); h.$('schedule-label').value = 'เก็บข้อความนี้'; h.$('schedule-date').value = '2099-01-01';
        h.submit(); await tick(); await tick();
        assert.equal(h.$('schedule-editor').hidden, false);
        assert.equal(h.$('schedule-label').value, 'เก็บข้อความนี้');
        assert.equal(h.$('schedule-message').textContent, 'บันทึกไฟล์ไม่ได้');
        assert.equal(h.$('btn-save-schedule').disabled, false);
    } finally { h.client.destroy(); }
});

test('schedule editor defaults and validation follow server time when the browser clock differs', async () => {
    const h = fixture({ state: { ...status, serverTime: NOW } });
    try {
        await tick(); h.click('btn-add-schedule');
        assert.equal(h.$('schedule-date').value, '2026-11-13');
        assert.equal(h.$('schedule-time').value, '00:35');
        h.$('schedule-time').value = '00:31'; h.submit(); await tick(); await tick();
        assert.ok(h.requests.some(request => request.method === 'POST'));
    } finally { h.client.destroy(); }
});

test('schedules paused after a destination change explain the pause and require explicit re-enabling', async () => {
    const item = schedule({ enabled: false, destinationMismatch: true, pauseReason: 'Broker หรือ Topic เปลี่ยนจากที่บันทึกไว้', nextRunAt: null });
    const h = fixture({ list: [item] });
    try {
        await tick();
        const main = h.$('schedule-list').children[0].children[0];
        assert.ok(main.children.some(child => child.textContent.includes(item.pauseReason)));
        assert.equal(h.$('schedule-first-toggle').textContent, 'ใช้กับปลายทางนี้');
        assert.match(h.$('schedule-first-toggle').attributes['aria-label'], /เปิดใช้กับปลายทางปัจจุบัน/);
        h.click('schedule-first-edit');
        assert.equal(h.$('schedule-enabled').checked, false);
        assert.match(h.$('schedule-message').textContent, /Broker หรือ Topic เปลี่ยน/);
        assert.match(h.$('schedule-message').textContent, /broker\.emqx\.io \/ room\/ac\/set/);
        assert.equal(h.requests.some(request => request.method), false);
        h.click('btn-cancel-schedule'); h.click('schedule-first-toggle'); await tick(); await tick();
        assert.deepEqual(JSON.parse(h.requests.find(request => request.method === 'PATCH').body), { enabled: true });
    } finally { h.client.destroy(); }
});

test('schedule storage failure is shown as an error and blocks activation', async () => {
    const h = fixture({ state: { ...status, storageReady: false, storageError: 'ไม่มีสิทธิ์เขียนไฟล์ตารางเวลา' }, list: [schedule({ enabled: false })] });
    try {
        await tick();
        assert.equal(h.$('schedule-status').textContent, 'บันทึกตารางเวลาไม่ได้ · กรุณาตรวจเซิร์ฟเวอร์');
        assert.equal(h.$('schedule-status').dataset.state, 'error');
        assert.match(h.$('schedule-server-detail').textContent, /ไม่มีสิทธิ์เขียนไฟล์/);
        h.click('schedule-first-toggle'); await tick();
        assert.equal(h.requests.some(request => request.method === 'PATCH'), false);
        assert.match(h.$('schedule-message').textContent, /บันทึกตารางเวลาไม่ได้/);
        h.click('btn-add-schedule'); h.$('schedule-date').value = '2099-01-01'; h.submit(); await tick();
        assert.equal(h.requests.some(request => request.method === 'POST'), false);
    } finally { h.client.destroy(); }
});
