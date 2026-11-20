'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeFlow } = require('../node-red/docker-entrypoint');
const { buildFlow } = require('../node-red/build-flow');
const { buildDht22Flow } = require('../node-red/build-dht22-flow');

test('Docker first start publishes separate CiRA and DHT22 flows and keeps saved editor changes', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bimclub-docker-node-red-'));
    const directory = path.join(temporary, 'data');
    const seedDirectory = path.join(temporary, 'empty-seed');
    try {
        const flowFile = initializeFlow(directory, seedDirectory);
        const flows = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
        assert.deepEqual(flows, [...buildFlow(), ...buildDht22Flow()]);
        assert.equal(flows.filter(node => node.type === 'tab').length, 2);
        assert.equal(new Set(flows.map(node => node.id)).size, flows.length);
        assert.deepEqual(fs.readdirSync(directory), ['flows.json']);

        const edited = '[{"id":"user-flow","type":"tab","label":"Saved on server"}]\n';
        const credentialFile = path.join(directory, 'flows_cred.json');
        fs.writeFileSync(flowFile, edited);
        fs.writeFileSync(credentialFile, '{"saved":"credentials"}\n');
        assert.equal(initializeFlow(directory, seedDirectory), flowFile);
        assert.equal(fs.readFileSync(flowFile, 'utf8'), edited);
        assert.equal(fs.readFileSync(credentialFile, 'utf8'), '{"saved":"credentials"}\n');
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('Docker private seed migrates its flow and credential key only onto a new volume', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bimclub-docker-node-red-seed-'));
    const directory = path.join(temporary, 'data');
    const seed = path.join(temporary, 'seed');
    const flow = '[{"id":"private-flow","type":"tab","label":"Private room"}]\n';
    try {
        fs.mkdirSync(seed);
        fs.writeFileSync(path.join(seed, 'flows.json'), flow);
        fs.writeFileSync(path.join(seed, 'flows_cred.json'), '{"fixture":"encrypted"}\n');
        fs.writeFileSync(path.join(seed, '.config.runtime.json'), '{"_credentialSecret":"test-key"}\n');
        const flowFile = initializeFlow(directory, seed);
        assert.equal(fs.readFileSync(flowFile, 'utf8'), flow);
        assert.equal(fs.readFileSync(path.join(directory, 'flows_cred.json'), 'utf8'), '{"fixture":"encrypted"}\n');
        assert.equal(fs.readFileSync(path.join(directory, '.config.runtime.json'), 'utf8'), '{"_credentialSecret":"test-key"}\n');

        fs.writeFileSync(flowFile, '[]\n');
        fs.writeFileSync(path.join(directory, 'flows_cred.json'), '{"updated":true}\n');
        initializeFlow(directory, seed);
        assert.equal(fs.readFileSync(flowFile, 'utf8'), '[]\n');
        assert.equal(fs.readFileSync(path.join(directory, 'flows_cred.json'), 'utf8'), '{"updated":true}\n');
        assert.equal(fs.readFileSync(path.join(directory, '.config.runtime.json'), 'utf8'), '{"_credentialSecret":"test-key"}\n');
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
