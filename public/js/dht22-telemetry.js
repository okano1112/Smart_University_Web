(function (root) {
    'use strict';

    const SENSOR_IDS = ['A', 'B'];
    const MAX_AGE_MS = 30_000;
    const MAX_FUTURE_MS = 5_000;
    const HISTORY_MS = 15 * 60_000;
    const MAX_POINTS = 240;

    function isTimestamp(value) {
        return Number.isSafeInteger(value) && value > 0;
    }

    function isFresh(timestamp, now) {
        return isTimestamp(timestamp) && now - timestamp < MAX_AGE_MS && timestamp - now <= MAX_FUTURE_MS;
    }

    function isSensor(sensor) {
        if (!sensor || typeof sensor !== 'object' || Array.isArray(sensor)) return false;
        const { state, reading } = sensor;
        if (state === 'waiting') return reading === null;
        return (state === 'fresh' || state === 'stale') && reading && typeof reading === 'object' &&
            !Array.isArray(reading) && isTimestamp(reading.captured_at) &&
            Number.isFinite(reading.temperature) && reading.temperature >= -40 && reading.temperature <= 80 &&
            Number.isFinite(reading.humidity) && reading.humidity >= 0 && reading.humidity <= 100;
    }

    function createTracker() {
        const newSensor = () => ({ capturedAt: 0, active: false, points: [] });
        let sensors = { A: newSensor(), B: newSensor() };
        let generatedAt = 0;

        function accept(snapshot, { now = Date.now(), retained = false } = {}) {
            if (retained || !Number.isFinite(now) || now <= 0) return false;
            if (typeof snapshot === 'string') {
                try { snapshot = JSON.parse(snapshot); } catch (_) { return false; }
            }
            if (snapshot?.source !== 'dht22' || !isFresh(snapshot.generated_at, now) ||
                snapshot.generated_at < generatedAt || !SENSOR_IDS.every(id => isSensor(snapshot.sensors?.[id]))) return false;

            for (const id of SENSOR_IDS) {
                const sensor = sensors[id];
                const { state, reading } = snapshot.sensors[id];
                // A pair can be emitted twice in the same millisecond. Each capture
                // is independent, and an older sibling cannot replace its latest state.
                if (reading && reading.captured_at < sensor.capturedAt) continue;
                if (!reading && snapshot.generated_at === generatedAt) continue;
                if (state !== 'fresh' || !isFresh(reading.captured_at, now)) {
                    sensor.active = false;
                    continue;
                }
                const time = reading.captured_at;
                if (time === sensor.capturedAt) continue;
                if (sensor.points.length && (!sensor.active || !isFresh(sensor.capturedAt, now))) {
                    sensor.points.push({ x: sensor.capturedAt + (time - sensor.capturedAt) / 2, y: null });
                }
                sensor.points.push({ x: time, y: reading.temperature });
                sensor.points = sensor.points.filter(point => now - point.x <= HISTORY_MS).slice(-MAX_POINTS);
                sensor.capturedAt = time;
                sensor.active = true;
            }
            generatedAt = snapshot.generated_at;
            return true;
        }

        function series(now = Date.now()) {
            const current = sensor => sensor.active && isFresh(sensor.capturedAt, now)
                ? sensor.points.filter(point => now - point.x <= HISTORY_MS) : null;
            return { seen: generatedAt > 0, A: current(sensors.A), B: current(sensors.B) };
        }

        function disconnect() {
            for (const id of SENSOR_IDS) sensors[id].active = false;
        }

        function reset() {
            sensors = { A: newSensor(), B: newSensor() };
            generatedAt = 0;
        }

        return { accept, series, disconnect, reset };
    }

    const api = { createTracker };
    root.SmartDht22Telemetry = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
