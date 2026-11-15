'use strict';

const CIRA_POSE_KEY = 'ciraPoseActivityV1';
const POSE_MAX_AGE_MS = 5000;
const POSE_MAX_BODY_BYTES = 128 * 1024;

// This function is also embedded in the generated Node-RED flow. Keep its
// runtime dependencies explicit so the import needs no external function modules.
function handleCiraPose(msg, method, { flow, key, update, now, maxAgeMs, maxBodyBytes }) {
    const json = (status, data) => {
        msg.statusCode = status;
        msg.headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
        msg.payload = JSON.stringify(data);
        return msg;
    };
    const error = (status, code) => json(status, { ok: false, code });
    const req = msg.req;
    if (method !== 'EXPIRE' && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req?.socket?.remoteAddress)) return error(403, 'LOCAL_ONLY');

    const record = flow.get(key) || { state: null, activity: null, activityWindow: [], lastCapturedAt: null, lastReceivedAt: null, events: [], sampledAt: {} };
    const append = (...events) => {
        record.events = [...record.events, ...events].slice(-20);
    };
    const sample = key => {
        const previous = record.sampledAt[key];
        if (previous !== undefined && now >= previous && now - previous < 1000) return false;
        record.sampledAt[key] = now;
        return true;
    };
    const save = () => flow.set(key, record);
    const stale = () => !record.activity || now - record.activity.captured_at > maxAgeMs || now - record.lastReceivedAt > maxAgeMs;
    const prune = () => {
        if (!record.activity || !stale()) return;
        record.activity = null;
        record.state = null;
        record.activityWindow = [];
        append({ at: now, stage: 'stale' });
        save();
    };

    if (method === 'GET') {
        prune();
        return json(200, { source: 'cira', serverTime: now, lastReceivedAt: record.lastReceivedAt,
            stale: stale(), activity: record.activity, activityWindow: record.activityWindow, events: record.events });
    }
    if (method === 'EXPIRE') {
        prune();
        return null;
    }
    if (method !== 'POST') return error(405, 'METHOD');

    // Raw poses are accepted only from a local sender, outside a browser page.
    // No forwarding header can make a nonloopback socket look local.
    const headers = req.headers || {};
    if (headers.origin || headers['sec-fetch-site']) return error(403, 'LOCAL_ONLY');
    prune();
    const reject = (status, code) => {
        if (sample('rejected')) { append({ at: now, stage: 'rejected', code }); save(); }
        return error(status, code);
    };
    if (!/^application\/json(?:\s*;|$)/i.test(String(headers['content-type'] || ''))) return reject(415, 'CONTENT_TYPE');
    if (Number(headers['content-length']) > maxBodyBytes) return reject(413, 'TOO_LARGE');
    if (!msg.payload || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) return reject(400, 'INVALID_FRAME');
    if (record.lastCapturedAt !== null && msg.payload.captured_at <= record.lastCapturedAt) return reject(400, 'INVALID_FRAME');

    let result;
    try {
        // Content-Length is optional (chunked encoding); check the decoded body too.
        if (Buffer.byteLength(JSON.stringify(msg.payload), 'utf8') > maxBodyBytes) return reject(413, 'TOO_LARGE');
        result = update(msg.payload, record.state, { now, maxAgeMs });
    } catch (_) { return reject(500, 'PROCESSING_ERROR'); }
    if (!result) return reject(400, 'INVALID_FRAME');

    // Copy a fixed projection; classifier internals can never enter events or HTTP output.
    const { captured_at, total_people, seated, standing, walking, running, unknown } = result.snapshot;
    const activity = { total_people, seated, standing, walking, running, unknown };
    // Hold separate sampled evidence for the comfort advisor, not a frame log.
    // Both camera and receipt gaps break continuity. A batch of old frames
    // cannot manufacture an uninterrupted history across a disconnect.
    if (record.lastCapturedAt === null || captured_at - record.lastCapturedAt > 2600 || now - record.lastReceivedAt > 2600) {
        record.activityWindow = [];
    }
    record.state = result.state;
    record.activity = { captured_at, ...activity };
    const lastPoint = record.activityWindow.at(-1);
    if (!lastPoint || captured_at - lastPoint.captured_at >= 1000) {
        record.activityWindow = [...record.activityWindow, record.activity].filter(point => captured_at - point.captured_at <= 35000).slice(-36);
    }
    record.lastCapturedAt = captured_at;
    record.lastReceivedAt = now;
    if (sample('classified')) append({ at: now, stage: 'received' }, { at: now, stage: 'classified', activity });
    save();
    return json(200, { ok: true });
}

module.exports = { CIRA_POSE_KEY, POSE_MAX_AGE_MS, POSE_MAX_BODY_BYTES, handleCiraPose };
