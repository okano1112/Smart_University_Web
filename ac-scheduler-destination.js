'use strict';

const { createHash } = require('node:crypto');

const DEFAULT_DESTINATION = Object.freeze({ brokerUrl: 'mqtt://broker.emqx.io:1883', commandTopic: 'spu/classroom/remote/air', statusTopic: 'spu/classroom/status' });
const PORTS = { 'mqtt:': '1883', 'mqtts:': '8883', 'ws:': '80', 'wss:': '443' };

function destinationIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MQTT destination is required');
  const { brokerUrl, commandTopic, statusTopic } = input;
  const url = new URL(brokerUrl);
  if (!PORTS[url.protocol] || !url.hostname || [commandTopic, statusTopic].some(topic => typeof topic !== 'string' || !topic || topic.length > 256 || /[+#\u0000]/.test(topic))) throw new Error('Invalid MQTT destination');
  const canonical = { protocol: url.protocol, hostname: url.hostname.toLowerCase(), port: url.port || PORTS[url.protocol],
    path: ['ws:', 'wss:'].includes(url.protocol) ? url.pathname || '/' : '', commandTopic, statusTopic };
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return { brokerUrl: url.toString(), commandTopic, statusTopic, fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}

function validSavedDestination(value) {
  if (value === null) return true; // A known legacy schedule remains unbound until explicitly enabled.
  try {
    if (!value || Object.keys(value).length !== 4 || !['brokerUrl', 'commandTopic', 'statusTopic', 'fingerprint'].every(key => Object.hasOwn(value, key))) return false;
    const expected = destinationIdentity(value);
    return typeof value.fingerprint === 'string' && value.fingerprint === expected.fingerprint && value.brokerUrl === expected.brokerUrl;
  } catch (_) { return false; }
}

module.exports = { destinationIdentity, validSavedDestination, DEFAULT_DESTINATION };
