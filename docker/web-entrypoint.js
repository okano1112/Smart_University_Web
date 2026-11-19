'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

function createRelay(targetPort, targetHost = '127.0.0.1') {
    return net.createServer(client => {
        const upstream = net.connect({ port: targetPort, host: targetHost });
        const close = () => { client.destroy(); upstream.destroy(); };
        client.on('error', close);
        upstream.on('error', close);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
    });
}

function importData(directory, seedDirectory) {
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ['login-account.json', 'ac-schedules.json']) {
        const source = path.join(seedDirectory, name);
        const destination = path.join(directory, name);
        if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
        // Complete each copy before publishing it. An existing Docker volume
        // always takes precedence over an old deployment bundle.
        const temporary = path.join(directory, '.' + name + '.import');
        fs.copyFileSync(source, temporary);
        try {
            JSON.parse(fs.readFileSync(temporary, 'utf8'));
            try { fs.linkSync(temporary, destination); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { fs.rmSync(temporary, { force: true }); }
    }
}

function run({
    script = path.join(__dirname, '../server.js'),
    dataDirectory = path.join(__dirname, '../data'),
    seedDirectory = '/seed/web',
    httpPort = 3000,
    appPort = 3001,
    nodeRedPort = 1880,
    nodeRedRelayPort = 1881
} = {}) {
    importData(dataDirectory, seedDirectory);
    const relays = [createRelay(appPort), createRelay(nodeRedPort)];
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, PORT: String(appPort) } });
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        for (const relay of relays) relay.close();
        child.kill('SIGTERM');
    };
    relays.forEach((relay, index) => {
        relay.on('error', error => { console.error('[Docker] ' + error.message); stop(); });
        relay.listen(index === 0 ? httpPort : nodeRedRelayPort, '0.0.0.0');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
    child.on('error', error => { console.error('[Docker] ' + error.message); stop(); process.exit(1); });
    child.on('exit', (code, signal) => {
        stop();
        process.exit(code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1));
    });
    return { child, relays, stop };
}

if (require.main === module) run();
module.exports = { createRelay, importData, run };
