'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { buildFlow } = require('./build-flow');
const { buildDht22Flow } = require('./build-dht22-flow');

function publishIfAbsent(file, contents) {
    const temporary = path.join(path.dirname(file), `.bimclub-seed-${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
        // Publish a complete file and preserve a concurrent writer's state.
        try { fs.linkSync(temporary, file); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { fs.rmSync(temporary, { force: true }); }
}

function initializeFlow(userDirectory, seedDirectory = '/seed/node-red') {
    fs.mkdirSync(userDirectory, { recursive: true });
    const flowFile = path.join(userDirectory, 'flows.json');
    if (fs.existsSync(flowFile)) return flowFile;

    const seedFlow = path.join(seedDirectory, 'flows.json');
    const hasSeed = fs.existsSync(seedFlow);
    const contents = hasSeed ? fs.readFileSync(seedFlow) : JSON.stringify([...buildFlow(), ...buildDht22Flow()], null, 2) + '\n';
    if (hasSeed) {
        // The runtime file keeps the key used for encrypted MQTT credentials.
        for (const name of ['flows_cred.json', '.config.runtime.json']) {
            const source = path.join(seedDirectory, name);
            if (fs.existsSync(source)) publishIfAbsent(path.join(userDirectory, name), fs.readFileSync(source));
        }
    }
    // The flow is published last so a stopped first launch can finish seeding.
    publishIfAbsent(flowFile, contents);
    return flowFile;
}

function main() {
    const userDirectory = path.resolve(process.env.NODE_RED_USER_DIR || '/data');
    initializeFlow(userDirectory);
    const executable = require.resolve('node-red/red.js', { paths: [process.cwd()] });
    const child = spawn(process.execPath, [executable, '--userDir', userDirectory,
        '--settings', path.join(__dirname, 'settings.js')], { stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    child.on('error', error => {
        console.error('[Node-RED] ' + error.message);
        process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
        process.exitCode = code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
    });
    return child;
}

if (require.main === module) {
    try { main(); }
    catch (error) { console.error('[Node-RED] ' + error.message); process.exitCode = 1; }
}

module.exports = { initializeFlow };
