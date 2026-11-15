'use strict';
const greeting = /^(?:(?:hey|hi|hello|เฮ้|เฮ|หวัดดี|วัดดี|สวัสดี)[\s,.!]*)?/i;
const wakeStart = /^(?:(?:hey|hi|hello|เฮ้|เฮ|หวัดดี|วัดดี|สวัสดี)[\s,.!]*)?(?:เอ็?น\s*จ[ีิ][่้๊๋]?|เอน\s*จ[ีิ][่้๊๋]?|engie?)(?=$|[\s,.!?:]|ครับ|ค่ะ|คะ|จ๋า|ช่วย|เปิด|ปิด|ปรับ|ตั้ง|ขอ|เพิ่ม|ลด|โหมด|พัดลม|แรงลม|เทอร์โบ|ประหยัด|สวิง|ไม่ต้อง|อย่า)/i;
// Misspellings can trigger an acoustic check, but are never plain-text aliases.
const nearStart = /^(?:เอ็น\s*ที่|เอ็นดี|เอ็นซ[ีิ][่้]?|เอิ้นที่|เอ็ง\s*จ[ีิ][่้]?|อิง\s*จ[ีิ][่้]?)(?=$|[\s,.!?]|ครับ|ค่ะ|คะ|ช่วย|เปิด|ปิด|ผิดแอร์|ปรับ|ตั้ง|ขอ|เพิ่ม|ลด|โหมด|พัดลม|แรงลม|เทอร์โบ|ประหยัด|สวิง|ไม่ต้อง|อย่า)/;
const hardStart = /^(?:เอ็นก[ีิ][่้]?|เอ็งก[ีิ][่้]?|เอ็นด์ก[ีิ][่้]?)(?=$|[\s,.!?]|ครับ|ค่ะ|คะ|ช่วย|เปิด|ปิด|ปรับ|ตั้ง|ขอ|เพิ่ม|ลด)/;
const normalize = input => String(input || '').normalize('NFC').trim().toLowerCase();
const compactWakeTail = text => text.replace(/[\s,.!?]/g, '');
const valid = candidate => typeof candidate?.transcript === 'string' && candidate.transcript.length <= 500 && Number.isFinite(candidate.score);

function afterLead(text, pattern) {
  const lead = text.match(pattern);
  return lead ? text.slice(lead[0].length).replace(/^[\s,.!?:]+/, '') : null;
}
function afterNear(text) {
  return afterLead(text.replace(greeting, ''), nearStart);
}
function conflicts(beams, firstScore, transcript) {
  const target = parseSpeech(transcript), power = target.commands?.find(c => c === 'OFF' || c === 'ON');
  if (!target.commands?.length) return false;
  return beams.some(candidate => {
    if (!valid(candidate) || firstScore - candidate.score > .25) return false;
    const text = normalize(candidate.transcript);
    const other = parseSpeech(afterNear(text) ?? text);
    return other.reason === 'negated' || other.reason === 'conflict' ||
      (power && other.commands?.includes(power === 'ON' ? 'OFF' : 'ON'));
  });
}

function verifiedWakeTranscript(result) {
  if (result?.engine !== 'LOCAL_WHISPER' || !result.accepted || !Number.isFinite(result.noSpeechProbability) ||
      result.noSpeechProbability >= .6 || !Array.isArray(result.wakeCandidates)) return null;
  const [first, ...rest] = result.wakeCandidates.slice(0, 6);
  if (!valid(first)) return null;
  const topText = normalize(first.transcript), exact = wakeStart.test(topText);
  const acoustic = (names, score, consonant, ending) =>
    Array.isArray(result.wakeAcoustics) && result.wakeAcoustics.some(e => names.includes(e?.name) &&
      Number.isFinite(e.score) && e.score >= score &&
      Number.isFinite(e.consonant) && e.consonant >= consonant && e.consonant <= 1 &&
      Number.isFinite(e.ending) && e.ending >= ending && e.ending <= 1);
  const softName = acoustic(['เอ็นจี้', 'เอ็นจี'], -1.6, .012, .16);
  const strongName = acoustic(['เอ็นจี้'], -1.2, .015, .55) ||
    acoustic(['เอ็นจี้', 'เอ็นจี'], -1.2, .035, .20);
  if (exact && (first.score >= -.7 || (first.score >= -1.10 && softName))) {
    return conflicts(rest, first.score, first.transcript) ? null : first.transcript;
  }

  const english = result.wakeEnglish;
  const [englishTop, ...englishRest] = Array.isArray(english?.candidates) ? english.candidates.slice(0, 4) : [];
  const hardName = acoustic(['เอ็นกี่', 'เอ็งกี้'], -1.4, .20, .24);
  if (valid(englishTop) && englishTop.score >= -.85 && Number.isFinite(english.noSpeechProbability) && english.noSpeechProbability < .6) {
    const englishText = normalize(englishTop.transcript);
    const nearEnglishTail = afterLead(englishText, /^(?:endi|andy)(?=$|[\s,.!?])/);
    const likelyHardLead = [first, ...rest.slice(0, 2)].some(c => valid(c) && afterLead(normalize(c.transcript), hardStart) !== null);
    const englishIntent = parseSpeech(englishText);
    const matchingExact = exact && (englishIntent.wakeOnly ||
      (englishIntent.commands && parseSpeech(topText).commands?.join('|') === englishIntent.commands.join('|')));
    const named = englishIntent.hasWakeWord && (matchingExact || (likelyHardLead && hardName) || (softName && afterNear(topText) !== null))
      ? englishTop.transcript : null;
    // A spelling like Endi is not a command prefix unless the independent
    // Thai-language pass and the hard-G acoustic measurement both support it.
    const recovered = hardName && likelyHardLead && nearEnglishTail && parseSpeech(nearEnglishTail).commands
      ? 'Engi ' + nearEnglishTail : null;
    const transcript = named || recovered;
    if (transcript && !conflicts(englishRest, englishTop.score, transcript) &&
        !conflicts([first, ...rest], first.score, transcript)) return transcript;
  }

  // An English hard-G name sometimes decodes as Andy. Do not recognize Andy
  // as the name: require a separate near-phonetic short lead and its acoustic
  // evidence. This fallback can acknowledge a name only, never send a command.
  const shortHardLeads = [first, ...rest].filter(c => valid(c) && first.score - c.score <= .26 &&
    afterLead(normalize(c.transcript), hardStart) === '');
  const standaloneVariant = /^(?:andy|อันดี|อังกี|เต็มที่|เอ็นด์ดี|เอ็งดี|เอ็นดี)[\s.!?]*$/.test(topText);
  if (first.score >= -1.2 && hardName && shortHardLeads.length >= 1 &&
      (standaloneVariant || afterLead(topText, hardStart) === '') &&
      ![first, ...rest].some(c => valid(c) && first.score - c.score <= .26 && parseSpeech(c.transcript).commands)) return 'เอ็นจี้';

  const near = afterNear(topText);
  if (near === null) return null;
  const suffix = compactWakeTail(near);
  // Allow the observed ผิดแอร์/ปิดแอร์ confusion only when both the exact
  // name and a separate strong hypothesis agree on the original OFF action.
  const closeSuffix = suffix.startsWith('ผิดแอร์') ? 'ปิดแอร์' + suffix.slice('ผิดแอร์'.length) : null;
  const closeCorroborated = closeSuffix && rest.some(candidate => {
    const tail = valid(candidate) && afterNear(normalize(candidate.transcript));
    return typeof tail === 'string' && first.score - candidate.score <= .20 && compactWakeTail(tail) === closeSuffix;
  });
  const found = rest.find(candidate => {
    if (!valid(candidate) || candidate.score < -1.15 || first.score - candidate.score > .75) return false;
    const tail = afterLead(normalize(candidate.transcript), wakeStart);
    if (tail === null) return false;
    const value = compactWakeTail(tail);
    return value === suffix || (closeCorroborated && value === closeSuffix && first.score - candidate.score <= .20);
  });
  if (found && (first.score >= -.7 || (softName && first.score >= -1.1)) &&
      !conflicts(rest, first.score, found.transcript)) return found.transcript;

  if (softName && first.score >= -1.15 && parseSpeech('เอ็นจี้ ' + near).wakeOnly &&
      !rest.some(candidate => valid(candidate) && first.score - candidate.score <= .20 &&
        parseSpeech(afterNear(normalize(candidate.transcript)) ?? candidate.transcript).commands)) return 'เอ็นจี้';

  // Repair only the name. Pick an actually decoded command suffix and never
  // let a name hint invent a suffix or decide between opposed commands.
  if (strongName && first.score >= -.7 && /^(?:เอ็น\s*ที่|เอ็นซ[ีิ][่้]?)/.test(topText.replace(greeting, '')) &&
      parseSpeech(near).reason !== 'negated') {
    const alternatives = [first, ...rest].filter(candidate => valid(candidate) && first.score - candidate.score <= .18)
      .flatMap(candidate => {
        const text = normalize(candidate.transcript), tail = afterLead(text, wakeStart) ?? afterNear(text);
        if (tail === null) return [];
        const transcript = 'เอ็นจี้ ' + tail, intent = parseSpeech(transcript);
        return intent.commands ? [{ transcript, signature: intent.commands.join('|') }] : [];
      });
    const best = alternatives[0];
    if (best && alternatives.every(c => c.signature === best.signature) &&
        !conflicts([first, ...rest], first.score, best.transcript)) return best.transcript;
  }
  return null;
}

function parseSpeech(input, { expectingTemperature = false } = {}) {
  let text = normalize(input);
  if (!text || text.length > 500) return { reason:'unmatched' };
  text = text.replace(/[๐-๙]/g,c=>String(c.charCodeAt(0)-0x0E50)).replace(/[’]/g,"'");
  const tail = afterLead(text, wakeStart);
  const wake = tail !== null;
  const result = value => ({ ...value, hasWakeWord: wake });
  if (wake) text = tail;
  const politeOnly = text.replace(/[\s,.!?]/g,'').replace(/ครับ|ค่ะ|คะ|จ๋า/g,'');
  if(wake && !politeOnly)return result({wakeOnly:true});
  if(/อย่า|ห้าม|ไม่ต้อง|ยังไม่|ไม่ได้|ไม่อยาก|ไม่ให้|ยกเลิก|\b(?:don't|do not|never|cancel)\b/.test(text))return result({reason:'negated'});
  if (/(?:อยู่(?:หรือเปล่า|ไหม|มั้ย|หรือยัง)|ใช่(?:ไหม|มั้ย))(?:\s|[?.!]|ครับ|ค่ะ|คะ)*$/.test(text) ||
      /^(?:is|are|was|were)\s+(?:the\s+)?(?:ac|aircon|air conditioner|it)\b/.test(text)) return result({reason:'unmatched'});
  const numWords={'เอ็ด':1,'หนึ่ง':1,'สอง':2,'สาม':3,'สี่':4,'ห้า':5,'หก':6,'เจ็ด':7,'แปด':8,'เก้า':9};
  text=text.replace(/ยี่สิบ\s*(เอ็ด|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า)/g,(_,n)=>String(20+numWords[n]))
    .replace(/สามสิบ/g,'30').replace(/สิบ\s*(แปด|เก้า)/g,(_,n)=>String(10+numWords[n]));
  text=text.replace(/อุ่นภูมิ|อุณภูม(?!ิ)/g,'อุณหภูมิ').replace(/องสา/g,'องศา').replace(/ภัตรลม/g,'พัดลม');
  const compact=text.replace(/[\s,.!?]/g,'');
  const core=compact.replace(/ให้ผมหน่อย|ให้หนูหน่อย|ให้เราหน่อย|ให้หน่อย|หน่อยได้ไหม|ได้ไหม|นะครับ|นะคะ|ครับผม|ครับ|ค่ะ|คะ|กรุณา|รบกวน|ช่วย|หน่อย|ให้ผม|ให้ที|เลย/g,'');
  const hasAc=/แอร์|เครื่องปรับอากาศ|\b(?:ac|aircon|air conditioner)\b/.test(text);
  const openThai=/เปิด/.test(core),closeThai=/(?<!เ)ปิด|ดับแอร์|หยุดแอร์/.test(core);
  const openEnglish=/\b(?:open|turn\s+on|switch\s+on|power\s+on)\b|\b(?:ac|it)\s+on\b|\b(?:turn|switch)\s+(?:the\s+)?(?:ac|air conditioner)\s+on\b/.test(text);
  const closeEnglish=/\b(?:close|turn\s+off|switch\s+off|power\s+off|shut\s+down)\b|\b(?:ac|it)\s+off\b|\b(?:turn|switch)\s+(?:the\s+)?(?:ac|air conditioner)\s+off\b/.test(text);
  if((openThai||openEnglish)&&(closeThai||closeEnglish))return result({reason:'conflict'});
  if(/(?:ไม่|อย่า)\s*(?:เปิด|ปิด|ปรับ|ตั้ง|ลด|เพิ่ม)/.test(text))return result({reason:'negated'});
  const commands=[];
  const bareEnglish=/^(?:please\s+)?(?:open|close|turn on|turn off|switch on|switch off)(?:\s+please)?[.!?]*$/.test(text);
  if((openThai && (hasAc||core==='เปิด'))||(openEnglish&&(hasAc||bareEnglish)))commands.push('ON');
  if((closeThai && (hasAc||core==='ปิด'))||(closeEnglish&&(hasAc||bareEnglish)))commands.push('OFF');
  if(/เทอร์โบ|เทอโบ|เย็นเร็ว|\bturbo\b/.test(text))commands.push('PRESET:TURBO');
  if(/ประหยัด|อีโค|\beco\b/.test(text))commands.push('PRESET:ECO');
  if(/สวิง|\bswing\b/.test(text))return result({commands:[closeThai||closeEnglish?'SWING:OFF':'SWING:ON']});
  if(/โหมดนอน|โหมดกลางคืน|\bsleep\b/.test(text))return result({commands:['MODE:SLEEP']});
  const mode = /โหมด(?:ทำความเย็น|คูล)|\bcool(?:ing)? mode\b/.test(text)?'COOL':/ลดความชื้น|โหมดดราย|\bdry(?: mode)?\b/.test(text)?'DRY':/โหมดพัดลม|\bfan mode\b/.test(text)?'FAN':null;
  if(mode)commands.push('MODE:'+mode);
  const fanMention=/พัดลม|แรงลม|\bfan\b/.test(text)&& !/โหมดพัดลม|\bfan mode\b/.test(text);
  if(fanMention){
    if(/(?:เพิ่ม|เร่ง).*?(?:พัดลม|แรงลม)|(?:พัดลม|แรงลม).*?(?:แรงขึ้น|เพิ่มขึ้น)/.test(core))commands.push('FAN:UP');
    else if(/(?:ลด|เบา).*?(?:พัดลม|แรงลม)|(?:พัดลม|แรงลม).*?(?:เบาลง|ลดลง)/.test(core))commands.push('FAN:DOWN');
    else if(/กลาง|ปานกลาง|เบอร์2|ระดับ2|\b(?:medium|med)\b/.test(text))commands.push('FAN:MED');
    else if(/แรง|สูง|เบอร์3|ระดับ3|\bhigh\b/.test(text))commands.push('FAN:HIGH');
    else if(/เบา|ต่ำ|เบอร์1|ระดับ1|\blow\b/.test(text))commands.push('FAN:LOW');
    else if(/อัตโนมัติ|ออโต้|\bauto\b/.test(text))commands.push('FAN:AUTO');
  }
  const numbers=[...text.matchAll(/(?<!\d)(1[5-9]|2\d|3[0-2])(?!\d)/g)].map(m=>Number(m[1]));
  const tempMention=/อุณหภูมิ|อุณภูมิ|อุณภูม|องศา|ความเย็น|\b(?:temperature|degrees?)\b/.test(text);
  if(new Set(numbers).size>1)return result({reason:'conflict'});
  if(numbers.length && (tempMention||expectingTemperature||/^(?:ปรับ|ตั้ง|ขอ|เอา)?\d+(?:องศา)?$/.test(core)))commands.push('TEMP:'+numbers[0]);
  else if(!numbers.length && !fanMention){
    if(/เพิ่มอุณหภูมิ|ปรับอุณหภูมิขึ้น|อุ่นขึ้น|หนาว|เบาแอร์|ลดความเย็น/.test(core))commands.push('TEMP:UP');
    else if(/ลดอุณหภูมิ|ปรับอุณหภูมิลง|เย็นขึ้น|ร้อน|เร่งแอร์|แอร์ไม่เย็น/.test(core))commands.push('TEMP:DOWN');
    else if(tempMention)return result({askTemperature:true});
  }
  const unique=[...new Set(commands)];
  if(unique.includes('OFF')&&unique.length>1)return result({reason:'conflict'});
  if(unique.filter(c=>c.startsWith('PRESET:')).length>1)return result({reason:'conflict'});
  if(unique.length)return {commands:unique, hasWakeWord:!!wake};
  return result({reason:'unmatched'});
}
module.exports={parseSpeech,verifiedWakeTranscript};
