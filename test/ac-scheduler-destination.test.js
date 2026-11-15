'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { destinationIdentity, validSavedDestination, DEFAULT_DESTINATION } = require('../ac-scheduler-destination');

test('destination fingerprints bind broker routing and topics while excluding credentials', () => {
  const first = destinationIdentity(DEFAULT_DESTINATION);
  const authenticated = destinationIdentity({ ...DEFAULT_DESTINATION, brokerUrl: 'mqtt://user:secret@broker.emqx.io:1883?token=secret#private' });
  assert.equal(first.fingerprint, authenticated.fingerprint); assert.deepEqual(authenticated, first);
  assert.equal(destinationIdentity({ ...DEFAULT_DESTINATION, brokerUrl: 'mqtt://broker.emqx.io' }).fingerprint, first.fingerprint);
  for (const change of [{ brokerUrl: 'mqtt://other.example:1883' }, { brokerUrl: 'mqtt://broker.emqx.io:1884' }, { brokerUrl: 'mqtts://broker.emqx.io:1883' }, { commandTopic: 'other/ac' }, { statusTopic: 'other/status' }]) assert.notEqual(destinationIdentity({ ...DEFAULT_DESTINATION, ...change }).fingerprint, first.fingerprint);
  assert.equal(validSavedDestination(first), true); assert.equal(validSavedDestination(null), true);
  assert.equal(validSavedDestination({ ...first, fingerprint: 'invalid' }), false);
  assert.equal(validSavedDestination({ ...first, password: 'secret' }), false);
});
