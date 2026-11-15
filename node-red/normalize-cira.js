'use strict';

/**
 * Normalize a CiRA count or explicitly named detection list without I/O.
 * Explicit counts are authoritative when present; detection arrays are only
 * inspected when there is no explicit count. All helpers stay inside this
 * function so Node-RED can embed normalizeCira.toString() without require().
 */
function normalizeCira(payload, options = {}) {
  let now, source, retained, maxPeople, maxAgeMs, minConfidence;
  const fail = (code, reason) => ({ ok: false, code, reason });
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const countValue = value => {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
      value = Number(text);
    }
    return typeof value === 'number' && Number.isSafeInteger(value)
      && value >= 0 && value <= maxPeople ? value : null;
  };
  const timeValue = value => {
    if (typeof value === 'string') {
      // Require an ISO instant with an explicit timezone; numeric strings are
      // counts only and are not guessed to be epoch seconds or milliseconds.
      const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
      if (!parts) return null;
      const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
        || hour > 23 || minute > 59 || second > 59) return null;
      value = Date.parse(value);
    }
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const detectionsCount = items => {
    if (!Array.isArray(items)) return fail('INVALID_DETECTIONS', 'detections/objects ต้องเป็นรายการวัตถุ');
    let count = 0;
    for (const item of items) {
      if (!isObject(item)) return fail('INVALID_DETECTIONS', 'รายการตรวจจับต้องมีชื่อวัตถุทุกตัว');
      const labels = ['label', 'name', 'class_name', 'className']
        .filter(key => has(item, key)).map(key => item[key]);
      if (!labels.length || labels.some(value => typeof value !== 'string' || !value.trim())) {
        return fail('INVALID_DETECTIONS', 'รายการตรวจจับขาดชื่อวัตถุที่รองรับ');
      }
      const normalizedLabels = labels.map(value => value.trim().toLowerCase());
      if (normalizedLabels.some(value => value !== normalizedLabels[0])) {
        return fail('INVALID_DETECTIONS', 'ชื่อวัตถุในรายการเดียวกันขัดแย้งกัน');
      }
      const scores = ['confidence', 'score'].filter(key => has(item, key)).map(key => item[key]);
      if (scores.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
        || scores.some(value => value !== scores[0])) {
        return fail('INVALID_DETECTIONS', 'ค่าความมั่นใจต้องอยู่ระหว่าง 0 ถึง 1 และไม่ขัดแย้งกัน');
      }
      if (normalizedLabels[0] === 'person' && (!scores.length || scores[0] >= minConfidence)) count++;
      if (count > maxPeople) return fail('INVALID_COUNT', 'จำนวนคนเกินขอบเขตที่กำหนด');
    }
    return { ok: true, count };
  };

  try {
    if (!isObject(options)) return fail('INVALID_OPTIONS', 'ค่าตั้งต้นต้องเป็นวัตถุ');
    ({ now = Date.now(), source = 'mqtt', retained = false,
      maxPeople = 1000, maxAgeMs = 30000, minConfidence = 0.5 } = options);
    if (retained === true) return fail('RETAINED', 'ไม่รับข้อความ MQTT ที่เก็บค้างไว้เป็นข้อมูลกล้องปัจจุบัน');
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isFinite(new Date(now).getTime())
      || !Number.isSafeInteger(maxPeople) || maxPeople < 0
      || typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
      || typeof minConfidence !== 'number' || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      return fail('INVALID_OPTIONS', 'ค่าตั้งต้นเวลา จำนวนคน หรือความมั่นใจไม่ถูกต้อง');
    }

    const cleanSource = typeof source === 'string'
      ? source.trim().replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 50) || 'mqtt'
      : 'mqtt';
    let value = payload;
    if (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer(value)) {
      value = value.toString('utf8');
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return fail('EMPTY_PAYLOAD', 'ข้อความจำนวนคนว่าง');
      if (/^\d+(?:\.\d+)?$/.test(text)) value = text;
      else {
        try { value = JSON.parse(text); }
        catch (_) { return fail('INVALID_JSON', 'ข้อความไม่ใช่ตัวเลขหรือ JSON ที่ถูกต้อง'); }
      }
    }

    let count;
    let timestamp = now, sampleTimeSource = 'received';
    if (typeof value === 'number' || typeof value === 'string') {
      count = countValue(value);
      if (count === null) return fail('INVALID_COUNT', 'จำนวนคนต้องเป็นจำนวนเต็มตั้งแต่ 0 ถึงค่าที่กำหนด');
    } else if (isObject(value)) {
      const samples = ['timestamp', 'captured_at'].filter(key => has(value, key)).map(key => timeValue(value[key]));
      if (samples.some(sample => sample === null)) return fail('INVALID_TIMESTAMP', 'เวลาเก็บภาพต้องเป็น epoch มิลลิวินาทีหรือ ISO พร้อมเขตเวลา');
      if (samples.some(sample => sample !== samples[0])) return fail('TIMESTAMP_CONFLICT', 'เวลาเก็บภาพในข้อความขัดแย้งกัน');
      if (samples.length) { timestamp = samples[0]; sampleTimeSource = 'camera'; }

      const counts = ['total_people', 'people', 'person_count']
        .filter(key => has(value, key)).map(key => value[key]);
      if (has(value, 'counts') && isObject(value.counts) && has(value.counts, 'person')) counts.push(value.counts.person);
      if (counts.length) {
        const parsedCounts = counts.map(countValue);
        if (parsedCounts.some(number => number === null)) return fail('INVALID_COUNT', 'จำนวนคนต้องเป็นจำนวนเต็มตั้งแต่ 0 ถึงค่าที่กำหนด');
        if (parsedCounts.some(number => number !== parsedCounts[0])) return fail('COUNT_CONFLICT', 'ฟิลด์จำนวนคนในข้อความขัดแย้งกัน');
        count = parsedCounts[0];
      } else {
        const arrays = ['detections', 'objects'].filter(key => has(value, key));
        if (!arrays.length) return fail('UNSUPPORTED_SCHEMA', 'ไม่พบฟิลด์จำนวนคนหรือรายการตรวจจับที่รองรับ');
        const results = arrays.map(key => detectionsCount(value[key]));
        const invalid = results.find(result => !result.ok);
        if (invalid) return invalid;
        if (results.some(result => result.count !== results[0].count)) {
          return fail('DETECTION_CONFLICT', 'จำนวนคนจาก detections และ objects ขัดแย้งกัน');
        }
        count = results[0].count;
      }
    } else return fail('INVALID_PAYLOAD', 'ข้อความต้องเป็นตัวเลขหรือวัตถุ JSON ที่รองรับ');

    if (now - timestamp > maxAgeMs) return fail('STALE_SAMPLE', 'ข้อมูลกล้องเก่าเกินช่วงเวลาที่กำหนด');
    if (timestamp - now > 5000) return fail('FUTURE_SAMPLE', 'เวลาเก็บภาพอยู่ในอนาคตเกิน 5 วินาที');
    return {
      ok: true,
      ...(options.includeProvenance === true ? { sampleTimeSource } : {}),
      data: { total_people: count, source: cleanSource, timestamp, received_at: new Date(now).toISOString() }
    };
  } catch (_) {
    return fail('INVALID_PAYLOAD', 'อ่านข้อความกล้องไม่ได้');
  }
}

module.exports = { normalizeCira };
