'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildFlow } = require('../node-red/build-flow');

const runtime = path.resolve(__dirname, '../node-red/runtime');
const flowFile = path.join(runtime, 'flows.json');
fs.mkdirSync(runtime, { recursive: true });
// Preserve edits made in the Node-RED editor on subsequent starts.
if (!fs.existsSync(flowFile)) fs.writeFileSync(flowFile, JSON.stringify(buildFlow(), null, 2) + '\n');
const child = spawn('node-red', ['--userDir', runtime, '--settings', path.resolve(__dirname, '../node-red/settings.js')], { stdio: 'inherit' });
child.on('error', error => { console.error('เปิด Node-RED ไม่ได้: ' + error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code == null ? 0 : code; });
