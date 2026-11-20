'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/js/room-camera.js'), 'utf8');
const playlist = '/camera/classroom/index.m3u8';
const flush = () => new Promise(resolve => setImmediate(resolve));

function player({ native = false } = {}) {
    const button = new EventTarget();
    const status = { hidden: true, textContent: '' };
    const video = new EventTarget();
    const window = new EventTarget();
    const scripts = [];
    const timers = new Map();
    let plays = 0;
    let nextTimer = 0;
    button.setAttribute = (_name, value) => { button.expanded = value; };
    video.hidden = true;
    video.canPlayType = () => native ? 'maybe' : '';
    video.play = async () => { plays++; };
    video.pause = () => {};
    video.removeAttribute = name => { delete video[name]; };
    video.load = () => {};
    const elements = { 'camera-toggle': button, 'camera-status': status, 'camera-video': video };
    runInNewContext(script, {
        window,
        document: {
            getElementById: id => elements[id],
            createElement: () => ({ remove() {} }),
            head: { append: node => scripts.push(node) }
        },
        setTimeout: handler => { timers.set(++nextTimer, handler); return nextTimer; },
        clearTimeout: timer => timers.delete(timer)
    });
    return { button, status, video, window, scripts, timers, plays: () => plays,
        click: () => button.dispatchEvent(new Event('click')) };
}

test('native playback starts on request and closing or leaving releases the camera', () => {
    const h = player({ native: true });
    assert.equal(h.video.src, undefined);
    h.click();
    assert.equal(h.video.src, playlist);
    assert.equal(h.video.hidden, false);
    assert.equal(h.video.muted, true);
    assert.equal(h.plays(), 1);
    assert.equal(h.timers.size, 1);

    h.video.dispatchEvent(new Event('playing'));
    assert.equal(h.timers.size, 0);
    assert.equal(h.status.textContent, 'กำลังแสดงภาพสด');
    h.window.dispatchEvent(new Event('pagehide'));
    assert.equal(h.video.src, undefined);
    assert.equal(h.video.hidden, true);
    assert.equal(h.button.expanded, 'false');
});

test('HLS is loaded only when needed and a pending load does not reopen a closed viewer', async () => {
    const h = player();
    assert.deepEqual(h.scripts, []);
    h.click();
    assert.equal(h.scripts[0].src, '/vendor/hls.min.js');
    h.click();

    const instances = [];
    h.window.Hls = class {
        static isSupported() { return true; }
        static Events = { MANIFEST_PARSED: 'parsed', ERROR: 'error' };
        handlers = {};
        constructor() { instances.push(this); }
        on(name, callback) { this.handlers[name] = callback; }
        loadSource(url) { this.source = url; }
        attachMedia(video) { this.video = video; }
        destroy() { this.destroyed = true; }
    };
    h.scripts[0].onload();
    await flush();
    assert.equal(instances.length, 0);
    h.click();
    await flush();
    assert.equal(instances[0].source, playlist);
    instances[0].handlers.parsed();
    assert.equal(h.plays(), 1);
    instances[0].handlers.error('error', { fatal: true, response: { code: 401 } });
    assert.equal(instances[0].destroyed, true);
    assert.equal(h.video.hidden, true);
    assert.match(h.status.textContent, /เข้าสู่ระบบใหม่/);
});
