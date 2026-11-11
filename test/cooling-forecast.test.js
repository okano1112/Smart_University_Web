const test=require('node:test'),assert=require('node:assert/strict');
const {CoolingForecast,duration,calculateCoolingForecast,ForecastInputError}=require('../cooling-forecast');
const now=Date.parse('2026-11-11T14:30:00+07:00'),base={now,roomTemp:28,target:25,power:true,mode:0,sensorAt:now,statusAt:now,statusFresh:true,assumedRate:.1};
test('28 to 25 has an explicitly assumed 30-minute estimate before enough observations',()=>{
 const f=new CoolingForecast(),r=f.estimate(base);assert.equal(r.minutes,30);assert.equal(r.source,'assumed');assert.ok(r.minMinutes<30&&r.maxMinutes>30);assert.equal(r.points.at(-1).temp,25);
});
test('measured cooling slope replaces assumed rate without depending on message frequency',()=>{
 const f=new CoolingForecast();for(let i=0;i<=8;i++)f.record({time:now-(8-i)*30000,temp:28.8-i*.1,context:'a'});
 const r=f.estimate(base);assert.equal(r.source,'measured');assert.ok(Math.abs(r.minutes-15)<.01);assert.equal(r.points[0].temp,28);
});
test('countdown is anchored to the sensor timestamp instead of restarting on every render',()=>{
 const f=new CoolingForecast(),r=f.estimate({...base,now:now+30000});assert.equal(r.minutes,29.5);assert.equal(r.points[0].time,now);
 assert.equal(f.estimate({...base,now:now+30001}).kind,'unavailable');
});
test('flat or warming observations do not fabricate a countdown',()=>{
 for(const sign of [0,1]){const f=new CoolingForecast();for(let i=0;i<=8;i++)f.record({time:now-(8-i)*30000,temp:28+sign*i*.05,context:'a'});assert.equal(f.estimate(base).kind,'unavailable');}
});
test('stale telemetry, pending commands, unknown status, power off, fan/dry disable forecasts',()=>{
 for(const patch of [{sensorAt:now-31000},{sensorAt:now+1},{statusAt:now-75001},{statusAt:null},{pending:true},{statusFresh:false},{power:false},{mode:1},{mode:2},{roomTemp:null}])assert.equal(new CoolingForecast().estimate({...base,...patch}).kind,'unavailable');
});
test('context and telemetry gaps reset learned rates; duplicate timestamps cannot add confidence',()=>{
 const f=new CoolingForecast();f.record({time:now-300000,temp:29,context:'a'});f.record({time:now,temp:28,context:'a'});assert.equal(f.samples.length,1);
 f.record({time:now,temp:28,context:'a'});assert.equal(f.samples.length,1);
 f.record({time:now+30000,temp:27.8,context:'b'});assert.equal(f.samples.length,1);
});
test('reached target and hour formatting are explicit',()=>{
 assert.equal(new CoolingForecast().estimate({...base,roomTemp:25.1}).kind,'reached');assert.equal(duration(90),'1 ชม. 30 นาที');
});
test('server predicts 15:00 arrival from a 14:30 reading and keeps that clock time as time passes',()=>{
 const first=calculateCoolingForecast(base,{now}),later=calculateCoolingForecast(base,{now:now+30000});
 assert.equal(first.arrivalAt,Date.parse('2026-11-11T15:00:00+07:00'));assert.equal(first.minutes,30);
 assert.equal(later.arrivalAt,first.arrivalAt);assert.equal(later.minutes,29.5);assert.equal(later.generatedAt,now+30000);
 assert.ok(first.earliestAt<first.arrivalAt&&first.latestAt>first.arrivalAt);assert.equal(first.method,'local_trend');
 assert.ok(first.points.some(point=>point.time===first.arrivalAt&&point.temp===25));
});
test('server arrival timestamps cross midnight without losing the date',()=>{
 const midnight=Date.parse('2026-11-11T23:50:00+07:00');
 const r=calculateCoolingForecast({...base,sensorAt:midnight,statusAt:midnight},{now:midnight});
 assert.equal(r.arrivalAt,Date.parse('2026-11-12T00:20:00+07:00'));assert.equal(r.minutes,30);
});
test('server fits bounded chronological observations and rejects malformed or future data',()=>{
 const samples=Array.from({length:9},(_,i)=>({time:now-(8-i)*30000,temp:28.8-i*.1}));
 const measured=calculateCoolingForecast({...base,samples},{now});
 assert.equal(measured.source,'measured');assert.ok(Math.abs(measured.arrivalAt-(now+15*60000))<1);
 const patches=[{target:28},{target:'25'},{mode:3},{power:'true'},{roomTemp:Infinity},{assumedRate:0},{sensorAt:now+1},{statusAt:now+1},
  {samples:[{time:now+1,temp:28}]},{samples:[{time:now,temp:28},{time:now-1,temp:28}]},{samples:[{time:now,temp:'28'}]},
  {samples:Array.from({length:41},(_,i)=>({time:now-(41-i)*1000,temp:28}))},{samples:{}}];
 for(const patch of patches)assert.throws(()=>calculateCoolingForecast({...base,...patch},{now}),ForecastInputError);
 assert.throws(()=>calculateCoolingForecast({...base,sensorAt:now-1,samples:[{time:now,temp:28}]},{now}),ForecastInputError);
});
test('missing optional telemetry gives unavailable rather than an estimate or exception',()=>{
 for(const body of [{},{roomTemp:28},{...base,statusAt:undefined},{...base,sensorAt:0}])assert.equal(calculateCoolingForecast(body,{now}).kind,'unavailable');
 for(const body of [null,[],true,'bad'])assert.throws(()=>calculateCoolingForecast(body,{now}),ForecastInputError);
});
test('densely repeated samples cannot meet the observed-data threshold',()=>{
 const samples=Array.from({length:40},(_,i)=>({time:now-(39-i)*1000,temp:28.1-i*.002}));
 assert.equal(calculateCoolingForecast({...base,samples},{now}).source,'assumed');
});
test('a new sensor reading after a telemetry gap cannot reuse an old learned slope',()=>{
 const samples=Array.from({length:9},(_,i)=>({time:now-180000-(8-i)*30000,temp:29.8-i*.1}));
 const r=calculateCoolingForecast({...base,samples},{now});assert.equal(r.source,'assumed');assert.equal(r.sampleCount,1);
});
test('browser clock skew preserves observation ages and canonical server arrival timestamps',()=>{
 const samples=Array.from({length:9},(_,i)=>({time:now-(8-i)*30000,temp:28.8-i*.1}));
 const expected=calculateCoolingForecast({...base,sensorAt:now-10000,samples:samples.slice(0,-1)},{now});
 for(const skew of [5000,-5*60000]){
  const input={...base,clientNow:now+skew,sensorAt:now-10000+skew,statusAt:now-20000+skew,
   samples:samples.slice(0,-1).map(sample=>({...sample,time:sample.time+skew}))};
  const original=structuredClone(input),r=calculateCoolingForecast(input,{now});
  assert.equal(r.kind,'estimate');assert.equal(r.source,'measured');assert.equal(r.generatedAt,now);
  assert.equal(r.arrivalAt,expected.arrivalAt);assert.equal(r.minutes,expected.minutes);assert.deepEqual(r.points,expected.points);
  assert.deepEqual(input,original);
 }
});
test('normalization cannot disguise stale data or genuine future observations',()=>{
 const clientNow=now+5*60000;
 const input={...base,clientNow,sensorAt:clientNow,statusAt:clientNow};
 for(const patch of [{sensorAt:clientNow-30001},{statusAt:clientNow-75001}])assert.equal(calculateCoolingForecast({...input,...patch},{now}).kind,'unavailable');
 for(const patch of [{sensorAt:clientNow+1},{statusAt:clientNow+1},{samples:[{time:clientNow+1,temp:28}]},
  {samples:[{time:clientNow-1,temp:28},{time:clientNow-2,temp:28}]}])assert.throws(()=>calculateCoolingForecast({...input,...patch},{now}),ForecastInputError);
 for(const clientNow of [null,'123',NaN,Infinity,-1,0,9e15])assert.throws(()=>calculateCoolingForecast({...base,clientNow},{now}),ForecastInputError);
});
test('unknown timestamp sentinels remain unavailable when client clock normalization is enabled',()=>{
 for(const sensorAt of [0,null,undefined])assert.equal(calculateCoolingForecast({...base,clientNow:now+5000,sensorAt,statusAt:0},{now}).kind,'unavailable');
});
