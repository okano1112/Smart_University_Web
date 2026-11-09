'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HandsFreeStartup, preferenceKey } = require('../public/js/voice-handsfree');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture({ permission = 'granted', preference = 'on', start } = {}) {
  const document = new EventTarget(); document.hidden = false;
  const window = new EventTarget(), saved = new Map();
  if (preference) saved.set(preferenceKey, preference);
  const calls = [];
  const controller = { state: 'OFF', lastStartError: null,
    stop() { calls.push('stop'); this.state = 'OFF'; },
    setState(state, label) { this.state = state; calls.push({ state, label }); },
    async start(handsFree, options) {
      calls.push({ handsFree, ...options }); this.state = 'INIT';
      if (start) return start.call(this, options);
      this.state = 'WAIT_WAKE'; return true;
    }
  };
  const manager = new HandsFreeStartup({ controller, document, window,
    storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    permission: async () => permission });
  return { manager, controller, document, window, saved, calls };
}
test('previously allowed microphone starts hands-free with no button press', async () => {
  const h = fixture(); h.manager.install(); await tick();
  assert.equal(h.controller.state, 'WAIT_WAKE'); assert.ok(h.calls.some(call => call.automatic === true));
  h.manager.destroy();
});
test('first visit waits for one gesture without claiming the microphone is listening', async () => {
  const h = fixture({ permission: 'prompt' }); h.manager.install(); await tick();
  assert.equal(h.controller.state, 'OFF'); assert.equal(h.manager.awaitingGesture, true);
  assert.ok(!h.calls.some(call => call.handsFree));
  h.document.dispatchEvent(new Event('pointerdown')); await tick();
  assert.equal(h.controller.state, 'WAIT_WAKE'); assert.ok(h.calls.some(call => call.automatic === false));
  h.manager.destroy();
});
test('explicitly disabled hands-free stays off after reload and ordinary gestures', async () => {
  const h = fixture({ preference: 'off' }); h.manager.install(); await tick();
  h.document.dispatchEvent(new Event('pointerdown')); await tick();
  assert.equal(h.controller.state, 'OFF'); assert.ok(!h.calls.some(call => call.handsFree));
  await h.manager.startByUser(); assert.equal(h.saved.get(preferenceKey), 'on');
  h.manager.stopByUser(); assert.equal(h.saved.get(preferenceKey), 'off');
  h.manager.destroy();
});
test('autoplay blocking falls back to a gesture and never loops automatically', async () => {
  const h = fixture({ start: async function (options) {
    if (options.automatic) { this.state = 'OFF'; this.lastStartError = { code: 'VOICE_GESTURE_REQUIRED' }; return false; }
    this.lastStartError = null; this.state = 'WAIT_WAKE'; return true;
  } });
  h.manager.install(); await tick();
  assert.equal(h.manager.awaitingGesture, true); assert.equal(h.controller.state, 'OFF');
  h.document.dispatchEvent(new Event('pointerdown')); await tick();
  assert.equal(h.controller.state, 'WAIT_WAKE');
  assert.equal(h.calls.filter(call => call.handsFree).length, 2);
  h.manager.destroy();
});
test('hidden page releases mic and visible page restores hands-free', async () => {
  const h = fixture(); h.manager.install(); await tick();
  h.document.hidden = true; h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.controller.state, 'OFF');
  h.document.hidden = false; h.document.dispatchEvent(new Event('visibilitychange')); await tick(); await tick();
  assert.equal(h.controller.state, 'WAIT_WAKE');
  h.manager.destroy();
});
test('permission denial does not repeatedly request microphone access', async () => {
  const h = fixture({ permission: 'denied' }); h.manager.install(); await tick();
  h.document.dispatchEvent(new Event('pointerdown')); await tick();
  assert.equal(h.manager.awaitingGesture, false); assert.ok(!h.calls.some(call => call.handsFree));
  h.manager.destroy();
});
test('pending permission check cannot undo an explicit stop', async () => {
  const h = fixture(); let release;
  h.manager.permission = () => new Promise(resolve => { release = resolve; });
  h.manager.install(); h.manager.stopByUser(); release('granted'); await tick();
  assert.equal(h.controller.state, 'OFF'); assert.ok(!h.calls.some(call => call.handsFree));
  h.manager.destroy();
});
test('permission changes restore listening when granted and stop capture when revoked', async () => {
  const h = fixture(); const status = new EventTarget(); status.state = 'prompt';
  h.manager.permission = async () => status;
  h.manager.install(); await tick(); assert.equal(h.manager.awaitingGesture, true);
  status.state = 'granted'; status.dispatchEvent(new Event('change')); await tick(); await tick();
  assert.equal(h.controller.state, 'WAIT_WAKE');
  status.state = 'denied'; status.dispatchEvent(new Event('change'));
  assert.equal(h.controller.state, 'OFF'); assert.equal(h.manager.awaitingGesture, false);
  h.manager.destroy();
});

test('local classifier does not inherit old wake-word opt-in or start listening by default', async () => {
  const h = fixture({ preference: null }); h.manager.install(); await tick();
  assert.equal(h.controller.state, 'OFF'); assert.equal(h.manager.enabled, false);
  h.document.dispatchEvent(new Event('pointerdown')); await tick();
  assert.equal(h.controller.state, 'OFF');
  await h.manager.startByUser(); assert.equal(h.controller.state, 'WAIT_WAKE');
  h.manager.destroy();
});
