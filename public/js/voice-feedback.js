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
    const api = { phrases, describe, variant };
    root.SmartVoiceFeedback = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
