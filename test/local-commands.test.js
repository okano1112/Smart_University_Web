const test=require('node:test'),assert=require('node:assert/strict');
const {parseSpeech,verifiedWakeTranscript}=require('../local-commands');
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
 assert.equal(parseSpeech('เอ็นจี้จ๋า').wakeOnly,true);
 assert.deepEqual(parseSpeech('Engi: turn off the AC').commands,['OFF']);
});

test('wake evidence may disambiguate only a known spelling confusion and the exact same command suffix',()=>{
 const prediction=(top,alternatives=[],noSpeechProbability=.02)=>({engine:'LOCAL_WHISPER',accepted:true,noSpeechProbability,wakeCandidates:[top,...alternatives].map(([transcript,score])=>({transcript,score}))});
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นจี้',-.2])),'เอ็นจี้');
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นที่',-.38],[['เอ็นจี้',-1.09]])),'เอ็นจี้');
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นที่เปิดแอร์',-.1],[['เอ็นจี้ เปิดแอร์',-.15]])),'เอ็นจี้ เปิดแอร์');
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นที่ผิดแอร์',-.28],[['เอ็นที่ปิดแอร์',-.36],['เอ็นจี้ปิดแอร์',-.38]])),'เอ็นจี้ปิดแอร์');
 for(const [first,rest] of [
  [['เอ็นที่',-.38],[['เอ็นจี้',-1.2]]],
  [['เอ็นที่',-.1],[['เอ็นจี้',-1.0]]],
  [['เอ็นที่เปิดแอร์',-.1],[['เอ็นจี้ปิดแอร์',-.15]]],
  [['เอ็นที่ผิดแอร์',-.1],[['เอ็นจี้ปิดแอร์',-.15]]],
  [['เอ็นที่ผิดแอร์',-.1],[['เอ็นที่ปิดแอร์',-.12],['เอ็นจี้เปิดแอร์',-.15]]],
  [['เอ็นที่ผิดแอร์',-.1],[['เอ็นที่ปิดแอร์',-.12],['เอ็นจี้ปิดแอร์',-.15],['เอ็นจี้เปิดแอร์',-.16]]],
  [['เปิดแอร์',-.1],[['เอ็นจี้เปิดแอร์',-.15]]],
  [['เอ็นที่',-.1],[['เอ็นจี้ เปิดแอร์',-.15]]],
  [['เอ็นจิน',-.1],[['เอ็นจี้',-.15]]],
 ]) assert.equal(verifiedWakeTranscript(prediction(first,rest)),null,first[0]);
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นจี้',-.2],[],.6)),null);
});

test('acoustic name recovery is separate from command decoding', () => {
 const prediction = (top, alternatives, wakeAcoustics) => ({
  engine: 'LOCAL_WHISPER', accepted: true, noSpeechProbability: .01, wakeAcoustics,
  wakeCandidates: [top, ...alternatives].map(([transcript, score]) => ({ transcript, score }))
 });
 const soft = [{ name: 'เอ็นจี้', score: -1.41, consonant: .02, ending: .34 }];
 const strong = [{ name: 'เอ็นจี้', score: -.82, consonant: .053, ending: .70 }];
 const near = [{ name: 'เอ็นจี้', score: -2.78, consonant: .0001, ending: .14 }];
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นที่', -.57], [], soft)), 'เอ็นจี้');
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นที่', -.57], [], near)), null);
 const inline = prediction(['เอ็นที่เปิดแทงให้ผม', -.22], [['เอ็นที่เปิดแอร์ให้ผม', -.27]], strong);
 assert.deepEqual(parseSpeech(verifiedWakeTranscript(inline)).commands, ['ON']);
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นที่เปิดแทงให้ผม', -.22], [['เอ็นที่เปิดแอร์ให้ผม', -.27]], near)), null);
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นที่เปิดแอร์', -.21], [['เอ็นที่ปิดแอร์', -.24]], strong)), null);
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นที่ไม่ต้องเปิดแอร์', -.21], [['เอ็นที่เปิดแอร์', -.24]], strong)), null);
 assert.equal(verifiedWakeTranscript(prediction(['เปิดแอร์', -.21], [], strong)), null);
});

test('English wake requires a verified prefix; ordinary Andy does not wake', () => {
 const hard = [{ name: 'เอ็นกี่', score: -1.17, consonant: .25, ending: .50 }];
 const prediction = {
  engine: 'LOCAL_WHISPER', accepted: true, noSpeechProbability: .01, wakeAcoustics: hard,
  wakeCandidates: [{ transcript: 'อันดี', score: -1.14 }, { transcript: 'เอ็งกี้', score: -1.15 }, { transcript: 'เอ็นกี่', score: -1.16 }],
  wakeEnglish: { noSpeechProbability: .01, candidates: [{ transcript: 'Andy.', score: -.94 }] }
 };
 assert.equal(verifiedWakeTranscript(prediction), 'เอ็นจี้');
 assert.equal(verifiedWakeTranscript({ ...prediction, wakeCandidates: [{ transcript: 'Andy', score: -.4 }] }), null);
 const inline = { ...prediction, wakeEnglish: { noSpeechProbability: .01,
  candidates: [{ transcript: 'Engi. Turn on AC.', score: -.61 }]
 }};
 assert.deepEqual(parseSpeech(verifiedWakeTranscript(inline)).commands, ['ON']);
 assert.equal(verifiedWakeTranscript({ ...inline, wakeEnglish: { noSpeechProbability: .01,
  candidates: [{ transcript: 'Turn on AC.', score: -.3 }]
 }, wakeCandidates: [{ transcript: 'เปิดแอร์', score: -.3 }] }), null);
 assert.equal(verifiedWakeTranscript({ ...inline, wakeAcoustics: [],
  wakeCandidates: [{ transcript: 'เอ็นจี้', score: -.76 }]
 }), null);
});

test('voice recovery does not infer unrelated NG, negated actions or status questions', () => {
 const result = { engine: 'LOCAL_WHISPER', accepted: true, noSpeechProbability: .02,
  wakeAcoustics: [{ name: 'เอ็นจี', score: -1.1, consonant: .127, ending: .736 }],
  wakeCandidates: [{ transcript: 'NG turn on the AC', score: -.2 }],
  wakeEnglish: { noSpeechProbability: .02, candidates: [{ transcript: 'Engi turn on the AC', score: -.3 }] } };
 assert.equal(verifiedWakeTranscript(result), null);
 assert.equal(verifiedWakeTranscript({ ...result, wakeCandidates: [
  { transcript: 'เอ็นจี้ตั้งอุณหภูมิ 25 องศา', score: -.1 },
  { transcript: 'เอ็นจี้ไม่ต้องตั้งอุณหภูมิ 25 องศา', score: -.15 },
 ] }), null);
 for (const text of ['เอ็นจี้ ไม่ได้บอกให้เปิดแอร์', 'เอ็นจี้ เปิดแอร์อยู่ไหม',
  'เอ็นจี้ เครื่องปรับอากาศเปิดอยู่ไหม', 'Engi, is the AC on?', 'เอ็นจี้ ตอนนี้แอร์ตั้งอุณหภูมิ 25 องศาใช่ไหมครับ'
 ]) assert.equal(parseSpeech(text).commands, undefined, text);
 assert.deepEqual(parseSpeech('เอ็นจี้เปิดแอร์ได้ไหม').commands, ['ON']);
});
