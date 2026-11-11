'use strict';

const MINUTE = 60_000;
const METHOD = 'local_trend';
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : NaN;
};

class ForecastInputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function normalizeInput(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.clientNow === undefined) return input;
  if (!Number.isFinite(input.clientNow) || input.clientNow <= 0 || input.clientNow > 8.64e15) throw new ForecastInputError('เวลา clientNow ไม่ถูกต้อง');
  // Telemetry timestamps originate in the browser. Preserve their ages while
  // expressing the observations and predictions on the server's clock.
  const shiftTime = (time, key) => {
    if (time == null || time === 0) return time;
    if (!Number.isFinite(time) || time < 0 || time > input.clientNow) throw new ForecastInputError(`เวลา ${key} ไม่ถูกต้อง`);
    return now - (input.clientNow - time);
  };
  return { ...input, sensorAt: shiftTime(input.sensorAt, 'sensorAt'), statusAt: shiftTime(input.statusAt, 'statusAt'),
    samples: Array.isArray(input.samples) ? input.samples.map(sample =>
      sample && typeof sample === 'object' && !Array.isArray(sample) ? { ...sample, time: shiftTime(sample.time, 'sample.time') } : sample) : input.samples };
}

function validateInput(input, now) {
  const invalid = message => { throw new ForecastInputError(message); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('ข้อมูลคาดการณ์ไม่ถูกต้อง');
  for (const [key, min, max] of [['roomTemp', -10, 60], ['target', 21, 27], ['assumedRate', .02, .5]]) {
    const value = input[key];
    if (value != null && (!Number.isFinite(value) || value < min || value > max)) invalid(`ค่า ${key} ไม่ถูกต้อง`);
  }
  for (const key of ['power', 'statusFresh', 'pending']) {
    if (input[key] != null && typeof input[key] !== 'boolean') invalid(`ค่า ${key} ไม่ถูกต้อง`);
  }
  if (input.mode != null && ![0, 1, 2].includes(input.mode)) invalid('โหมดแอร์ไม่ถูกต้อง');
  for (const key of ['sensorAt', 'statusAt']) {
    if (input[key] != null && (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > now)) invalid(`เวลา ${key} ไม่ถูกต้อง`);
  }
  const samples = input.samples == null ? [] : input.samples;
  if (!Array.isArray(samples) || samples.length > 40) invalid('ข้อมูลย้อนหลังต้องมีไม่เกิน 40 จุด');
  let previous = -Infinity;
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)
      || !Number.isFinite(sample.time) || sample.time <= 0 || sample.time > now
      || (input.sensorAt > 0 && sample.time > input.sensorAt)
      || sample.time <= previous || !Number.isFinite(sample.temp) || sample.temp < -10 || sample.temp > 60) {
      invalid('ข้อมูลอุณหภูมิย้อนหลังหรือเวลาไม่ถูกต้อง');
    }
    previous = sample.time;
  }
  return samples;
}

// Recreated for each request: the browser supplies observations from the current AC setting.
class CoolingForecast {
  constructor() { this.reset(); }
  reset() { this.context = null; this.samples = []; }
  record({ time, temp, context }) {
    if (!Number.isFinite(time) || !Number.isFinite(temp) || temp < -10 || temp > 60) return;
    if (context !== this.context) { this.context = context; this.samples = []; }
    const last = this.samples.at(-1);
    if (last && time <= last.time) return;
    if (last && time - last.time > 2 * MINUTE) this.samples = [];
    if (this.samples.length && time - this.samples.at(-1).time < 25_000) return;
    this.samples.push({ time, temp });
    this.samples = this.samples.filter(sample => time - sample.time <= 15 * MINUTE).slice(-40);
  }
  estimate({ now = Date.now(), roomTemp, target, power, mode, sensorAt, statusAt, statusFresh, pending = false, assumedRate = .1 }) {
    const common = { method: METHOD, generatedAt: now, arrivalAt: null, earliestAt: null, latestAt: null };
    const unavailable = message => ({ ...common, kind: 'unavailable', message, points: [], source: null });
    if (!Number.isFinite(roomTemp) || !sensorAt || now < sensorAt || now - sensorAt > 30_000) return unavailable('รออุณหภูมิห้องล่าสุดจากเซนเซอร์');
    if (pending) return unavailable('รอ ESP32 รายงานค่าที่ตั้งใหม่ก่อนคาดการณ์');
    if (!statusFresh || !statusAt || now < statusAt || now - statusAt > 75_000
      || typeof power !== 'boolean' || !Number.isFinite(target)) return unavailable('รอสถานะล่าสุดจาก ESP32');
    if (!power) return unavailable('แอร์ปิดอยู่ ยังไม่คาดการณ์การทำความเย็น');
    if (mode !== 0) return unavailable('คาดการณ์เวลาได้เมื่อใช้โหมด COOL');
    if (roomTemp <= target + .2) return { ...common, kind: 'reached', message: 'อุณหภูมิห้องถึงหรือใกล้เป้าหมายแล้ว (±0.2°C)', points: [], source: null, minutes: 0 };
    if (!Number.isFinite(assumedRate) || assumedRate < .02 || assumedRate > .5) assumedRate = .1;
    const recent = this.samples.filter(sample => sample.time <= sensorAt && now - sample.time <= 15 * MINUTE);
    const span = recent.length ? (recent.at(-1).time - recent[0].time) / MINUTE : 0;
    let rate = assumedRate, low = rate * .7, high = rate * 1.3, source = 'assumed';
    if (recent.length >= 6 && span >= 3) {
      const slopes = [];
      for (let i = 0; i < recent.length; i++) for (let j = i + 1; j < recent.length; j++) {
        const dt = (recent[j].time - recent[i].time) / MINUTE;
        if (dt >= 1) slopes.push((recent[i].temp - recent[j].temp) / dt);
      }
      rate = quantile(slopes, .5); source = 'measured';
      if (!Number.isFinite(rate) || rate < .01) return unavailable('อุณหภูมิยังไม่ลดลงชัดเจน จึงยังบอกเวลาถึงเป้าหมายไม่ได้');
      // These are rate scenarios, not a statistical confidence interval.
      low = Math.max(.005, Math.min(quantile(slopes, .2), rate * .8));
      high = Math.max(quantile(slopes, .8), rate * 1.2);
    }
    const delta = roomTemp - target;
    const arrivalAt = sensorAt + delta / rate * MINUTE;
    const earliestAt = sensorAt + delta / high * MINUTE;
    const latestAt = sensorAt + delta / low * MINUTE;
    const minutes = Math.max(0, (arrivalAt - now) / MINUTE);
    const minMinutes = Math.max(0, (earliestAt - now) / MINUTE);
    const maxMinutes = Math.max(0, (latestAt - now) / MINUTE);
    const horizon = Math.min(180, Math.max(15, (latestAt - sensorAt) / MINUTE * 1.1));
    const points = [];
    for (let i = 0; i <= 40; i++) {
      const m = horizon * i / 40;
      points.push({ time: sensorAt + m * MINUTE, temp: Math.max(target, roomTemp - rate * m),
        lower: Math.max(target, roomTemp - high * m), upper: Math.max(target, roomTemp - low * m) });
    }
    if (arrivalAt <= sensorAt + horizon * MINUTE && !points.some(point => point.time === arrivalAt)) {
      const m = delta / rate;
      points.push({ time: arrivalAt, temp: target, lower: target, upper: Math.max(target, roomTemp - low * m) });
      points.sort((a, b) => a.time - b.time);
    }
    return { ...common, kind: 'estimate', source, rate, minutes, minMinutes, maxMinutes, arrivalAt, earliestAt, latestAt, points,
      message: source === 'measured' ? 'คำนวณจากแนวโน้มเซนเซอร์ในช่วงล่าสุด' : 'ประมาณเบื้องต้นจากอัตราความเย็นที่สมมติ', sampleCount: recent.length, span };
  }
}

function calculateCoolingForecast(input, { now = Date.now() } = {}) {
  input = normalizeInput(input, now);
  const samples = validateInput(input, now);
  const forecast = new CoolingForecast();
  for (const sample of samples) forecast.record({ ...sample, context: 'request' });
  // Include the current reading, including the telemetry-gap reset, even when the
  // browser has not yet added it to its spaced observation history.
  if (input.sensorAt > 0 && Number.isFinite(input.roomTemp)) forecast.record({ time: input.sensorAt, temp: input.roomTemp, context: 'request' });
  return forecast.estimate({ ...input, now });
}

function duration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  const n = Math.max(1, Math.round(minutes));
  return n < 60 ? `${n} นาที` : `${Math.floor(n / 60)} ชม.${n % 60 ? ` ${n % 60} นาที` : ''}`;
}

module.exports = { CoolingForecast, calculateCoolingForecast, ForecastInputError, duration };
