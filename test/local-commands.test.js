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

test('re-aligned short audio can open a wake window only for an isolated name', () => {
 const prediction = {
  engine: 'LOCAL_WHISPER', accepted: true, noSpeechProbability: .01,
  wakeCandidates: [{ transcript: 'เอ็นที่', score: -.2 }],
  wakeShortAcoustics: [{ name: 'เอ็นจี้', score: -1, consonant: .04, ending: .41 }]
 };
 assert.equal(verifiedWakeTranscript(prediction), 'เอ็นจี้');
 assert.equal(verifiedWakeTranscript({ ...prediction, wakeCandidates: [{ transcript: 'เอ็นที่ เปิดแอร์', score: -.2 }] }), null);
 assert.equal(verifiedWakeTranscript({ ...prediction, wakeShortAcoustics: [{ name: 'เอ็นจี้', score: -1, consonant: .005, ending: .41 }] }), null);
});

test('an exact English command supported by a phonetic beam still rejects conflicting actions', () => {
 const prediction = {
  engine: 'LOCAL_WHISPER', accepted: true, noSpeechProbability: .001,
  wakeAcoustics: [{ name: 'เอ็นกี่', score: -.8, consonant: .5, ending: .5 }],
  wakeCandidates: ['เอ็งเกี่ยวกับเอ็งเกี่ยว', 'เอ็งเกี่ยวกับธนาคาร', 'เอ็งเกี่ยวกับตัว AC', 'เอ็งกี่ เชิญกับ AC']
   .map((transcript, index) => ({ transcript, score: -.65 - .05 * index })),
  wakeEnglish: { noSpeechProbability: .001, candidates: [
   { transcript: 'Engi. Turn on AC.', score: -.59 }, { transcript: 'Engi, churn on AC.', score: -.69 }
  ] }
 };
 assert.deepEqual(parseSpeech(verifiedWakeTranscript(prediction)).commands, ['ON']);
 const conflicting = { transcript: 'Engi, churn off AC.', score: -.72 };
 assert.equal(verifiedWakeTranscript({ ...prediction, wakeEnglish: {
  ...prediction.wakeEnglish, candidates: [...prediction.wakeEnglish.candidates, conflicting]
 } }), null);
 assert.equal(verifiedWakeTranscript({ ...prediction, wakeEnglish: {
  ...prediction.wakeEnglish, candidates: prediction.wakeEnglish.candidates.slice(1)
 } }), null);
});

test('a misheard English verb needs a close literal command and a verified name', () => {
 const prediction = {
  engine: 'LOCAL_WHISPER', accepted: true, noSpeechProbability: .001,
  wakeAcoustics: [{ name: 'เอ็นกี่', score: -.70, consonant: .50, ending: .55 }],
  wakeCandidates: [{ transcript: 'เอ็งกี่ เชิญกับภาษี', score: -.76 }],
  wakeEnglish: { noSpeechProbability: .001, candidates: [
   { transcript: 'Engi, churn on the AC.', score: -.55 },
   { transcript: 'Engi. Turn on AC.', score: -.61 },
  ] }
 };
 const resolve = (candidates, options = {}) => parseSpeech(verifiedWakeTranscript({
  ...prediction, ...options, wakeEnglish: { ...prediction.wakeEnglish, candidates }
 })).commands;
 const [top, literal] = prediction.wakeEnglish.candidates;
 assert.deepEqual(resolve([top, literal]), ['ON']);
 assert.equal(resolve([top]), undefined);
 assert.equal(resolve([top, { ...literal, score: -.73 }]), undefined);
 assert.equal(resolve([top, literal], { wakeAcoustics: [] }), undefined);
 assert.equal(resolve([top, literal, { transcript: 'Engi, turn off AC.', score: -.65 }]), undefined);
 assert.equal(resolve([{ ...top, transcript: 'Andy, churn on AC.' }, literal]), undefined);
});

test('the Thai word-boundary variant needs acoustic evidence and an unchanged command', () => {
 const prediction = {
  engine: 'LOCAL_WHISPER', accepted: true, noSpeechProbability: .001,
  wakeAcoustics: [{ name: 'เอ็นจี้', score: -.44, consonant: .24, ending: .71 }],
  wakeCandidates: [
   { transcript: 'เป็นที่เปิดแอร์ให้ผม', score: -.14 },
   { transcript: 'เอ็นที่เปิดแอร์ให้ผม', score: -.15 },
   { transcript: 'เอ็นจี้เปิดแอร์ให้ผม', score: -.17 }
  ]
 };
 const [top, near, exact] = prediction.wakeCandidates;
 assert.deepEqual(parseSpeech(verifiedWakeTranscript(prediction)).commands, ['ON']);
 assert.equal(verifiedWakeTranscript({ ...prediction, wakeAcoustics: [] }), null);
 assert.equal(verifiedWakeTranscript({ ...prediction, wakeCandidates: [top, exact] }), null);
 assert.equal(verifiedWakeTranscript({ ...prediction, wakeCandidates: [top, near, exact,
  { transcript: 'เอ็นจี้ปิดแอร์ให้ผม', score: -.20 }
 ] }), null);
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

test('room questions distinguish the room sensor from the AC setting and never take action', () => {
 for (const [text, query, hasWakeWord] of [
  ['เอ็นจี้ ตอนนี้อุณหภูมิเท่าไหร่', 'room_temperature', true],
  ['เอ็นจี้ตอนนี้อุณภูมิเท่าไร', 'room_temperature', true],
  ['เอ็นจี้ อุณหภูมิห้องตอนนี้เท่าไหร่ครับ', 'room_temperature', true],
  ['ตอนนี้ห้องกี่องศา', 'room_temperature', false],
  ['ช่วยบอกอุณหภูมิห้องหน่อย', 'room_temperature', false],
  ['กี่องศา', 'room_temperature', false],
  ['เอ็นจี้ในห้องมีกี่คน', 'people_count', true],
  ['เอ็นจี้ คนกี่คน', 'people_count', true],
  ['เอ็นจี้ คนในห้องมีกี่คน', 'people_count', true],
  ['ในห้องมีคนอยู่เท่าไหร่ครับ', 'people_count', false],
  ['มีคนกี่คน', 'people_count', false],
  ['ถามว่าความชื้นเท่าไหร่', 'room_humidity', false],
  ['เอ็นจี้ความชื้นกี่เปอร์เซ็นต์', 'room_humidity', true],
  ['ตั้งแอร์ไว้กี่องศา', 'ac_setpoint', false],
  ['เอ็นจี้แอร์ตั้งไว้เท่าไหร่', 'ac_setpoint', true],
  ['แอร์เปิดอยู่ไหม', 'ac_power', false],
  ['เอ็นจี้เปิดแอร์อยู่หรือไม่', 'ac_power', true],
  ['เอ็นจี้ เครื่องปรับอากาศปิดอยู่หรือเปล่า', 'ac_power', true],
  ['Engi, is the AC on?', 'ac_power', true],
  ['Engi what is the room temperature?', 'room_temperature', true],
  ['Engi how many people are in the room?', 'people_count', true],
 ]) assert.deepEqual(parseSpeech(text), { query, hasWakeWord }, text);
 assert.deepEqual(parseSpeech('กี่องศา', { expectingTemperature: true }), { query: 'room_temperature', hasWakeWord: false });
});

test('a query mixed with a control or another query does not execute the embedded control', () => {
 for (const text of ['เอ็นจี้เปิดแอร์แล้วบอกอุณหภูมิเท่าไหร่', 'เอ็นจี้ในห้องมีกี่คนแล้วปิดแอร์',
  'เอ็นจี้แอร์เปิดไหมแล้วปรับพัดลมแรง', 'เอ็นจี้ปิดแอร์อยู่หรือยังแล้วตั้งอุณหภูมิ25องศา',
  'เอ็นจี้ ตอนนี้อุณหภูมิเท่าไหร่แล้วตั้งแอร์ไว้กี่องศา', 'Engi, is the AC on? Turn it off',
  'เอ็นจี้ปรับอุณหภูมิกี่องศาดี', 'เอ็นจี้ ตอนนี้แอร์ตั้งไว้25องศาใช่หรือเปล่า',
  'เอ็นจี้ ตั้งอุณหภูมิ 25 องศาหรือเปล่า', 'เอ็นจี้เปิดแอร์25องศาหรือยัง', 'เอ็นจี้แอร์เปิดใช่หรือไม่']) {
  const intent = parseSpeech(text);
  assert.ok(intent.hasWakeWord, text);
  assert.equal(intent.commands, undefined, text);
  assert.equal(intent.askTemperature, undefined, text);
  assert.equal(intent.query, undefined, text);
 }
 for (const text of ['เอ็นจี้ไม่ต้องเปิดแอร์', 'เอ็นจี้ อย่าปิดแอร์ ตอนนี้อุณหภูมิเท่าไหร่']) assert.equal(parseSpeech(text).reason, 'negated');
 assert.deepEqual(parseSpeech('เอ็นจี้เปิดแอร์ได้ไหม').commands, ['ON']);
 assert.equal(parseSpeech('เอ็นจี้ปรับอุณหภูมิ').askTemperature, true);
});

test('inline questions follow the existing neutral wake evidence gate without weakening it', () => {
 const prediction = (top, ...alternatives) => ({
  engine:'LOCAL_WHISPER', accepted:true, noSpeechProbability:.02,
  wakeCandidates:[top,...alternatives].map(([transcript,score])=>({transcript,score}))
 });
 const exact = prediction(['เอ็นจี้ตอนนี้อุณหภูมิเท่าไหร่', -.2]);
 assert.equal(parseSpeech(verifiedWakeTranscript(exact)).query, 'room_temperature');
 const matching = prediction(['เอ็นที่ในห้องมีกี่คน', -.31], ['เอ็นจี้ในห้องมีกี่คน', -.37]);
 assert.equal(parseSpeech(verifiedWakeTranscript(matching)).query, 'people_count');
 assert.equal(verifiedWakeTranscript(prediction(['ในห้องมีกี่คน', -.1], ['เอ็นจี้ในห้องมีกี่คน', -.15])), null);
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นที่ในห้องมีกี่คน', -.31])), null);
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นจี้เปิดแอร์', -.19], ['เอ็นจี้แอร์เปิดอยู่ไหม', -.30])), null);
 assert.equal(verifiedWakeTranscript({ ...exact, noSpeechProbability:.6 }), null);
 assert.equal(verifiedWakeTranscript(prediction(['เอ็นจี้ยง คนกี่คน', -.21])), null);
 const recover = { ...prediction(['เอ็นที่แอร์เปิดอยู่ไหม', -.23]), wakeAcoustics:[{name:'เอ็นจี้',score:-.85,consonant:.06,ending:.66}] };
 assert.equal(parseSpeech(verifiedWakeTranscript(recover)).query, 'ac_power');
 assert.equal(verifiedWakeTranscript({ ...recover, wakeCandidates:[...recover.wakeCandidates,{transcript:'เอ็นที่เปิดแอร์',score:-.24}] }), null);
});
