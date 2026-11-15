'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Controller=require('../public/js/voice-controller');
const {wav}=require('../public/js/voice-audio');
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(options={}){
 const events=[],sent=[],logged=[];let count=0,revision=0,destination='room-a',current={power:true,temp:24,mode:0,fan:3};
 let respond=async form=>({requestId:form.get('requestId'),wakeVerified:true,success:true,nextState:{...current,power:false},label:'ปิดแอร์',feedback:{text:'ปิดแอร์ครับ',clips:['power-off']}});
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
 const h=fixture();await h.c.start(true);h.setRespond(async()=>{throw Error('local down')});await h.c.onEnd(samples(),h.c.epoch);
 assert.equal(h.c.state,'RECOVERING');assert.equal(h.sent.length,0);h.c.stop();
});
test('automatic autoplay restriction preserves gesture-required hint',async()=>{
 const h=fixture();h.audio.start=async()=>{throw Object.assign(Error('แตะหน้าจอ'),{code:'VOICE_GESTURE_REQUIRED'})};
 assert.equal(await h.c.start(true,{automatic:true}),false);assert.equal(h.c.lastStartError.code,'VOICE_GESTURE_REQUIRED');assert.equal(h.c.state,'OFF');
});

test('a second command captured during inference is processed once after the first reply',async()=>{
 const h=fixture();await h.c.start(true);let release;
 let calls=0;h.setRespond(async form=>{calls++;if(calls===1)await new Promise(r=>release=r);return{requestId:form.get('requestId'),wakeVerified:true,success:true,nextState:{power:true,temp:25,mode:0,fan:3},label:'ตั้ง 25',feedback:{text:'25',clips:['temp-25']}};});
 const first=h.c.onEnd(samples(),h.c.epoch);await tick();
 h.c.onStart(h.c.epoch);await h.c.onEnd(samples(),h.c.epoch);
 release();await first;await tick();await tick();assert.equal(h.sent.length,2);assert.equal(calls,2);h.c.stop();
});
test('speaking the next sentence delays feedback instead of cutting it off',async()=>{
 const h=fixture();await h.c.start(true);let release;
 let calls=0;h.setRespond(async form=>{if(++calls===1)await new Promise(r=>release=r);return{requestId:form.get('requestId'),wakeVerified:true,success:true,nextState:{power:false,temp:24,mode:0,fan:3},feedback:{text:'ปิด',clips:['power-off']}}});
 const first=h.c.onEnd(samples(),h.c.epoch);await tick();h.c.onStart(h.c.epoch);release();await tick();
 assert.equal(h.c.state,'DRAINING');assert.equal(h.sent.length,0);
 await h.c.onEnd(samples(),h.c.epoch);await first;h.c.stop();
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
  assert.ok(h.events.includes(spoken[0].text));assert.deepEqual(h.logged,[['info',`เอ็นจี้ตอบ: ${spoken[0].text}`]]);
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
