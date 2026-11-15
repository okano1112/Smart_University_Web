'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const mqtt = require('mqtt');
const packet = require('mqtt-packet');
const { SchedulerMqtt, readConfig } = require('../ac-scheduler-mqtt');

async function until(predicate, timeout = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Local MQTT test timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('installed MQTT client sends nonretained exact AC commands and does not replay disconnected publishes', async t => {
  const sockets = new Set(), received = [];
  let activeSocket, connectionCount = 0;
  const broker = net.createServer(socket => {
    sockets.add(socket); activeSocket = socket; connectionCount++;
    const parser = packet.parser();
    socket.on('data', data => parser.parse(data));
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    parser.on('packet', data => {
      if (data.cmd === 'connect') socket.write(packet.generate({ cmd: 'connack', sessionPresent: false, returnCode: 0 }));
      if (data.cmd === 'subscribe') socket.write(packet.generate({ cmd: 'suback', messageId: data.messageId, granted: data.subscriptions.map(() => 0) }));
      if (data.cmd === 'publish') {
        received.push({ payload: data.payload.toString(), qos: data.qos, retain: data.retain, topic: data.topic });
        if (data.payload.toString() === 'STATUS') socket.write(packet.generate({ cmd: 'publish', qos: 0, retain: false, topic: 'spu/classroom/status', payload: JSON.stringify({ power: 'OFF', temp: 25, mode: 'COOL', fan: 'MED' }) }));
      }
      if (data.cmd === 'pingreq') socket.write(packet.generate({ cmd: 'pingresp' }));
    });
  });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const adapter = new SchedulerMqtt({ config: readConfig({ MQTT_URL: `mqtt://127.0.0.1:${broker.address().port}` }),
    connect: (url, options) => mqtt.connect(url, { ...options, reconnectPeriod: 50 }) });
  t.after(async () => { await adapter.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => broker.close(resolve)); });
  adapter.start(); await until(() => adapter.status().deviceOnline);
  const payload = { POWER: 1, TEMP: 25, MODE: 0, FAN: 2 };
  await adapter.publish(payload); await until(() => received.some(item => item.payload.startsWith('{')));
  const command = received.find(item => item.payload.startsWith('{'));
  assert.deepEqual(command, { topic: 'spu/classroom/remote/air', payload: JSON.stringify(payload), qos: 0, retain: false });
  activeSocket.destroy(); await until(() => !adapter.status().brokerConnected);
  await assert.rejects(adapter.publish({ ...payload, POWER: 0 }));
  await until(() => connectionCount >= 2 && adapter.status().deviceOnline);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(received.filter(item => item.payload.startsWith('{')).length, 1);
});
