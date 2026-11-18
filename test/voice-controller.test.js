'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Controller=require('../public/js/voice-controller');
const {wav}=require('../public/js/voice-audio');
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(options={}){
 const events=[],sent=[],logged=[];let count=0,revision=0,destination='room-a',current={power:true,temp:24,mode:0,fan:3};
 let respond=async form=>({requestId:form.get('requestId'),wakeVerified:true,success:true,nextState:{...current,power:false},label:'ปิดแอร์',latencyMs:42,feedback:{text:'ปิดแอร์ครับ',clips:['power-off']}});
 const audio={start:async()=>{},close:()=>events.push('close'),beep:async()=>events.push('beep'),reply:async f=>events.push(f.clips[0])};
 const c=new Controller({audio:()=>audio,wav,id:()=>`request-${++count}`,device:()=>destination,current:()=>current,revision:()=>revision,
  fetch:async(url,o)=>{if(url.endsWith('/voice-command'))return{ok:true,json:()=>respond(o.body)};return{ok:true,json:async()=>({sessionId:'test-session'})};},
  send:next=>{sent.push(next);return{demo:true};},notice:(...v)=>events.push(v[0]),log:(...v)=>logged.push(v),render:()=>{},...options});
 return{c,audio,events,sent,logged,setRespond:f=>respond=f,manual:()=>revision++,move:()=>destination='room-b'};
}
const samples=()=>new Float32Array(32000).fill(.1);
test('continuous activation waits for name; commands do not add greetings and duplicate callbacks deliver once',async()=>{
 const h=fixture();await h.c.start(true);assert.equal(h.c.state,'WAIT_CONTINUOUS');assert.equal(h.events.filter(x=>x==='wake-ready'||x==='beep').length,0);
 const a=samples();h.c.onStart(h.c.epoch);await Promise.all([h.c.onEnd(a,h.c.epoch),h.c.onEnd(a,h.c.epoch)]);
 assert.equal(h.sent.length,1);assert.equal(h.c.state,'WAIT_CONTINUOUS');assert.ok(h.events.includes('power-off'));h.c.stop();
 assert.match(h.logged[0][1], /ประมวลผลบนเซิร์ฟเวอร์ 42 ms · รับส่งและรอคิว ~\d+ ms · ตรวจสิทธิ์และส่ง MQTT \d+ ms/);
});
for (const accepted of [true, false]) {
 test(`browser recognition ${accepted ? 'sends only text' : 'falls back with the same original samples'}`, async () => {
  const audio = samples(), requests = [];
  const localModel = { ready: true, prepare() {}, close() {}, canRecognize: () => true,
   recognize(received) { assert.equal(received, audio); return ['เอ็นจี้ปิดแอร์', 'เอ็นจี้ ปิดแอร์']; } };
  const command = { wakeVerified: true, success: true, nextState: {power:false,temp:24,mode:0,fan:3}, label:'ปิดแอร์' };
  const h = fixture({ localModel: () => localModel, fetch: async (url, options) => {
   if (url.endsWith('/voice-transcript')) {
    const input = JSON.parse(options.body);
    requests.push([url, input.requestId]);
    assert.equal(input.stage, 'continuous'); assert.equal(input.transcripts.length, 2);
    assert.equal(input.currentAc.power, true);
    return Response.json(accepted ? { ...command, requestId: input.requestId, engine: 'LOCAL_BROWSER' } : {useServer:true});
   }
   if (url.endsWith('/voice-command')) {
    const input = options.body;
    requests.push([url, input.get('requestId')]);
    assert.deepEqual(await input.get('audio').arrayBuffer(), await wav(audio).arrayBuffer());
    return Response.json({ ...command, requestId: input.get('requestId') });
   }
   return Response.json({sessionId:'browser-session'});
  } });
  try {
   await h.c.start(true);
   await h.c.onEnd(audio, h.c.epoch);
   assert.deepEqual(requests, accepted ? [['/api/voice-transcript', 'request-1']] :
    [['/api/voice-transcript', 'request-1'], ['/api/voice-command', 'request-1']]);
   assert.equal(h.sent.length, 1);
   if (accepted) assert.match(h.logged[0][1], /ถอดเสียงบนอุปกรณ์/);
  } finally { h.c.stop(); }
 });
}

test('stopping during client inference fences late text and fallback', async () => {
 let complete, noticedRequest = false;
 const h = fixture({
  localModel: () => ({prepare() {}, close() {}, canRecognize: () => true,
   recognize: () => new Promise(resolve => { complete = resolve; }) }),
  fetch: async url => {
   if (url.endsWith('/voice-transcript') || url.endsWith('/voice-command')) noticedRequest = true;
   return Response.json({sessionId:'browser-session'});
  }
 });
 await h.c.start(true);
 const pending = h.c.onEnd(samples(), h.c.epoch);
 await tick(); h.c.stop();
 complete(['เอ็นจี้ปิดแอร์','เอ็นจี้ ปิดแอร์']);
 await pending;
 assert.equal(noticedRequest, false);
 assert.equal(h.sent.length, 0);
});

test('name greeting finishes before arming; speech echo cannot execute; command consumes claim',async()=>{
 const h=fixture();await h.c.start(true);let release;
 h.audio.reply=()=>new Promise(r=>release=r);
 h.setRespond(async f=>({requestId:f.get('requestId'),wakeVerified:true,success:false,wakeOnly:true,wakeToken:'test-token',feedback:{text:'พูดได้เลย',clips:['wake-ready']}}));
 const wake=h.c.onEnd(samples(),h.c.epoch);await tick();assert.equal(h.c.state,'SPEAKING');
 await h.c.onEnd(samples(),h.c.epoch);assert.equal(h.sent.length,0);
 release();await wake;assert.equal(h.c.state,'WAIT_COMMAND');assert.equal(h.c.wakeToken,'test-token');
 h.audio.reply=async()=>{};
 h.setRespond(async f=>{assert.equal(f.get('stage'),'command');assert.equal(f.get('wakeToken'),'test-token');return{requestId:f.get('requestId'),success:true,nextState:{power:true,temp:24,mode:0,fan:3}};});
 await h.c.onEnd(samples(),h.c.epoch);assert.equal(h.sent.length,1);assert.equal(h.c.state,'WAIT_CONTINUOUS');assert.equal(h.c.wakeToken,null);h.c.stop();
});
test('speech captured before the acknowledgement cannot inherit a wake token',async()=>{
 const h=fixture();await h.c.start(true);let release,calls=0;
 h.setRespond(async f=>{
  if(++calls===1){await new Promise(r=>release=r);return{requestId:f.get('requestId'),wakeVerified:true,wakeOnly:true,wakeToken:'queued-token',feedback:{clips:['wake-ready']}};}
  assert.equal(f.get('stage'),'command');assert.equal(f.get('wakeToken'),'queued-token');
  return{requestId:f.get('requestId'),success:true,nextState:{power:false,temp:24,mode:0,fan:3},feedback:{clips:['power-off']}};
 });
 const name=h.c.onEnd(samples(),h.c.epoch);await tick();h.c.onStart(h.c.epoch);await h.c.onEnd(samples(),h.c.epoch);
 release();await name;await tick();
 assert.equal(calls,1);assert.equal(h.sent.length,0);assert.ok(h.events.includes('wake-ready'));
 await h.c.onEnd(samples(),h.c.epoch);assert.equal(h.sent.length,1);assert.equal(h.c.state,'WAIT_CONTINUOUS');h.c.stop();
});
for(const action of ['stop','manual','move'])test(`late result cannot publish after ${action}`,async()=>{
 const h=fixture();await h.c.start(true);let release;h.setRespond(form=>new Promise(r=>release=()=>r({requestId:form.get('requestId'),wakeVerified:true,success:true,nextState:{power:false,temp:24,mode:0,fan:3}})));
 const pending=h.c.onEnd(samples(),h.c.epoch);await tick();if(action==='stop')h.c.stop();else h[action]();release();await pending;assert.equal(h.sent.length,0);h.c.stop();
});
test('voice waits for authenticated publishing; stop invalidates the async send and its feedback', async () => {
 let authorize, guard, signals;
 const h = fixture({ send: (_state, _label, options) => {
  guard = options.validate; signals = options.signal;
  return new Promise(resolve => { authorize = resolve; });
 } });
 try {
  await h.c.start(true);
  const output = h.c.onEnd(samples(), h.c.epoch); await tick();
  assert.equal(h.c.state, 'PROCESSING_COMMAND');
  assert.equal(guard(), true);
  assert.ok(!h.events.includes('power-off'));
  h.c.stop();
  assert.equal(guard(), false);
  assert.equal(signals.aborted, true);
  authorize({ id: 'late' }); await output;
  assert.equal(h.c.state, 'OFF'); assert.equal(h.c.commandId, null);
  assert.ok(!h.events.includes('power-off'));
 } finally { h.c.stop(); }
});
test('unsupported or rejected command is spoken without sending, microphone resumes',async()=>{
 const h=fixture();await h.c.start(true);h.setRespond(async f=>({requestId:f.get('requestId'),wakeVerified:true,success:false,message:'ไม่รองรับ',feedback:{text:'ไม่รองรับ',clips:['unsupported']}}));
 await h.c.onEnd(samples(),h.c.epoch);assert.equal(h.sent.length,0);assert.ok(h.events.includes('unsupported'));assert.equal(h.c.state,'WAIT_CONTINUOUS');h.c.stop();
});
test('push to talk returns off and playback failure does not break continuous mode',async()=>{
 const h=fixture();await h.c.start(false);await h.c.onEnd(samples(),h.c.epoch);assert.equal(h.c.state,'OFF');
 await h.c.start(true);h.audio.reply=async()=>{throw Error('audio failure')};await h.c.onEnd(samples(),h.c.epoch);assert.equal(h.c.state,'WAIT_CONTINUOUS');h.c.stop();
});
test('local engine error backs off without publishing',async()=>{
 const h=fixture();await h.c.start(true);let fail;
 h.setRespond(()=>new Promise((_, reject)=>{fail=reject;}));
 const first=h.c.onEnd(samples(),h.c.epoch);await tick();
 h.c.onStart(h.c.epoch);await h.c.onEnd(samples(),h.c.epoch);
 fail(Error('local down'));await first;
 assert.equal(h.c.state,'RECOVERING');assert.equal(h.c.queue.length,0);assert.equal(h.sent.length,0);h.c.stop();
});
test('automatic autoplay restriction preserves gesture-required hint',async()=>{
 const h=fixture();h.audio.start=async()=>{throw Object.assign(Error('แตะหน้าจอ'),{code:'VOICE_GESTURE_REQUIRED'})};
 assert.equal(await h.c.start(true,{automatic:true}),false);assert.equal(h.c.lastStartError.code,'VOICE_GESTURE_REQUIRED');assert.equal(h.c.state,'OFF');
});

test('startup distinguishes microphone and server model loading and reports a proxy error', async () => {
 const phases = [], faults = [];
 const h = fixture({
  render: (phase, _handsFree, label) => { if (phase === 'INIT') phases.push(label); },
  onHandsFreeFault: error => faults.push(error),
  fetch: async () => new Response('<html>Service unavailable</html>', { status: 502 })
 });
 assert.equal(await h.c.start(true), false);
 assert.deepEqual(phases, ['กำลังเตรียมไมโครโฟน', 'กำลังโหลดโมเดลเสียงบนเซิร์ฟเวอร์']);
 assert.equal(faults[0].status, 502);
 assert.match(faults[0].message, /HTTP 502/);
 assert.equal(h.c.state, 'OFF');
});

test('connects the voice session in parallel with the detector after the mic is granted', async () => {
 let finishAudio, openCount = 0;
 const h = fixture({
  audio: callbacks => ({
   start() { callbacks.onMicReady(); return new Promise(resolve => { finishAudio = resolve; }); },
   close() {}
  }),
  fetch: async url => {
   if (url === '/api/voice-session') openCount++;
   return new Response(JSON.stringify({ sessionId: 'parallel-session' }));
  }
 });
 try {
  const starting = h.c.start(true);
  assert.equal(openCount, 1);
  await tick();
  assert.equal(h.c.state, 'INIT');
  finishAudio();
  assert.equal(await starting, true);
  assert.equal(h.c.state, 'WAIT_CONTINUOUS');
  assert.equal(openCount, 1);
 } finally { h.c.stop(); }
});

test('a late session response is canceled if the detector fails during parallel startup', async () => {
 let respond, connectionSignal;
 const canceled = [];
 const h = fixture({
  audio: callbacks => ({
   async start() { callbacks.onMicReady(); throw Error('detector did not initialize'); },
   close() {}
  }),
  fetch: async (url, options) => {
   if (url === '/api/voice-session') {
    connectionSignal = options.signal;
    return new Promise(resolve => { respond = resolve; });
   }
   if (url === '/api/voice-session/cancel') canceled.push(JSON.parse(options.body).sessionId);
   return Response.json({ success: true });
  }
 });
 assert.equal(await h.c.start(true), false);
 assert.equal(connectionSignal.aborted, true);
 respond(Response.json({ sessionId: 'late-session' }));
 await tick();
 assert.deepEqual(canceled, ['late-session']);
 assert.equal(h.c.sessionId, null);
 assert.equal(h.c.state, 'OFF');
});

test('an expired voice session renews on the same microphone and only a new utterance can publish', async () => {
 let sessionCount = 0, commands = 0;
 const h = fixture({ fetch: async (url, options) => {
  if (url === '/api/voice-session') return Response.json({ sessionId: `voice-${++sessionCount}` });
  if (url === '/api/voice-command') {
   if (++commands === 1) return new Response('<html>Voice session was lost</html>', { status: 410 });
   assert.equal(options.body.get('sessionId'), 'voice-2');
   return Response.json({ requestId: options.body.get('requestId'), wakeVerified: true, success: true,
    nextState: { power: false, temp: 24, mode: 0, fan: 3 }, label: 'ปิดแอร์', feedback: { clips: ['power-off'] } });
  }
  return Response.json({ success: true });
 }});
 try {
  await h.c.start(true);
  const epoch = h.c.epoch;
  await h.c.onEnd(samples(), epoch);
  assert.equal(h.c.state, 'WAIT_CONTINUOUS');
  assert.equal(h.c.epoch, epoch);
  assert.equal(h.c.sessionId, 'voice-2');
  assert.equal(h.events.includes('close'), false);
  assert.equal(h.sent.length, 0);
  assert.equal(commands, 1);
  await h.c.onEnd(samples(), epoch);
  assert.equal(h.sent.length, 1);
 } finally { h.c.stop(); }
});

test('a second command captured during inference is processed once after the first reply',async()=>{
 const h=fixture();await h.c.start(true);let release;
 let calls=0;h.setRespond(async form=>{calls++;if(calls===1)await new Promise(r=>release=r);return{requestId:form.get('requestId'),wakeVerified:true,success:true,nextState:{power:true,temp:25,mode:0,fan:3},label:'ตั้ง 25',feedback:{text:'25',clips:['temp-25']}};});
 const first=h.c.onEnd(samples(),h.c.epoch);await tick();
 h.c.onStart(h.c.epoch);await h.c.onEnd(samples(),h.c.epoch);
 release();await first;await tick();await tick();assert.equal(h.sent.length,2);assert.equal(calls,2);h.c.stop();
});
test('a verified command publishes while the next sentence is still being captured',async()=>{
 const h=fixture({send(next) { h.sent.push(next); h.manual(); return {demo:true}; }});await h.c.start(true);let release;
 let calls=0;h.setRespond(async form=>{if(++calls===1)await new Promise(r=>release=r);return{requestId:form.get('requestId'),wakeVerified:true,success:true,nextState:{power:false,temp:24,mode:0,fan:3},feedback:{text:'ปิด',clips:['power-off']}}});
 const first=h.c.onEnd(samples(),h.c.epoch);await tick();h.c.onStart(h.c.epoch);release();await tick();
 assert.equal(h.c.state,'DRAINING');assert.equal(h.sent.length,1);assert.equal(h.events.includes('power-off'),false);
 await h.c.onEnd(samples(),h.c.epoch);await first;await tick();await tick();
 assert.equal(h.sent.length,2);assert.equal(calls,2);h.c.stop();
});
test('temperature follow-up keeps push-to-talk microphone open until the number is spoken',async()=>{
 const h=fixture();await h.c.start(false);
 h.setRespond(async f=>({requestId:f.get('requestId'),wakeVerified:true,success:false,followUp:'temperature',feedback:{text:'กี่องศา',clips:['ask-temperature']}}));
 await h.c.onEnd(samples(),h.c.epoch);assert.equal(h.c.state,'WAIT_COMMAND');assert.equal(h.sent.length,0);
 h.setRespond(async f=>({requestId:f.get('requestId'),success:true,nextState:{power:true,temp:25,mode:0,fan:3},feedback:{text:'25',clips:['temp-25']}}));
 await h.c.onEnd(samples(),h.c.epoch);assert.equal(h.sent.length,1);assert.equal(h.c.state,'OFF');
});
test('ambient speech, misfire and unverified responses stay silent',async()=>{
 const h=fixture();await h.c.start(true);const baseline=h.events.length,epoch=h.c.epoch;
 h.c.onStart(epoch);h.c.onMisfire(epoch,'too_long');
 for (const response of [
  {ignored:true,message:'background',feedback:{clips:['not-understood']}},
  {success:true,nextState:{power:false,temp:24,mode:0,fan:3},feedback:{clips:['power-off']}},
  {wakeOnly:true,wakeToken:'unverified',feedback:{clips:['wake-ready']}}
 ]) {
  h.setRespond(async f=>({...response,requestId:f.get('requestId')}));
  await h.c.onEnd(samples(),epoch);
  assert.equal(h.c.state,'WAIT_CONTINUOUS');assert.equal(h.c.wakeToken,null);
 }
 assert.equal(h.events.length,baseline);assert.equal(h.sent.length,0);h.c.stop();
});
test('temporary mic mute invalidates captured commands and resumes name detection',async()=>{
 const h=fixture();await h.c.start(true);let release;
 h.setRespond(form=>new Promise(r=>release=()=>r({requestId:form.get('requestId'),wakeVerified:true,success:true,nextState:{power:false,temp:24,mode:0,fan:3}})));
 const epoch=h.c.epoch,pending=h.c.onEnd(samples(),epoch);await tick();
 h.c.onAvailability(epoch,false);assert.equal(h.c.state,'MIC_PAUSED');
 h.c.onAvailability(epoch,true);assert.equal(h.c.state,'WAIT_CONTINUOUS');
 release();await pending;assert.equal(h.sent.length,0);assert.equal(h.c.epoch,epoch);h.c.stop();
});
test('failed acknowledgement cannot open an unnamed command window',async()=>{
 const h=fixture();await h.c.start(true);
 h.audio.reply=async()=>{throw Error('clip unavailable')};
 h.setRespond(async f=>({requestId:f.get('requestId'),wakeVerified:true,wakeOnly:true,wakeToken:'not-armed',feedback:{clips:['wake-ready']}}));
 await h.c.onEnd(samples(),h.c.epoch);
 assert.equal(h.c.state,'WAIT_CONTINUOUS');assert.equal(h.c.wakeToken,null);assert.equal(h.sent.length,0);
 h.c.stop();
});

test('verified room question reports and speaks the latest reading without publishing even while a device command is pending',async()=>{
 let current=26.5,release;
 const queries=[];
 const h=fixture({pending:()=>true,answer:query=>{queries.push(query);return{text:`อุณหภูมิห้อง ${current} องศาครับ`,clips:['room-temperature',`reading-${current}`]};}});
 try {
  await h.c.start(true);
  h.setRespond(f=>new Promise(resolve=>{release=()=>resolve({requestId:f.get('requestId'),success:true,wakeVerified:true,query:'room_temperature'});}));
  const spoken=[];h.audio.reply=async f=>spoken.push(f);
  const question=h.c.onEnd(samples(),h.c.epoch);await tick();
  current=28.5;h.manual();release();await question;
  assert.deepEqual(queries,['room_temperature']);assert.equal(h.sent.length,0);
  assert.deepEqual(spoken,[{text:'อุณหภูมิห้อง 28.5 องศาครับ',clips:['room-temperature','reading-28.5']}]);
  assert.ok(h.events.includes(spoken[0].text));
  assert.equal(h.logged.length,1);assert.equal(h.logged[0][0],'info');
  assert.ok(h.logged[0][1].startsWith(`เอ็นจี้ตอบ: ${spoken[0].text} · รอผลเสียง `));
  assert.equal(h.c.state,'WAIT_CONTINUOUS');
 } finally {h.c.stop();}
});

test('unverified questions stay silent and an unknown query cannot fall through to publishing',async()=>{
 let reads=0;
 const h=fixture({answer:()=>{reads++;return{text:'คำตอบ',clips:['people-count']};}});
 try {
  await h.c.start(true);const baseline=h.events.length;
  h.setRespond(async f=>({requestId:f.get('requestId'),success:true,query:'people_count'}));
  await h.c.onEnd(samples(),h.c.epoch);
  assert.equal(h.events.length,baseline);assert.equal(reads,0);
  h.setRespond(async f=>({requestId:f.get('requestId'),success:true,wakeVerified:true,query:'not-a-query',nextState:{power:false,temp:24,mode:0,fan:3}}));
  await h.c.onEnd(samples(),h.c.epoch);
  assert.equal(h.sent.length,0);assert.equal(reads,0);assert.equal(h.c.state,'WAIT_CONTINUOUS');
 } finally {h.c.stop();}
});

test('answered question uses one claimed wake window and a direct question finishes push to talk',async()=>{
 const h=fixture({answer:query=>({text:`ตอบ ${query}`,clips:[query]})});
 try {
  await h.c.start(true);
  h.setRespond(async f=>({requestId:f.get('requestId'),wakeVerified:true,wakeOnly:true,wakeToken:'query-token',feedback:{clips:['wake-ready']}}));
  await h.c.onEnd(samples(),h.c.epoch);
  assert.equal(h.c.state,'WAIT_COMMAND');
  h.setRespond(async f=>{assert.equal(f.get('stage'),'command');assert.equal(f.get('wakeToken'),'query-token');return{requestId:f.get('requestId'),success:true,query:'ac_power'};});
  await h.c.onEnd(samples(),h.c.epoch);
  assert.ok(h.events.includes('ac_power'));assert.equal(h.c.wakeToken,null);assert.equal(h.c.state,'WAIT_CONTINUOUS');
  await h.c.start(false);
  h.setRespond(async f=>{assert.equal(f.get('stage'),'direct');return{requestId:f.get('requestId'),success:true,query:'ac_setpoint'};});
  await h.c.onEnd(samples(),h.c.epoch);
  assert.ok(h.events.includes('ac_setpoint'));assert.equal(h.c.state,'OFF');assert.equal(h.sent.length,0);
 } finally {h.c.stop();}
});
