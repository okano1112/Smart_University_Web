'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { request: requestHttp } = require('node:http');
const express = require('express');
const { makeLoginAccount, installRoomLogin } = require('../room-login');

test('login closes application routes and checks credentials, origin, expiry and logout', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bimclub-login-'));
    const accountFile = path.join(directory, 'login.json');
    process.env.BIMCLUB_LOGIN_ACCOUNT_FILE = accountFile;
    const { app } = require('../server');
    let now = Date.now();
    const timedApp = express();
    installRoomLogin(timedApp, { accountFile, now: () => now });
    const http = app.listen(0, '127.0.0.1'), timed = timedApp.listen(0, '127.0.0.1');
    const servers = [http, timed];
    await Promise.all(servers.map(server => once(server, 'listening')));
    const base = 'http://127.0.0.1:' + http.address().port, timedBase = 'http://127.0.0.1:' + timed.address().port;
    const username = 'integration-user', password = 'qa-8xQ!7';
    const request = (route, options, host = base) => fetch(host + route, { ...options, redirect: 'manual' });
    const signin = (params, options = {}, host = base) => request('/login', {
        method: 'POST', body: new URLSearchParams(params), ...options, headers: { Origin: host, ...options.headers }
    }, host);
    try {
        const redirect = await request('/');
        assert.equal(redirect.status, 303);
        assert.equal(redirect.headers.get('location'), '/login');
        assert.equal((await request('/login')).status, 503);
        assert.equal((await request('/login.css')).status, 200);
        assert.equal((await request('/api/auth/session')).status, 401);
        for (const target of ['/api/schedules', '/api/cira/logs', '/js/dashboard.js', '/audio/voice/wake-ready.wav',
            '/vendor/mqtt.min.js', '/vad-web/silero_vad.onnx', '/ort/ort.min.js', '/ort/ort.wasm.min.js',
            '/ort/ort-wasm-simd-threaded.wasm', '/data/login-account.json']) {
            assert.equal((await request(target)).status, 401, target);
        }
        for (const [method, target] of [['POST', '/api/voice-command'], ['POST', '/api/voice-session'],
            ['POST', '/api/schedules'], ['PATCH', '/api/schedules/unknown'], ['DELETE', '/api/schedules/unknown'],
            ['POST', '/api/comfort/recommendation'], ['POST', '/api/cooling-forecast']]) {
            assert.equal((await request(target, { method })).status, 401, target);
        }

        await assert.rejects(makeLoginAccount(username, password.slice(0, -1)), /8 ตัวขึ้นไป/);
        const account = await makeLoginAccount(username, password);
        assert.equal(Object.hasOwn(account, 'password'), false);
        assert.notEqual(account.hash, password);
        await writeFile(accountFile, JSON.stringify(account), { mode: 0o600 });
        assert.equal((await request('/login')).status, 200);
        assert.equal((await signin({ username, password }, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
        const rejected = await signin({ username, password: 'wrong-example-only' });
        assert.equal(rejected.status, 401);
        assert.match(await rejected.text(), /ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง/);

        const authenticated = await signin({ username, password });
        assert.equal(authenticated.status, 303);
        assert.equal(authenticated.headers.get('location'), '/');
        const header = authenticated.headers.get('set-cookie');
        assert.match(header, /HttpOnly/);
        assert.match(header, /SameSite=Lax/);
        assert.doesNotMatch(header, /; Secure/);
        const cookie = { Cookie: header.split(';')[0] };
        const dashboard = await request('/', { headers: cookie });
        assert.equal(dashboard.status, 200);
        assert.match(await dashboard.text(), /ห้องประชุม BimClub/);
        assert.match(dashboard.headers.get('cache-control'), /no-store/);
        assert.equal((await request('/js/dashboard.js', { headers: cookie })).status, 200);
        assert.equal((await request('/data/login-account.json', { headers: cookie })).status, 404);
        const session = await request('/api/auth/session', { headers: cookie });
        assert.equal(session.status, 204);
        assert.match(session.headers.get('cache-control'), /no-store/);
        const wasmPath = '/ort/ort-wasm-simd-threaded.wasm';
        const asset = await request(wasmPath, { headers: { ...cookie, 'Accept-Encoding': 'gzip' } });
        assert.equal(asset.status, 200);
        assert.equal(asset.headers.get('content-type'), 'application/wasm');
        assert.equal(asset.headers.get('content-encoding'), 'gzip');
        assert.equal(asset.headers.get('cache-control'), 'private, no-cache');
        assert.equal(asset.headers.get('cloudflare-cdn-cache-control'), 'no-store');
        assert.match(asset.headers.get('vary'), /Accept-Encoding/i);
        const wasm = Buffer.from(await asset.arrayBuffer());
        assert.equal(wasm.subarray(0, 4).toString('ascii'), '\0asm');
        assert.ok(Number(asset.headers.get('content-length')) < wasm.length / 2);
        const ranged = await request(wasmPath, { headers: { ...cookie, Range: 'bytes=0-3', 'Accept-Encoding': 'gzip' } });
        assert.equal(ranged.status, 206);
        assert.equal(ranged.headers.get('content-encoding'), null);
        assert.equal(ranged.headers.get('content-range'), `bytes 0-3/${wasm.length}`);
        assert.equal(Buffer.from(await ranged.arrayBuffer()).toString('ascii'), '\0asm');
        const assetEtag = asset.headers.get('etag');
        assert.ok(assetEtag);
        const revalidated = await new Promise((resolve, reject) => {
            const req = requestHttp(base + wasmPath, { method: 'HEAD', headers: {
                ...cookie, 'Accept-Encoding': 'gzip', 'If-None-Match': assetEtag
            } }, res => { res.resume(); resolve(res); });
            req.once('error', reject);
            req.end();
        });
        assert.equal(revalidated.statusCode, 304);
        assert.equal(revalidated.headers['cache-control'], 'private, no-cache');
        assert.equal(revalidated.headers['cloudflare-cdn-cache-control'], 'no-store');
        assert.equal((await request('/api/schedules', { method: 'POST', headers: cookie })).status, 403);
        const blocked = await request('/api/schedules', { method: 'POST', headers: { ...cookie, Origin: 'https://untrusted.example' } });
        assert.equal(blocked.status, 403);
        assert.equal(blocked.headers.get('access-control-allow-origin'), null);

        const form = new URLSearchParams({ username, password }).toString();
        const fromTunnel = await new Promise((resolve, reject) => {
            // Native fetch controls the Host header. A tunnel preserves the
            // public host across the local HTTP hop, so simulate it directly.
            const req = requestHttp(base + '/login', { method: 'POST', headers: {
                Host: 'room.example.net', Origin: 'https://room.example.net', 'Content-Length': Buffer.byteLength(form),
                'Content-Type': 'application/x-www-form-urlencoded'
            } }, res => { res.resume(); resolve(res); });
            req.once('error', reject);
            req.end(form);
        });
        assert.equal(fromTunnel.statusCode, 303);
        assert.match(fromTunnel.headers['set-cookie'][0], /^__Host-bimclub_session=.+; Path=\/;.+; Secure;/);
        const logOut = await request('/logout', { method: 'POST', headers: { ...cookie, Origin: base } });
        assert.equal(logOut.status, 303);
        assert.equal(logOut.headers.get('location'), '/login');
        assert.match(logOut.headers.get('set-cookie'), /^bimclub_session=;/);
        assert.equal((await request('/api/auth/session', { headers: cookie })).status, 401);
        assert.equal((await request(wasmPath, { headers: { ...cookie, 'If-None-Match': assetEtag } })).status, 401);

        const timedLogin = await signin({ username, password }, {}, timedBase);
        assert.equal(timedLogin.status, 303);
        const expired = { Cookie: timedLogin.headers.get('set-cookie').split(';')[0] };
        assert.equal((await request('/api/auth/session', { headers: expired }, timedBase)).status, 204);
        now += 12 * 60 * 60 * 1000;
        assert.equal((await request('/api/auth/session', { headers: expired }, timedBase)).status, 401);
        for (let i = 0; i < 10; i++) assert.equal((await signin({ password }, {}, timedBase)).status, 401);
        const throttled = await signin({ username, password }, {}, timedBase);
        assert.equal(throttled.status, 429);
        assert.ok(Number(throttled.headers.get('retry-after')) > 0);
    } finally {
        for (const server of servers) server.closeAllConnections();
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
        await rm(directory, { recursive: true, force: true });
    }
});
