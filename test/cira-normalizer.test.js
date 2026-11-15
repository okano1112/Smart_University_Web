'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { normalizeCira } = require('../node-red/normalize-cira');
const NOW = Date.parse('2026-11-12T08:00:00.000Z');
const normalize = (payload, options = {}) => normalizeCira(payload, { now: NOW, ...options });

test('normalizes scalar and explicit count schemas, including zero, into one canonical sample', () => {
  const values = [0, '0', 3, ' 3 ', { total_people: 3 }, { people: '3' },
    { person_count: 3 }, { counts: { person: 3, chair: 99 } }, '{"total_people":3}',
    Buffer.from('{"total_people":3}')];
  for (const value of values) {
    const expected = value === 0 || value === '0' ? 0 : 3;
    assert.deepEqual(normalize(value), {
      ok: true,
      data: { total_people: expected, source: 'mqtt', timestamp: NOW, received_at: '2026-11-12T08:00:00.000Z' }
    });
  }
  assert.equal(normalize({ total_people: 0 }).data.total_people, 0);
});

test('rejects invalid counts and unknown payloads instead of converting them to zero', () => {
  for (const value of [null, true, false, undefined, '', ' ', [], {}, { unknown: [] }]) {
    assert.equal(normalize(value).ok, false, JSON.stringify(value));
  }
  for (const value of [-1, 0.3, 1001, Infinity, NaN, '3 people', { total_people: null },
    { people: false }, { person_count: 1.2 }, { counts: { person: -2 } }]) {
    assert.equal(normalize(value).ok, false, String(value));
  }
  assert.equal(normalize('{not json}').code, 'INVALID_JSON');
  assert.equal(normalize(11, { maxPeople: 10 }).code, 'INVALID_COUNT');
});

test('explicit count fields must agree and remain authoritative over detection arrays', () => {
  assert.equal(normalize({ total_people: 3, people: '3', person_count: 3, counts: { person: 3 } }).ok, true);
  assert.equal(normalize({ total_people: 3, people: 0 }).code, 'COUNT_CONFLICT');
  assert.equal(normalize({ total_people: 3, counts: { person: 4 } }).code, 'COUNT_CONFLICT');
  assert.equal(normalize({ total_people: 0, detections: [{ nonsense: true }] }).data.total_people, 0);
  assert.equal(normalize({ total_people: 1, objects: [] }).data.total_people, 1);
});

test('counts only named person detections meeting the configured confidence', () => {
  const detections = [
    { label: 'person', confidence: 0.5 },
    { name: 'PERSON', score: 0.49 },
    { class_name: 'person' },
    { className: ' chair ', score: 0.99 },
    { label: 'person', confidence: 0.95, score: 0.95 }
  ];
  assert.equal(normalize({ detections }).data.total_people, 3);
  assert.equal(normalize({ objects: detections }, { minConfidence: 0.9 }).data.total_people, 2);
  assert.equal(normalize({ detections: [] }).data.total_people, 0);
  assert.equal(normalize({ objects: [{ label: 'chair' }] }).data.total_people, 0);
  assert.equal(normalize({ objects: [], detections: [] }).data.total_people, 0);
  assert.equal(normalize({ objects: [], detections: [{ label: 'person' }] }).code, 'DETECTION_CONFLICT');
  assert.equal(normalize({ objects: [{ label: 'person' }, { label: 'person' }] }, { maxPeople: 1 }).code, 'INVALID_COUNT');
});

test('malformed detection arrays and scores are rejected, including malformed non-person objects', () => {
  for (const detections of [null, {}, [null], [2], [[]], [{}], [{ label: '' }],
    [{ label: 0 }], [{ class: 'person' }], [{ label: 'person', name: 'chair' }],
    [{ label: 'person', confidence: '0.9' }], [{ label: 'person', confidence: null }],
    [{ label: 'person', score: Infinity }], [{ label: 'person', score: -0.1 }],
    [{ label: 'person', score: 1.1 }], [{ label: 'person', score: 0.7, confidence: 0.8 }],
    [{ label: 'chair', confidence: NaN }]]) {
    assert.equal(normalize({ detections }).code, 'INVALID_DETECTIONS', JSON.stringify(detections));
  }
});

test('preserves the sample timestamp, uses received time only as fallback, and validates age boundaries', () => {
  const sampleAt = NOW - 20000;
  for (const input of [{ timestamp: sampleAt }, { captured_at: new Date(sampleAt).toISOString() },
    { timestamp: sampleAt, captured_at: new Date(sampleAt).toISOString() }]) {
    const result = normalize({ total_people: 2, ...input });
    assert.equal(result.data.timestamp, sampleAt);
    assert.equal(result.data.received_at, new Date(NOW).toISOString());
  }
  assert.equal(normalize({ people: 2, timestamp: NOW - 30000 }).ok, true);
  assert.equal(normalize({ people: 2, timestamp: NOW - 30001 }).code, 'STALE_SAMPLE');
  assert.equal(normalize({ people: 2, timestamp: NOW + 5000 }).ok, true);
  assert.equal(normalize({ people: 2, timestamp: NOW + 5001 }).code, 'FUTURE_SAMPLE');
  assert.equal(normalize({ people: 2, captured_at: NOW - 40000 }, { maxAgeMs: 60000 }).ok, true);
  assert.equal(normalize({ people: 2, timestamp: NOW, captured_at: NOW - 1 }).code, 'TIMESTAMP_CONFLICT');
  for (const timestamp of [null, false, '', '2026-11-12', '2026-11-12T08:00:00',
    '2026-02-30T08:00:00Z', '2026-02-29T08:00:00Z', 'not-a-date', String(NOW), -1, 1.5]) {
    assert.equal(normalize({ total_people: 1, timestamp }).code, 'INVALID_TIMESTAMP', String(timestamp));
  }
});

test('rejects retained and invalid configuration, and bounds safe source values', () => {
  assert.equal(normalizeCira(2, null).code, 'INVALID_OPTIONS');
  assert.equal(normalizeCira(2, true).code, 'INVALID_OPTIONS');
  assert.equal(normalize({ people: 2 }, { retained: true }).code, 'RETAINED');
  for (const options of [{ now: NaN }, { now: 1e20 }, { maxPeople: -1 }, { maxPeople: 0.5 },
    { maxAgeMs: -1 }, { maxAgeMs: '30000' }, { minConfidence: -1 }, { minConfidence: 1.1 }]) {
    assert.equal(normalize(1, options).code, 'INVALID_OPTIONS');
  }
  assert.equal(normalize(2, { source: ' http camera\n1 ' }).data.source, 'http_camera_1');
  assert.equal(normalize(2, { source: 'x'.repeat(100) }).data.source.length, 50);
  assert.equal(normalize(2, { source: {} }).data.source, 'mqtt');
  assert.equal(normalize(2, { source: '' }).data.source, 'mqtt');
});

test('function can be embedded standalone in a Node-RED VM without require or Buffer', () => {
  const embedded = vm.runInNewContext('(' + normalizeCira.toString() + ')', {});
  const result = embedded('{"counts":{"person":2}}', { now: NOW, source: 'http' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), normalize('{"counts":{"person":2}}', { source: 'http' }));
  const malicious = {};
  Object.defineProperty(malicious, 'total_people', { enumerable: true, get() { throw new Error('bad getter'); } });
  assert.equal(normalize(malicious).ok, false);
});
