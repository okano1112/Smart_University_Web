require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { VoiceSessions, VoiceError, detectAndStripWakeWord, validAc, ambiguousSpeech } = require('./voice-session');
const voiceSessions = new VoiceSessions();
const { LocalVoice, commandFor } = require('./offline-voice');
const localVoice = new LocalVoice();
const { describe: describeVoiceCommand } = require('./public/js/voice-feedback');

const app = express();
app.use(cors());
app.use(express.json());

// เสิร์ฟไฟล์โมเดล Silero VAD และ ONNX Runtime จากเครื่องตัวเอง
app.use('/vad-web', express.static(path.join(__dirname, 'node_modules/@ricky0123/vad-web/dist')));
app.use('/ort', express.static(path.join(__dirname, 'node_modules/onnxruntime-web/dist')));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const MIN_TEMP = 21;
const MAX_TEMP = 27;
const MODE_NAMES = ['COOL', 'DRY', 'FAN'];
const FAN_NAMES = ['AUTO', 'LOW', 'MED', 'HIGH'];
const INTENTS_FILE_PATH = path.join(__dirname, 'voice_intents.json');
const LOG_FILE_PATH = process.env.VOICE_LOG_PATH || path.join(__dirname, 'voice_history.log');

// ============================================================================
// คลังคำสั่งหลักเริ่มต้น (Master Default Dictionary)
// หากต้องการเพิ่มคำพูดด้วยตัวเอง สามารถแก้ที่ไฟล์ voice_intents.json หรือแก้ในนี้ได้เลย
// ============================================================================
const DEFAULT_DICTIONARY = {
  whisper_prompt_keywords: "เอ็นจี้ Engi open close turn on turn off switch on switch off air conditioner เปิดแอร์ให้ผมหน่อย ปิดแอร์ให้ที ขออุณหภูมิ 21 22 23 24 25 26 27 องศา แอร์หนาวเกินไป แอร์ร้อนเกินไป แอร์ไม่เย็น พัดลมแรงสุด พัดลมกลาง พัดลมเบาสุด เบาลมลง เพิ่มพัดลม โหมดดราย โหมดคูล",

  power_off_phrases: [
    "ปิดแอร์", "ปิดเครื่องปรับอากาศ", "ดับแอร์", "หยุดแอร์", "ปิดระบบแอร์",
    "เลิกใช้แอร์", "ปิดสวิตช์แอร์", "ปิดให้หน่อย", "ปิดเลย", "เลิกเรียนแล้วปิด",
    "หมดคาบแล้วปิด", "ไม่มีคนแล้วปิด"
  ],

  power_on_phrases: [
    "เปิดแอร์", "เปิดเครื่องปรับอากาศ", "ติดแอร์", "เริ่มแอร์", "เปิดระบบแอร์",
    "เปิดสวิตช์แอร์", "เปิดให้หน่อย", "เปิดเลย", "ขอแอร์หน่อย", "เอาแอร์หน่อย"
  ],

  relative_temp_rules: [
    {
      id: "feel_cold",
      name: "แอร์หนาว / เย็นเกินไป (ปรับอุ่นขึ้น +1°C)",
      tempDelta: 1,
      phrases: [
        "แอร์หนาว", "หนาวเกิน", "หนาวไป", "หนาวจัง", "หนาวมาก", "หนาวแล้ว", "เริ่มหนาว",
        "เย็นเกิน", "เย็นไป", "แอร์เย็นมาก", "เบาแอร์", "ผ่อนแอร์", "ลดความเย็น",
        "ลดแอร์หน่อย", "ขออุ่นขึ้น", "ปรับให้อุ่น", "อุ่นกว่านี้", "ขนลุก"
      ]
    },
    {
      id: "feel_very_cold",
      name: "แอร์หนาวจัด (ปรับอุ่นขึ้น +2°C)",
      tempDelta: 2,
      phrases: [
        "หนาวสั่น", "หนาวสุด", "หนาวไม่ไหว", "หนาวจะตาย", "แข็งไปหมด",
        "มือแข็ง", "นิ้วชา", "เย็นยะเยือก", "เหมือนขั้วโลก"
      ]
    },
    {
      id: "feel_hot",
      name: "แอร์ร้อน / ไม่เย็น (ปรับเย็นขึ้น -1°C)",
      tempDelta: -1,
      phrases: [
        "แอร์ร้อน", "ร้อนเกิน", "ร้อนไป", "ร้อนจัง", "ร้อนมาก", "ร้อนแล้ว", "เริ่มร้อน",
        "ไม่เย็น", "ไม่ค่อยเย็น", "แอร์ไม่ฉ่ำ", "เร่งแอร์", "เร่งความเย็น", "เพิ่มความเย็น",
        "ขอเย็นขึ้น", "ขอเย็นกว่านี้", "ปรับให้เย็น", "อบอ้าว", "อึดอัด", "อากาศร้อน"
      ]
    },
    {
      id: "feel_very_hot",
      name: "แอร์ร้อนจัด (ปรับเย็นขึ้น -2°C)",
      tempDelta: -2,
      phrases: [
        "ร้อนตับแตก", "ร้อนสุด", "ร้อนไม่ไหว", "ร้อนจะตาย", "เหงื่อแตก",
        "เหงื่อท่วม", "เหงื่อออก", "เหมือนเตาอบ", "เหมือนไฟเผา"
      ]
    }
  ],

  preset_scenes: [
    {
      id: "scene_cool_strong",
      name: "โหมดเย็นฉ่ำ / คนเยอะ (23°C • COOL • พัดลม HIGH)",
      set: { power: true, temp: 23, mode: 0, fan: 3 },
      phrases: ["เย็นฉ่ำ", "ขอเย็นฉ่ำ", "คนเต็มห้อง", "คนเยอะ", "นักศึกษาเยอะ", "เต็มห้อง"]
    },
    {
      id: "scene_standard",
      name: "โหมดมาตรฐานห้องเรียน (24°C • COOL • พัดลม HIGH)",
      set: { power: true, temp: 24, mode: 0, fan: 3 },
      phrases: ["โหมดมาตรฐาน", "ค่ามาตรฐาน", "อุณหภูมิมาตรฐาน", "ค่าเริ่มต้น", "อุณหภูมิปกติ", "เริ่มคลาส", "เริ่มเรียน", "เปิดแอร์สอน"]
    },
    {
      id: "scene_eco",
      name: "โหมดประหยัดพลังงาน (25°C • COOL • พัดลม AUTO)",
      set: { power: true, temp: 25, mode: 0, fan: 0 },
      phrases: ["ประหยัดไฟ", "ประหยัดพลังงาน", "โหมดอีโค", "คนน้อย", "อยู่คนเดียว"]
    },
    {
      id: "scene_min_temp",
      name: "เย็นที่สุดของระบบ (21°C)",
      set: { power: true, temp: 21, mode: 0, fan: 3 },
      phrases: ["เย็นที่สุด", "เย็นสุด", "อุณหภูมิต่ำสุด", "ปรับต่ำสุด", "เอาต่ำสุด"]
    },
    {
      id: "scene_max_temp",
      name: "อุ่นที่สุดของระบบ (27°C)",
      set: { power: true, temp: 27, mode: 0, fan: 1 },
      phrases: ["อุ่นที่สุด", "อุ่นสุด", "อุณหภูมิสูงสุด", "ปรับสูงสุด", "เอาสูงสุด"]
    }
  ],

  mode_rules: [
    {
      id: "mode_cool",
      mode: 0,
      label: "โหมดทำความเย็น (COOL)",
      phrases: ["โหมดคูล", "ทำความเย็น", "โหมดเย็น", "cool"]
    },
    {
      id: "mode_dry",
      mode: 1,
      label: "โหมดลดความชื้น (DRY)",
      phrases: ["โหมดดราย", "ลดความชื้น", "โหมดแห้ง", "อากาศชื้น", "เหนียวตัว", "ฝนตก", "dry"]
    },
    {
      id: "mode_fan",
      mode: 2,
      label: "โหมดพัดลม (FAN)",
      phrases: ["โหมดแฟน", "พัดลมอย่างเดียว", "ระบายอากาศ", "มีกลิ่นอับ", "fan"]
    }
  ],

  fan_rules: [
    {
      id: "fan_high",
      fan: 3,
      label: "พัดลมแรงสุด (HIGH)",
      phrases: ["พัดลมแรง", "ลมแรง", "เบอร์ 3", "ระดับ 3", "แรงสุด", "อัดลม"]
    },
    {
      id: "fan_med",
      fan: 2,
      label: "พัดลมปานกลาง (MED)",
      phrases: ["พัดลมกลาง", "ลมกลาง", "เบอร์ 2", "ระดับ 2", "ลมปานกลาง"]
    },
    {
      id: "fan_low",
      fan: 1,
      label: "พัดลมเบาสุด (LOW)",
      phrases: ["พัดลมเบา", "ลมเบา", "เบอร์ 1", "ระดับ 1", "เบาสุด", "ลมเงียบ", "เสียงแอร์ดัง", "แอร์ดัง"]
    },
    {
      id: "fan_auto",
      fan: 0,
      label: "พัดลมอัตโนมัติ (AUTO)",
      phrases: ["พัดลมออโต้", "ลมออโต้", "พัดลมอัตโนมัติ", "ลมอัตโนมัติ"]
    }
  ],

  ai_learned_log: []
};

const FORBIDDEN_SINGLE_WORDS = new Set([
  'แอร์', 'เครื่องปรับอากาศ', 'อุณหภูมิ', 'องศา', 'ห้อง', 'ห้องเรียน',
  'ปรับ', 'ตั้ง', 'เปิด', 'ปิด', 'ขอ', 'เอา', 'ช่วย', 'พัดลม', 'ลม', 'โหมด', 'เอ็นจี้', 'engi'
]);

// โหลดและสร้างไฟล์ voice_intents.json อัตโนมัติหากยังไม่มีไฟล์
function loadIntentDictionary() {
  try {
    if (!fs.existsSync(INTENTS_FILE_PATH)) {
      fs.writeFileSync(INTENTS_FILE_PATH, JSON.stringify(DEFAULT_DICTIONARY, null, 2), 'utf8');
      return JSON.parse(JSON.stringify(DEFAULT_DICTIONARY));
    }
    const raw = fs.readFileSync(INTENTS_FILE_PATH, 'utf8');
    const userDict = JSON.parse(raw);
    return {
      ...DEFAULT_DICTIONARY,
      ...userDict
    };
  } catch (err) {
    console.warn('[WARN] ไฟล์ voice_intents.json มีรูปแบบผิดพลาด ระบบใช้คลังคำสั่งหลักแทนชั่วคราว:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_DICTIONARY));
  }
}

function appendVoiceLog(engine, rawText, normText, detail) {
  const line = `[${new Date().toLocaleString('th-TH')}] [${engine}] ได้ยิน: "${rawText}" | แปลง: "${normText}" -> ${detail}\n`;
  fs.appendFile(LOG_FILE_PATH, line, () => {});
}

// ============================================================================
// 1. ฟังก์ชันตรวจสอบคำภาษาไทยแบบป้องกันบั๊กสระหน้า ("เปิด" vs "ปิด") และคำปฏิเสธ ("ไม่")
// ============================================================================
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsThaiPhrase(text, phrase) {
  if (!text || !phrase) return false;
  const cleanPhrase = phrase.trim().toLowerCase();
  if (!cleanPhrase) return false;

  // หากวลีที่จะค้นหาเริ่มต้นด้วยคำว่า "ไม่" อยู่แล้ว (เช่น "ไม่เย็น") ให้เช็กเฉพาะสระหน้า (เ แ โ ใ ไ)
  // หากวลีไม่ได้ขึ้นต้นด้วย "ไม่" ให้ป้องกันทั้งสระหน้า (ป้องกัน "เปิด" แมตช์กับ "ปิด") และป้องกันคำปฏิเสธ (เช่น "ไม่หนาว", "ไม่ร้อน", "อย่าปิด")
  const startsWithNegation = /^(ไม่|อย่า|ห้าม)/.test(cleanPhrase);
  const lookbehind = startsWithNegation
    ? '(?<![\\u0E40-\\u0E44])'
    : '(?<![\\u0E40-\\u0E44]|ไม่|ไม่ได้|ไม่ต้อง|อย่า|อย่าเพิ่ง|ห้าม)';

  // อนุญาตให้มีช่องว่างคั่นระหว่างคำภายในวลีได้
  const flexiblePattern = escapeRegExp(cleanPhrase).replace(/\\\s+/g, '\\s*');
  const regex = new RegExp(`${lookbehind}${flexiblePattern}`, 'i');
  return regex.test(text);
}

function findMatchingPhrase(rawNorm, coreText, phraseList = []) {
  if (!Array.isArray(phraseList)) return null;
  const sorted = [...phraseList].sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    if (containsThaiPhrase(rawNorm, phrase) || containsThaiPhrase(coreText, phrase)) {
      return phrase;
    }
  }
  return null;
}

// ============================================================================
// 2. ระบบตรวจจับคำเรียกชื่อ "Engi" (Wake-Word Detector)
// ============================================================================
// ============================================================================
// 3. ระบบซ่อมคำพ้องเสียงและแปลงตัวเลขภาษาไทย (Thai Phonetic & Number Normalizer)
// ============================================================================
function normalizeAndRepairThaiText(rawText) {
  if (!rawText) return '';
  let text = rawText.trim().toLowerCase();

  // แก้กรณีพิมพ์หรือถอดเสียงสระเอสองตัวติดกัน (เเ) ให้เป็นสระแอ (แ) มาตรฐาน
  text = text.replace(/\u0E40\u0E40/g, '\u0E41');

  // แปลงเลขไทย (๐-๙) เป็นอารบิก (0-9)
  const thaiDigits = ['๐', '๑', '๒', '๓', '๔', '๕', '๖', '๗', '๘', '๙'];
  thaiDigits.forEach((digit, idx) => {
    text = text.replace(new RegExp(digit, 'g'), idx.toString());
  });

  // Translate complete English power requests only; unrelated objects must not turn on AC.
  const englishPower = text.match(/^(?:(?:please|can you|could you|would you)\s+)*(open|close|turn\s+on|turn\s+off|switch\s+on|switch\s+off|power\s+on|power\s+off|shut\s+down)(?:\s*(?:(?:the|my)\s+)?(?:air[ -]?conditioner|air[ -]?conditioning|a\.?c\.?|aircon|แอร์|it))?(?:\s+(?:for me|please))*[.!?]*$/i);
  const trailingPower = text.match(/^(?:(?:please|can you|could you)\s+)*(?:turn|switch|power)\s+(?:(?:the|my)\s+)?(?:air[ -]?conditioner|a\.?c\.?|aircon|it)\s+(on|off)(?:\s+(?:for me|please))*[.!?]*$/i);
  if (englishPower) text = /close|off|shut/.test(englishPower[1]) ? 'ปิดแอร์' : 'เปิดแอร์';
  else if (trailingPower) text = trailingPower[1] === 'off' ? 'ปิดแอร์' : 'เปิดแอร์';

  text = text.replace(/เครื่องปรับอากาศ|เครื่องแอร์|ตัวแอร์|สวิตช์แอร์/g, 'แอร์');
  text = text.replace(/แอ(?!ร์)/g, 'แอร์');

  // ซ่อมคำพ้องเสียงโดยล็อกสระหน้า (?<![\u0E40-\u0E44]) ไม่ให้ "เปิด" กับ "ปิด" ทับกันเด็ดขาด
  const phoneticRepairs = [
    { pattern: /เปิด\s*แอร์/g, replace: 'เปิดแอร์' },
    { pattern: /(?<![\u0E40-\u0E44])ปิด\s*แอร์/g, replace: 'ปิดแอร์' },
    { pattern: /อุนหะพูม|อุนหภูมิ|อุณหภูม(?!ิ)|คุณหภูมิ|อุ่นหภูมิ|อุนภูมิ/g, replace: 'อุณหภูมิ' },
    { pattern: /องสา|องศาเซลเซียส|อองศา|องค์ศา/g, replace: 'องศา' },
    { pattern: /นาวเกิน|หนาวเกิ้น|หนาวเกิ๊น/g, replace: 'หนาวเกิน' },
    { pattern: /รอนเกิน|ร้อนเกิ้น|ร้อนเกิ๊น/g, replace: 'ร้อนเกิน' },
    { pattern: /ออโต(?!้)|อัตโนมัต(?!ิ)|อัตโนมัติ|auto/g, replace: 'ออโต้' }
  ];
  phoneticRepairs.forEach(({ pattern, replace }) => {
    text = text.replace(pattern, replace);
  });

  // ซ่อมคำอ่านตัวเลขภาษาไทยที่เสียงท้ายมักเพี้ยน
  const fuzzyThaiNumbers = [
    { pattern: /ยี่สิบ\s*(เจ็ด|เจ็บ|เจด)/g, replace: '27' },
    { pattern: /ยี่สิบ\s*(หก)/g, replace: '26' },
    { pattern: /ยี่สิบ\s*(ห้า|ฮ่า|หา)/g, replace: '25' },
    { pattern: /ยี่สิบ\s*(สี่|สี|ซี|ซี่)/g, replace: '24' },
    { pattern: /ยี่สิบ\s*(สาม|ขาม|สา)/g, replace: '23' },
    { pattern: /ยี่สิบ\s*(สอง|ซอง|ส่อง)/g, replace: '22' },
    { pattern: /ยี่สิบ\s*(เอ็ด|หนึ่ง|เห็ด|เอ็บ)/g, replace: '21' }
  ];
  fuzzyThaiNumbers.forEach(({ pattern, replace }) => {
    text = text.replace(pattern, replace);
  });

  const compoundNumbers = [
    ['สามสิบเก้า', '39'], ['สามสิบแปด', '38'], ['สามสิบเจ็ด', '37'], ['สามสิบหก', '36'], ['สามสิบห้า', '35'],
    ['สามสิบสี่', '34'], ['สามสิบสาม', '33'], ['สามสิบสอง', '32'], ['สามสิบเอ็ด', '31'], ['สามสิบหนึ่ง', '31'],
    ['ยี่สิบเก้า', '29'], ['ยี่สิบแปด', '28'], ['ยี่สิบเจ็ด', '27'], ['ยี่สิบหก', '26'], ['ยี่สิบห้า', '25'],
    ['ยี่สิบสี่', '24'], ['ยี่สิบสาม', '23'], ['ยี่สิบสอง', '22'], ['ยี่สิบเอ็ด', '21'], ['ยี่สิบหนึ่ง', '21'],
    ['สิบเก้า', '19'], ['สิบแปด', '18'], ['สิบเจ็ด', '17'], ['สิบหก', '16'], ['สิบห้า', '15'],
    ['สิบสี่', '14'], ['สิบสาม', '13'], ['สิบสอง', '12'], ['สิบเอ็ด', '11'],
    ['สามสิบ', '30'], ['ยี่สิบ', '20'], ['สิบ', '10']
  ];
  compoundNumbers.forEach(([word, num]) => {
    text = text.replace(new RegExp(word, 'g'), num);
  });

  const singleNumbers = [
    ['เก้า', '9'], ['แปด', '8'], ['เจ็ด', '7'], ['หก', '6'],
    ['ห้า', '5'], ['สี่', '4'], ['สาม', '3'], ['สอง', '2'], ['หนึ่ง', '1']
  ];
  singleNumbers.forEach(([word, num]) => {
    text = text.replace(new RegExp(word, 'g'), num);
  });

  text = text.replace(/20\s+([1-9])/g, '2$1');
  text = text.replace(/30\s+([1-9])/g, '3$1');
  text = text.replace(/10\s+([1-9])/g, '1$1');
  text = text.replace(/(?<!เบอร์\s*)([1-3])\s+([0-9])/g, '$1$2');

  return text.replace(/\s+/g, ' ').trim();
}

// ตัดคำสุภาพ คำสรรพนาม และคำเชื่อมฟุ่มเฟือยออกเพื่อให้เหลือเฉพาะแก่นคำสั่ง
function extractCoreThaiMeaning(normalizedText) {
  if (!normalizedText) return '';
  let core = normalizedText;
  const fillerPatterns = [
    /ให้ผมหน่อยได้ไหม|ให้หนูหน่อยได้ไหม|ให้เราหน่อยได้ไหม|ให้หน่อยได้ไหม/g,
    /ให้ผมหน่อย|ให้หนูหน่อย|ให้เราหน่อย|ให้หน่อย|ให้ผมที|ให้หนูที|ให้ที/g,
    /หน่อยได้ไหม|ได้ไหมครับ|ได้ไหมค่ะ|ได้ไหมคะ|ได้ไหม|ได้ปะ|ได้เปล่า/g,
    /รบกวนช่วย|กรุณาช่วย|อยากจะขอให้|อยากให้ช่วย|อยากให้|ช่วยปรับ|วานช่วย|อยากได้/g,
    /ในห้องเรียนนี้|ในห้องเรียน|ในห้องนี้|ในห้อง|ข้างในห้อง|ข้างในนี้|ข้างใน/g,
    /อาจารย์ครับ|อาจารย์ค่ะ|พี่ครับ|พี่ค่ะ|น้องครับ|คุณครับ/g,
    /ตอนนี้เลย|เดี๋ยวนี้เลย|ตอนนี้|เดี๋ยวนี้|วันนี้|ช่วงนี้/g,
    /รู้สึกว่ามัน|รู้สึกว่า|รู้สึกเหมือน|เหมือนว่ามัน|ผมว่ามัน|หนูว่ามัน/g,
    /รบกวน|กรุณา|หน่อยสิ|หน่อยนะ|นะครับ|นะค่ะ|นะคะ|เลยครับ|เลยค่ะ/g,
    /ครับผม|ครับ|ค่ะ|คะ|จ้า|จ้ะ|เว้ย|ว่ะ|เนี่ย|เถอะ|ทีสิ|สิครับ/g,
    /ผม|หนู|ฉัน|กู|เรา|พี่|น้อง|อาจารย์|จารย์/g,
    /ช่วย|วาน|หน่อย|ที|สิ|เลย|นะ|มัน|ตัว|สัก/g,
    /ๆ+/g
  ];
  fillerPatterns.forEach((p) => { core = core.replace(p, ' '); });
  core = core.replace(/([ก-๙])\s+([ก-๙])/g, '$1$2');
  core = core.replace(/([ก-๙])\s+([ก-๙])/g, '$1$2');
  return core.replace(/\s+/g, ' ').trim();
}

// ============================================================================
// 4. สมองสกัดคำสั่ง Multi-Concept Engine (เข้าใจทั้งคลังคำศัพท์ + โครงสร้างประโยคอิสระ)
// ============================================================================
function parseWithDictionaryAndRules(rawNorm, coreText, currentAc, dict) {
  if (!rawNorm || ambiguousSpeech(rawNorm)) return { matched: false };

  // เช็กว่ามีทั้งคำว่า "เปิดแอร์" และ "ปิดแอร์" จริงๆ หรือไม่ (ใช้ containsThaiPhrase ที่แก้บั๊กสระเอแล้ว)
  const hasRealOpen = containsThaiPhrase(rawNorm, 'เปิดแอร์');
  const hasRealClose = containsThaiPhrase(rawNorm, 'ปิดแอร์');
  if ((hasRealOpen && hasRealClose) || rawNorm.includes('คำสั่งควบคุมแอร์')) {
    return { matched: false };
  }

  let next = {
    power: currentAc && typeof currentAc.power === 'boolean' ? currentAc.power : true,
    temp: currentAc && Number.isInteger(currentAc.temp) && currentAc.temp >= MIN_TEMP && currentAc.temp <= MAX_TEMP ? currentAc.temp : 24,
    mode: currentAc && Number.isInteger(currentAc.mode) && currentAc.mode >= 0 && currentAc.mode <= 2 ? currentAc.mode : 0,
    fan: currentAc && Number.isInteger(currentAc.fan) && currentAc.fan >= 0 && currentAc.fan <= 3 ? currentAc.fan : 3
  };

  // Explicit power-only requests preserve every other setting, even if already on/off.
  const powerOnly = coreText.replace(/[\s.!?]/g, '').match(/^(เปิด|ปิด)(?:แอร์|ระบบแอร์)?$/);
  if (powerOnly) {
    next.power = powerOnly[1] === 'เปิด';
    return { matched: true, next, fields: ['power'], label: `สั่งด้วยเสียง: ${powerOnly[1]}แอร์`, engine: 'SMART_NLU' };
  }

  // --------------------------------------------------------------------------
  // กฎที่ 1: คำสั่งปิดแอร์ (ตรวจจากคลังคำศัพท์ + โครงสร้างกริยาปิดแยกคำ)
  // --------------------------------------------------------------------------
  const offMatch = findMatchingPhrase(rawNorm, coreText, dict.power_off_phrases);
  const splitOffConcept = /(?<![\u0E40-\u0E44]|ไม่|อย่า|ห้าม)(ปิด|ดับ|หยุด|เลิกใช้|พัก).*?(แอร์|เครื่องปรับอากาศ|ระบบ)/.test(rawNorm);
  if (offMatch || splitOffConcept) {
    next.power = false;
    return { matched: true, next, fields: ['power'], label: 'สั่งด้วยเสียง: ปิดแอร์', engine: 'SMART_NLU' };
  }

  let actions = [];
  const fields = new Set();
  let fanHandled = false;
  let tempHandled = false;

  // --------------------------------------------------------------------------
  // กฎที่ 2: โหมดสำเร็จรูป (Preset Scenes)
  // --------------------------------------------------------------------------
  if (Array.isArray(dict.preset_scenes)) {
    for (const scene of dict.preset_scenes) {
      if (findMatchingPhrase(rawNorm, coreText, scene.phrases) && scene.set) {
        next.power = Boolean(scene.set.power ?? true);
        next.temp = Math.max(MIN_TEMP, Math.min(MAX_TEMP, Number(scene.set.temp ?? next.temp)));
        next.mode = Number(scene.set.mode ?? next.mode);
        next.fan = Number(scene.set.fan ?? next.fan);
        actions.push(scene.name);
        for (const field of ['temp', 'mode', 'fan']) fields.add(field);
        if (!currentAc.power) fields.add('power');
        tempHandled = true;
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // กฎที่ 3: โหมดแอร์ (0=COOL, 1=DRY, 2=FAN)
  // --------------------------------------------------------------------------
  if (Array.isArray(dict.mode_rules)) {
    for (const rule of dict.mode_rules) {
      if (findMatchingPhrase(rawNorm, coreText, rule.phrases)) {
        next.power = true;
        next.mode = rule.mode;
        fields.add('mode');
        actions.push(rule.label);
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // กฎที่ 4: ความแรงพัดลม (0=AUTO, 1=LOW, 2=MED, 3=HIGH)
  // --------------------------------------------------------------------------
  const fanText = rawNorm.replace(/\s+/g, '');
  const decreaseFan = /(?:เบา|ลด|ผ่อน)(?:ความแรง|ระดับ|แรง)?(?:พัดลม|ลม)|(?:พัดลม|ลม)(?:ให้|อีก)?(?:ลง|เบาลง|อ่อนลง)/.test(fanText);
  const increaseFan = /(?:เพิ่ม|เร่ง)(?:ความแรง|ระดับ|แรง)?(?:พัดลม|ลม)|(?:พัดลม|ลม)(?:ให้|อีก)?(?:ขึ้น|แรงขึ้น)/.test(fanText);
  const explicitFan = fanText.match(/(?:พัดลม|ลม)(?:เป็น|ให้|ระดับ|ความแรง|ที่|เบอร์)*(อัตโนมัติ|ออโต้|ปานกลาง|กลาง|แรงสุด|สูงสุด|เบาสุด|ต่ำสุด|แรง|สูง|เบา|ต่ำ|[123])/);
  const relativeFan = (decreaseFan || increaseFan) && !/(?:สุด|ระดับ[123])/.test(fanText) && !(explicitFan && !/ขึ้น|ลง/.test(fanText));
  if (decreaseFan && increaseFan) return { matched: false };
  if (relativeFan) {
    // AUTO has no numeric speed; use MED as the neutral reference for up/down.
    const reference = next.fan === 0 ? 2 : next.fan;
    next.fan = Math.max(1, Math.min(3, reference + (decreaseFan ? -1 : 1)));
    fanHandled = true;
  } else if (explicitFan) {
    const value = explicitFan[1];
    next.fan = /อัตโนมัติ|ออโต้/.test(value) ? 0 : /ปานกลาง|กลาง|2/.test(value) ? 2 : /แรง|สูง|3/.test(value) ? 3 : 1;
    fanHandled = true;
  } else if (Array.isArray(dict.fan_rules)) {
    for (const rule of dict.fan_rules) {
      if (findMatchingPhrase(rawNorm, coreText, rule.phrases)) {
        next.fan = rule.fan; fanHandled = true; break;
      }
    }
  }
  if (fanHandled) {
    next.power = true;
    // Keep DRY/FAN/COOL unchanged: speed is not a request to switch mode or temperature.
    fields.add('fan');
    actions.push(`พัดลม${['อัตโนมัติ', 'เบา', 'กลาง', 'แรง'][next.fan]}`);
  }

  // --------------------------------------------------------------------------
  // กฎที่ 5: ตัวเลขอุณหภูมิ 2 หลัก (จับทุกประโยคที่มีตัวเลข 15-35 เช่น "ขออุณหภูมิ 27", "เอา 24 หน่อย")
  // --------------------------------------------------------------------------
  const exactTempMatch = rawNorm.match(/(?<![0-9])(1[5-9]|2[0-9]|3[0-5])(?![0-9])/);
  if (exactTempMatch) {
    const rawTemp = parseInt(exactTempMatch[1], 10);
    const clampedTemp = Math.max(MIN_TEMP, Math.min(MAX_TEMP, rawTemp));
    next.power = true;
    next.temp = clampedTemp;
    tempHandled = true;
    actions.push(rawTemp !== clampedTemp ? `ตั้งอุณหภูมิ ${clampedTemp}°C (จำกัดช่วงจาก ${rawTemp}°C)` : `ตั้งอุณหภูมิ ${clampedTemp}°C`);
  }

  // --------------------------------------------------------------------------
  // กฎที่ 6: สั่งเพิ่ม/ลดระบุจำนวนองศา 1 หลัก (เช่น "ลดลง 2 องศา", "เพิ่ม 1 องศา", "เย็นขึ้น 2 องศา")
  // --------------------------------------------------------------------------
  if (!tempHandled && (!fanHandled || /อุณหภูมิ|องศา|เย็น|อุ่น/.test(rawNorm))) {
    const textWithoutFan = rawNorm.replace(/(?:เบอร์|ระดับ)\s*[1-3]/g, '');
    const deltaNumMatch = textWithoutFan.match(/(ลด|เพิ่ม|เร่ง|เบา|ขึ้น|ลง|เย็นขึ้น|อุ่นขึ้น).*?(?<![0-9])([1-5])(?![0-9])/);
    if (deltaNumMatch) {
      const verb = deltaNumMatch[1];
      const delta = parseInt(deltaNumMatch[2], 10);
      const makeCooler = (verb === 'ลด' || verb === 'เร่ง' || verb === 'ลง' || verb === 'เย็นขึ้น');
      next.power = true;
      next.temp = Math.max(MIN_TEMP, Math.min(MAX_TEMP, makeCooler ? next.temp - delta : next.temp + delta));
      tempHandled = true;
      actions.push(`${makeCooler ? 'ลด' : 'เพิ่ม'}อุณหภูมิ ${delta}°C เป็น ${next.temp}°C`);
    }
  }

  // --------------------------------------------------------------------------
  // กฎที่ 7: คำบอกความรู้สึก ร้อน/หนาว จากคลังคำสั่ง + การจับคู่แนวคิดอิสระ (Concept Matcher)
  // --------------------------------------------------------------------------
  if (!tempHandled && !fanHandled && Array.isArray(dict.relative_temp_rules)) {
    for (const rule of dict.relative_temp_rules) {
      if (findMatchingPhrase(rawNorm, coreText, rule.phrases)) {
        next.power = true;
        next.temp = Math.max(MIN_TEMP, Math.min(MAX_TEMP, next.temp + Number(rule.tempDelta)));
        tempHandled = true;
        actions.push(`${rule.name} -> ${next.temp}°C`);
        break;
      }
    }
  }

  // यदिพูดด้วยรูปประโยคอื่นที่ไม่อยู่ในคลัง แต่มีคำบ่งชี้ความรู้สึกชัดเจน
  if (!tempHandled && !fanHandled) {
    if (/(?<!ไม่|ไม่ได้|หาย)(หนาว|เย็นเกิน|เย็นไป|เบาแอร์|ผ่อนแอร์|อุ่นขึ้น)/.test(rawNorm)) {
      next.power = true;
      next.temp = Math.max(MIN_TEMP, Math.min(MAX_TEMP, next.temp + 1));
      tempHandled = true;
      actions.push(`ปรับอุ่นขึ้น (+1°C) -> ${next.temp}°C`);
    } else if (/(?<!ไม่|ไม่ได้|หาย)(ร้อน|อบอ้าว|อึดอัด|เหงื่อ|เร่งแอร์|เย็นขึ้น)|ไม่เย็น|ไม่ค่อยเย็น/.test(rawNorm)) {
      next.power = true;
      next.temp = Math.max(MIN_TEMP, Math.min(MAX_TEMP, next.temp - 1));
      tempHandled = true;
      actions.push(`ปรับเย็นขึ้น (-1°C) -> ${next.temp}°C`);
    }
  }

  // --------------------------------------------------------------------------
  // กฎที่ 8: คำสั่งเปิดแอร์ (รองรับ "เปิดแอร์ให้ผมหน่อย", "ช่วยเปิดแอร์ที", "เปิดเครื่องปรับอากาศ")
  // --------------------------------------------------------------------------
  if (actions.length === 0) {
    const onMatch = findMatchingPhrase(rawNorm, coreText, dict.power_on_phrases);
    const splitOnConcept = /(เปิด|ติด|เริ่ม|ขอ|เอา).*?(แอร์|เครื่องปรับอากาศ|ความเย็น)/.test(rawNorm);
    if (onMatch || splitOnConcept) {
      next.power = true;
      fields.add('power');
      actions.push(`เปิดแอร์ (${next.temp}°C • ${MODE_NAMES[next.mode]})`);
    }
  }

  if (actions.length > 0) {
    if (tempHandled) fields.add('temp');
    return {
      matched: true,
      next,
      fields: [...fields],
      label: `สั่งด้วยเสียง: ${actions.join(' + ')}`,
      engine: 'SMART_NLU'
    };
  }

  return { matched: false };
}

// ============================================================================
// 5. ตีความด้วย AI และเก็บข้อเสนอคำศัพท์แยกจากคลังคำสั่งจริง
// ============================================================================
// ใช้ AI (Llama-3.3-70B) ตีความประโยคสแลงหรือประโยคเปรียบเทียบที่อยู่นอกเหนือกฎปกติ
function voiceRoute(handler) {
  return async (req, res) => {
    try { res.json(await handler(req)); }
    catch (error) {
      const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
      res.status(timedOut ? 504 : error.status || 500).json({ success: false,
        message: timedOut ? 'ประมวลผลเสียงนานเกินไป กรุณาลองใหม่' : error.status ? error.message : 'ระบบเสียงขัดข้อง กรุณาลองใหม่' });
    }
  };
}
app.post('/api/voice-session', voiceRoute(req => ({ sessionId: voiceSessions.create(req.body.device), engine: 'LOCAL_TFLITE', wakeWord: false })));
app.post('/api/voice-session/cancel', voiceRoute(req => {
  voiceSessions.cancel(req.body.sessionId); return { success: true };
}));
app.post('/api/voice-session/ping', voiceRoute(req => {
  voiceSessions.get(req.body.sessionId, req.body.device); return { success: true };
}));
for (const action of ['arm', 'claim']) {
  app.post(`/api/voice-session/${action}`, voiceRoute(req => {
    const session = voiceSessions.get(req.body.sessionId, req.body.device);
    return { success: true, ...voiceSessions[action](session, req.body.wakeToken) };
  }));
}
app.post('/api/voice-command', upload.single('audio'), voiceRoute(async req => {
  const session = voiceSessions.get(req.body.sessionId, req.body.device);
  return voiceSessions.run(session, req.body.requestId, async signal => {
    const startTime = Date.now();
    const stage = req.body.stage;
    if (!['wake', 'command', 'direct'].includes(stage)) throw new VoiceError('สถานะรับเสียงไม่ถูกต้อง');
    if (stage === 'command') voiceSessions.consume(session, req.body.wakeToken);
    const audio = req.file?.buffer;
    if (!audio || audio.length < 1644 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.length > 16_000 * 2 * 16 + 44) {
      throw new VoiceError('ไฟล์เสียงไม่ถูกต้องหรือยาวเกินไป กรุณาพูดใหม่');
    }
    let currentAc;
    try { currentAc = JSON.parse(req.body.currentAc); } catch (_) { }
    if (!currentAc || !validAc({ ...currentAc, power: currentAc.power === null ? true : currentAc.power })) throw new VoiceError('สถานะอุปกรณ์ไม่ถูกต้อง');
    const result = await localVoice.classify(audio, signal);
    signal.throwIfAborted();
    const parsed = commandFor(result, currentAc);
    const latencyMs = Date.now() - startTime;
    if (!parsed) return { success: false, ignored: stage === 'wake', engine: 'LOCAL_TFLITE', latencyMs,
      message: result.reason === 'too_long' ? 'กรุณาพูดคำสั่งสั้น ๆ เช่น เปิดแอร์ หรือ ปิดแอร์ โมเดลรับเสียงได้ 1.5 วินาที' : 'โมเดลยังไม่มั่นใจ กรุณาพูดคำสั่งสั้น ๆ อีกครั้ง' };
    return { success: true, transcript: parsed.text, label: `โมเดลในเครื่อง: ${parsed.text}`,
      engine: 'LOCAL_TFLITE', confidence: result.confidence, latencyMs, nextState: parsed.next,
      feedback: describeVoiceCommand(parsed.next, currentAc, parsed.fields) };
  });
}));
app.use((error, req, res, next) => {
  if (req.path.startsWith('/api/voice')) return res.status(400).json({ success: false, message: 'ไม่สามารถรับไฟล์เสียงได้ กรุณาพูดใหม่' });
  next(error);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => {
  // Warm the local model once; no external AI endpoint is used.
  localVoice.start().then(() => console.log('Local TFLite พร้อมรับคำสั่ง • ไม่ใช้ AI API ภายนอก')).catch(error => console.error(error.message));
  console.log('================================================================');
  console.log(`Smart Classroom Voice Server พร้อมทำงานที่: http://localhost:${PORT}`);
  console.log('โมเดลคำสั่งเสียง: models/ac_voice_model_int8.tflite');
  console.log('================================================================');
});
module.exports = { app, voiceSessions, localVoice, parseWithDictionaryAndRules, normalizeAndRepairThaiText, extractCoreThaiMeaning, loadIntentDictionary };

if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { localVoice.close(); process.exit(0); });
}
