const test=require('node:test'),assert=require('node:assert/strict');
const {parseSpeech}=require('../local-commands');
const {commandFor}=require('../offline-voice');
for(const [speech,cmd] of [['เปิดแอร์ให้ผมหน่อย','ON'],['เปิดแอร์','ON'],['ปิดแอร์','OFF'],['ปิดแอร์ให้ผมหน่อย','OFF'],['เอ็นจี้เปิดแอร์ให้ผมหน่อย','ON'],['เฮ้ เอ็นจี ช่วยปิดแอร์','OFF'],['Engi open the AC','ON'],['turn the AC off','OFF'],['ปรับแอร์เป็นยี่สิบห้าองศา','TEMP:25'],['ขออุณภูม 25','TEMP:25'],['ยี่สิบห้าองศา','TEMP:25'],['เพิ่มอุณหภูมิ','TEMP:UP'],['ปรับพัดลมกลาง','FAN:MED'],['พัดลมแรง','FAN:HIGH'],['เพิ่มพัดลมหน่อย','FAN:UP']]) {
 test(`natural speech: ${speech}`,()=>assert.deepEqual(parseSpeech(speech).commands,[cmd]));
}
test('temperature dialogue and name-only request no device changes',()=>{
 assert.equal(parseSpeech('ปรับอุณหภูมิ').askTemperature,true);
 assert.equal(parseSpeech('เอ็นจี้').wakeOnly,true);
 assert.deepEqual(parseSpeech('25',{expectingTemperature:true}).commands,['TEMP:25']);
});
test('negation, conflict, unrelated objects, multiple temperatures do not execute',()=>{
 for(const s of ['ไม่ต้องเปิดแอร์','อย่าปิดแอร์','เปิดแอร์แล้วปิดแอร์','เปิดแอร์ 25 องศา 27 องศา',"don't open AC",'เปิดประตู','open the door','วันนี้กินข้าวหรือยัง'])assert.equal(parseSpeech(s).commands,undefined,s);
});
test('combined commands preserve the requested fields and fan steps use latest state',()=>{
 const intent=parseSpeech('เอ็นจี้ช่วยเปิดแอร์ให้ผมหน่อยแล้วตั้งอุณหภูมิยี่สิบห้าองศา');
 assert.deepEqual(intent.commands,['ON','TEMP:25']);
 const state={power:false,temp:24,mode:0,fan:1};
 const mapped=commandFor({accepted:true,...intent},state);assert.equal(mapped.next.power,true);assert.equal(mapped.next.temp,25);
 assert.equal(commandFor({accepted:true,commands:['FAN:UP']},state).next.fan,2);
 assert.equal(commandFor({accepted:true,commands:['FAN:DOWN']},state).next.fan,1);
});

test('wake aliases are recognized only at the beginning and carried on follow-up intents',()=>{
 for(const name of ['Engi','ENGI','เอ็นจี้','เอนจี้','เอ็นจี','เฮ้ เอ็นจี้']) {
  assert.equal(parseSpeech(name).wakeOnly,true,name);assert.equal(parseSpeech(name+'ปรับอุณหภูมิ').hasWakeWord,true,name);
 }
 for(const text of ['มีคนชื่อเอ็นจี้','engineering เปิดแอร์','ng เปิดแอร์','เปิดแอร์'])assert.ok(!parseSpeech(text).hasWakeWord,text);
});
