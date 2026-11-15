'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { install, readMetrics, parseResult, activityAge, canApply } = require('../public/js/cira-activity');

const NOW = Date.parse('2026-11-14T14:40:00+07:00');
const metrics = patch => ({
    ac: { power: true, mode: 0, temp: 25, fan: 2, ageMs: 600 },
    temperature: { value: 27.5, ageMs: 300 }, humidity: { value: 60, ageMs: 400 }, people: { value: 4, ageMs: 500 },
    sensorFresh: true, mqttConnected: true, roomMatches: true, canApply: true, pending: false, ...patch
});
const counts = patch => ({ total_people: 4, seated: 0, standing: 0, walking: 3, running: 1, unknown: 0, ...patch });
const recommendation = patch => ({ status: 'suggested', target: 24, currentTarget: 25, delta: -1, calculatedAt: NOW,
    reason: 'คนส่วนใหญ่เดินหรือวิ่งต่อเนื่องและห้องค่อนข้างอุ่น', evidence: ['ใช้ข้อมูลต่อเนื่อง 25 วินาที'], ...patch });
const pose = patch => ({ source: 'cira', serverTime: NOW, lastReceivedAt: NOW - 700, stale: false,
    activity: { captured_at: NOW - 500, ...counts() }, events: [
        { at: NOW - 700, stage: 'received' }, { at: NOW - 600, stage: 'classified', activity: counts() }
    ], ...patch });
const data = patch => ({ serverTime: NOW, pose: pose(), recommendation: recommendation(), ...patch });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('activity recommendation request includes only validated room measurement and AC fields', () => {
    const current = metrics({
        temperature: { value: 27.5, ageMs: 300, raw: 'private' }, humidity: { value: 101, ageMs: 100 },
        ac: { power: true, mode: 0, temp: 25, fan: 2, ageMs: 600, mqttTopic: 'private' },
        skeleton: [1, 2], username: 'private', password: 'private'
    });
    assert.deepEqual(readMetrics(current), {
        temperature: { value: 27.5, ageMs: 300 }, people: { value: 4, ageMs: 500 },
        ac: metrics().ac, roomMatches: true, mqttConnected: true, canApply: true, pending: false, sensorFresh: true
    });
});

test('comfort history is projected to the newest 50 consistent aggregate readings', () => {
    const sample = (at, extra = {}) => ({ at, temperature: 27.5, people: 4, ...extra });
    const history = Array.from({ length: 55 }, (_, i) => sample(NOW - (54 - i) * 5_000));
    assert.deepEqual(readMetrics(metrics({ comfortHistory: history, observedAt: NOW })).comfortHistory, history.slice(-50));

    const valid = [sample(NOW - 300_000), sample(NOW - 10_000), sample(NOW, { people: 0 })];
    const incoming = [sample(NOW - 300_001), { ...valid[0], trackId: 'private' }, sample(NOW - 20_000, { people: 1.2 }),
        valid[1], sample(NOW - 11_000), sample(NOW - 10_000), sample(NOW - 5_000, { temperature: 61 }),
        sample(NOW + 1), sample('invalid'), null, valid[2]];
    const projected = readMetrics(metrics({ comfortHistory: incoming, observedAt: NOW }));
    assert.deepEqual(projected.comfortHistory, valid);
    assert.equal(projected.observedAt, NOW);
    assert.ok(!('comfortHistory' in readMetrics(metrics({ comfortHistory: valid }))));
    assert.ok(!('comfortHistory' in readMetrics(metrics({ comfortHistory: { sample: valid[0] }, observedAt: NOW }))));
});

test('activity parser drops person IDs, raw positions and event details and rejects inconsistent totals', () => {
    const raw = data({ pose: pose({
        activity: { ...pose().activity, personIds: ['not-for-ui'], skeleton: [] },
        events: [{ at: NOW - 500, stage: 'classified', id: 'not-for-ui', activity: { ...counts(), trackId: 'private' } },
            { at: NOW - 400, stage: 'rejected', code: 'unknown private string', message: 'do not render' },
            { at: NOW, stage: 'toString' }]
    }) });
    const parsed = parseResult(raw);
    assert.deepEqual(parsed.pose.activity, pose().activity);
    assert.deepEqual(parsed.pose.events, [
        { at: NOW - 400, stage: 'rejected', code: null, activity: null },
        { at: NOW - 500, stage: 'classified', code: null, activity: counts() }
    ]);
    assert.equal(parseResult(data({ pose: pose({ activity: { ...pose().activity, total_people: 5 } }) })).pose.activity, null);
});

test('staleness uses both capture and receive age without depending on browser clock epoch', () => {
    const receivedAt = NOW + 7 * 3600_000;
    const parsed = parseResult(data());
    assert.equal(activityAge({ data: parsed, receivedAt }, receivedAt + 4300), 5000);
    assert.equal(activityAge({ data: parsed, receivedAt }, receivedAt + 4301), 5001);
    assert.equal(activityAge({ data: parseResult(data({ pose: pose({ stale: true }) })), receivedAt }, receivedAt), Infinity);
    assert.equal(activityAge({ data: parseResult(data({ pose: pose({ ageMs: 4900 }) })), receivedAt }, receivedAt + 101), 5001);
});

test('manual apply requires the same live AC, room and temperature recommendation', () => {
    assert.equal(canApply(recommendation(), metrics()), true);
    for (const patch of [
        { pending: true }, { mqttConnected: false }, { roomMatches: false }, { sensorFresh: false }, { canApply: false },
        { humidity: { value: 60, ageMs: 30_001 } }, { ac: { ...metrics().ac, temp: 26 } },
        { ac: { ...metrics().ac, mode: 2 } }, { ac: { ...metrics().ac, ageMs: 75_001 } }
    ]) assert.equal(canApply(recommendation(), metrics(patch)), false);
    for (const patch of [{ status: 'hold' }, { target: 23, delta: -2 }, { target: 24, delta: 1 }]) {
        assert.equal(canApply(recommendation(patch), metrics()), false);
    }
});

class Element extends EventTarget {
    constructor() { super(); this.textContent = ''; this.children = []; this.dataset = {}; this.hidden = true; this.disabled = true; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
}

function fixture() {
    const document = new EventTarget();
    const elements = new Map();
    document.visibilityState = 'visible';
    document.createElement = () => new Element();
    const $ = document.getElementById = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const requests = [], commands = [];
    let snapshot = metrics(), response = data(), now = NOW, fail = false;
    const client = install({ document, now: () => now, metrics: () => snapshot,
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (fail) throw new Error('offline');
            return { ok: true, json: async () => response };
        },
        apply: async command => { commands.push(command); return true; }
    });
    return { $, client, commands, requests,
        metrics: value => { snapshot = value; }, response: value => { response = value; },
        time: value => { now = value; }, offline: value => { fail = value; },
        click: () => $('cira-comfort-apply').dispatchEvent(new Event('click')),
        openLog: () => { $('cira-logs').open = true; $('cira-logs').dispatchEvent(new Event('toggle')); }
    };
}

test('room flow renders fresh counts and recommendation, applies only on click, and removes stale data', async () => {
    const h = fixture();
    try {
        await tick();
        const button = h.$('cira-comfort-apply');
        assert.equal(h.requests[0].url, '/api/comfort/recommendation');
        assert.equal(h.requests[0].options.method, 'POST');
        assert.equal(h.$('cira-walking').textContent, '3');
        assert.equal(h.$('cira-seated').textContent, '0');
        assert.equal(h.$('cira-comfort-target').textContent, '24°C');
        assert.match(h.$('cira-comfort-delta').textContent, /ลด 1°C/);
        assert.equal(button.disabled, false);
        assert.deepEqual(h.commands, []);
        h.openLog();
        assert.match(h.$('cira-activity-log-received').textContent, /Node-RED รับ/);
        assert.match(h.$('cira-activity-log-comfort').textContent, /มีคำแนะนำ 24°C/);
        assert.equal(h.$('cira-activity-log-events').children.length, 2);
        h.click(); await tick();
        assert.deepEqual(h.commands.map(command => command.target), [24]);
        assert.match(h.$('cira-comfort-feedback').textContent, /รอ ESP32 รายงานสถานะ/);
        h.time(NOW + 4301); h.openLog();
        assert.equal(h.$('cira-walking').textContent, '—');
        assert.equal(button.hidden, true);
        h.click(); await tick();
        assert.equal(h.commands.length, 1);
    } finally { h.client.stop(); }
});

test('periodic recommendation requests send one bounded history with its browser observation time', async () => {
    const h = fixture();
    try {
        await tick();
        const aggregate = { at: NOW - 1000, temperature: 27.5, people: 4 };
        h.metrics(metrics({ observedAt: NOW, peopleStableMs: 60_000, comfortHistory: [{ ...aggregate, raw: 'private' }] }));
        await h.client.refresh();
        const { observedAt, peopleStableMs, comfortHistory } = JSON.parse(h.requests.at(-1).options.body);
        assert.equal(observedAt, NOW);
        assert.equal(peopleStableMs, 60_000);
        assert.deepEqual(comfortHistory, [aggregate]);
        assert.equal(h.commands.length, 0);
    } finally { h.client.stop(); }
});

test('a count or temperature change invalidates displayed advice before the next response', async () => {
    const h = fixture();
    try {
        await tick();
        assert.equal(h.$('cira-comfort-value').hidden, false);
        h.metrics(metrics({ people: { value: 5, ageMs: 0 } }));
        h.openLog();
        assert.equal(h.$('cira-comfort-value').hidden, true);
        h.click(); await tick();
        assert.deepEqual(h.commands, []);
    } finally { h.client.stop(); }
});

test('room mismatch and bridge failure clear live suggestions without claiming zero people', async () => {
    const h = fixture();
    try {
        await tick();
        h.metrics(metrics({ roomMatches: false }));
        h.openLog();
        assert.equal(h.$('cira-comfort-value').hidden, true);
        h.click(); await tick();
        assert.equal(h.commands.length, 0);
        h.metrics(metrics());
        h.response(data({ pose: null, recommendation: recommendation({ status: 'unavailable', target: null, delta: null, reason: 'Node-RED ยังไม่ได้โหลด Flow รับ Skeleton' }) }));
        await h.client.refresh();
        assert.equal(h.$('cira-seated').textContent, '—');
        assert.match(h.$('cira-comfort-reason').textContent, /ยังไม่ได้โหลด/);
        h.offline(true);
        await h.client.refresh();
        assert.match(h.$('cira-activity-status').textContent, /ติดต่อข้อมูลกิจกรรมไม่ได้/);
        assert.equal(h.$('cira-comfort-apply').hidden, true);
    } finally { h.client.stop(); }
});
