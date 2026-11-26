'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recommendComfort, asActivity } = require('../comfort-recommendation');
const { createComfortHandler } = require('../comfort-route');

const now = 1760000000000;
const full = { roomMatches: true, mqttConnected: true, sensorFresh: true, pending: false,
    temperature: { value: 26, ageMs: 2000 }, humidity: { value: 56, ageMs: 2000 },
    people: { value: 3, ageMs: 2000 }, ac: { power: true, mode: 0, temp: 25, ageMs: 2000 } };
const count = { recommendationMode: 'count', roomMatches: true, mqttConnected: true, pending: false,
    people: full.people, ac: { ...full.ac, temp: 27 } };

function profile(changes = {}, seconds = 25) {
    const activity = { captured_at: now - 500, total_people: 3, seated: 0, standing: 0, walking: 2, running: 1, unknown: 0, ...changes };
    const activityWindow = Array.from({ length: seconds + 1 }, (_, i) => ({ ...activity, captured_at: activity.captured_at - (seconds - i) * 1000 }));
    return { activity: { ...activity }, activityWindow };
}
const compute = (input = full, pose = profile()) => recommendComfort(input, pose, { now });

function measured({ after = 3, before = 1, warm = 26, warmSince = 40, latest = 58 } = {}) {
    const observedAt = now, origin = observedAt - 60_000;
    const comfortHistory = [-18, -12, -6, ...Array.from({ length: 11 }, (_, i) => i * 6).filter(s => s < latest), latest]
        .map(second => ({ at: origin + second * 1000, people: second < 0 ? before : after,
            temperature: second >= latest - warmSince ? warm : 25 }));
    return { observedAt, peopleStableMs: 60_001, comfortHistory };
}

test('sustained count and temperature rise can cool a seated room by exactly one step', () => {
    const input = { ...full, people: { value: 2, ageMs: 2000 }, ...measured({ after: 2 }) };
    const quiet = profile({ total_people: 2, seated: 2, walking: 0, running: 0 });
    const advice = compute(input, quiet);
    assert.equal(advice.status, 'suggested');
    assert.equal(advice.code, 'occupancy_warming');
    assert.equal(advice.target, 24);
    assert.equal(advice.delta, -1);
    assert.equal(advice.currentTarget, 25);
    assert.ok(advice.evidence.some(text => text.includes('1 → 2') && text.includes('25 → 26')));
    const at27 = compute({ ...input, ac: { ...input.ac, temp: 27 } }, quiet);
    assert.equal(at27.target, 26);
    assert.equal(recommendComfort(input, quiet, { now, base: 26 }).target, 26);
});
test('seated and standing room can return one step toward its baseline once cool enough', () => {
    const quiet = profile({ seated: 2, standing: 1, walking: 0, running: 0 });
    const colderAc = { ...full, temperature: { value: 25, ageMs: 0 }, ac: { ...full.ac, temp: 23 } };
    assert.equal(compute(colderAc, quiet).target, 24);
    assert.equal(compute({ ...colderAc, temperature: full.temperature }, quiet).code, 'keep');
    assert.equal(compute({ ...full, temperature: { value: 24, ageMs: 0 } }).code, 'keep');
});
test('count-only, temperature-only, and a short or interrupted rise hold the current target', () => {
    assert.equal(compute().code, 'history');
    assert.equal(compute({ ...full, ...measured({ before: 3 }) }).code, 'no_count_rise');
    assert.equal(compute({ ...full, ...measured({ warm: 25.5 }), temperature: { value: 25.5, ageMs: 2000 } }).code, 'warm_pending');
    assert.equal(compute({ ...full, ...measured({ warmSince: 20 }) }).code, 'warm_pending');
    const dipped = measured();
    dipped.comfortHistory.at(-3).temperature = 25;
    assert.equal(compute({ ...full, ...dipped }).code, 'warm_pending');
    assert.equal(compute({ ...full, ...measured(), peopleStableMs: 15_000 }).code, 'count_pending');
    assert.equal(compute({ ...full, ...measured(), peopleStableMs: 48_000 }).code, 'no_count_rise');
    const gaps = measured();
    gaps.comfortHistory.splice(7, 3);
    assert.equal(compute({ ...full, ...gaps }).code, 'count_pending');
});
test('duplicate or expired sensor history and recently changed Skeleton counts do not cool', () => {
    const repeated = measured();
    repeated.comfortHistory.at(-1).at = repeated.comfortHistory.at(-2).at;
    assert.equal(compute({ ...full, ...repeated }).code, 'history');
    const old = measured();
    const at = old.observedAt + 16_000;
    assert.equal(compute({ ...full, ...old, observedAt: at }).code, 'count_pending');
    const warming = measured();
    const newlyMatched = profile();
    newlyMatched.activityWindow.slice(0, 15).forEach(row => { row.total_people = 2; row.running = 0; });
    assert.equal(compute({ ...full, ...warming }, newlyMatched).code, 'collecting');
});
test('short, patchy, changed, or partly hidden activity does not change the setpoint', () => {
    assert.equal(compute(full, profile({}, 19)).code, 'collecting');
    const gap = profile();
    gap.activityWindow.splice(8, 3);
    assert.equal(compute(full, gap).code, 'collecting');
    const burst = profile({ seated: 3, walking: 0, running: 0 });
    burst.activity = profile().activity;
    assert.equal(compute(full, burst).code, 'mixed');
    assert.equal(compute(full, profile({ walking: 1, unknown: 1 })).code, 'collecting');
});
test('stale data, disagreement, other room, humidity extremes, or a pending request suppress advice', () => {
    const stale = profile();
    stale.activity.captured_at = now - 5001;
    assert.equal(compute(full, stale).code, 'pose_stale');
    assert.equal(compute(full, profile({ total_people: 0, walking: 0, running: 0 })).code, 'empty');
    assert.equal(compute({ ...full, people: { value: 4, ageMs: 0 } }).code, 'count_mismatch');
    for (const [changes, code] of [
        [{ roomMatches: false }, 'room'], [{ pending: true }, 'pending'], [{ mqttConnected: false }, 'ac_stale'],
        [{ ac: { ...full.ac, ageMs: 75001 } }, 'ac_stale'], [{ ac: { ...full.ac, power: false } }, 'ac_mode'],
        [{ ac: { ...full.ac, mode: 2 } }, 'ac_mode'], [{ temperature: { value: 28, ageMs: 30001 } }, 'sensors'],
        [{ humidity: { value: 82, ageMs: 0 } }, 'humidity'], [{ people: { value: 3, ageMs: 30001 } }, 'count_stale']
    ]) {
        const advice = compute({ ...full, ...changes });
        assert.equal(advice.code, code);
        assert.equal(advice.target, null);
    }
});
test('upstream snapshot is canonical, allowlisted, and fetched from loopback before recommendation', async () => {
    const activityData = profile();
    const upstream = { source: 'cira', stale: false, serverTime: now, lastReceivedAt: now - 100,
        events: [{ stage: 'classified', at: now, activity: { ...activityData.activity, captured_at: undefined, id: 'private-track' }, keypoints: [1] },
            { stage: '<tag>', at: now }], ...activityData };
    const handler = createComfortHandler({ now: () => now, port: 9100, fetch: async (url) => {
        assert.equal(url, 'http://127.0.0.1:9100/cira-activity');
        return Response.json(upstream);
    } });
    let response;
    const request = { body: { ...full, ...measured(), activity: { total_people: 0 } } };
    await handler(request, { set(key, value) { assert.equal(key, 'Cache-Control'); assert.equal(value, 'no-store'); },
        json(value) { response = value; } });
    assert.equal(response.recommendation.mode, 'activity');
    assert.equal(response.recommendation.target, 24);
    assert.equal(response.pose.events.length, 1);
    assert.equal(response.pose.events[0].activity.walking, 2);
    assert.equal(response.pose.ageMs, 500);
    assert.doesNotMatch(JSON.stringify(response), /private-track|keypoints|activityWindow/);
    assert.equal(asActivity({ ...upstream.activity, seated: 4 }), null);
});
test('unavailable Node-RED is distinguishable from a verified empty room', async () => {
    let result;
    const handler = createComfortHandler({ now: () => now, fetch: async () => new Response(null, { status: 404 }) });
    await handler({ body: full }, { set() {}, json(value) { result = value; } });
    assert.equal(result.pose, null);
    assert.equal(result.recommendation.mode, 'activity');
    assert.equal(result.recommendation.code, 'missing_flow');
    assert.equal(result.recommendation.target, null);
    assert.equal(result.bridgeStatus, 'missing_flow');
});

test('count mode moves one degree toward the room reference without ambient or pose data', () => {
    const warmer = compute(count, null);
    assert.equal(warmer.mode, 'count');
    assert.equal(warmer.status, 'suggested');
    assert.equal(warmer.target, 26);
    assert.equal(warmer.delta, -1);

    const colder = { ...count, ac: { ...count.ac, temp: 25 } };
    const withConflictingPose = recommendComfort(colder, profile({ total_people: 0, walking: 0, running: 0 }), { now, base: 26 });
    assert.equal(withConflictingPose.target, 26);
    assert.equal(withConflictingPose.delta, 1);

    const atReference = compute({ ...count, ac: { ...count.ac, temp: 25 } }, null);
    assert.equal(atReference.mode, 'count');
    assert.equal(atReference.status, 'hold');
    assert.equal(atReference.target, null);
});

test('count mode distinguishes a verified empty room from missing or invalid counts and requires live AC to propose changes', () => {
    const empty = compute({ ...count, people: { value: 0, ageMs: 0 } }, null);
    assert.equal(empty.status, 'hold');
    assert.equal(empty.code, 'empty');
    for (const [patch, code, status] of [
        [{ people: null }, 'count_stale', 'unavailable'],
        [{ people: { value: 0, ageMs: 30_001 } }, 'count_stale', 'unavailable'],
        [{ people: { value: 2.5, ageMs: 0 } }, 'count_stale', 'unavailable'],
        [{ roomMatches: false }, 'room', 'unavailable'],
        [{ mqttConnected: false }, 'ac_stale', 'unavailable'],
        [{ ac: { ...count.ac, ageMs: 75_001 } }, 'ac_stale', 'unavailable'],
        [{ ac: { ...count.ac, power: false } }, 'ac_mode', 'hold'],
        [{ ac: { ...count.ac, mode: 1 } }, 'ac_mode', 'hold'],
        [{ pending: true }, 'pending', 'hold']
    ]) {
        const advice = compute({ ...count, ...patch }, null);
        assert.equal(advice.mode, 'count');
        assert.equal(advice.code, code);
        assert.equal(advice.status, status);
        assert.equal(advice.target, null);
    }
});

async function postComfort(handler, body) {
    let status = 200, response;
    await handler({ body }, { set() {}, status(code) { status = code; return this; },
        json(value) { response = value; } });
    return { status, response };
}

test('count route returns available pose data by default and keeps advice independent of bridge failures', async () => {
    for (const [fetch, bridgeStatus] of [
        [async () => Response.json({ source: 'cira', stale: false, serverTime: now, events: [], ...profile() }), 'ready'],
        [async () => new Response(null, { status: 404 }), 'missing_flow'],
        [async () => { throw new Error('Node-RED unreachable'); }, 'offline']
    ]) {
        const { status, response } = await postComfort(createComfortHandler({ now: () => now, base: 25, fetch }), count);
        assert.equal(status, 200);
        assert.equal(response.bridgeStatus, bridgeStatus);
        assert.equal(response.pose?.activity?.total_people ?? null, bridgeStatus === 'ready' ? 3 : null);
        assert.equal(response.recommendation.mode, 'count');
        assert.equal(response.recommendation.target, 26);
    }
});

test('only count may skip pose reads, and bad explicit modes never reach the bridge', async () => {
    let reads = 0;
    const handler = createComfortHandler({ now: () => now, base: 25, fetch: async () => {
        reads++;
        return new Response(null, { status: 404 });
    } });
    for (const recommendationMode of ['invalid', '', null, false]) {
        assert.equal((await postComfort(handler, { ...count, recommendationMode })).status, 400);
    }
    const skipped = (await postComfort(handler, { ...count, includePose: false })).response;
    assert.equal(reads, 0);
    assert.equal(skipped.pose, null);
    assert.equal(skipped.bridgeStatus, 'not_requested');
    assert.equal(skipped.recommendation.target, 26);

    const required = (await postComfort(handler, { ...full, recommendationMode: 'activity', includePose: false })).response;
    assert.equal(reads, 1);
    assert.equal(required.recommendation.mode, 'activity');
    assert.equal(required.recommendation.code, 'missing_flow');
    assert.equal(required.recommendation.target, null);
});
