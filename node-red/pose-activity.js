'use strict';

/** Classify one camera frame and return bounded, serializable temporal state.
 * Keep helpers scoped here so Node-RED's generated function can embed this source.
 * The base camera must be fixed; unobservable or ambiguous motions stay unknown.
 */
function updatePoseActivity(frame, previousState = null, options = {}) {
    const { now = Date.now(), maxAgeMs = 5000 } = options || {};
    const integerIn = (value, lo, hi) => Number.isSafeInteger(value) && value >= lo && value <= hi;
    const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(frame) || !integerIn(now, 1, 8.64e15) || !integerIn(maxAgeMs, 1, 30000)
        || !integerIn(frame.captured_at, 1, now) || now - frame.captured_at > maxAgeMs
        || !integerIn(frame.width, 16, 8192) || !integerIn(frame.height, 16, 8192)
        || !Array.isArray(frame.people) || frame.people.length > 64) return null;
    const at = frame.captured_at, aspect = frame.width / frame.height;
    if (aspect < .25 || aspect > 4 || at <= previousState?.captured_at) return null;
    const ids = new Set();
    for (const person of frame.people) {
        if (!object(person) || typeof person.id !== 'string' || !person.id.trim() || person.id.length > 64 || /[\u0000-\u001f\u007f]/u.test(person.id)
            || ids.has(person.id) || !Array.isArray(person.keypoints) || person.keypoints.length !== 17) return null;
        ids.add(person.id);
        for (const point of person.keypoints) {
            if (!object(point) || !unit(point.x) || !unit(point.y) || !unit(point.score)) return null;
        }
    }

    const snapshot = { captured_at: at, total_people: frame.people.length, seated: 0, standing: 0, walking: 0, running: 0, unknown: 0 };
    const state = { captured_at: at, width: frame.width, height: frame.height, tracks: [] };
    const keepTracks = previousState?.width === frame.width && previousState?.height === frame.height
        && at - previousState.captured_at <= 750 && Array.isArray(previousState.tracks);
    const prior = new Map(keepTracks ? previousState.tracks.map(track => [track.id, track.observations]) : []);

    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const median = values => {
        const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
    };
    function legFeature(hip, knee, ankle, scale) {
        const thigh = distance(hip, knee), shin = distance(knee, ankle);
        if (thigh / scale < .20 || thigh / scale > 2.25 || shin / scale < .20 || shin / scale > 2.25) return null;
        const dot = (hip.x - knee.x) * (ankle.x - knee.x) + (hip.y - knee.y) * (ankle.y - knee.y);
        const kneeAngle = Math.acos(Math.max(-1, Math.min(1, dot / (thigh * shin)))) * 180 / Math.PI;
        return {
            standing: kneeAngle >= 150 && (ankle.y - hip.y) / (thigh + shin) >= .76,
            seated: kneeAngle >= 55 && kneeAngle <= 132 && Math.abs(knee.y - hip.y) / thigh <= .48
                && (ankle.y - knee.y) / shin >= .65,
            ankleBelowHip: (ankle.y - hip.y) >= .20 * scale
        };
    }
    function observe(person) {
        const point = i => ({ x: person.keypoints[i].x * aspect, y: person.keypoints[i].y });
        // Require both shoulders, hips, knees and ankles for these labels. Pixels
        // become frame-height units before angles or torso-relative movement.
        if ([5, 6, 11, 12, 13, 14, 15, 16].some(i => person.keypoints[i].score < .45)) return null;
        const shoulders = midpoint(point(5), point(6));
        const hips = midpoint(point(11), point(12));
        const scale = distance(hips, shoulders);
        if (scale < .018 || scale > .55 || (hips.y - shoulders.y) / scale < .70) return null;
        const leftAnkle = point(15), rightAnkle = point(16);
        const left = legFeature(point(11), point(13), leftAnkle, scale), right = legFeature(point(12), point(14), rightAnkle, scale);
        if (!left || !right || !left.ankleBelowHip || !right.ankleBelowHip) return null;
        const pose = left.standing && right.standing ? 'standing' : left.seated && right.seated ? 'seated' : 'unknown';
        return { at, x: hips.x, y: hips.y, scale, stride: (leftAnkle.x - rightAnkle.x) / scale,
            leftFootY: (leftAnkle.y - hips.y) / scale, rightFootY: (rightAnkle.y - hips.y) / scale, pose };
    }

    function classify(observations) {
        const latest = observations.at(-1);
        const gait = observations.filter(sample => latest.at - sample.at <= 1900);
        if (gait.length >= 8 && latest.at - gait[0].at >= 1200 && latest.pose !== 'seated') {
            const first = gait[0], duration = (latest.at - first.at) / 1000, scale = median(gait.map(sample => sample.scale));
            const dx = Math.abs(latest.x - first.x), speed = dx / (scale * duration);
            const path = gait.slice(1).reduce((sum, sample, i) => sum + Math.abs(sample.x - gait[i].x), 0);
            const recent = gait.find(sample => latest.at - sample.at <= 400 && latest.at - sample.at >= 220);
            const recentSpeed = recent ? Math.abs(latest.x - recent.x) / (scale * (latest.at - recent.at) / 1000) : 0;
            const yValues = gait.map(sample => sample.y), scales = gait.map(sample => sample.scale);
            const consistent = recent && speed >= .45 && dx / path >= .76 && recentSpeed >= speed * .40
                && Math.sign(latest.x - recent.x) === Math.sign(latest.x - first.x)
                && Math.max(...yValues) - Math.min(...yValues) <= .55 * scale
                && Math.max(...scales) / Math.min(...scales) <= 1.35
                && gait.filter(sample => sample.pose === 'seated').length <= gait.length * .15;
            if (consistent) {
                // Dead band filters foot jitter. Require repeated left-right
                // stride reversals with plausible intervals rather than speed alone.
                const swaps = [];
                let sign = 0;
                for (const sample of gait) {
                    const next = sample.stride >= .24 ? 1 : sample.stride <= -.24 ? -1 : 0;
                    if (next && sign && sign !== next) swaps.push(sample.at);
                    if (next) sign = next;
                }
                const intervals = swaps.slice(1).map((time, i) => time - swaps[i]);
                if (intervals.length && intervals.every(ms => ms >= 130 && ms <= 1150) && latest.at - swaps.at(-1) <= 650) {
                    const cadence = 1000 / median(intervals);
                    if (speed >= 3.6 && speed <= 11 && cadence >= 2.6 && cadence <= 6.5 && latest.at - swaps.at(-1) <= 480) return 'running';
                    if (speed <= 3.2 && cadence >= .9 && cadence <= 3.1) return 'walking';
                }
            }
        }
        if (latest.pose === 'unknown') return 'unknown';
        // Require a continuous still stretch in the same posture. Looking back
        // just far enough avoids retaining a prior activity across a transition.
        let first = observations.length - 1;
        while (first > 0 && (latest.at - observations[first].at < 600 || observations.length - first < 3)) first--;
        const still = observations.slice(first);
        if (still.length < 3 || latest.at - still[0].at < 600 || latest.at - still[0].at > 1200 || still.some(sample => sample.pose !== latest.pose)) return 'unknown';
        const extent = key => Math.max(...still.map(sample => sample[key])) - Math.min(...still.map(sample => sample[key]));
        const scale = median(still.map(sample => sample.scale));
        if (extent('x') > .24 * scale || extent('y') > .20 * scale || extent('scale') > .22 * scale || extent('stride') > .30
            || extent('leftFootY') > .26 || extent('rightFootY') > .26) return 'unknown';
        return latest.pose;
    }

    for (const person of frame.people) {
        const sample = observe(person);
        // Missing landmarks end the usable history, even if that track ID returns.
        if (!sample) { snapshot.unknown++; continue; }
        let observations = prior.get(person.id) || [];
        const last = observations.at(-1);
        if (last) {
            const elapsed = at - last.at, relativeShift = distance(sample, last) / Math.min(sample.scale, last.scale);
            if (elapsed > 750 || elapsed <= 0 || relativeShift > Math.max(.6, 12 * elapsed / 1000)
                || Math.max(sample.scale, last.scale) / Math.min(sample.scale, last.scale) > 1.4) observations = [];
        }
        observations = observations.filter(item => at - item.at <= 2400).slice(-31);
        const current = [...observations, sample];
        snapshot[classify(current)]++;
        // Bound history to 32 observations; still examine intervening high-rate
        // frames so occlusion and sudden changes immediately clear stale labels.
        if (!observations.length || at - observations.at(-1).at >= 50 || observations.at(-1).pose !== sample.pose) observations = current;
        state.tracks.push({ id: person.id, observations });
    }
    return { snapshot, state };
}

function createPoseActivityClassifier(options = {}) {
    let state = null;
    return {
        update(frame, overrides = {}) {
            const result = updatePoseActivity(frame, state, { ...options, ...overrides });
            if (result) state = result.state;
            return result?.snapshot ?? null;
        },
        reset() { state = null; }
    };
}

module.exports = { updatePoseActivity, createPoseActivityClassifier };
