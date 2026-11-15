(function (root) {
    'use strict';
    const phrases = {
        'wake-ready': 'ครับ พูดได้เลยครับ',
        'power-on': 'เปิดแอร์ครับ', 'power-off': 'ปิดแอร์ครับ',
        'power-on-alt': 'รับทราบครับ เปิดแอร์ครับ', 'power-off-alt': 'รับทราบครับ ปิดแอร์ครับ',
        'too-long': 'กรุณาพูดคำสั่งให้สั้นลง ไม่เกินสิบสองวินาทีครับ',
        'ask-temperature': 'ต้องการกี่องศาครับ',
        'cancelled': 'รับทราบครับ ยังไม่ส่งคำสั่ง',
        'need-status': 'ยังไม่ทราบอุณหภูมิปัจจุบัน กรุณารอสถานะอุปกรณ์หรือระบุอุณหภูมิครับ',
        'temp-range': 'ระบบอุปกรณ์ปัจจุบันรองรับอุณหภูมิยี่สิบเอ็ดถึงยี่สิบเจ็ดองศาครับ',
        'unsupported': 'อุปกรณ์ปัจจุบันยังไม่รองรับคำสั่งสวิงและโหมดนอนครับ',
        'fan-0': 'ปรับพัดลมเป็นอัตโนมัติครับ', 'fan-1': 'ปรับพัดลมเป็นระดับเบาครับ',
        'fan-2': 'ปรับพัดลมเป็นระดับกลางครับ', 'fan-3': 'ปรับพัดลมเป็นระดับแรงครับ',
        'mode-0': 'ปรับเป็นโหมดทำความเย็นครับ', 'mode-1': 'ปรับเป็นโหมดลดความชื้นครับ', 'mode-2': 'ปรับเป็นโหมดพัดลมครับ',
        'not-understood': 'ไม่เข้าใจคำสั่งครับ กรุณาพูดใหม่', 'not-sent': 'ยังส่งคำสั่งไม่ได้ครับ กรุณาตรวจสอบการเชื่อมต่อ'
    };
    for (let temp = 21; temp <= 27; temp++) phrases[`temp-${temp}`] = `ตั้งอุณหภูมิ ${temp} องศาครับ`;
    const preloadKeys = Object.freeze(Object.keys(phrases));
    const digits = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
    for (let i = 0; i <= 9; i++) phrases[`num-${i}`] = digits[i];
    for (let i = 1; i <= 9; i++) phrases[`num-${i * 10}`] = `${i === 1 ? '' : i === 2 ? 'ยี่' : digits[i]}สิบ`;
    Object.assign(phrases, {
        'num-et': 'เอ็ด', 'num-hundred': 'ร้อย', 'num-100': 'หนึ่งร้อย', 'num-1000': 'หนึ่งพัน',
        'num-point': 'จุด', 'num-minus': 'ลบ',
        'answer-room-temperature': 'อุณหภูมิห้องตอนนี้',
        'answer-room-humidity': 'ความชื้นในห้องตอนนี้',
        'answer-people-count': 'ตอนนี้ตรวจพบ',
        'answer-ac-setpoint': 'แอร์ตั้งไว้ที่',
        'answer-degrees': 'องศาเซลเซียสครับ',
        'answer-percent': 'เปอร์เซ็นต์ครับ',
        'answer-people': 'คนครับ',
        'answer-ac-on': 'สถานะล่าสุด แอร์เปิดอยู่ครับ',
        'answer-ac-off': 'สถานะล่าสุด แอร์ปิดอยู่ครับ',
        'answer-unavailable': 'ตอนนี้ยังไม่มีข้อมูลล่าสุดครับ'
    });

    function numberClips(formatted) {
        const [integer, fraction] = formatted.replace(/^-/, '').split('.');
        const value = Number(integer), clips = [];
        // Don't say "minus zero" when a small negative rounds to displayed -0.0.
        if (formatted.startsWith('-') && Number(formatted) !== 0) clips.push('num-minus');
        if (value <= 9 || value === 100 || value === 1000) clips.push(`num-${value}`);
        else {
            const hundreds = Math.floor(value / 100), tens = Math.floor(value / 10) % 10, ones = value % 10;
            if (hundreds === 1) clips.push('num-100');
            else if (hundreds) clips.push(`num-${hundreds}`, 'num-hundred');
            if (tens) clips.push(`num-${tens * 10}`);
            if (ones) clips.push(ones === 1 ? 'num-et' : `num-${ones}`);
        }
        if (fraction && /[1-9]/.test(fraction)) clips.push('num-point', ...[...fraction].map(digit => `num-${digit}`));
        return clips;
    }

    function answerQuestion(query, reading) {
        const one = key => ({ text: phrases[key], clips: [key] });
        const unavailable = () => one('answer-unavailable');
        if (query === 'ac_power') return typeof reading === 'boolean' ? one(reading ? 'answer-ac-on' : 'answer-ac-off') : unavailable();
        const finite = typeof reading === 'number' && Number.isFinite(reading);
        let formatted, lead, tail;
        switch (query) {
        case 'room_temperature':
            if (!finite || reading < -10 || reading > 60) return unavailable();
            formatted = reading.toFixed(1); lead = 'answer-room-temperature'; tail = 'answer-degrees'; break;
        case 'room_humidity':
            if (!finite || reading < 0 || reading > 100) return unavailable();
            formatted = String(Math.round(reading)); lead = 'answer-room-humidity'; tail = 'answer-percent'; break;
        case 'people_count':
            if (!Number.isInteger(reading) || reading < 0 || reading > 1000) return unavailable();
            formatted = String(reading); lead = 'answer-people-count'; tail = 'answer-people'; break;
        case 'ac_setpoint':
            if (!Number.isInteger(reading) || reading < 21 || reading > 27) return unavailable();
            formatted = String(reading); lead = 'answer-ac-setpoint'; tail = 'answer-degrees'; break;
        default: return null;
        }
        return { text: `${phrases[lead]} ${formatted} ${phrases[tail]}`, clips: [lead, ...numberClips(formatted), tail] };
    }

    function describe(next, current = {}, fields) {
        if (!next || typeof next.power !== 'boolean' || !Number.isInteger(next.temp) || next.temp < 21 || next.temp > 27 || ![0, 1, 2].includes(next.mode) || ![0, 1, 2, 3].includes(next.fan)) return null;
        const requested = new Set(Array.isArray(fields) ? fields : ['power', 'temp', 'mode', 'fan'].filter(key => current[key] !== next[key]));
        if (!next.power) return { text: phrases['power-off'], clips: ['power-off'] };
        const clips = [];
        if (requested.has('power')) clips.push('power-on');
        if (requested.has('temp')) clips.push(`temp-${next.temp}`);
        if (requested.has('mode')) clips.push(`mode-${next.mode}`);
        if (requested.has('fan')) clips.push(`fan-${next.fan}`);
        if (!clips.length) clips.push(`temp-${next.temp}`);
        return { text: clips.map(key => phrases[key]).join(' '), clips };
    }
    function variant(feedback) {
        const key = feedback.clips[0] + '-alt';
        return phrases[key] ? { text: phrases[key], clips: [key] } : feedback;
    }
    const api = { phrases, preloadKeys, describe, variant, answerQuestion };
    root.SmartVoiceFeedback = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
