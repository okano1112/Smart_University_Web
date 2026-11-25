'use strict';

const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { parse } = require('dotenv');

const root = path.join(__dirname, '..');
const sourceKey = 'MTX_PATHS_CLASSROOM_SOURCE';

function startCamera() {
    let source;
    try {
        source = parse(readFileSync(path.join(root, 'camera.env')))[sourceKey];
    } catch {
        console.error('Cannot read camera.env. Copy camera.env.example and set the camera URL.');
        process.exitCode = 1;
        return;
    }

    let url;
    try { url = new URL(source); } catch { /* invalid or missing URL */ }
    if (!url || !['rtsp:', 'rtsps:'].includes(url.protocol) ||
        !url.hostname || url.hostname.toLowerCase() === 'camera_ip') {
        console.error(`Set ${sourceKey} in camera.env to the camera's RTSP URL.`);
        process.exitCode = 1;
        return;
    }

    const executable = process.argv[2] || (process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
    const child = spawn(executable, [path.join(root, 'camera', 'mediamtx.yml')], {
        cwd: root,
        env: { ...process.env, [sourceKey]: source },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        createInterface({ input }).on('line', line => {
            const safe = line.replaceAll(source, '[RTSP URL]').replace(/rtsps?:\/\/[^\s"'<>]+/gi, '[RTSP URL]');
            output.write(`${safe}\n`);
        });
    }

    child.once('error', error => {
        console.error(error.code === 'ENOENT'
            ? 'MediaMTX was not found. Add it to PATH or pass its full executable path.'
            : 'MediaMTX could not be started. Check the executable path and permissions.');
    });
    child.once('close', code => { process.exitCode = code === null || code < 0 ? 1 : code; });

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => child.kill(signal));
    }
}

startCamera();
