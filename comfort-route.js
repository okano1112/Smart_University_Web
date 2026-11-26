'use strict';

const { readNodeRedJson } = require('./cira-logs-route');
const { asActivity, recommendComfort, POSE_MAX_AGE_MS } = require('./comfort-recommendation');

const STAGES = new Set(['received', 'classified', 'rejected', 'stale']);
const CODES = new Set(['INVALID_FRAME', 'PROCESSING_ERROR', 'TOO_LARGE', 'CONTENT_TYPE', 'STALE']);

function createComfortHandler({ fetch, port, now = Date.now, base = Number(process.env.COMFORT_BASE_TEMP || 25) } = {}) {
    let inFlight;
    function readPose() {
        inFlight ??= readNodeRedJson('/cira-activity', { fetch, port }).finally(() => { inFlight = null; });
        return inFlight;
    }
    return async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const mode = req.body?.recommendationMode;
        if (mode !== undefined && mode !== 'count' && mode !== 'activity') {
            return res.status(400).json({ message: 'โหมดคำแนะนำไม่ถูกต้อง' });
        }
        const includePose = mode !== 'count' || req.body.includePose !== false;
        let pose = null, modelInput = null, bridgeStatus = 'not_requested';
        if (includePose) {
            try {
                const upstream = await readPose();
                if (upstream?.source !== 'cira' || typeof upstream.stale !== 'boolean' ||
                    !Number.isSafeInteger(upstream.serverTime) || !Array.isArray(upstream.events)) {
                    throw new Error('Invalid activity snapshot');
                }
                const activity = asActivity(upstream.activity);
                const ageMs = activity ? now() - activity.captured_at : null;
                const fresh = !upstream.stale && activity && ageMs >= -1000 && ageMs <= POSE_MAX_AGE_MS;
                if (!upstream.stale && !activity) throw new Error('Invalid activity snapshot');
                const time = value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
                pose = {
                    source: 'cira', serverTime: upstream.serverTime, lastReceivedAt: time(upstream.lastReceivedAt) ? upstream.lastReceivedAt : null,
                    stale: !fresh, activity: fresh ? activity : null, ageMs: fresh ? Math.max(0, ageMs) : null,
                    events: upstream.events.slice(-20).flatMap(event => {
                        if (!event || !STAGES.has(event.stage) || !time(event.at)) return [];
                        const eventActivity = event.activity && asActivity({ ...event.activity, captured_at: event.at });
                        return [{ at: event.at, stage: event.stage,
                            ...(CODES.has(event.code) ? { code: event.code } : {}),
                            ...(eventActivity ? { activity: eventActivity } : {}) }];
                    })
                };
                modelInput = { ...pose, activityWindow: upstream.activityWindow };
                bridgeStatus = 'ready';
            } catch (error) {
                bridgeStatus = error.missingFlow ? 'missing_flow' : 'offline';
            }
        }
        const serverTime = now();
        const recommendation = recommendComfort(req.body, modelInput, { now: serverTime, base });
        if (mode !== 'count' && !pose) {
            recommendation.code = bridgeStatus;
            recommendation.reason = bridgeStatus === 'missing_flow'
                ? 'Node-RED ยังไม่ได้โหลด Flow รับ Skeleton'
                : 'ยังอ่านผลกิจกรรมจาก Node-RED ไม่ได้';
        }
        return res.json({ pose, recommendation, serverTime, bridgeStatus });
    };
}

module.exports = { createComfortHandler };
