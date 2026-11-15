'use strict';
const greeting = /^(?:(?:hey|hi|hello|เฮ้|เฮ|หวัดดี|วัดดี|สวัสดี)[\s,.!]*)?/i;
const queryLead = 'ตอนนี้|ขณะนี้|ในห้อง|ห้อง|มีคน|มีกี่คน|จำนวนคน|คนกี่คน|คนในห้อง|อุณห?ภูมิ?|อุ่นภูมิ|ความชื้น|แอร์|เครื่องปรับอากาศ|กี่องศา|กี่คน|บอก|ถาม|ดู|เช็ก|เช็ค';
const wakeStart = new RegExp(greeting.source + String.raw`(?:เอ็?น\s*จ[ีิ][่้๊๋]?|เอน\s*จ[ีิ][่้๊๋]?|engie?)(?=$|[\s,.!?:]|ครับ|ค่ะ|คะ|จ๋า|ช่วย|เปิด|ปิด|ปรับ|ตั้ง|ขอ|เพิ่ม|ลด|โหมด|พัดลม|แรงลม|เทอร์โบ|ประหยัด|สวิง|ไม่ต้อง|อย่า|${queryLead})`, 'i');
// Misspellings can trigger an acoustic check, but are never plain-text aliases.
const nearStart = new RegExp(String.raw`^(?:เอ็น\s*ที่|เอ็นดี|เอ็นซ[ีิ][่้]?|เอิ้นที่|เอ็ง\s*จ[ีิ][่้]?|อิง\s*จ[ีิ][่้]?)(?=$|[\s,.!?]|ครับ|ค่ะ|คะ|ช่วย|เปิด|ปิด|ผิดแอร์|ปรับ|ตั้ง|ขอ|เพิ่ม|ลด|โหมด|พัดลม|แรงลม|เทอร์โบ|ประหยัด|สวิง|ไม่ต้อง|อย่า|${queryLead})`);
const hardStart = new RegExp(String.raw`^(?:เอ็นก[ีิ][่้]?|เอ็งก[ีิ][่้]?|เอ็นด์ก[ีิ][่้]?)(?=$|[\s,.!?]|ครับ|ค่ะ|คะ|ช่วย|เปิด|ปิด|ปรับ|ตั้ง|ขอ|เพิ่ม|ลด|${queryLead})`);
const normalize = input => String(input || '').normalize('NFC').trim().toLowerCase();
const compactWakeTail = text => text.replace(/[\s,.!?]/g, '');
const valid = candidate => typeof candidate?.transcript === 'string' && candidate.transcript.length <= 500 && Number.isFinite(candidate.score);
const actionable = intent => intent.commands || intent.query;

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
    return Boolean(other.query) || ['negated', 'conflict', 'ambiguous'].includes(other.reason) ||
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
    const thaiIntent = parseSpeech(topText);
    const matchingExact = exact && (englishIntent.wakeOnly ||
      (englishIntent.query && thaiIntent.query === englishIntent.query) ||
      (englishIntent.commands && thaiIntent.commands?.join('|') === englishIntent.commands.join('|')));
    const named = englishIntent.hasWakeWord && (matchingExact || (likelyHardLead && hardName) || (softName && afterNear(topText) !== null))
      ? englishTop.transcript : null;
    // A spelling like Endi is not a command prefix unless the independent
    // Thai-language pass and the hard-G acoustic measurement both support it.
    const nearEnglishIntent = nearEnglishTail ? parseSpeech(nearEnglishTail) : null;
    const recovered = hardName && likelyHardLead && nearEnglishIntent && actionable(nearEnglishIntent)
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
      ![first, ...rest].some(c => valid(c) && first.score - c.score <= .26 && actionable(parseSpeech(c.transcript)))) return 'เอ็นจี้';

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
        actionable(parseSpeech(afterNear(normalize(candidate.transcript)) ?? candidate.transcript)))) return 'เอ็นจี้';

  // Repair only the name. Pick an actually decoded command suffix and never
  // let a name hint invent a suffix or decide between opposed commands.
  if (strongName && first.score >= -.7 && /^(?:เอ็น\s*ที่|เอ็นซ[ีิ][่้]?)/.test(topText.replace(greeting, '')) &&
      parseSpeech(near).reason !== 'negated') {
    const alternatives = [first, ...rest].filter(candidate => valid(candidate) && first.score - candidate.score <= .18)
      .flatMap(candidate => {
        const text = normalize(candidate.transcript), tail = afterLead(text, wakeStart) ?? afterNear(text);
        if (tail === null) return [];
        const transcript = 'เอ็นจี้ ' + tail, intent = parseSpeech(transcript);
        return intent.query ? [{ transcript, signature: 'query:' + intent.query }]
          : intent.commands ? [{ transcript, signature: intent.commands.join('|') }] : [];
      });
    const best = alternatives[0];
    if (best && alternatives.every(c => c.signature === best.signature) &&
        !conflicts([first, ...rest], first.score, best.transcript)) return best.transcript;
  }
  return null;
}

function roomQuery(text) {
  const compact = text.replace(/[\s,.!?:]/g, '');
  const phrase = compact.replace(/^(?:ครับผม|ครับ|ค่ะ|คะ|จ๋า)?(?:กรุณา|รบกวน|ช่วย)?/, '')
    .replace(/(?:(?:หน่อย|ด้วย|นะ|ครับผม|ครับ|ค่ะ|คะ))+$/, '');
  const lead = /^(?:(?:ขอ)?ถาม(?:ว่า)?|ช่วย)?(?:(?:บอก|ดู|เช็ก|เช็ค)(?:ให้หน่อยว่า|ให้ฟังหน่อยว่า|หน่อยว่า|ให้ผมว่า|ทีว่า|ว่า)?|ขอทราบ)?/;
  const body = phrase.replace(lead, '').replace(/ตอนนี้|ขณะนี้/g, '');
  const wantsReading = /^(?:บอก|ถาม|ดู|เช็ก|เช็ค|ขอทราบ)/.test(phrase);
  const english = text.replace(/[.!?]+$/, '').replace(/^(?:please\s+)?(?:(?:can|could) you\s+)?(?:tell me\s+(?:what\s+)?|check\s+)?(?:the\s+)?/, '');
  if (/^(?:แอร์|เครื่องปรับอากาศ)(?:ตั้ง(?:อุณหภูมิ)?(?:ไว้(?:ที่)?|อยู่ที่)?|อยู่ที่)?(?:กี่องศา|เท่าไหร่|เท่าไร)$/.test(body) ||
      /^(?:ตั้ง(?:อุณหภูมิ)?(?:แอร์|เครื่องปรับอากาศ)ไว้(?:ที่)?|อุณหภูมิที่ตั้ง(?:แอร์)?ไว้(?:ที่)?|อุณหภูมิแอร์)(?:กี่องศา|เท่าไหร่|เท่าไร)$/.test(body) ||
      /^(?:what(?:'s| is) (?:the )?)?(?:ac|aircon|air conditioner) set ?point$/.test(english) ||
      /^what(?:'s| is) (?:the )?(?:ac|aircon|air conditioner) set to$/.test(english)) return 'ac_setpoint';
  if (/^(?:(?:แอร์|เครื่องปรับอากาศ)(?:เปิด|ปิด|ทำงาน)|(?:เปิด|ปิด)(?:แอร์|เครื่องปรับอากาศ))(?:อยู่)?(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง|หรือไม่|เหรอ|หรอ)$/.test(body) ||
      /^is (?:the )?(?:ac|aircon|air conditioner) (?:on|off|running)$/.test(english)) return 'ac_power';
  if (/^(?:ในห้อง(?:นี้)?|ห้อง(?:นี้)?)?(?:มีกี่คน|มี(?:คน|ผู้คน)(?:อยู่(?:ในห้อง(?:นี้)?)?)?(?:กี่คน|เท่าไหร่|เท่าไร)|คน(?:ในห้อง(?:นี้)?)?(?:อยู่|มี)?กี่คน|จำนวนคน(?:ในห้อง(?:นี้)?)?(?:กี่คน|เท่าไหร่|เท่าไร)|กี่คน(?:อยู่ในห้อง(?:นี้)?)?)$/.test(body) ||
      (wantsReading && /^(?:จำนวนคน|คน)(?:ในห้อง(?:นี้)?)?$/.test(body)) ||
      /^how many people(?:(?: are)? in (?:the|this) room| (?:are there|inside))?$/.test(english) || /^people count$/.test(english)) return 'people_count';
  if (/^(?:ในห้อง(?:นี้)?|ห้อง(?:นี้)?)?ความชื้น(?:สัมพัทธ์)?(?:ในห้อง(?:นี้)?|ห้อง(?:นี้)?)?(?:เท่าไหร่|เท่าไร|กี่เปอร์เซ็นต์|กี่เปอร์เซ็น|กี่%)$/.test(body) ||
      (wantsReading && /^ความชื้น(?:ในห้อง(?:นี้)?|ห้อง(?:นี้)?)?$/.test(body)) ||
      /^(?:what(?:'s| is) (?:the )?)?(?:room )?humidity(?: in (?:this|the) room)?$/.test(english)) return 'room_humidity';
  if (/^(?:อุณหภูมิ(?:ในห้อง(?:นี้)?|ห้อง(?:นี้)?)?|(?:ในห้อง(?:นี้)?|ห้อง(?:นี้)?)(?:อุณหภูมิ|เย็น|ร้อน)?)(?:อยู่ที่)?(?:เท่าไหร่|เท่าไร|กี่องศา)$/.test(body) ||
      /^กี่องศา$/.test(body) || (wantsReading && /^อุณหภูมิ(?:ในห้อง(?:นี้)?|ห้อง(?:นี้)?)?$/.test(body)) ||
      /^(?:what(?:'s| is) (?:the )?)?(?:room )?temperature(?: (?:now|in (?:this|the) room))?$/.test(english)) return 'room_temperature';
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
  text=text.replace(/อุ่นภูมิ|อุณภูม(?!ิ)|อุณภูมิ/g,'อุณหภูมิ').replace(/องสา/g,'องศา').replace(/ภัตรลม/g,'พัดลม');
  const query = roomQuery(text);
  if (query) return result({query});
  // A mixed or unrecognized question must not fall through to substring-based
  // controls. Request endings such as เปิดแอร์ได้ไหม remain actionable.
  if (/กี่\s*(?:องศา|คน|เปอร์เซ็นต์?|%)|เท่า\s*ไหร่|เท่า\s*ไร|(?:เปิด|ปิด|ทำงาน)\s*(?:แอร์|เครื่องปรับอากาศ)?\s*(?:อยู่)?\s*(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง|หรือไม่|เหรอ|หรอ)|\b(?:how many|what is|what's|is (?:the )?(?:ac|aircon|air conditioner))\b/.test(text)) return result({reason:'ambiguous'});
  const questionTail = text.replace(/[\s,.!?:]/g, '').replace(/(?:(?:นะ|ครับผม|ครับ|ค่ะ|คะ))+$/, '');
  if ((!/ได้(?:ไหม|มั้ย)$/.test(questionTail) && /(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง|หรือไม่|เหรอ|หรอ)$/.test(questionTail)) ||
      /^(?:is|are|was|were)\s+(?:the\s+)?(?:ac|aircon|air conditioner|it)\b/.test(text)) return result({reason:'ambiguous'});
  const numWords={'เอ็ด':1,'หนึ่ง':1,'สอง':2,'สาม':3,'สี่':4,'ห้า':5,'หก':6,'เจ็ด':7,'แปด':8,'เก้า':9};
  text=text.replace(/ยี่สิบ\s*(เอ็ด|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า)/g,(_,n)=>String(20+numWords[n]))
    .replace(/สามสิบ/g,'30').replace(/สิบ\s*(แปด|เก้า)/g,(_,n)=>String(10+numWords[n]));
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
