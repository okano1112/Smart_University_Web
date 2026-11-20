'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, writeFile, unlink, rmdir } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAuthStore } = require('../auth-store');
const { installRoomLogin, makeLoginAccount } = require('../room-login');
const { createCameraRouter } = require('../camera-route');

const username = 'camera-test';
const password = 'local-test-secret';

async function listen(t, server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    return server.address().port;
}

async function fixture(t, handler, timeoutMs = 3_000) {
    const upstreamPort = await listen(t, createServer(handler));
    const directory = await mkdtemp(path.join(tmpdir(), 'bimclub-camera-test-'));
    const accountFile = path.join(directory, 'login.json');
    await writeFile(accountFile, JSON.stringify(await makeLoginAccount(username, password)), { mode: 0o600 });
    t.after(async () => {
        await unlink(accountFile);
        await rmdir(directory);
    });
    const app = express();
    const store = createAuthStore({ accountFile, mode: 'file' });
    installRoomLogin(app, { store });
    app.use('/camera/classroom', createCameraRouter({ port: upstreamPort, timeoutMs }));
    const port = await listen(t, createServer(app));
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/login`, {
        method: 'POST', headers: { Origin: origin }, redirect: 'manual',
        body: new URLSearchParams({ username, password })
    });
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie').split(';', 1)[0];
    const camera = (file, options = {}) => fetch(`${origin}/camera/classroom/${file}`, {
        ...options, headers: { Cookie: cookie, ...options.headers }
    });
    return { camera, origin };
}

test('camera requires a session and serves a private playlist and byte-range media', async t => {
    const mediaSession = '9bd33060-bc51-4efe-82eb-1574ef806782';
    const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:2\nsegment_001.mp4?session=${mediaSession}\n`;
    const calls = [];
    const { camera, origin } = await fixture(t, (req, res) => {
        calls.push({ path: req.url, method: req.method, headers: req.headers });
        if (req.url.startsWith('/classroom/index.m3u8')) {
            res.setHeader('Content-Type', 'text/html');
            res.setHeader('Set-Cookie', 'upstream-fixture=1');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(playlist);
        } else {
            res.writeHead(206, { 'Content-Length': '2', 'Content-Range': 'bytes 1-2/4', 'Accept-Ranges': 'bytes' });
            res.end(Buffer.from([8, 9]));
        }
    });

    for (const file of ['index.m3u8', 'segment_001.mp4']) {
        const anonymous = await fetch(`${origin}/camera/classroom/${file}`);
        assert.equal(anonymous.status, 401);
        assert.match(anonymous.headers.get('cache-control'), /private.*no-store/);
    }
    assert.equal(calls.length, 0);

    const response = await camera(`index.m3u8?session=${mediaSession}&_HLS_msn=12&_HLS_part=1&_HLS_skip=YES&discard=true`, {
        headers: { Authorization: 'Basic not-for-upstream', 'Sec-Fetch-Site': 'same-origin' }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(await response.text(), playlist);
    assert.equal(calls[0].path, `/classroom/index.m3u8?cookieCheck=1&session=${mediaSession}&_HLS_msn=12&_HLS_part=1&_HLS_skip=YES`);
    assert.equal(calls[0].headers.authorization, undefined);
    assert.equal(calls[0].headers.cookie, undefined);

    const segment = await camera(`segment_001.mp4?session=${mediaSession}&_HLS_msn=12`, { headers: { Range: 'bytes=1-2' } });
    assert.equal(segment.status, 206);
    assert.equal(segment.headers.get('content-type'), 'video/mp4');
    assert.equal(segment.headers.get('content-range'), 'bytes 1-2/4');
    assert.equal(segment.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await segment.arrayBuffer()), Buffer.from([8, 9]));
    assert.equal(calls[1].headers.range, 'bytes=1-2');
    assert.equal(calls[1].path, `/classroom/segment_001.mp4?session=${mediaSession}`);
    const head = await camera('segment_001.mp4?session=invalid', { method: 'HEAD' });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), '2');
    assert.equal(await head.text(), '');
    assert.equal(calls[2].method, 'GET');
    assert.equal(calls[2].path, '/classroom/segment_001.mp4');
});

test('camera confines media paths and suppresses upstream redirects and error details', async t => {
    const calls = [];
    const { camera } = await fixture(t, (req, res) => {
        calls.push(req.url);
        if (req.url === '/classroom/index.m3u8?cookieCheck=1') res.writeHead(302, { Location: 'http://example.invalid/resource' });
        else res.writeHead(404);
        res.end('private upstream detail');
    });
    assert.equal((await camera('api.json')).status, 404);
    assert.equal((await camera('other%2Findex.m3u8')).status, 404);
    assert.equal((await camera('index.m3u8', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal(calls.length, 0);

    const redirect = await camera('index.m3u8');
    assert.equal(redirect.status, 503);
    assert.equal(redirect.headers.get('location'), null);
    assert.doesNotMatch(await redirect.text(), /private upstream detail/);
    const missing = await camera('missing.m4s');
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /private upstream detail/);
});

test('camera master playlist uses the MediaMTX query-session mode without forwarding cookies', async t => {
    const mediaSession = '9bd33060-bc51-4efe-82eb-1574ef806782';
    const calls = [];
    const { camera } = await fixture(t, (req, res) => {
        calls.push(req.url);
        if (req.url === '/classroom/index.m3u8') {
            return res.writeHead(302, { Location: '/classroom/index.m3u8?cookieCheck=1' }).end();
        }
        res.end(`#EXTM3U\nvideo1_stream.m3u8?session=${mediaSession}\n`);
    });

    const master = await camera('index.m3u8?cookieCheck=client-value', { redirect: 'manual' });
    assert.equal(master.status, 200);
    assert.equal((await master.text()).trim().split('\n').at(-1), `video1_stream.m3u8?session=${mediaSession}`);
    const variant = await camera(`video1_stream.m3u8?session=${mediaSession}&cookieCheck=1`);
    assert.equal(variant.status, 200);
    await variant.text();
    assert.deepEqual(calls, ['/classroom/index.m3u8?cookieCheck=1', `/classroom/video1_stream.m3u8?session=${mediaSession}`]);
});

test('camera cancels upstream I/O on timeout and viewer disconnect', async t => {
    const observed = [];
    const { camera } = await fixture(t, (_req, res) => {
        observed.push(once(res, 'close'));
    }, 400);
    const timeout = await camera('index.m3u8');
    assert.equal(timeout.status, 504);
    await observed[0];

    const controller = new AbortController();
    const result = assert.rejects(camera('index.m3u8', { signal: controller.signal }), { name: 'AbortError' });
    for (let elapsed = 0; observed.length < 2 && elapsed < 1_000; elapsed += 10) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observed.length, 2);
    controller.abort();
    await result;
    await observed[1];
});
