'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Controller = require('../public/js/voice-controller');
const { wav } = require('../public/js/voice-audio');

function fixture(transcriptResponse) {
    const requests = [];
    const sent = [];
    const samples = Float32Array.from({ length: 16000 }, (_, index) => Math.sin(index / 20) * 0.1);
    const current = { power: true, temp: 24, mode: 0, fan: 3 };
    const audio = { start: async () => {}, close() {}, resetInput() {}, reply: async () => true };
    const localModel = {
        prepare() {}, close() {}, ready: true, canRecognize: () => true,
        recognize: async () => ['ปิดแอร์', 'ปิดแอร์ครับ']
    };
    const controller = new Controller({
        audio: () => audio,
        localModel: () => localModel,
        wav,
        id: () => 'request-client-handoff-1111',
        device: () => 'room-a',
        current: () => current,
        revision: () => 0,
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url === '/api/voice-transcript') return transcriptResponse();
            if (url === '/api/voice-command') {
                return Response.json({
                    requestId: options.body.get('requestId'), success: true,
                    nextState: { ...current, power: false },
                    feedback: { text: 'ปิดแอร์ครับ', clips: ['power-off'] }
                });
            }
            return Response.json({ sessionId: 'test-session' });
        },
        send: async state => { sent.push(state); return { demo: true }; },
        render() {}, log() {}, notice() {}
    });
    return { controller, requests, sent, samples };
}

async function openFollowUp(controller) {
    assert.equal(await controller.start(true), true);
    controller.wakeToken = 'test-wake-token';
    controller.followUp = true;
    controller.armPromise = Promise.resolve({ listeningMs: 9000 });
    controller.listen(controller.epoch);
}

for (const status of [401, 403, 410, 503]) {
    test(`transcript HTTP ${status} never replays the claimed command through PCM`, async () => {
        const h = fixture(() => Response.json({ message: 'Transcript unavailable' }, { status }));
        try {
            await openFollowUp(h.controller);
            await h.controller.onEnd(h.samples, h.controller.epoch);
            const transcriptRequests = h.requests.filter(request => request.url === '/api/voice-transcript');
            assert.equal(transcriptRequests.length, 1);
            const body = JSON.parse(transcriptRequests[0].options.body);
            assert.equal(body.stage, 'command');
            assert.equal(body.wakeToken, 'test-wake-token');
            assert.equal(h.requests.some(request => request.url === '/api/voice-command'), false);
            assert.equal(h.sent.length, 0);
            if (status === 410) {
                assert.equal(h.requests.filter(request => request.url === '/api/voice-session').length, 2);
                assert.equal(h.controller.state, 'WAIT_CONTINUOUS');
            }
        } finally { h.controller.stop(); }
    });
}

test('a malformed successful transcript response cannot replay the claimed command through PCM', async () => {
    const h = fixture(() => new Response('<html>Unexpected upstream response</html>', {
        headers: { 'Content-Type': 'text/html' }
    }));
    try {
        await openFollowUp(h.controller);
        await h.controller.onEnd(h.samples, h.controller.epoch);
        assert.equal(h.requests.filter(request => request.url === '/api/voice-transcript').length, 1);
        assert.equal(h.requests.some(request => request.url === '/api/voice-command'), false);
        assert.equal(h.sent.length, 0);
    } finally { h.controller.stop(); }
});

for (const reason of ['missing route', 'explicit decline']) {
    test(`a transcript ${reason} falls back with the original audio, request ID and wake ticket`, async () => {
        const h = fixture(() => reason === 'missing route'
            ? new Response('Not Found', { status: 404 })
            : Response.json({ useServer: true }));
        try {
            await openFollowUp(h.controller);
            await h.controller.onEnd(h.samples, h.controller.epoch);
            const inference = h.requests.filter(request =>
                request.url === '/api/voice-transcript' || request.url === '/api/voice-command');
            assert.deepEqual(inference.map(request => request.url), ['/api/voice-transcript', '/api/voice-command']);
            const transcript = JSON.parse(inference[0].options.body);
            const pcm = inference[1].options.body;
            assert.equal(pcm.get('requestId'), transcript.requestId);
            assert.equal(pcm.get('stage'), transcript.stage);
            assert.equal(pcm.get('wakeToken'), transcript.wakeToken);
            assert.deepEqual(await pcm.get('audio').arrayBuffer(), await wav(h.samples).arrayBuffer());
            assert.equal(h.sent.length, 1);
            assert.equal(h.sent[0].power, false);
        } finally { h.controller.stop(); }
    });
}

test('client activation creates its voice session before the model or detector is ready', async () => {
    const requests = [];
    let finishDetector;
    let preparing = false;
    const localModel = {
        ready: false,
        prepare() { preparing = true; return new Promise(() => {}); },
        close() {}
    };
    const controller = new Controller({
        localModel: () => localModel,
        audio: callbacks => ({
            start() {
                callbacks.onMicReady();
                return new Promise(resolve => { finishDetector = resolve; });
            },
            close() {}
        }),
        device: () => 'room-a',
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url === '/api/voice-session') {
                // A missing flag would take the server's Python readiness path.
                assert.equal(JSON.parse(options.body).browserRecognition, true);
            }
            return Response.json({ sessionId: 'client-session', engine: 'LOCAL_BROWSER' });
        },
        render() {}, log() {}, notice() {}
    });
    try {
        const started = controller.start(true);
        assert.equal(requests[0].url, '/api/voice-session');
        assert.equal(preparing, false);
        finishDetector();
        assert.equal(await started, true);
        assert.equal(preparing, true);
        assert.equal(localModel.ready, false);
        assert.equal(controller.state, 'WAIT_CONTINUOUS');
    } finally { controller.stop(); }
});
