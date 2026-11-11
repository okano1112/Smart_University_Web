(function (root) {
    'use strict';
    const MINUTE = 60000;
    const unavailable = message => ({ kind: 'unavailable', message, points: [] });

    // Collect observations and display server results; the cooling model runs on Node.js.
    class ForecastClient {
        constructor({ fetch, onChange = () => {}, now = Date.now }) {
            this.fetch = fetch; this.onChange = onChange; this.now = now;
            this.context = null; this.samples = []; this.result = null; this.generation = 0; this.clockOffset = 0;
        }
        reset(context = null) {
            this.controller?.abort(); this.controller = null; this.generation++;
            this.context = context; this.samples = []; this.result = null; this.key = null; this.failed = false;
        }
        record({ time, temp, context }) {
            if (context !== this.context) this.reset(context);
            if (!Number.isFinite(time) || !Number.isFinite(temp) || temp < -10 || temp > 60) return;
            const last = this.samples.at(-1);
            if (last && time <= last.time) return;
            if (last && time - last.time > 2 * MINUTE) this.samples = [];
            if (this.samples.length && time - this.samples.at(-1).time < 25000) return;
            this.samples.push({ time, temp });
            this.samples = this.samples.filter(s => time - s.time <= 15 * MINUTE).slice(-40);
        }
        nowOnServer() { return this.now() + this.clockOffset; }
        sync(input, context) {
            if (context !== this.context) this.reset(context);
            const payload = { ...input, samples: this.samples.slice() }, key = JSON.stringify(payload);
            if (key !== this.key || (this.failed && this.now() - this.requestAt >= 5000)) this.request(payload, key);
            const result = this.result || { kind: 'loading', message: 'เซิร์ฟเวอร์กำลังคำนวณเวลาถึงเป้าหมาย', points: [] };
            // Telemetry timestamps are captured by this browser. Compare them in
            // the same clock domain; the server offset is only for its arrival time.
            const now = this.now();
            if (!input.sensorAt || now - input.sensorAt > 30000 || now < input.sensorAt) return unavailable('รออุณหภูมิห้องล่าสุดจากเซนเซอร์');
            if (!input.statusFresh || !input.statusAt || now - input.statusAt > 75000 || now < input.statusAt) return unavailable('รอสถานะล่าสุดจาก ESP32');
            return result;
        }
        async request(payload, key) {
            this.controller?.abort();
            const controller = new AbortController(), generation = ++this.generation, started = this.now();
            this.controller = controller; this.key = key; this.result = null; this.failed = false; this.requestAt = started;
            const timeout = setTimeout(() => controller.abort(), 8000);
            try {
                const response = await this.fetch('/api/cooling-forecast', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, clientNow: started }), signal: controller.signal
                });
                const data = await response.json();
                if (generation !== this.generation) return;
                if (!response.ok || !['estimate', 'unavailable', 'reached'].includes(data.kind) || !Array.isArray(data.points)) throw new Error('คำนวณเวลาไม่สำเร็จ');
                this.result = data;
                if (Number.isFinite(data.generatedAt)) this.clockOffset = data.generatedAt - (started + this.now()) / 2;
            } catch (_) {
                if (generation !== this.generation) return;
                this.failed = true; this.result = unavailable('ติดต่อระบบคาดการณ์ในเซิร์ฟเวอร์ไม่ได้ กำลังรอลองใหม่');
            } finally {
                clearTimeout(timeout);
                if (generation === this.generation) { this.controller = null; this.onChange(); }
            }
        }
    }
    function duration(minutes) {
        if (!Number.isFinite(minutes) || minutes < 0) return '—';
        const n = Math.max(1, Math.round(minutes));
        return n < 60 ? `${n} นาที` : `${Math.floor(n / 60)} ชม.${n % 60 ? ` ${n % 60} นาที` : ''}`;
    }
    const zone = 'Asia/Bangkok';
    function dayNumber(time) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(time).map(p => [p.type, p.value]));
        return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000;
    }
    function clockTime(time, now = Date.now()) {
        if (!Number.isFinite(time)) return '—';
        const clock = new Date(time).toLocaleTimeString('th-TH', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const difference = dayNumber(time) - dayNumber(now);
        const date = difference === 0 ? '' : difference === 1 ? 'พรุ่งนี้ ' : new Date(time).toLocaleDateString('th-TH', { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric' }) + ' ';
        return date + clock + ' น.';
    }
    function remainingMinutes(result, now = Date.now()) { return Math.max(0, (result.arrivalAt - now) / MINUTE); }
    const api = { ForecastClient, duration, clockTime, remainingMinutes };
    root.SmartCoolingForecastClient = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
