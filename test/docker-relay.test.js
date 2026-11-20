'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { request: requestHttp } = require('node:http');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const readline = require('node:readline');
const { tmpdir } = require('node:os');
const path = require('node:path');
const express = require('express');
const { makeLoginAccount, installRoomLogin } = require('../room-login');
const { createRelay, importData } = require('../docker/web-entrypoint');

async function listen(server, port = 0) {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

async function close(server) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
}

function request(port, pathname, headers = {}, body) {
    return new Promise((resolve, reject) => {
        const req = requestHttp({ hostname: '127.0.0.1', port, path: pathname,
            method: body ? 'POST' : 'GET', headers: { Connection: 'close', ...headers } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        // Send more than one chunk so uploads exercise both directions while streaming.
        if (body) for (let offset = 0; offset < body.length; offset += 8192) req.write(body.subarray(offset, offset + 8192));
        req.end();
    });
}

test('Docker relay preserves HTTP localhost login, public Host cookies, origin checks and binary uploads', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bimclub-docker-relay-'));
    const accountFile = path.join(directory, 'account.json');
    const username = 'relay-test';
    const password = 'relay-test-password';
    await writeFile(accountFile, JSON.stringify(await makeLoginAccount(username, password)), { mode: 0o600 });
    const app = express();
    installRoomLogin(app, { accountFile });
    app.post('/echo', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
        res.set({ 'X-Upstream-Peer': req.socket.remoteAddress, 'X-Observed-Host': req.get('host') });
        res.type('application/octet-stream').send(req.body);
    });
    const upstream = app.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const relay = createRelay(upstream.address().port);
    const port = await listen(relay);
    const host = `127.0.0.1:${port}`;
    const form = Buffer.from(new URLSearchParams({ username, password }).toString());
    const localHeaders = { Host: host, Origin: `http://${host}`,
        'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': form.length };
    try {
        const local = await request(port, '/login', localHeaders, form);
        assert.equal(local.status, 303);
        const localCookie = local.headers['set-cookie'][0];
        assert.match(localCookie, /^bimclub_session=/);
        assert.doesNotMatch(localCookie, /; Secure/);

        const boundary = 'docker-relay-binary-boundary';
        const bytes = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
            randomBytes(256 * 1024), Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);
        const echoHeaders = { Host: host, Origin: `http://${host}`, Cookie: localCookie.split(';')[0],
            'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bytes.length };
        const echoed = await request(port, '/echo', echoHeaders, bytes);
        assert.equal(echoed.status, 200);
        assert.equal(echoed.headers['x-upstream-peer'], '127.0.0.1');
        assert.equal(echoed.headers['x-observed-host'], host);
        assert.deepEqual(echoed.body, bytes);
        assert.equal((await request(port, '/echo', { ...echoHeaders, Origin: 'https://other.example' }, bytes)).status, 403);

        const publicHost = 'bimclub-room.example.net';
        const publicLogin = await request(port, '/login', { ...localHeaders, Host: publicHost,
            Origin: `https://${publicHost}` }, form);
        assert.equal(publicLogin.status, 303);
        const publicCookie = publicLogin.headers['set-cookie'][0];
        assert.match(publicCookie, /^__Host-bimclub_session=/);
        assert.match(publicCookie, /; Secure/);
        const publicEcho = await request(port, '/echo', { ...echoHeaders, Host: publicHost,
            Origin: `https://${publicHost}`, Cookie: publicCookie.split(';')[0] }, bytes);
        assert.equal(publicEcho.status, 200);
        assert.equal(publicEcho.headers['x-observed-host'], publicHost);
        assert.deepEqual(publicEcho.body, bytes);
    } finally {
        upstream.closeAllConnections();
        await Promise.all([close(relay), close(upstream)]);
        await rm(directory, { recursive: true, force: true });
    }
});

test('a refused upstream closes its client and the same relay accepts later connections', async () => {
    const reservation = net.createServer();
    const targetPort = await listen(reservation);
    await close(reservation);
    const relay = createRelay(targetPort);
    const relayPort = await listen(relay);
    const target = net.createServer(socket => socket.pipe(socket));
    try {
        const refused = net.connect(relayPort, '127.0.0.1');
        refused.on('error', () => {});
        await once(refused, 'close', { signal: AbortSignal.timeout(2000) });
        assert.equal(relay.listening, true);
        await listen(target, targetPort);
        const payload = Buffer.from([0, 255, 13, 10, 128, 1]);
        const received = await new Promise((resolve, reject) => {
            const socket = net.connect(relayPort, '127.0.0.1');
            socket.on('error', reject);
            socket.on('data', chunk => { resolve(chunk); socket.destroy(); });
            socket.once('connect', () => socket.write(payload));
        });
        assert.deepEqual(received, payload);
    } finally { await Promise.all([close(relay), close(target)]); }
});

test('disconnecting either relay peer releases the other socket', async () => {
    let upstreamSocket;
    const target = net.createServer(socket => { upstreamSocket = socket; });
    const targetPort = await listen(target);
    const relay = createRelay(targetPort);
    const relayPort = await listen(relay);
    const clients = [];
    try {
        const firstConnection = once(target, 'connection');
        const first = net.connect(relayPort, '127.0.0.1');
        clients.push(first);
        first.on('error', () => {});
        await firstConnection;
        const firstClosed = once(first, 'close', { signal: AbortSignal.timeout(2000) });
        upstreamSocket.destroy();
        await firstClosed;

        const secondConnection = once(target, 'connection');
        const second = net.connect(relayPort, '127.0.0.1');
        clients.push(second);
        second.on('error', () => {});
        await secondConnection;
        const upstreamClosed = once(upstreamSocket, 'close', { signal: AbortSignal.timeout(2000) });
        second.destroy();
        await upstreamClosed;
    } finally {
        clients.forEach(client => client.destroy());
        upstreamSocket?.destroy();
        await Promise.all([close(relay), close(target)]);
    }
});

test('Docker data seeding preserves existing volume files and rejects incomplete JSON', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bimclub-docker-import-'));
    const data = path.join(directory, 'data');
    const seed = path.join(directory, 'seed');
    const occupancy = {
        version: 1,
        settings: { offWhenEmpty: false, onWhenOccupied: false, emptyDelayMinutes: 10 },
        destinationFingerprint: null
    };
    const occupancySeed = path.join(seed, 'ac-occupancy.json');
    const readOccupancy = () => JSON.parse(fs.readFileSync(path.join(data, 'ac-occupancy.json'), 'utf8'));
    fs.mkdirSync(seed);
    try {
        fs.writeFileSync(path.join(seed, 'login-account.json'), '{"version":1,"username":"original"}');
        fs.writeFileSync(occupancySeed, JSON.stringify(occupancy));
        importData(data, seed);
        assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'login-account.json'))).username, 'original');
        assert.deepEqual(readOccupancy(), occupancy);
        fs.writeFileSync(path.join(seed, 'login-account.json'), '{"version":1,"username":"old-backup"}');
        fs.writeFileSync(occupancySeed, JSON.stringify({
            ...occupancy, settings: { ...occupancy.settings, emptyDelayMinutes: 5 }
        }));
        importData(data, seed);
        assert.deepEqual(readOccupancy(), occupancy);

        fs.writeFileSync(path.join(seed, 'ac-schedules.json'), '{"items":[]');
        assert.throws(() => importData(data, seed), SyntaxError);
        assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'login-account.json'))).username, 'original');
        assert.equal(fs.existsSync(path.join(data, 'ac-schedules.json')), false);
        assert.deepEqual(fs.readdirSync(data).sort(), ['ac-occupancy.json', 'login-account.json']);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const termination of ['application exit', 'SIGTERM']) {
    test(`Docker supervisor releases relays after ${termination}`, { skip: process.platform === 'win32' && termination === 'SIGTERM' }, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'bimclub-docker-supervisor-'));
        const fixture = path.join(directory, 'server.cjs');
        const wrapper = path.join(directory, 'wrapper.cjs');
        const reservation = net.createServer();
        const appPort = await listen(reservation);
        await close(reservation);
        await writeFile(fixture, `
            const server = require('node:http').createServer((req, res) => {
                res.end('ready');
                if (req.url === '/exit') setTimeout(() => process.exit(23), 20);
            }).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('FIXTURE_READY'));
            process.once('SIGTERM', () => server.close(() => process.exit(0)));
        `);
        await writeFile(wrapper, `
            const {run} = require(${JSON.stringify(path.resolve(__dirname, '../docker/web-entrypoint'))});
            const instance = run(${JSON.stringify({ script: fixture, dataDirectory: path.join(directory, 'data'),
                seedDirectory: path.join(directory, 'seed'), appPort, httpPort: 0, nodeRedRelayPort: 0 })});
            instance.relays[0].once('listening', () => process.send({ port: instance.relays[0].address().port, appPid: instance.child.pid }));
        `);
        const supervisor = fork(wrapper, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const stdout = readline.createInterface({ input: supervisor.stdout });
        const exited = once(supervisor, 'exit');
        let appPid;
        const timeout = AbortSignal.timeout(5000);
        try {
            const ready = new Promise(resolve => stdout.on('line', line => { if (line === 'FIXTURE_READY') resolve(); }));
            const [message] = await once(supervisor, 'message', { signal: timeout });
            appPid = message.appPid;
            await Promise.race([ready, once(timeout, 'abort').then(() => { throw new Error('Fixture did not start'); })]);
            assert.equal((await request(message.port, '/')).status, 200);
            if (termination === 'application exit') await request(message.port, '/exit');
            else supervisor.kill('SIGTERM');
            const [code] = await Promise.race([exited, once(timeout, 'abort').then(() => { throw new Error('Supervisor did not stop'); })]);
            assert.equal(code, termination === 'application exit' ? 23 : 0);
            await assert.rejects(request(message.port, '/'), { code: 'ECONNREFUSED' });
        } finally {
            stdout.close();
            if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
            if (appPid) try { process.kill(appPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            await rm(directory, { recursive: true, force: true });
        }
    });
}
