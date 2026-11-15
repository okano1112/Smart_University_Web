'use strict';

const SENSOR_MAX_AGE_MS = 30_000;
const DEVICE_MAX_AGE_MS = 75_000;
const POSE_MAX_AGE_MS = 5_000;
const WINDOW_MS = 30_000;
const MIN_WINDOW_MS = 20_000;
const MAX_GAP_MS = 2_600;
const HISTORY_MS = 300_000;
const HISTORY_GAP_MS = 15_000;
const COUNT_CONFIRM_MS = 45_000;
const WARM_CONFIRM_MS = 30_000;
const MIN_RISE = .8;
const COUNT_KEYS = ['seated', 'standing', 'walking', 'running', 'unknown'];

const within = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
const whole = (n, min, max) => Number.isInteger(n) && within(n, min, max);
const quantize = n => Math.round(n * 10) / 10;

function asActivity(input) {
    if (!whole(input?.captured_at, 1, 8.64e15) || !whole(input.total_people, 0, 64) ||
        !COUNT_KEYS.every(key => whole(input[key], 0, 64)) ||
        COUNT_KEYS.reduce((sum, key) => sum + input[key], 0) !== input.total_people) return null;
    return { captured_at: input.captured_at, total_people: input.total_people,
        ...Object.fromEntries(COUNT_KEYS.map(key => [key, input[key]])) };
}

function activityProfile(rows, latest) {
    if (!Array.isArray(rows) || !rows.length) return null;
    let samples = rows.slice(-40).map(asActivity);
    if (samples.some(sample => !sample)) return null;
    samples = samples.filter(sample => sample.captured_at >= latest.captured_at - WINDOW_MS);
    if (!samples.length || samples.at(-1).captured_at > latest.captured_at) return null;
    if (samples.at(-1).captured_at < latest.captured_at) samples.push(latest);
    else samples[samples.length - 1] = latest;
    // Discard everything before a stream gap, including any period without
    // enough visible keypoints. Weight each interval by time, not message rate.
    let start = samples.length - 1;
    const usable = sample => sample.total_people > 0 && sample.unknown / sample.total_people <= .2;
    if (!usable(latest)) return null;
    while (start > 0) {
        const diff = samples[start].captured_at - samples[start - 1].captured_at;
        if (diff <= 0 || diff > MAX_GAP_MS || !usable(samples[start - 1]) ||
            samples[start - 1].total_people !== latest.total_people) break;
        start--;
    }
    const span = latest.captured_at - samples[start].captured_at;
    if (span < MIN_WINDOW_MS) return null;
    let moving = 0, resting = 0;
    for (let i = start; i < samples.length - 1; i++) {
        const sample = samples[i], duration = samples[i + 1].captured_at - sample.captured_at;
        if ((sample.walking + sample.running) / sample.total_people >= .6) moving += duration;
        if ((sample.seated + sample.standing) / sample.total_people >= .8) resting += duration;
    }
    const movingNow = (latest.walking + latest.running) / latest.total_people >= .6;
    const restingNow = (latest.seated + latest.standing) / latest.total_people >= .8;
    return {
        seconds: Math.floor(span / 1000),
        kind: movingNow && moving / span >= .8 ? 'moving' : restingNow && resting / span >= .8 ? 'resting' : 'mixed'
    };
}

function occupancyWarmup(input) {
    const history = input.comfortHistory, observedAt = input.observedAt, people = input.people.value;
    if (!whole(observedAt, 1, 8.64e15) || !Array.isArray(history) || history.length < 3 || history.length > 50) {
        return { code: 'history', reason: 'กำลังเก็บอุณหภูมิห้องเทียบกับจำนวนคนก่อนและหลังการเปลี่ยนแปลง' };
    }
    let previous = 0;
    for (const row of history) {
        if (!whole(row?.at, Math.max(1, observedAt - HISTORY_MS), observedAt) || row.at <= previous ||
            !whole(row.people, 0, 1000) || !within(row.temperature, 15, 45)) {
            return { code: 'history', reason: 'รอประวัติอุณหภูมิและจำนวนคนที่เรียงตามเวลา' };
        }
        previous = row.at;
    }
    const last = history.at(-1);
    if (observedAt - last.at > HISTORY_GAP_MS || last.people !== people) {
        return { code: 'count_pending', reason: 'รอผลวัดอุณหภูมิที่ตรงกับจำนวนคนล่าสุด' };
    }
    const since = within(input.peopleStableMs, COUNT_CONFIRM_MS, observedAt) ? observedAt - input.peopleStableMs : null;
    let start = history.length - 1;
    while (start > 0 && history[start - 1].people === people && history[start].at - history[start - 1].at <= HISTORY_GAP_MS) start--;
    if (since === null || last.at - history[start].at < COUNT_CONFIRM_MS) {
        return { code: 'count_pending', reason: 'รอให้จำนวนคนคงที่อย่างน้อย 45 วินาทีก่อนพิจารณาลดอุณหภูมิ' };
    }
    const before = history[start - 1];
    if (!before || before.people >= people || before.at >= since || since > history[start].at ||
        history[start].at - before.at > HISTORY_GAP_MS) {
        return { code: 'no_count_rise', reason: 'ยังไม่พบช่วงที่จำนวนคนเพิ่มและมีค่าก่อนหน้าให้เปรียบเทียบ' };
    }
    let first = start - 1;
    while (first > 0 && history[first - 1].people === before.people &&
        before.at - history[first - 1].at <= 30_000 && history[first].at - history[first - 1].at <= HISTORY_GAP_MS) first--;
    const baselineRows = history.slice(first, start);
    const temperatures = baselineRows.map(row => row.temperature).sort((a, b) => a - b);
    if (baselineRows.length < 3 || before.at - baselineRows[0].at < 10_000 || temperatures.at(-1) - temperatures[0] > .4 + 1e-9) {
        return { code: 'baseline', reason: 'ยังไม่มีอุณหภูมิก่อนคนเพิ่มที่นิ่งพอให้เทียบ' };
    }
    const mid = Math.floor(temperatures.length / 2);
    const baseline = (temperatures[mid] + temperatures[Math.floor((temperatures.length - 1) / 2)]) / 2;
    const warmer = temperature => temperature - baseline >= MIN_RISE - 1e-9;
    let warmStart = history.length;
    while (warmStart > start && warmer(history[warmStart - 1].temperature)) warmStart--;
    if (warmStart === history.length || !warmer(input.temperature.value) || last.at - history[warmStart].at < WARM_CONFIRM_MS) {
        return { code: 'warm_pending', reason: 'คนเพิ่มแล้ว รอให้อุณหภูมิสูงขึ้นอย่างน้อย 0.8°C ต่อเนื่อง 30 วินาที' };
    }
    return { before: before.people, baseline, warmSeconds: Math.floor((last.at - history[warmStart].at) / 1000) };
}

/**
 * Advisory setpoint for one meeting room. The base is a room preference.
 * Without measured radiant temperature, clothing and air speed, it is not PMV.
 */
function recommendComfort(input, pose, { now = Date.now(), base = 25 } = {}) {
    const roomBase = whole(base, 24, 26) ? base : 25;
    const currentTarget = whole(input?.ac?.temp, 21, 27) ? input.ac.temp : null;
    const evidence = [];
    const result = (status, code, reason, target = null) => ({
        status, code, reason, target, delta: target === null ? null : target - currentTarget,
        currentTarget, evidence, calculatedAt: now
    });
    const hold = (code, reason) => result('hold', code, reason);
    const unavailable = (code, reason) => result('unavailable', code, reason);
    const activity = pose?.activity;
    if (!activity || !within(now - activity.captured_at, -1000, POSE_MAX_AGE_MS) || pose.stale) {
        return unavailable('pose_stale', 'รอผลกิจกรรมล่าสุดจาก CiRA CORE');
    }
    if (activity.total_people === 0) return hold('empty', 'ตอนนี้กล้องไม่พบคนในพื้นที่ที่มองเห็น');
    evidence.push(`กล้องเห็น ${activity.total_people} คน · จำแนกได้ ${activity.total_people - activity.unknown} คน`);
    if (input?.roomMatches !== true) return unavailable('room', 'ข้อมูลเซนเซอร์และแอร์ต้องมาจากห้องเดียวกับกล้อง');
    if (input?.pending === true) return hold('pending', 'รอผลจากคำสั่งแอร์ก่อนหน้า');
    if (input?.mqttConnected !== true || !within(input?.ac?.ageMs, 0, DEVICE_MAX_AGE_MS) || currentTarget === null ||
        typeof input.ac.power !== 'boolean' || !whole(input.ac.mode, 0, 2)) {
        return unavailable('ac_stale', 'รอสถานะล่าสุดจาก ESP32');
    }
    if (input.ac.power !== true || input.ac.mode !== 0) return hold('ac_mode', 'คำแนะนำใช้เมื่อแอร์เปิดอยู่ในโหมดทำความเย็น');
    if (input.sensorFresh !== true || !within(input.temperature?.ageMs, 0, SENSOR_MAX_AGE_MS) ||
        !within(input.humidity?.ageMs, 0, SENSOR_MAX_AGE_MS) ||
        !within(input.temperature.value, 15, 45) || !within(input.humidity.value, 0, 100)) {
        return unavailable('sensors', 'รออุณหภูมิห้องและความชื้นล่าสุด');
    }
    if (!within(input.people?.ageMs, 0, SENSOR_MAX_AGE_MS) || !whole(input.people.value, 0, 1000)) {
        return unavailable('count_stale', 'รอจำนวนคนจากระบบนับคน CiRA เพื่อเทียบกับผล Skeleton');
    }
    if (input.people.value !== activity.total_people) {
        return hold('count_mismatch', `Skeleton เห็น ${activity.total_people} คน แต่ระบบนับคนรายงาน ${input.people.value} คน`);
    }
    const temperature = input.temperature.value, humidity = input.humidity.value;
    evidence.push(`อุณหภูมิห้อง ${quantize(temperature)}°C · ความชื้น ${quantize(humidity)}%`);
    if (!within(humidity, 30, 75)) return hold('humidity', 'ความชื้นอยู่นอกช่วงที่ใช้คำนวณคำแนะนำนี้');
    const profile = activityProfile(pose.activityWindow, activity);
    if (!profile) return hold('collecting', 'รอข้อมูลท่าทางที่ต่อเนื่องอย่างน้อย 20 วินาที');
    evidence.push(`ใช้ข้อมูลต่อเนื่อง ${profile.seconds} วินาที · ค่าอ้างอิงห้อง ${roomBase}°C`);
    if (profile.kind === 'mixed') return hold('mixed', 'กิจกรรมในห้องยังผสมกันหรือเพิ่งเปลี่ยน');
    const warm = temperature >= roomBase + .5;
    if (warm && currentTarget > roomBase - 1) {
        const warming = occupancyWarmup(input);
        if (warming.code) return hold(warming.code, warming.reason);
        evidence.push(`จำนวนคน ${warming.before} → ${input.people.value} คน · ห้อง ${quantize(warming.baseline)} → ${quantize(temperature)}°C`,
            `อุณหภูมิสูงขึ้นต่อเนื่อง ${warming.warmSeconds} วินาที`);
        return result('suggested', 'occupancy_warming', 'จำนวนคนเพิ่มคงที่และอุณหภูมิห้องสูงขึ้นต่อเนื่อง', currentTarget - 1);
    }
    if (temperature <= roomBase && profile.kind === 'resting' && currentTarget < roomBase) {
        return result('suggested', 'resting', 'คนส่วนใหญ่นั่งหรือยืนต่อเนื่องและห้องเย็นพอให้ปรับกลับเข้าหาค่าอ้างอิง', currentTarget + 1);
    }
    return hold('keep', 'คงอุณหภูมิที่ตั้งไว้ตามสภาพห้องขณะนี้');
}

module.exports = { recommendComfort, asActivity, activityProfile, POSE_MAX_AGE_MS };
