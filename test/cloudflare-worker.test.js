'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { request: requestHttp } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const express = require('express');
const { installRoomLogin, makeLoginAccount } = require('../room-login');

const publicOrigin = 'https://bimclub-room.example.workers.dev';
const workerModule = import('../cloudflare/worker.mjs');

async function relayToLocal(port, request, body) {
    const target = new URL(request.url);
    const headers = { ...Object.fromEntries(request.headers), host: target.host };
    if (body) headers['content-length'] = Buffer.byteLength(body);
    return new Promise((resolve, reject) => {
        // A VPC binding dials the private target but uses the Request URL as Host.
        const outgoing = requestHttp({ hostname: '127.0.0.1', port, path: target.pathname + target.search,
            method: request.method, headers }, async incoming => {
            try {
                const chunks = [];
                for await (const chunk of incoming) chunks.push(chunk);
                const responseHeaders = new Headers();
                for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
                    responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
                }
                resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, {
                    status: incoming.statusCode, headers: responseHeaders
                }));
            } catch (error) { reject(error); }
        });
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}

test('Worker proxy preserves public same-origin login, secure cookie, redirect and authenticated session', async t => {
    const { default: worker } = await workerModule;
    const directory = await mkdtemp(path.join(tmpdir(), 'bimclub-worker-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const accountFile = path.join(directory, 'login.json');
    const form = new URLSearchParams({ username: 'worker-qa', password: 'test-passphrase' });
    await writeFile(accountFile, JSON.stringify(await makeLoginAccount(form.get('username'), form.get('password'))));
    const app = express();
    installRoomLogin(app, { accountFile });
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, 'listening');

    const forwarded = [];
    const env = { BIMCLUB_ORIGIN: { async fetch(request, options) {
        const body = request.body ? await request.text() : undefined;
        forwarded.push({ request, body, redirect: options?.redirect ?? request.redirect });
        return relayToLocal(server.address().port, request, body);
    } } };
    const proxy = (pathname, options) => worker.fetch(new Request(publicOrigin + pathname, options), env);

    const guest = await proxy('/');
    assert.equal(guest.status, 303);
    assert.equal(guest.headers.get('Location'), '/login');

    const login = await proxy('/login?source=worker', {
        method: 'POST', body: form, headers: { Origin: publicOrigin, 'Sec-Fetch-Site': 'same-origin' }
    });
    const [{ redirect: guestRedirect }, { request, body, redirect }] = forwarded;
    assert.equal(guestRedirect, 'manual');
    assert.equal(redirect, 'manual');
    assert.equal(request.url, 'http://bimclub-room.example.workers.dev/login?source=worker');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Origin'), publicOrigin);
    assert.equal(body, form.toString());
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('Location'), '/');
    const cookie = login.headers.get('Set-Cookie');
    assert.match(cookie, /^__Host-bimclub_session=.+; Path=\/;.+; HttpOnly; Secure; SameSite=Lax$/);
    assert.match(login.headers.get('Cache-Control'), /no-store/);

    const sessionCookie = cookie.split(';')[0];
    const session = await proxy('/api/auth/session', { headers: { Cookie: sessionCookie } });
    assert.equal(forwarded.at(-1).request.headers.get('Cookie'), sessionCookie);
    assert.equal(session.status, 204);
});

test('Worker returns an uncached failure when the tunnel is down and retains the app’s own 503', async () => {
    const { default: worker } = await workerModule;
    const request = new Request(publicOrigin + '/api/voice-session', { method: 'POST' });
    const unavailable = await worker.fetch(request, { BIMCLUB_ORIGIN: { async fetch() {
        throw new Error('connector unavailable');
    } } });
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.headers.get('Cache-Control'), /no-store/);
    assert.match(unavailable.headers.get('Content-Type'), /application\/json/);

    const modelFailure = { success: false, message: 'Local model is loading' };
    const fromApp = await worker.fetch(request, { BIMCLUB_ORIGIN: { async fetch() {
        return Response.json(modelFailure, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
    } } });
    assert.equal(fromApp.status, 503);
    assert.deepEqual(await fromApp.json(), modelFailure);
});
