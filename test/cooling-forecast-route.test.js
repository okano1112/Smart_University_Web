const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {once}=require('node:events');
const {createCoolingForecastRouter}=require('../cooling-forecast-route');

test('forecast route uses its server clock, returns arrival time, and validates request data',async()=>{
 const now=Date.parse('2026-11-11T14:30:00+07:00'),app=express();
 app.use(express.json());app.use('/api/cooling-forecast',createCoolingForecastRouter({now:()=>now}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const url=`http://127.0.0.1:${server.address().port}/api/cooling-forecast`;
  const post=body=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const response=await post({roomTemp:28,target:25,power:true,mode:0,sensorAt:now,statusAt:now,statusFresh:true,now:now-999999999});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const result=await response.json();assert.equal(result.generatedAt,now);assert.equal(result.minutes,30);assert.equal(result.arrivalAt,now+30*60000);
  const bad=await post({target:50});assert.equal(bad.status,400);assert.equal((await bad.json()).kind,'invalid');
  const missing=await post({});assert.equal(missing.status,200);assert.equal((await missing.json()).kind,'unavailable');
  for(const skew of [5000,-5*60000]){
   const clientNow=now+skew;
   const skewed=await post({roomTemp:28,target:25,power:true,mode:0,statusFresh:true,clientNow,sensorAt:clientNow-10000,statusAt:clientNow-20000});
   assert.equal(skewed.status,200);const prediction=await skewed.json();assert.equal(prediction.generatedAt,now);
   assert.equal(prediction.arrivalAt,now-10000+30*60000);assert.equal(prediction.minutes,30-1/6);
   const future=await post({clientNow,sensorAt:clientNow+1});assert.equal(future.status,400);
   const futureSample=await post({clientNow,samples:[{time:clientNow+1,temp:28}]});assert.equal(futureSample.status,400);
  }
  assert.equal((await post({clientNow:'bad'})).status,400);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
