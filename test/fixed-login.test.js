'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const express = require('express');
const { createAuthStore, FixedAuthStore, FileAuthStore } = require('../auth-store');
const { installRoomLogin } = require('../room-login');

test('preset account is ready without files or a database, even with old database configuration', async () => {
    const previous = { ...process.env };
    try {
        delete process.env.BIMCLUB_AUTH_MODE;
        process.env.DATABASE_URL = 'postgresql://invalid.example/unused';
        process.env.BIMCLUB_REQUIRE_DATABASE = '1';
        process.env.BIMCLUB_LOGIN_ACCOUNT_FILE = '/unused/legacy-account.json';
        const store = createAuthStore();
        const account = await store.getAccount();
        assert.ok(store instanceof FixedAuthStore);
        assert.equal(store.storage, 'fixed');
        assert.equal(account.username, 'adminbim');
        assert.equal(Object.hasOwn(account, 'password'), false);
        assert.equal(Object.isFrozen(account), true);
        assert.match(account.hash, /^[a-f0-9]{64}$/);
        assert.deepEqual(await createAuthStore().getAccount(), account);
        assert.equal(createAuthStore({ accountFile: process.env.BIMCLUB_LOGIN_ACCOUNT_FILE }).storage, 'fixed');
        const explicitFile = createAuthStore({ mode: 'file', accountFile: '/unused/account.json' });
        assert.ok(explicitFile instanceof FileAuthStore);
        assert.equal(await explicitFile.getAccount(), null);
        assert.throws(() => createAuthStore({ mode: 'postgres', connectionString: '' }), /DATABASE_URL/);
        assert.throws(() => createAuthStore({ mode: 'unknown' }), /BIMCLUB_AUTH_MODE/);
    } finally {
        process.env = previous;
    }
});

test('preset login keeps routes protected and sessions local to each running server', async () => {
    const app = express();
    const store = new FixedAuthStore();
    installRoomLogin(app, { store });
    app.get('/', (_req, res) => res.send('private dashboard'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = (route, options = {}) => fetch(base + route, { ...options, redirect: 'manual' });
    try {
        const page = await request('/login');
        assert.equal(page.status, 200);
        assert.doesNotMatch(await page.text(), /ยังไม่ได้ตั้งบัญชี/);
        assert.equal((await request('/')).status, 303);
        assert.equal((await request('/api/auth/session')).status, 401);
        const rejected = await request('/login', { method: 'POST', headers: { Origin: base },
            body: new URLSearchParams({ username: 'adminbim', password: 'incorrect-test-password' }) });
        assert.equal(rejected.status, 401);
        const token = randomBytes(32).toString('base64url');
        const key = createHash('sha256').update(token).digest('hex');
        const account = await store.getAccount();
        const now = Date.now();
        assert.equal(await store.createSession(key, { origin: base, expiresAt: now + 60000 }, account.hash, now), true);
        assert.equal(await new FixedAuthStore().findSession(key, base, now), null);
        const headers = { Cookie: 'bimclub_session=' + token };
        assert.equal((await request('/api/auth/session', { headers })).status, 204);
        assert.equal((await request('/', { headers })).status, 200);
        const logout = await request('/logout', { method: 'POST', headers: { ...headers, Origin: base } });
        assert.equal(logout.status, 303);
        assert.equal((await request('/api/auth/session', { headers })).status, 401);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('default account check and setup finish without prompts or database access', async () => {
    const env = { ...process.env, DATABASE_URL: 'postgresql://invalid.example/unused', BIMCLUB_REQUIRE_DATABASE: '1' };
    delete env.BIMCLUB_AUTH_MODE;
    delete env.BIMCLUB_LOGIN_ACCOUNT_FILE;
    const execute = promisify(execFile);
    const checked = await execute(process.execPath, ['scripts/check-login.js'], { env, timeout: 5000 });
    assert.deepEqual(JSON.parse(checked.stdout), { storage: 'fixed', accountReady: true });
    const setup = await execute(process.execPath, ['scripts/setup-login.js'], { env, timeout: 5000 });
    assert.match(setup.stdout, /adminbim พร้อมใช้งานแล้ว/);
});
