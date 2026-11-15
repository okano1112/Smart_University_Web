'use strict';

const { randomUUID } = require('node:crypto');

const DEVICE_STALE_MS = 75_000;
const DEFAULTS = { brokerUrl: 'mqtt://broker.emqx.io:1883', commandTopic: 'spu/classroom/remote/air', statusTopic: 'spu/classroom/status' };

function safeBrokerUrl(value) {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch (_) { return 'ไม่สามารถอ่านที่อยู่ MQTT'; }
}

function readConfig(env = process.env) {
  const brokerUrl = env.MQTT_URL || DEFAULTS.brokerUrl;
  const url = new URL(brokerUrl);
  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('MQTT_URL ต้องเป็น mqtt, mqtts, ws หรือ wss');
  const config = { brokerUrl, commandTopic: env.MQTT_COMMAND_TOPIC || DEFAULTS.commandTopic, statusTopic: env.MQTT_STATUS_TOPIC || DEFAULTS.statusTopic,
    username: env.MQTT_USERNAME, password: env.MQTT_PASSWORD };
  if ([config.commandTopic, config.statusTopic].some(topic => !topic || topic.length > 256 || /[+#\u0000]/.test(topic))) throw new Error('MQTT Topic ของตารางเวลาไม่ถูกต้อง');
  return config;
}

function parseReport(raw) {
  let value;
  try { value = JSON.parse(raw.toString()); } catch (_) { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.status === 'string' && /^(?:(?:engine|esp32|device)\s+)?offline$/i.test(value.status.trim())) return { offline: true };
  const power = String(value.power || '').toUpperCase(), temp = value.temp;
  const mode = ['COOL', 'DRY', 'FAN'].indexOf(String(value.mode || '').toUpperCase());
  const fan = ['AUTO', 'LOW', 'MED', 'HIGH'].indexOf(String(value.fan || '').toUpperCase());
  if (!['ON', 'OFF'].includes(power) || !Number.isInteger(temp) || temp < 21 || temp > 27 || mode < 0 || fan < 0) return null;
  return { power: power === 'ON', temp, mode, fan };
}

class SchedulerMqtt {
  constructor({ config = readConfig(), now = Date.now, connect, publishTimeoutMs = 8000 } = {}) {
    this.config = config; this.now = now; this.connect = connect; this.publishTimeoutMs = publishTimeoutMs;
    this.client = null; this.connected = false; this.lastStatusAt = 0; this.deviceState = null; this.poll = null;
  }

  status() {
    return { brokerConnected: this.connected, deviceOnline: this.connected && this.lastStatusAt > 0 && this.now() - this.lastStatusAt < DEVICE_STALE_MS,
      lastStatusAt: this.lastStatusAt || null, deviceState: this.deviceState ? { ...this.deviceState } : null,
      brokerUrl: safeBrokerUrl(this.config.brokerUrl), commandTopic: this.config.commandTopic, statusTopic: this.config.statusTopic };
  }

  start() {
    if (this.client) return;
    const connect = this.connect || require('mqtt').connect;
    const client = this.client = connect(this.config.brokerUrl, { username: this.config.username, password: this.config.password,
      clientId: `bimclub-scheduler-${randomUUID().slice(0, 12)}`, protocolVersion: 4, clean: true,
      reconnectPeriod: 5000, connectTimeout: 10_000, keepalive: 30, queueQoSZero: false, resubscribe: false });
    client.on('connect', () => {
      this.connected = true; this.lastStatusAt = 0; this.deviceState = null;
      client.subscribe(this.config.statusTopic, { qos: 0 }, error => { if (!error && this.client === client) this.requestStatus(); });
    });
    const disconnected = () => { this.connected = false; this.lastStatusAt = 0; this.deviceState = null; };
    client.on('offline', disconnected); client.on('close', disconnected);
    // MQTT.js emits errors while reconnecting. Do not log URLs or authentication material.
    client.on('error', () => {});
    client.on('message', (topic, raw, packet) => {
      if (topic !== this.config.statusTopic || packet?.retain || !this.connected) return;
      const report = parseReport(raw);
      if (!report) return;
      if (report.offline) { this.lastStatusAt = 0; this.deviceState = null; return; }
      this.lastStatusAt = this.now(); this.deviceState = report;
    });
    this.poll = setInterval(() => this.requestStatus(), 30_000); this.poll.unref?.();
  }

  requestStatus() {
    if (!this.connected || !this.client?.connected) return;
    this.client.publish(this.config.commandTopic, 'STATUS', { qos: 0, retain: false }, () => {});
  }

  publish(payload) {
    if (!this.connected || !this.client?.connected || !this.status().deviceOnline) return Promise.reject(new Error('MQTT หรือ ESP32 ไม่พร้อม'));
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(new Error('หมดเวลาส่ง MQTT')), this.publishTimeoutMs);
      function finish(error) { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(); }
      // QoS 0, retain false and queueQoSZero false prevent reconnect replay.
      // The callback confirms a socket write, not that the AC received infrared.
      try { this.client.publish(this.config.commandTopic, JSON.stringify(payload), { qos: 0, retain: false }, finish); }
      catch (error) { finish(error); }
    });
  }

  async close() {
    clearInterval(this.poll); this.poll = null; this.connected = false;
    if (!this.client) return;
    const client = this.client; this.client = null;
    await new Promise(resolve => client.end(true, {}, resolve));
  }
}

module.exports = { SchedulerMqtt, parseReport, readConfig, safeBrokerUrl, DEVICE_STALE_MS, DEFAULTS };
