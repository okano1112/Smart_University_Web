'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VoiceAudio}=require('../public/js/voice-audio');
test('suppression drops stale speech events and resumes the detector after its pending frame',async()=>{
 const events=[];const audio=new VoiceAudio({onStart:()=>events.push('start'),onEnd:()=>events.push('end')});
 let release;const inference=new Promise(r=>release=r);
 audio.detector={pause:()=>events.push('pause'),start:()=>events.push('resume')};audio.inferenceIdle=()=>inference;
 audio.setInputSuppressed(true);audio.speechStart();audio.speechEnd(new Float32Array(100));
 assert.deepEqual(events,['pause']);audio.setInputSuppressed(false);await Promise.resolve();assert.equal(events.includes('resume'),false);
 release();await Promise.resolve();await Promise.resolve();assert.equal(events.at(-1),'resume');audio.closed=true;
});
