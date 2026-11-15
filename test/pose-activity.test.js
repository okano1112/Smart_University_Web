'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { updatePoseActivity, createPoseActivityClassifier } = require('../node-red/pose-activity');

const NOW = Date.parse('2026-11-14T16:00:00+07:00');
const WIDTH = 1280, HEIGHT = 720, TORSO = .105;
const counts = (result, name, count = 1) => assert.equal(result[name], count, JSON.stringify(result));

// Geometry fixtures exercise the rules, not real-camera recognition accuracy.
// Construct each point in frame-height units, then convert to normalized x/y.
function person(id, { pose = 'standing', center = .35, age = 0, speed = 0, cadence = 0, aspect = WIDTH / HEIGHT, confidence = .95 } = {}) {
    const x = center + speed * TORSO * age, hip = .45;
    const points = Array.from({ length: 17 }, () => ({ x: 0, y: 0, score: 0 }));
    const set = (i, px, py) => { points[i] = { x: px / aspect, y: py, score: confidence }; };
    for (const side of [0, 1]) {
        const sign = side ? 1 : -1;
        const sideX = x + sign * .022;
        set(5 + side, x + sign * .03, hip - TORSO);
        set(11 + side, sideX, hip);
        if (pose === 'seated') {
            set(13 + side, sideX + .093, hip + .014);
            set(15 + side, sideX + .10, hip + .129);
        } else if (pose === 'ambiguous') {
            set(13 + side, sideX + .074, hip + .078);
            set(15 + side, sideX + .060, hip + .188);
        } else if (pose === 'gait') {
            const stride = sign * .077 * Math.sin(Math.PI * cadence * age);
            const ankleY = hip + .245 - Math.max(0, -sign * Math.sin(Math.PI * cadence * age)) * .020;
            set(13 + side, sideX + .45 * stride, hip + .13);
            set(15 + side, sideX + stride, ankleY);
        } else {
            set(13 + side, sideX, hip + .125);
            set(15 + side, sideX, hip + .25);
        }
    }
    return { id, keypoints: points };
}

function frame(ms, people, width = WIDTH, height = HEIGHT) {
    return { captured_at: NOW + ms, width, height, people };
}

function feed(classifier, { from = 0, to = 1700, interval = 100, width = WIDTH, height = HEIGHT, people }) {
    let snapshot;
    for (let ms = from; ms <= to; ms += interval) {
        const f = frame(ms, people(ms), width, height);
        snapshot = classifier.update(f, { now: f.captured_at });
        assert.ok(snapshot);
        assert.equal(snapshot.seated + snapshot.standing + snapshot.walking + snapshot.running + snapshot.unknown, snapshot.total_people);
    }
    return snapshot;
}

test('starts unknown, then independently classifies sustained seated and standing poses', () => {
    const classifier = createPoseActivityClassifier();
    const people = () => [person('seated', { pose: 'seated' }), person('standing', { center: .9 })];
    counts(feed(classifier, { to: 500, people }), 'unknown', 2);
    const snapshot = feed(classifier, { from: 600, to: 800, people });
    assert.deepEqual(snapshot, { captured_at: NOW + 800, total_people: 2, seated: 1, standing: 1, walking: 0, running: 0, unknown: 0 });
});

test('posture and gait geometry corrects for camera aspect ratio', () => {
    for (const [width, height] of [[640, 640], [640, 960], [1920, 768]]) {
        const aspect = width / height;
        const classifier = createPoseActivityClassifier();
        const snapshot = feed(classifier, { width, height, to: 800, people: () => [person('s', { pose: 'seated', center: .26, aspect })] });
        counts(snapshot, 'seated');
        counts(feed(classifier, { width, height, from: 900, to: 2700, people: ms => [person('g', {
            pose: 'gait', age: (ms - 900) / 1000, speed: 1.6, cadence: 2.1, center: .19, aspect
        })] }), 'walking');
    }
});

test('walking and running need sustained translation plus alternating stride and plausible cadence', () => {
    for (const [activity, speed, cadence, center] of [['walking', 1.8, 2.0, .35], ['running', 4.5, 3.5, .21], ['walking', -1.7, 2.1, 1.3]]) {
        const classifier = createPoseActivityClassifier();
        const people = ms => [person('a', { pose: 'gait', center, speed, cadence, age: ms / 1000 })];
        const early = feed(classifier, { to: 1100, people });
        counts(early, activity, 0);
        counts(feed(classifier, { from: 1200, to: 1800, people }), activity);
    }
});

test('unobservable translation, sliding without steps and ambiguous speed stay unknown', () => {
    for (const [pose, speed, cadence] of [['gait', 0, 2.4], ['standing', 4.2, 0], ['gait', 3.4, 2.8], ['ambiguous', 0, 0]]) {
        const classifier = createPoseActivityClassifier();
        const snapshot = feed(classifier, { people: ms => [person('a', { pose, speed, cadence, age: ms / 1000 })] });
        counts(snapshot, 'unknown');
    }
});

test('visible vertical stepping without reliable lateral motion does not become standing', () => {
    const classifier = createPoseActivityClassifier();
    const snapshot = feed(classifier, { people: ms => {
        const track = person('a');
        const step = Math.sin(2 * Math.PI * ms / 850);
        track.keypoints[15].y -= .055 * Math.max(0, step);
        track.keypoints[16].y -= .055 * Math.max(0, -step);
        return [track];
    } });
    counts(snapshot, 'unknown');
});

test('the current frame clears occluded or changed activity immediately and requires new evidence', () => {
    const classifier = createPoseActivityClassifier();
    const standing = () => [person('track')];
    counts(feed(classifier, { to: 700, people: standing }), 'standing');
    const occluded = person('track');
    occluded.keypoints[16].score = .1;
    counts(feed(classifier, { from: 800, to: 800, people: () => [occluded] }), 'unknown');
    counts(feed(classifier, { from: 900, to: 1400, people: standing }), 'unknown');
    counts(feed(classifier, { from: 1500, to: 1500, people: standing }), 'standing');
    const seated = () => [person('track', { pose: 'seated' })];
    counts(feed(classifier, { from: 1600, to: 2100, people: seated }), 'unknown');
    counts(feed(classifier, { from: 2200, to: 2300, people: seated }), 'seated');
});

test('stopping after running removes gait before reporting standing', () => {
    const classifier = createPoseActivityClassifier();
    const speed = 4.3, center = .23, stop = 1400;
    counts(feed(classifier, { to: stop, people: ms => [person('track', { pose: 'gait', speed, center, cadence: 3.6, age: ms / 1000 })] }), 'running');
    const still = () => [person('track', { center: center + speed * TORSO * stop / 1000 })];
    counts(feed(classifier, { from: 1500, to: 1800, people: still }), 'unknown');
    counts(feed(classifier, { from: 1900, to: 2200, people: still }), 'standing');
});

test('explicit empty clears histories without pretending missing or malformed frames are empty', () => {
    const classifier = createPoseActivityClassifier();
    const track = () => [person('opaque-track')];
    counts(feed(classifier, { to: 800, people: track }), 'standing');
    const zero = feed(classifier, { from: 900, to: 900, people: () => [] });
    assert.deepEqual(zero, { captured_at: NOW + 900, total_people: 0, seated: 0, standing: 0, walking: 0, running: 0, unknown: 0 });
    counts(feed(classifier, { from: 1000, to: 1000, people: track }), 'unknown');
    assert.equal(classifier.update({ ...frame(2000, []), people: undefined }, { now: NOW + 2000 }), null);
});

test('large gaps, camera dimensions changes and track discontinuity cannot retain a prior label', () => {
    const classifier = createPoseActivityClassifier();
    const track = () => [person('same-id')];
    counts(feed(classifier, { to: 700, people: track }), 'standing');
    counts(feed(classifier, { from: 1500, to: 1500, people: track }), 'unknown');
    counts(feed(classifier, { from: 1600, to: 2200, people: track }), 'standing');
    const jump = () => [person('same-id', { center: 1 })];
    counts(feed(classifier, { from: 2300, to: 2300, people: jump }), 'unknown');
    counts(feed(classifier, { from: 2400, to: 3000, people: jump }), 'standing');
    counts(feed(classifier, { from: 3100, to: 3100, width: 640, height: 360, people: jump }), 'unknown');
});

test('schema, bounds, sample order and freshness are validated before modifying state', () => {
    const classifier = createPoseActivityClassifier();
    assert.equal(classifier.update(frame(0, []), { now: NOW - 1 }), null);
    assert.equal(classifier.update(frame(0, []), { now: NOW + 5001 }), null);
    assert.ok(classifier.update(frame(100, []), { now: NOW + 100 }));
    assert.equal(classifier.update(frame(100, []), { now: NOW + 200 }), null);
    assert.equal(classifier.update(frame(50, []), { now: NOW + 200 }), null);
    const broken = person('malformed'); broken.keypoints[0].x = '0.3';
    const list = [null, {}, frame(400, [person('same'), person('same')]), frame(400, [person('')]),
        frame(400, [{ id: 'bad', keypoints: Array(16).fill(null) }]), frame(400, [broken]), frame(400, [], 1, 720),
        frame(400, [], 4000, 100), frame(400, Array.from({ length: 65 }, (_, i) => person(String(i))))];
    for (const value of list) assert.equal(classifier.update(value, { now: NOW + 400 }), null);
    assert.ok(classifier.update(frame(200, []), { now: NOW + 400 }));
});

test('state is bounded, serializable, and embedded classifier emits aggregate only', () => {
    const embedded = vm.runInNewContext(`(${updatePoseActivity.toString()})`);
    let previous = null, result;
    for (let ms = 0; ms <= 3250; ms += 25) {
        result = embedded(frame(ms, [person('ephemeral-opaque-id')]), previous, { now: NOW + ms });
        previous = JSON.parse(JSON.stringify(result.state));
    }
    counts(result.snapshot, 'standing');
    const observations = result.state.tracks[0].observations;
    assert.ok(observations.length <= 32);
    assert.ok(NOW + 3250 - observations[0].at <= 2400);
    assert.doesNotMatch(JSON.stringify(result.snapshot), /id|keypoints|stride|scale/);
    assert.doesNotMatch(JSON.stringify(result.state), /keypoints|score/);
});
