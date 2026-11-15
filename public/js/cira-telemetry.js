(function (root) {
    'use strict';

    function parsePeopleReading(payload, { now = Date.now(), retained = false, maxAgeMs = 30000 } = {}) {
        if (retained || !Number.isFinite(now) || now <= 0 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return null;

        const count = value => {
            if (typeof value === 'string') {
                const text = value.trim();
                if (!/^\d+$/.test(text)) return null;
                value = Number(text);
            }
            return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000 ? value : null;
        };
        const timestamp = value => {
            if (typeof value === 'string') {
                const text = value.trim();
                if (/^\d+$/.test(text)) value = Number(text);
                else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) value = Date.parse(text);
                else return null;
            }
            return typeof value === 'number' && Number.isFinite(value) && value > 0 && now - value <= maxAgeMs && value - now <= 5000 ? Math.min(now, value) : null;
        };

        if (typeof payload === 'string') {
            const text = payload.trim();
            if (!text) return null;
            if (/^\d+$/.test(text)) payload = text;
            else {
                try { payload = JSON.parse(text); } catch (_) { return null; }
                // A JSON numeric literal written with fractions or exponent notation
                // is not a clear integer count sent as a string.
                if (typeof payload === 'number') return null;
            }
        }
        if (typeof payload === 'number' || typeof payload === 'string') {
            const people = count(payload);
            return people === null ? null : { people, at: now };
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

        const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
        const readings = [];
        if (has(payload, 'total_people')) readings.push(count(payload.total_people));
        if (has(payload, 'people')) readings.push(count(payload.people));
        if (payload.counts && typeof payload.counts === 'object' && !Array.isArray(payload.counts) && has(payload.counts, 'person')) readings.push(count(payload.counts.person));
        if (!readings.length || readings.some(value => value === null || value !== readings[0])) return null;

        const times = [];
        for (const key of ['timestamp', 'captured_at']) {
            if (has(payload, key)) times.push(timestamp(payload[key]));
        }
        if (times.some(value => value === null)) return null;
        // received_at describes the bridge receipt, not camera capture. It must
        // never make an old camera observation appear fresh.
        return { people: readings[0], at: times.length ? Math.min(...times) : now };
    }

    const api = { parsePeopleReading };
    root.SmartCiraTelemetry = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
