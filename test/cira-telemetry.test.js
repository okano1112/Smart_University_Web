'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePeopleReading } = require('../public/js/cira-telemetry');

const NOW = Date.parse('2026-11-12T12:00:00+07:00');
const parse = (payload, options = {}) => parsePeopleReading(payload, { now: NOW, ...options });

test('CiRA accepts supported numeric counts and preserves an empty room', () => {
    for (const payload of [0, '0', ' 0 ', '"0"', { total_people: 0 }, { people: '0' }, { counts: { person: 0 } }]) {
        assert.deepEqual(parse(payload), { people: 0, at: NOW });
    }
    for (const payload of [23, '23', '{"total_people":23}', { people: '23' }, { counts: { person: '23' } }, { total_people: 23, people: 23, counts: { person: '23' } }]) {
        assert.deepEqual(parse(payload), { people: 23, at: NOW });
    }
    assert.deepEqual(parse(1000), { people: 1000, at: NOW });
});

test('CiRA rejects ambiguous counts instead of coercing them to zero', () => {
    for (const payload of [null, undefined, false, true, '', ' ', 'null', 'false', 'true', '[]', '{}', [], [0], {}, NaN, Infinity, -1, 1001, 1.1, '1.0', '1e2', '+1', '-0', '1 person', '0x10']) {
        assert.equal(parse(payload), null, String(payload));
    }
    for (const value of [false, true, null, '', '1.0', '1e2', [], {}, -1, 1001, 1.5]) {
        assert.equal(parse({ total_people: value }), null, String(value));
    }
});

test('CiRA rejects conflicting or invalid fields when multiple count formats occur', () => {
    for (const payload of [
        { total_people: 3, people: 4 }, { total_people: 0, counts: { person: 1 } },
        { total_people: 3, people: false }, { people: 3, counts: { person: null } },
        { counts: [] }, { counts: { persons: 3 } },
    ]) assert.equal(parse(payload), null);
});

test('CiRA accepts sample timestamps in milliseconds or ISO and keeps sample time', () => {
    const at = NOW - 12000;
    for (const sampleTime of [at, String(at), new Date(at).toISOString(), '2026-11-12T11:59:48+07:00']) {
        assert.deepEqual(parse({ total_people: 4, timestamp: sampleTime }), { people: 4, at });
        assert.deepEqual(parse({ people: 4, captured_at: sampleTime }), { people: 4, at });
    }
    assert.deepEqual(parse({ people: 4, timestamp: NOW - 30000 }), { people: 4, at: NOW - 30000 });
    assert.deepEqual(parse({ people: 4, timestamp: NOW + 5000 }), { people: 4, at: NOW });
});

test('CiRA discards retained, stale, future or invalid sample timestamps', () => {
    assert.equal(parse({ total_people: 3 }, { retained: true }), null);
    assert.equal(parse('0', { retained: true }), null);
    for (const time of [NOW - 30001, NOW + 5001, 0, -1, NaN, Infinity, null, false, '', 'bad date', '2026-11-12', '0', '1763000']) {
        assert.equal(parse({ people: 3, timestamp: time }), null, String(time));
    }
    assert.equal(parse({ people: 3, captured_at: NOW - 5001 }, { maxAgeMs: 5000 }), null);
});

test('bridge receipt cannot refresh stale sample time and older valid sample timestamp wins', () => {
    assert.equal(parse({ total_people: 3, timestamp: NOW - 30001, received_at: new Date(NOW).toISOString() }), null);
    assert.equal(parse({ total_people: 3, timestamp: NOW, captured_at: NOW - 30001 }), null);
    assert.deepEqual(parse({ total_people: 3, timestamp: NOW, captured_at: NOW - 12000, received_at: new Date(NOW).toISOString() }), { people: 3, at: NOW - 12000 });
    assert.deepEqual(parse({ total_people: 3, received_at: 'not a sample timestamp' }), { people: 3, at: NOW });
});
