'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { request } = require('node:http');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const express = require('express');
const { PostgresAuthStore } = require('../auth-store');
const { makeLoginAccount, installRoomLogin } = require('../room-login');

test('central PostgreSQL shares migrated credentials and sessions while an application is stopped',
    { skip: !process.env.TEST_DATABASE_URL }, async t => {
    const folder = await mkdtemp(path.join(tmpdir(), 'bimclub-db-auth-'));
    const accountFile = path.join(folder, 'login-account.json');
    const username = 'shared-admin', password = 'test-central-8';
    await writeFile(accountFile, JSON.stringify(await makeLoginAccount(username, password)));
    const stores = [], servers = [];
    let now = Date.now();
    const start = async file => {
        const store = new PostgresAuthStore({ connectionString: process.env.TEST_DATABASE_URL, accountFile: file });
        stores.push(store);
        const app = express();
        installRoomLogin(app, { store, now: () => now });
        const server = app.listen(0, '127.0.0.1');
        servers.push(server);
        await once(server, 'listening');
        return { store, server };
    };
    const call = (server, route, { cookie, credentials, origin = 'https://shared.example' } = {}) => new Promise((resolve, reject) => {
        const body = credentials ? new URLSearchParams(credentials).toString() : '';
        const headers = { Host: 'shared.example', Origin: origin };
        if (cookie) headers.Cookie = cookie;
        if (credentials) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            headers['Content-Length'] = Buffer.byteLength(body);
        }
        const req = request({ hostname: '127.0.0.1', port: server.address().port, path: route,
            method: credentials || route === '/logout' ? 'POST' : 'GET', headers }, response => {
            const chunks = [];
            response.on('data', data => chunks.push(data));
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(),
                cookie: response.headers['set-cookie']?.[0]?.split(';')[0] }));
        });
        req.on('error', reject); req.end(body);
    });
    try {
        const [windows, mac] = await Promise.all([start(accountFile), start(path.join(folder, 'absent.json'))]);
        await Promise.all(stores.map(store => store.initialize()));
        assert.equal((await mac.store.getAccount()).username, username);
        assert.equal((await call(mac.server, '/login')).status, 200);
        const signed = await call(windows.server, '/login', { credentials: { username, password } });
        assert.equal(signed.status, 303);
        assert.equal((await call(mac.server, '/api/auth/session', { cookie: signed.cookie })).status, 204);
        assert.equal((await call(mac.server, '/logout', { cookie: signed.cookie, origin: 'https://other.example' })).status, 403);
        await call(mac.server, '/logout', { cookie: signed.cookie });
        assert.equal((await call(windows.server, '/api/auth/session', { cookie: signed.cookie })).status, 401);

        const again = await call(windows.server, '/login', { credentials: { username, password } });
        windows.server.closeAllConnections();
        await new Promise(resolve => windows.server.close(resolve));
        await windows.store.close();
        assert.equal((await call(mac.server, '/api/auth/session', { cookie: again.cookie })).status, 204);
        const restarted = await start(path.join(folder, 'also-absent.json'));
        assert.equal((await call(restarted.server, '/api/auth/session', { cookie: again.cookie })).status, 204);
        await assert.rejects(mac.store.saveAccount(await makeLoginAccount('another', 'another-8'), false),
            { code: 'ACCOUNT_EXISTS' });

        await mac.store.saveAccount(await makeLoginAccount(username, 'changed-pass-8'), true);
        assert.equal((await call(restarted.server, '/api/auth/session', { cookie: again.cookie })).status, 401);
        assert.equal((await call(mac.server, '/login', { credentials: { username, password } })).status, 401);
        const renewed = await call(mac.server, '/login', { credentials: { username, password: 'changed-pass-8' } });
        assert.equal(renewed.status, 303);
        now += 12 * 60 * 60 * 1000;
        assert.equal((await call(restarted.server, '/api/auth/session', { cookie: renewed.cookie })).status, 401);
        await restarted.store.close();
        const unavailable = await call(restarted.server, '/login');
        assert.equal(unavailable.status, 503);
        assert.match(unavailable.body, /ฐานข้อมูล/);
        assert.doesNotMatch(unavailable.body, /ตั้งบัญชีผู้ดูแล/);
    } finally {
        for (const server of servers) server.closeAllConnections();
        await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
        await Promise.allSettled(stores.map(store => store.close()));
        await rm(folder, { recursive: true, force: true });
    }
});
