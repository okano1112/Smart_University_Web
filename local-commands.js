'use strict';
const metadata = require('./models/ac_command_metadata.json');
const labels = new Map(Object.values(metadata.classes).map(e=>[e.mqtt_command,e.class_name]));
function parseSpeech(input, { expectingTemperature = false } = {}) {
  let text = String(input || '').normalize('NFC').trim().toLowerCase();
  if (!text || text.length > 500) return { reason:'unmatched' };
  text = text.replace(/[๐-๙]/g,c=>String(c.charCodeAt(0)-0x0E50)).replace(/[’]/g,"'");
  const wake = text.match(/^(?:(?:hey|hi|hello|เฮ้|เฮ|หวัดดี|สวัสดี)[\s,.!]*)?(?:เอ็?นจ[ีิ][่้๊๋]?|เอนจ[ีิ][่้๊๋]?|engi)(?=$|[\s,.!?]|ครับ|ค่ะ|คะ|ช่วย|เปิด|ปิด|ปรับ|ตั้ง|ขอ|เพิ่ม|ลด)/i);
  const result = value => ({ ...value, hasWakeWord: !!wake });
  if(wake)text=text.slice(wake[0].length).trim();
  const politeOnly = text.replace(/[\s,.!?]/g,'').replace(/ครับ|ค่ะ|คะ|จ๋า/g,'');
  if(wake && !politeOnly)return result({wakeOnly:true});
  if(/อย่า|ห้าม|ไม่ต้อง|ยังไม่|ไม่ได้สั่ง|ไม่อยาก|ไม่ให้|ยกเลิก|\b(?:don't|do not|never|cancel)\b/.test(text))return result({reason:'negated'});
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
module.exports={parseSpeech};
