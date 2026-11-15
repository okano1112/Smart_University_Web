'use strict';

const COUNTERS = ['received', 'forwarded', 'rejected', 'tests'];
const STAGES = new Set(['capture', 'validate', 'forward', 'rejected', 'stale', 'test']);
const MAX_BYTES = 65536;

function snapshot(value) {
    const validTime = time => Number.isFinite(time) && time > 0 && time <= 8.64e15;
    const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
    if (value?.source !== 'cira' || !validTime(value.serverTime) || !Array.isArray(value.events)
        || !COUNTERS.every(key => nonnegative(value.counters?.[key]))) throw new Error('Invalid CiRA snapshot');
    const events = value.events.slice(-60).flatMap(event => {
        if (!event || !STAGES.has(event.stage) || !validTime(event.at) || typeof event.id !== 'string'
            || typeof event.message !== 'string') return [];
        const details = {}, input = event.details;
        if (nonnegative(input?.totalPeople) && input.totalPeople <= 1000) details.totalPeople = input.totalPeople;
        if (nonnegative(input?.latencyMs)) details.latencyMs = input.latencyMs;
        for (const key of ['sampleAt', 'lastSeen']) if (validTime(input?.[key])) details[key] = input[key];
        if (input?.lastSeen === null) details.lastSeen = null;
        if (['camera', 'received'].includes(input?.sampleTimeSource)) details.sampleTimeSource = input.sampleTimeSource;
        if (typeof input?.code === 'string') details.code = input.code.slice(0, 64);
        return [{ id: event.id.slice(0, 96), ...(typeof event.frameId === 'string' ? { frameId: event.frameId.slice(0, 96) } : {}),
            source: 'cira', stage: event.stage, level: event.level === 'warning' ? 'warning' : 'info',
            at: event.at, message: event.message.slice(0, 240), details }];
    });
    return { source: 'cira', serverTime: value.serverTime,
        counters: Object.fromEntries(COUNTERS.map(key => [key, value.counters[key]])), events };
}

async function readNodeRedJson(endpoint, { fetch: fetchLogs = globalThis.fetch, port = Number(process.env.NODE_RED_PORT || 1880) } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Node-RED port');
    const response = await fetchLogs(`http://127.0.0.1:${port}${endpoint}`, {
        signal: AbortSignal.timeout(2000), redirect: 'error', headers: { Accept: 'application/json' }
    });
    if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        if (response.status === 404) throw Object.assign(new Error('Missing Node-RED endpoint'), { missingFlow: true });
        throw new Error('Node-RED endpoint unavailable');
    }
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES) throw new Error('Node-RED snapshot too large');
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

function createCiraLogReader(options) {
    let inFlight;
    const load = async () => snapshot(await readNodeRedJson('/cira-observability', options));
    return async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            inFlight ??= load().finally(() => { inFlight = null; });
            res.json(await inFlight);
        } catch (error) {
            res.status(503).json({ message: error.missingFlow
                ? 'Node-RED ยังไม่ได้โหลด flow CiRA ที่มี Logs'
                : 'อ่าน Logs จาก Node-RED ไม่ได้ · ตรวจว่า Node-RED เปิดอยู่' });
        }
    };
}

module.exports = { createCiraLogReader, readCiraLogs: createCiraLogReader(), readNodeRedJson };
