'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('../public/js/ac-occupancy');

const destination = {
    brokerUrl: 'mqtt://broker.example:1883', commandTopic: 'room/ac/set', statusTopic: 'room/ac/status',
    peopleTopic: 'room/people', fingerprint: 'current'
};
const connection = { mqttUrl: 'wss://broker.example:8084/mqtt', command: 'room/ac/set', status: 'room/ac/status', people: 'room/people' };
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element extends EventTarget {
    value = '';
    checked = false;
    dataset = {};
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
    reportValidity() { return true; }
}

function fixture(t, { browser = connection, settings = {}, rejectSave = false } = {}) {
    const ids = ['ac-occupancy-form', 'ac-occupancy-status', 'ac-occupancy-action', 'ac-occupancy-message',
        'ac-occupancy-fields', 'ac-off-when-empty', 'ac-on-when-occupied', 'ac-empty-delay', 'btn-save-ac-occupancy'];
    const elements = new Map(ids.map(id => [id, new Element()]));
    const document = new EventTarget();
    const $ = id => elements.get(id);
    document.getElementById = $;
    const form = $('ac-occupancy-form');
    const snapshot = {
        settings: { offWhenEmpty: false, onWhenOccupied: false, emptyDelayMinutes: 5, ...settings },
        status: { phase: 'disabled', destination }
    };
    const saves = [];
    const client = install({ document, connection: () => browser, fetch: async (url, options) => {
        assert.equal(url, '/api/ac-occupancy');
        if (options.method === 'PUT') {
            saves.push(JSON.parse(options.body));
            if (rejectSave) return { ok: false, json: async () => ({ error: 'บันทึกไม่สำเร็จ' }) };
            const { destinationFingerprint, ...saved } = saves.at(-1);
            snapshot.settings = saved;
        }
        return { ok: true, json: async () => structuredClone(snapshot) };
    } });
    t.after(() => client.destroy());
    return { client, snapshot, saves, $,
        edit() { form.dispatchEvent(new Event('input')); },
        submit() { form.dispatchEvent(new Event('submit', { cancelable: true })); }
    };
}

test('occupancy refresh shows current status while preserving unsaved edits and accepts a zero-minute delay', async t => {
    const h = fixture(t);
    await tick();
    assert.equal(h.$('ac-empty-delay').disabled, true);
    h.$('ac-off-when-empty').checked = true;
    h.$('ac-empty-delay').value = '0';
    h.edit();
    assert.equal(h.$('ac-empty-delay').disabled, false);
    h.snapshot.status.phase = 'occupied';
    h.snapshot.status.people = 2;
    await h.client.refresh();
    assert.equal(h.$('ac-empty-delay').value, '0');
    assert.match(h.$('ac-occupancy-status').textContent, /2 คน/);
    h.submit();
    await tick();
    assert.deepEqual(h.saves, [{ offWhenEmpty: true, onWhenOccupied: false, emptyDelayMinutes: 0, destinationFingerprint: 'current' }]);
    assert.match(h.$('ac-occupancy-message').textContent, /บันทึกการตั้งค่าแล้ว/);
});

test('a different browser people topic blocks activation and still allows disabling', async t => {
    const h = fixture(t, { browser: { ...connection, people: 'other/people' }, settings: { onWhenOccupied: true } });
    await tick();
    assert.match(h.$('ac-occupancy-status').textContent, /ไม่ตรงกัน/);
    h.submit();
    await tick();
    assert.equal(h.saves.length, 0);
    h.$('ac-on-when-occupied').checked = false;
    h.edit();
    h.submit();
    await tick();
    assert.deepEqual(h.saves, [{ offWhenEmpty: false, onWhenOccupied: false, emptyDelayMinutes: 5, destinationFingerprint: 'current' }]);
});

test('invalid delay is rejected before saving and a failed save keeps the values in the form', async t => {
    const h = fixture(t, { rejectSave: true });
    await tick();
    h.$('ac-off-when-empty').checked = true;
    h.$('ac-empty-delay').value = '1.5';
    h.edit();
    h.submit();
    await tick();
    assert.equal(h.saves.length, 0);
    h.$('ac-empty-delay').value = '10';
    h.edit();
    h.submit();
    await tick();
    assert.equal(h.saves.length, 1);
    assert.equal(h.$('ac-empty-delay').value, '10');
    assert.equal(h.$('ac-off-when-empty').checked, true);
    assert.match(h.$('ac-occupancy-message').textContent, /บันทึกไม่สำเร็จ/);
});
