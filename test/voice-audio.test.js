'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VoiceAudio}=require('../public/js/voice-audio');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
test('suppression drops stale speech events and resumes the detector after its pending frame',async()=>{
 const events=[];const audio=new VoiceAudio({onStart:()=>events.push('start'),onEnd:()=>events.push('end')});
 let release;const inference=new Promise(r=>release=r);
 audio.detector={pause:()=>events.push('pause'),start:()=>events.push('resume')};audio.inferenceIdle=()=>inference;
 audio.setInputSuppressed(true);audio.speechStart();audio.speechEnd(new Float32Array(100));
 assert.deepEqual(events,['pause']);audio.setInputSuppressed(false);await Promise.resolve();assert.equal(events.includes('resume'),false);
 release();await Promise.resolve();await Promise.resolve();assert.equal(events.at(-1),'resume');audio.closed=true;
});
test('an overlong utterance is discarded through its end without closing capture',()=>{
 const events=[];const audio=new VoiceAudio({onStart:()=>events.push('start'),onEnd:()=>events.push('end'),onMisfire:reason=>events.push(reason)});
 audio.speechStart();audio.discardLongSpeech();audio.speechEnd(new Float32Array(200));
 audio.speechStart();audio.speechEnd(new Float32Array(200));
 assert.deepEqual(events,['start','too_long','start','end']);assert.equal(audio.closed,false);
});

test('a failed wake acknowledgement uses a local tone with capture suppressed', async () => {
 const audio = new VoiceAudio({});
 audio.context = { state: 'running' };
 audio.loadClip = async () => { throw Error('WAV not available'); };
 audio.beep = async type => {
  assert.equal(type, 'ready');
  assert.equal(audio.inputSuppressed, true);
  return true;
 };
 assert.equal(await audio.reply({ clips: ['wake-ready'] }), true);
 assert.equal(audio.inputSuppressed, false);
 await assert.rejects(audio.reply({ clips: ['power-off'] }), /WAV not available/);
});

function fakeAudio({ microphone, detector }) {
 const timers = new Map(), statuses = [], requests = [];
 const browser = {
  AudioContext: class {
   state = 'running';
   async resume() {}
   async close() { this.state = 'closed'; }
   createMediaStreamSource() { return { disconnect() {} }; }
  },
  AbortController, navigator: { mediaDevices: { getUserMedia: () => microphone } },
  ort: {}, vad: { AudioNodeVAD: { new: () => detector } },
  fetch: async url => { requests.push(url); return new Response('fixture'); },
  console: { warn() {} },
  setTimeout: (callback, ms) => { const id = Symbol(); timers.set(id, { callback, ms }); return id; },
  clearTimeout: id => timers.delete(id)
 };
 vm.runInNewContext(readFileSync(require.resolve('../public/js/voice-audio'), 'utf8'), browser);
 const audio = new browser.SmartVoiceAudio.VoiceAudio({ onPreparation: label => statuses.push(label) });
 audio.loadClip = async key => { requests.push(key); };
 return { audio, statuses, requests, expire(ms) {
  const deadline = [...timers.values()].find(item => item.ms === ms);
  assert.ok(deadline, `scheduled deadline ${ms}`);
  deadline.callback();
 } };
}

test('a slow Silero startup opens the fallback and never connects the late detector', async () => {
 let resolveDetector, destroyed = 0, fallback = 0;
 const detector = new Promise(resolve => { resolveDetector = resolve; });
 const microphone = Promise.resolve({ getAudioTracks: () => [], getTracks: () => [] });
 const h = fakeAudio({ microphone, detector });
 h.audio.startFallback = async () => { fallback++; };
 const started = h.audio.start();
 await new Promise(setImmediate);
 assert.deepEqual(h.statuses, ['รออนุญาตไมโครโฟนในเบราว์เซอร์', 'กำลังโหลดตัวตรวจจับเสียงพูด']);
 h.expire(9000);
 await started;
 resolveDetector({ destroy() { destroyed++; } });
 await new Promise(setImmediate);
 assert.equal(destroyed, 1);
 assert.equal(fallback, 1);
 assert.equal(h.audio.kind, 'rms');
 assert.equal(h.statuses.at(-1), 'กำลังเปิดตัวตรวจจับเสียงสำรอง');
 assert.deepEqual(h.requests, ['/vad-web/silero_vad.onnx', 'wake-ready']);
 h.audio.close();
});

test('closing during the browser permission prompt releases a stream granted later', async () => {
 let allow, stopped = 0;
 const microphone = new Promise(resolve => { allow = resolve; });
 const h = fakeAudio({ microphone });
 const started = h.audio.start();
 await new Promise(setImmediate);
 assert.deepEqual(h.statuses, ['รออนุญาตไมโครโฟนในเบราว์เซอร์']);
 h.audio.close();
 await assert.rejects(started, { name: 'AbortError' });
 allow({ getTracks: () => [{ stop() { stopped++; } }] });
 await new Promise(setImmediate);
 assert.equal(stopped, 1);
 assert.deepEqual(h.requests, []);
});
