'use strict';

const CIRA_LOG_KEY = 'ciraObservabilityV1';

// Embedded in Node-RED function nodes, so helpers use no module-local state.
function newCiraLog(now) {
    return {
        runId: now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        sequence: 0, lastSample: {}, events: [],
        counters: { received: 0, forwarded: 0, rejected: 0, tests: 0 }
    };
}

function recordCiraLog(log, outcome, now, details = {}) {
    if (outcome === 'forwarded' || outcome === 'rejected') {
        log.counters.received++;
        log.counters[outcome]++;
    } else if (outcome === 'test') log.counters.tests++;

    // Keep precise totals, but sample traces/debug independently per outcome.
    // Clock adjustments cannot suppress an entire bucket until wall time catches up.
    const previous = log.lastSample[outcome];
    if (outcome !== 'stale' && previous !== undefined && now >= previous && now - previous < 1000) return false;
    log.lastSample[outcome] = now;
    const frameId = outcome === 'forwarded' || outcome === 'rejected' ? 'cira-' + log.runId + '-' + (log.sequence + 1) : null;
    const event = (stage, level, at, message, extra = {}) => {
        log.events.push({ id: 'cira-' + log.runId + '-event-' + ++log.sequence, ...(frameId ? { frameId } : {}),
            source: 'cira', stage, level, at, message, details: extra });
    };
    if (frameId) event('capture', 'info', now, 'ได้รับข้อความผลตรวจจับบน MQTT จาก CiRA CORE');
    if (outcome === 'forwarded') {
        const sample = { totalPeople: details.totalPeople, sampleAt: details.sampleAt, sampleTimeSource: details.sampleTimeSource };
        const validatedAt = Math.max(now, details.validatedAt);
        event('validate', 'info', validatedAt, 'ตรวจและสรุปจำนวนคนแล้ว', { ...sample, latencyMs: validatedAt - now });
        event('forward', 'info', validatedAt, 'ส่งต่อไปยังโหนด MQTT output แล้ว', sample);
    } else if (outcome === 'rejected') {
        event('rejected', 'warning', Math.max(now, details.validatedAt), details.reason, { code: details.code });
    } else if (outcome === 'test') {
        if (details.code) event('test', 'warning', now, details.reason, { code: details.code });
        else event('test', 'info', now, 'ตรวจตัวอย่างใน Node-RED เท่านั้น ไม่ส่ง MQTT', { totalPeople: details.totalPeople });
    } else if (outcome === 'stale') {
        event('stale', 'warning', now, 'ยังไม่มีผลตรวจจับล่าสุดจาก CiRA CORE', { lastSeen: details.lastSeen });
    }
    // Evict entire frame traces so the first visible stage is never missing.
    while (log.events.length > 60) {
        const { frameId: oldestFrame } = log.events.shift();
        while (oldestFrame && log.events[0]?.frameId === oldestFrame) log.events.shift();
    }
    return true;
}

module.exports = { CIRA_LOG_KEY, newCiraLog, recordCiraLog };
