'use strict';
/*
 * BimClub meeting-room dashboard — direct manual MQTT control.
 * Manual commands publish immediately to the existing ESP32 MQTT command topic.
 * No browser cooldown, no Node-RED/ACK dependency, no automatic resend on reconnect.
 * ESP32 status is self-reported last command, not proof of physical air-conditioner action.
 */
const DEFAULTS = Object.freeze({
    mqttUrl: 'wss://broker.emqx.io:8084/mqtt',
    username: '',
    command: 'spu/classroom/remote/air',
    status: 'spu/classroom/status',
    temp: 'spu/classroom/middle/temp',
    humid: 'spu/classroom/middle/humid',
    people: 'spu/classroom/cira'
});
const ROOM_NAME = 'ห้องประชุม BimClub';
const MIN_TEMP = 21;
const MAX_TEMP = 27;
const ACK_TIMEOUT_MS = 10000; // display-only timeout: never blocks the next command
const DEVICE_STALE_MS = 75000;
const SENSOR_STALE_MS = 30000;
const FORECAST_HISTORY_MS = 15 * 60000;
const DHT22_ENVIRONMENT_TOPIC = 'spu/classroom/environment';
const COMFORT_SAMPLE_MS = 6_000;
const MODE_NAMES = ['COOL', 'DRY', 'FAN'];
const FAN_NAMES = ['AUTO', 'LOW', 'MED', 'HIGH'];
const $ = id => document.getElementById(id);
const state = {
    mqttConnected: false, deviceOnline: false,
    ac: { power: null, temp: 24, mode: 0, fan: 3 },
    roomTemp: null, humid: null, people: null,
    sensorAt: { temp: 0, humid: 0, people: 0 }, lastStatusAt: 0,
    statusQuality: 'unknown',
    verifyState: 'unknown', pending: null,
    requested: null, lastPollAt: 0, requestCount: 0,
    commandDetail: '', events: [], notice: null
};
let settings = { ...DEFAULTS };
let mqttClient = null;
let chart = null;
const temperatureHistory = [];
let latestChartTemperature = null, chartTemperatureInterrupted = false;
const dht22Temperatures = window.SmartDht22Telemetry?.createTracker();
const targetHistory = [];
let latestChartTarget = null;
const comfortHistory = [];
let peopleStableSince = 0;
const coolingForecast = new SmartCoolingForecastClient.ForecastClient({ fetch: appFetch, onChange: () => renderForecast() });
let assumedCoolingRate = .1;
try { const saved=Number(localStorage.getItem('smartCoolingRateV1')); if(saved>=.02&&saved<=.5)assumedCoolingRate=saved; } catch(_) {}
let noticeTimer = null;
let reconnectProbeTimer = null;
let scheduleClient = null;
let occupancyClient = null;
let activityClient = null;
let sessionAuthorized = false, sessionEnded = false, sessionSuspended = false, sessionRevision = 0;
let sessionProbe = null, mqttRevision = 0, commandQueue = Promise.resolve(), queuedCommands = 0;

async function appFetch(resource, options) {
    if (sessionEnded || sessionSuspended) {
        // Best-effort release for a voice session during navigation. Never
        // treat its response as a new login state or restart any resources.
        if (resource === '/api/voice-session/cancel' && options?.method === 'POST' && options.keepalive) return fetch(resource, options);
        throw new DOMException('Dashboard closed', 'AbortError');
    }
    const revision = sessionRevision;
    const response = await fetch(resource, options);
    if (revision !== sessionRevision || sessionEnded || sessionSuspended) throw new DOMException('Dashboard closed', 'AbortError');
    const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url, location.href);
    if (response.status === 401 && url.origin === location.origin && (!response.url || new URL(response.url).origin === location.origin)) {
        pauseDashboardSession(true);
        location.replace('/login');
    }
    return response;
}
window.SmartDashboardFetch = appFetch;

function pauseDashboardSession(permanent = false) {
    sessionRevision++; sessionAuthorized = false; sessionEnded ||= permanent; sessionSuspended = !sessionEnded;
    sessionProbe = null;
    if (permanent) {
        handsFreeStartup.destroy();
        scheduleClient?.destroy();
        occupancyClient?.destroy();
        activityClient?.stop();
    } else handsFreeStartup.pause();
    stopMqtt();
    state.pending = null; state.requested = null;
    coolingForecast.reset();
}

async function checkDashboardSession(signal) {
    const revision = sessionRevision;
    try {
        const timeout = AbortSignal.timeout(4000);
        const response = await appFetch('/api/auth/session', {
            cache: 'no-store', credentials: 'same-origin', redirect: 'error',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        });
        return response.status === 204 && revision === sessionRevision && !sessionEnded && !sessionSuspended && !timeout.aborted && !signal?.aborted;
    } catch (_) { return false; }
}

function refreshDashboardSession() {
    if (sessionEnded || sessionSuspended || sessionProbe) return sessionProbe;
    const revision = sessionRevision;
    const pending = checkDashboardSession().then(ok => {
        if (!ok || revision !== sessionRevision || sessionEnded || sessionSuspended) return;
        if (!sessionAuthorized) {
            sessionAuthorized = true;
            connectMqtt(); renderAll();
            if (!scheduleClient) scheduleClient = SmartAcSchedules.install({ document, fetch: appFetch, notice,
                connection: () => ({ mqttUrl: settings.mqttUrl, command: settings.command, status: settings.status }), current: currentDesired });
            else scheduleClient.refresh();
            if (!occupancyClient) occupancyClient = window.SmartAcOccupancy?.install({ document, fetch: appFetch, connection: () => settings });
            else occupancyClient.refresh();
            if (!activityClient) activityClient = window.CiraActivity?.install({ metrics: comfortMetrics, apply: applyComfort, fetch: appFetch });
            else activityClient.refresh();
            handsFreeStartup.resume();
        }
    }).finally(() => { if (sessionProbe === pending) sessionProbe = null; });
    sessionProbe = pending;
    return pending;
}

function logEvent(kind, msg) {
    const entry = { at: new Date(), kind, msg };
    state.events.unshift(entry);
    state.events.splice(12);
    const parent = $('event-log');
    if (!parent) return;
    parent.textContent = '';
    for (const x of state.events) {
        const row = document.createElement('div');
        row.className = 'event-row';
        const time = document.createElement('span');
        time.className = 'event-time';
        time.textContent = x.at.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const label = document.createElement('span');
        label.className = x.kind === 'error' ? 'text-danger' : x.kind === 'warning' ? 'text-warning' : 'text-muted';
        label.textContent = x.msg;
        row.append(time, label);
        parent.append(row);
    }
}
function clearEventLog() {
    state.events = [];
    $('event-log').textContent = 'ยังไม่มีเหตุการณ์';
}
function notice(message, kind = 'info', timeout = 7500) {
    const node = $('notice-banner');
    if (noticeTimer) clearTimeout(noticeTimer);
    node.textContent = message;
    node.className = `notice ${kind}`;
    if (timeout) noticeTimer = setTimeout(() => { node.classList.add('hidden') }, timeout);
}
function parseValue(raw) { try { return JSON.parse(raw) } catch { return raw } }
function numberInRange(n, lo, hi) { return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi }
function sensorNumber(value) {
    if (typeof value === 'number') return value;
    return typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()) ? Number(value) : NaN;
}
function readableAge(ms) {
    if (!ms) return 'ยังไม่มีข้อมูล';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    return sec < 60 ? `${sec} วินาทีที่แล้ว` : `${Math.floor(sec / 60)} นาทีที่แล้ว`;
}
function isFreshSensor(which, now = Date.now()) {
    const at = state.sensorAt[which];
    return at > 0 && now >= at && now - at < SENSOR_STALE_MS;
}
// Direct manual control needs only an active MQTT socket. ESP32 state may be unknown.
function commandAllowed() { return sessionAuthorized && !sessionEnded && !sessionSuspended && state.mqttConnected }
function currentDesired() { return state.requested || state.ac }

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('smartClassroomMqttSettingsV3Direct') || '{}');
        for (const k of Object.keys(DEFAULTS)) {
            if (k !== 'username' && typeof saved[k] === 'string' && saved[k].trim()) settings[k] = saved[k];
        }
    } catch (_) { /* private browsing / file origin may disable storage */ }
    settingsToForm();
}
function settingsToForm() {
    const names = ['mqttUrl', 'username', 'command', 'status', 'temp', 'humid', 'people'];
    const ids = ['setting-broker', 'setting-user', 'setting-command', 'setting-status', 'setting-temp', 'setting-humid', 'setting-people'];
    names.forEach((key, i) => { $(ids[i]).value = settings[key] || '' });
    $('setting-pass').value = '';
}
function toggleSettings() {
    const panel = $('settings-panel');
    panel.classList.toggle('hidden');
    $('btn-settings').setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
}
function applySettings() {
    const next = {
        mqttUrl: $('setting-broker').value.trim(),
        username: $('setting-user').value.trim(),
        command: $('setting-command').value.trim(),
        status: $('setting-status').value.trim(),
        temp: $('setting-temp').value.trim(),
        humid: $('setting-humid').value.trim(),
        people: $('setting-people').value.trim()
    };
    if (!/^wss?:\/\/[^\s]+$/i.test(next.mqttUrl)) { notice('ต้องระบุ URL รูปแบบ wss://host:port/path หรือ ws://host:port/path', 'error'); return }
    if (window.location.protocol === 'https:' && next.mqttUrl.toLowerCase().startsWith('ws://')) { notice('เว็บ HTTPS ต้องใช้ MQTT แบบ wss:// เพื่อหลีกเลี่ยง Mixed Content', 'error'); return }
    if (Object.keys(next).some(k => k !== 'username' && !next[k])) { notice('กรุณาระบุ MQTT URL และทุก Topic', 'error'); return }
    if ((new Set([next.command, next.status, next.temp, next.humid, next.people])).size !== 5) { notice('Topic แต่ละหน้าที่ต้องไม่ซ้ำกัน', 'error'); return }
    handsFreeStartup.pause();
    settings = next;
    try { const persist = { ...next }; delete persist.username; localStorage.setItem('smartClassroomMqttSettingsV3Direct', JSON.stringify(persist)) } catch (_) { }
    stopMqtt();
    state.pending = null; state.requested = null; state.verifyState = 'unknown';
    state.deviceOnline = false; state.statusQuality = 'unknown'; state.ac.power = null;
    state.roomTemp = state.humid = state.people = null; resetChart();
    state.sensorAt = { temp: 0, humid: 0, people: 0 };
    renderAll();
    connectMqtt();
    handsFreeStartup.resume();
    scheduleClient?.refresh();
    occupancyClient?.refresh();
    activityClient?.refresh();
    $('settings-panel').classList.add('hidden');
    $('btn-settings').setAttribute('aria-expanded', 'false');
    notice('บันทึกการเชื่อมต่อแล้ว กำลังเชื่อมต่อกับ Broker ใหม่', 'info');
}
function resetSettings() {
    for (const [id, key] of Object.entries({ 'setting-broker': 'mqttUrl', 'setting-command': 'command', 'setting-status': 'status', 'setting-temp': 'temp', 'setting-humid': 'humid', 'setting-people': 'people' })) $(id).value = DEFAULTS[key];
    $('setting-user').value = $('setting-pass').value = '';
    notice('เติมค่าตั้งต้นแล้ว กรุณากด “บันทึกและเชื่อมต่อใหม่”', 'info');
}
function resetTelemetryConnection() {
    state.people = null; state.sensorAt = { temp: 0, humid: 0, people: 0 };
    chartTemperatureInterrupted = true;
    dht22Temperatures?.disconnect();
    peopleStableSince = 0; comfortHistory.length = 0;
    window.SmartCiraLogs?.recordBrowser({ stage: 'disconnected', at: Date.now() });
}
function stopMqtt() {
    mqttRevision++;
    if (reconnectProbeTimer) { clearTimeout(reconnectProbeTimer); reconnectProbeTimer = null }
    if (mqttClient) { const old = mqttClient; mqttClient = null; try { old.end(true) } catch (_) { } }
    state.mqttConnected = false; state.deviceOnline = false; state.statusQuality = 'unknown';
    resetTelemetryConnection();
}
function connectMqtt() {
    if (!sessionAuthorized || sessionEnded || sessionSuspended || mqttClient) return;
    if (typeof window.mqtt === 'undefined') {
        notice('ไม่พบไลบรารี MQTT.js — ต้องใช้อินเทอร์เน็ตเพื่อโหลดไฟล์ไลบรารี หรือโฮสต์ไฟล์ไว้ภายในเครือข่าย', 'error', 0);
        logEvent('error', 'ไม่สามารถโหลด MQTT.js ได้'); renderAll(); return;
    }
    try {
        mqttClient = mqtt.connect(settings.mqttUrl, {
            clientId: 'classroom_web_' + Math.random().toString(16).slice(2, 10),
            clean: true, connectTimeout: 7000, reconnectPeriod: 4000, keepalive: 30, queueQoSZero: false,
            ...(settings.username ? { username: settings.username, password: $('setting-pass').value } : {})
        });
    } catch (err) { notice('เชื่อมต่อ MQTT ไม่ได้: ' + err.message, 'error'); logEvent('error', err.message); return }
    const target = mqttClient;
    target.on('connect', () => {
        if (mqttClient !== target) return;
        mqttRevision++;
        state.mqttConnected = true;
        window.SmartCiraLogs?.recordBrowser({ stage: 'connected', at: Date.now() });
        state.deviceOnline = false;
        state.statusQuality = 'unknown';
        state.ac.power = null;
        state.verifyState = 'unknown';
        state.lastStatusAt = 0;
        logEvent('info', 'เชื่อมต่อ MQTT Broker สำเร็จ กำลังขอสถานะ ESP32');
        const topics = [settings.status, settings.temp, settings.humid, settings.people];
        target.subscribe(topics, { qos: 0 }, err => {
            if (mqttClient !== target) return;
            if (err) { notice('Subscribe MQTT ไม่สำเร็จ: ' + err.message, 'error'); logEvent('error', 'Subscribe ไม่สำเร็จ'); return }
            if (reconnectProbeTimer) clearTimeout(reconnectProbeTimer);
            reconnectProbeTimer = setTimeout(() => requestDeviceStatus(false), 750);
        });
        if (dht22Temperatures && !topics.includes(DHT22_ENVIRONMENT_TOPIC)) {
            target.subscribe(DHT22_ENVIRONMENT_TOPIC, { qos: 0 }, error => {
                if (error && mqttClient === target) logEvent('warning', 'ติดตามข้อมูล DHT22 ผ่าน MQTT ไม่ได้');
            });
        }
        renderAll();
    });
    target.on('message', (topic, buffer, packet) => {
        if (mqttClient !== target) return;
        try { processMessage(topic, buffer.toString().trim(), Boolean(packet?.retain)) } catch (err) { logEvent('error', 'อ่านข้อความ MQTT ไม่สำเร็จ: ' + err.message) }
    });
    const disconnect = () => {
        if (mqttClient !== target) return;
        mqttRevision++;
        if (state.mqttConnected) { logEvent('warning', 'Broker ขาดการเชื่อมต่อ'); resetTelemetryConnection(); }
        state.mqttConnected = false; state.deviceOnline = false; state.statusQuality = 'unknown';
        if (state.pending) { voiceCommandResult(state.pending.id, false, 'การเชื่อมต่ออุปกรณ์ขาดหาย • ยังไม่ยืนยันคำสั่ง'); state.pending = null; state.requested = null; state.verifyState = 'timeout' }
        renderAll();
    };
    target.on('offline', disconnect);
    target.on('close', disconnect);
    target.on('error', err => { if (mqttClient === target) console.warn('[MQTT]', err.message) });
}
function processMessage(topic, raw, retained) {
    if (topic === settings.status) {
        const data = parseValue(raw);
        if (data && typeof data === 'object' && typeof data.status === 'string' && /offline/i.test(data.status)) {
            state.deviceOnline = false; state.statusQuality = 'unknown'; state.lastStatusAt = 0;
            comfortHistory.length = 0;
            if (state.pending) { voiceCommandResult(state.pending.id, false, 'การเชื่อมต่ออุปกรณ์ขาดหาย • ยังไม่ยืนยันคำสั่ง'); state.pending = null; state.requested = null; state.verifyState = 'timeout' }
            logEvent('warning', 'ESP32 รายงานว่า Offline'); renderAll(); return;
        }
        if (raw.toLowerCase() === 'engine online') return;
        if (!data || typeof data !== 'object') return;
        const power = typeof data.power === 'string' ? data.power.toUpperCase() : '';
        const temp = Number(data.temp);
        const mode = MODE_NAMES.indexOf(String(data.mode || '').toUpperCase());
        const fan = FAN_NAMES.indexOf(String(data.fan || '').toUpperCase());
        if (!['ON', 'OFF'].includes(power) || !numberInRange(temp, MIN_TEMP, MAX_TEMP) || mode < 0 || fan < 0) return;
        const previous = state.ac.power;
        if (retained || Date.now() - state.lastStatusAt > DEVICE_STALE_MS || previous !== (power === 'ON') ||
            temp !== state.ac.temp || mode !== state.ac.mode || fan !== state.ac.fan) {
            comfortHistory.length = 0;
        }
        state.ac = { power: power === 'ON', temp, mode, fan };
        state.lastStatusAt = Date.now();
        state.statusQuality = retained ? 'cached' : 'fresh';
        state.deviceOnline = !retained;
        if (!retained && finishPendingIfReported()) {
            // Matched last requested state after direct publish (device self-report only).
        } else if (!state.pending && previous !== state.ac.power) {
            state.commandDetail = 'รับสถานะล่าสุดจาก ESP32 (ไม่ใช่การยืนยันจากแอร์)';
        }
        renderAll(); return;
    }
    const data = parseValue(raw);
    if (topic === settings.temp) {
        const candidate = (data && typeof data === 'object') ? (data.temp ?? data.temperature) : data;
        const n = sensorNumber(candidate);
        if (!retained && numberInRange(n, -10, 60)) {
            state.roomTemp = n; state.sensorAt.temp = Date.now();
            recordComfortReading(); appendChartPoint(); renderEnvironment(); renderForecast();
        }
    } else if (topic === settings.humid) {
        const candidate = (data && typeof data === 'object') ? (data.humid ?? data.humidity) : data;
        const n = sensorNumber(candidate);
        if (numberInRange(n, 0, 100)) {
            state.humid = n; state.sensorAt.humid = retained ? 0 : Date.now(); renderEnvironment();
        }
    } else if (topic === settings.people) {
        const receivedAt = Date.now(), serverNow = coolingForecast.nowOnServer();
        const logs = window.SmartCiraLogs;
        logs?.recordBrowser({ stage: 'received', at: receivedAt, topic });
        const reading = SmartCiraTelemetry.parsePeopleReading(raw, { retained, now: serverNow });
        const captureAt = reading ? Math.round(receivedAt - (serverNow - reading.at)) : 0;
        if (!reading || captureAt < state.sensorAt.people ||
            (captureAt === state.sensorAt.people && reading.people !== state.people)) {
            logs?.recordBrowser({ stage: 'rejected', at: receivedAt, topic, code: retained ? 'retained' : 'invalid-or-stale' });
            return;
        }
        if (!state.sensorAt.people || captureAt - state.sensorAt.people > SENSOR_STALE_MS) {
            comfortHistory.length = 0;
            peopleStableSince = captureAt;
        } else if (state.people !== reading.people) peopleStableSince = captureAt;
        state.people = reading.people;
        state.sensorAt.people = captureAt;
        renderEnvironment();
        if (isFreshSensor('people')) logs?.recordBrowser({ stage: 'displayed', at: receivedAt, count: state.people, captureAt: state.sensorAt.people, topic });
    } else if (topic === DHT22_ENVIRONMENT_TOPIC && dht22Temperatures?.accept(data, { retained, now: coolingForecast.nowOnServer() })) {
        renderForecast();
    }
}
function pendingMatches(expected, actual) {
    return expected.power === actual.power && (!expected.power || (expected.temp === actual.temp && expected.mode === actual.mode && expected.fan === actual.fan));
}
function finishPendingIfReported() {
    const item = state.pending;
    if (!item || item.stage !== 'DIRECT_SENT' || state.statusQuality !== 'fresh' || state.lastStatusAt < item.createdAt || !pendingMatches(item.expected, state.ac)) return false;
    const label = item.label;
    voiceCommandResult(item.id, true, 'ESP32 ตอบสถานะตรงกับคำสั่งแล้ว • ยังไม่ใช่การยืนยันว่าแอร์รับ IR');
    state.pending = null; state.requested = null; state.verifyState = 'ir_sent';
    state.commandDetail = `ESP32 รายงานสถานะตรงกับคำขอ: ${label} (ไม่ใช่การยืนยันแอร์รับ IR)`;
    logEvent('info', state.commandDetail);
    return true;
}
function sendMqtt(topic, payload, callback) {
    if (!mqttClient || !state.mqttConnected || !mqttClient.connected) return false;
    try { mqttClient.publish(topic, payload, { qos: 0, retain: false }, callback || (() => { })); return true }
    catch (err) { logEvent('error', 'Publish ล้มเหลว: ' + err.message); return false }
}
function requestDeviceStatus(userInitiated = false) {
    if (!state.mqttConnected) { if (userInitiated) notice('ยังไม่เชื่อมต่อ MQTT Broker', 'warning'); return }
    const now = Date.now();
    if (now - state.lastPollAt < 2000) return;
    state.lastPollAt = now;
    if (sendMqtt(settings.command, 'STATUS')) {
        if (userInitiated) notice('ส่งคำขอ STATUS ไป ESP32 แล้ว (ไม่มีการยิง IR)', 'info');
        logEvent('info', 'ขอสถานะจาก ESP32 โดยตรง (ไม่ยิง IR)');
    }
}
function sendAcCommand(change, label, { validate = () => true, signal } = {}) {
    if (!commandAllowed()) {
        notice(sessionAuthorized ? 'MQTT Offline: ไม่ได้ส่งคำสั่ง กรุณาตรวจสอบการเชื่อมต่อ'
            : 'ยังไม่ได้ยืนยันเซสชัน จึงไม่ได้ส่งคำสั่ง', 'warning');
        return Promise.resolve(false);
    }
    if (queuedCommands >= 5) return Promise.resolve(false);
    const revision = sessionRevision, connectionRevision = mqttRevision, connection = mqttClient;
    const deadline = Date.now() + 6000;
    const stillValid = () => commandAllowed() && connection === mqttClient && revision === sessionRevision &&
        connectionRevision === mqttRevision && Date.now() <= deadline && !signal?.aborted && validate();
    queuedCommands++;
    commandQueue = commandQueue.then(async () => {
        if (!stillValid()) return false;
        if (!await checkDashboardSession(signal)) {
            if (stillValid()) notice('ตรวจสอบการเข้าสู่ระบบไม่ได้ จึงไม่ได้ส่งคำสั่ง', 'warning');
            return false;
        }
        if (!stillValid()) return false;
        // Manual deltas compose in arrival order after checks; a stale voice
        // or advice command instead fails its captured-state validation above.
        const intent = typeof change === 'function' ? change(currentDesired()) : { next: change, label };
        return intent ? publishAcCommand(intent.next, intent.label) : false;
    }).catch(() => false).finally(() => { queuedCommands--; });
    return commandQueue;
}
function publishAcCommand(next, label) {
    if (!next || typeof next.power !== 'boolean' || !Number.isInteger(next.temp) || !numberInRange(next.temp, MIN_TEMP, MAX_TEMP) || !Number.isInteger(next.mode) || next.mode < 0 || next.mode > 2 || !Number.isInteger(next.fan) || next.fan < 0 || next.fan > 3) {
        notice('ค่าคำสั่งไม่ถูกต้อง', 'error'); return false;
    }
    if (!commandAllowed()) { notice('MQTT Offline: ไม่ได้ส่งคำสั่ง กรุณาตรวจสอบการเชื่อมต่อ', 'warning'); return false }
    comfortHistory.length = 0;
    if (state.pending) voiceCommandResult(state.pending.id, false, 'มีคำสั่งใหม่แทนคำสั่งเสียงก่อนหน้า • โปรดตรวจสถานะอุปกรณ์');
    const id = `manual-${Date.now().toString(36)}-${++state.requestCount}`;
    const payload = JSON.stringify({ POWER: next.power ? 1 : 0, TEMP: next.temp, MODE: next.mode, FAN: next.fan });
    // Set pending before publish: a synchronous publish error cannot be overwritten by success UI.
    state.requested = { ...next };
    state.pending = { id, expected: { ...next }, label, createdAt: Date.now(), startedAt: Date.now(), stage: 'DIRECT_SENT' };
    state.verifyState = 'sending';
    const sent = sendMqtt(settings.command, payload, err => {
        if (!err || sessionEnded || sessionSuspended) return;
        logEvent('error', 'MQTT Publish ผิดพลาด: ' + err.message);
        voiceCommandResult(id, false, 'ส่งคำสั่ง MQTT ไม่สำเร็จ • กรุณาตรวจการเชื่อมต่อ');
        if (state.pending?.id === id) { state.pending = null; state.requested = null; state.verifyState = 'timeout'; renderAll() }
        notice('MQTT Publish ผิดพลาด: ไม่ยืนยันว่าคำสั่งถูกส่งแล้ว', 'error');
    });
    if (!sent || state.pending?.id !== id) {
        if (state.pending?.id === id) { state.pending = null; state.requested = null; state.verifyState = 'timeout'; renderAll() }
        notice('ส่ง MQTT ไม่สำเร็จ', 'error'); return false;
    }
    if (!state.deviceOnline) notice('ส่งคำขอเข้า MQTT แล้ว แต่ ESP32 ยังไม่ยืนยันว่าออนไลน์', 'warning', 5500);
    state.commandDetail = `เว็บ Publish MQTT: ${label} • รอสถานะจาก ESP32 (ยังไม่ยืนยัน IR)`;
    logEvent('info', state.commandDetail); renderAll();
    return { id };
}
function handlePowerToggle() {
    void sendAcCommand(current => {
        const power = current.power === null ? true : !current.power;
        return { next: { ...current, power }, label: power ? 'เปิดแอร์' : 'ปิดแอร์' };
    });
}
function adjustTemperature(delta) {
    void sendAcCommand(current => {
        const t = current.temp + delta;
        return current.power === true && numberInRange(t, MIN_TEMP, MAX_TEMP)
            ? { next: { ...current, temp: t }, label: `ปรับอุณหภูมิ ${t}°C` } : null;
    });
}
function selectQuickTemp(t) {
    if (!numberInRange(t, MIN_TEMP, MAX_TEMP)) return;
    void sendAcCommand(current => ({ next: { ...current, power: true, temp: t }, label: `ตั้งแอร์ ${t}°C` }));
}
function chooseAcMode(mode) {
    if (![0, 1, 2].includes(mode)) return;
    void sendAcCommand(current => current.power === true
        ? { next: { ...current, mode }, label: `เปลี่ยนโหมด ${MODE_NAMES[mode]}` } : null);
}
function chooseAcFan(fan) {
    if (![0, 1, 2, 3].includes(fan)) return;
    void sendAcCommand(current => current.power === true && current.mode === 0
        ? { next: { ...current, fan }, label: `ปรับแรงลม ${FAN_NAMES[fan]}` } : null);
}

function renderThermostat() {
    const { power, temp, mode, fan } = currentDesired();
    const canControl = commandAllowed();
    $('thermostat-card').classList.toggle('is-off', power !== true);
    $('ui-target-temp').textContent = power === null ? '—' : power === false ? 'ปิด' : String(temp);
    $('ui-target-unit').textContent = power === true ? '°C' : '';
    $('thermostat-subtitle').textContent = state.pending ? 'อุณหภูมิที่ร้องขอ · รอ ESP32 ตอบกลับ' : power === null ? 'กำลังรอสถานะจาก ESP32' : power === false ? 'เครื่องปรับอากาศ' : 'อุณหภูมิที่ตั้งไว้';
    $('ui-cooling-desc').textContent = state.pending ? 'กำลังส่งคำสั่ง โปรดรอสถานะตอบกลับ' : power === null ? 'ยังไม่ทราบสถานะแอร์' : power === false ? 'ESP32 รายงานว่าปิดแอร์' : ['โหมดเย็น', 'โหมดลดความชื้น', 'โหมดพัดลม'][mode];
    $('btn-power-text').textContent = power === true ? 'ปิดแอร์' : 'เปิดแอร์';
    $('btn-power').classList.toggle('is-on', power === true);
    $('btn-power').disabled = !canControl;
    $('btn-temp-down').disabled = !canControl || power !== true || temp <= MIN_TEMP;
    $('btn-temp-up').disabled = !canControl || power !== true || temp >= MAX_TEMP;
    [23, 24, 25].forEach(t => {
        const e = $('preset-' + t), selected = power === true && temp === t;
        e.classList.toggle('active', selected); e.setAttribute('aria-pressed', String(selected)); e.disabled = !canControl;
    });
    document.querySelectorAll('[data-ac-mode]').forEach(button => {
        const selected = mode === Number(button.dataset.acMode) && power === true;
        button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
        button.disabled = !canControl || power !== true;
    });
    document.querySelectorAll('[data-ac-fan]').forEach(button => {
        const selected = fan === Number(button.dataset.acFan) && power === true && mode === 0;
        button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
        button.disabled = !canControl || power !== true || mode !== 0;
    });
    $('last-command-info').textContent = state.commandDetail || 'สถานะจาก ESP32 ยังไม่ใช่การยืนยันว่าแอร์รับสัญญาณ IR';
    renderVerify();
}
function renderVerify() {
    let label, type = '';
    if (state.pending) { label = 'ส่ง MQTT แล้ว · รอสถานะจาก ESP32'; type = 'pending'; }
    else if (!state.mqttConnected) { label = 'ยังไม่ได้เชื่อมต่อ MQTT'; type = 'pending'; }
    else if (state.verifyState === 'timeout') { label = 'ยังไม่พบสถานะตอบกลับคำสั่ง'; type = 'error'; }
    else if (!state.deviceOnline) { label = state.statusQuality === 'cached' ? 'ได้รับสถานะเก่า · รอ ESP32 ตอบกลับ' : 'รอ ESP32 ตอบกลับ'; type = 'pending'; }
    else if (state.verifyState === 'ir_sent') label = 'ESP32 รายงานสถานะตรงกับคำสั่งแล้ว';
    else label = 'ได้รับสถานะล่าสุดจาก ESP32';
    $('verify-message').textContent = label;
    $('verify-pill').className = `verify-status ${type}`;
    $('retry-action-box').classList.toggle('hidden', state.verifyState !== 'timeout');
}
function renderEnvironment() {
    $('val-room-temp').textContent = isFreshSensor('temp') ? state.roomTemp.toFixed(1) : '—';
    $('val-room-humid').textContent = isFreshSensor('humid') ? String(Math.round(state.humid)) : '—';
    $('val-room-people').textContent = isFreshSensor('people') ? String(state.people) : '—';
    const tempBadge = $('badge-room-temp');
    tempBadge.className = 'reading-caption' + (isFreshSensor('temp') && state.roomTemp >= 27 ? ' warm' : '');
    tempBadge.textContent = !isFreshSensor('temp') ? 'รอข้อมูลอุณหภูมิล่าสุด' : state.roomTemp >= 27 ? 'ห้องค่อนข้างร้อน' : state.roomTemp >= 23 ? 'อยู่ในช่วงสบาย' : 'อุณหภูมิค่อนข้างต่ำ';
    $('desc-room-humid').textContent = !isFreshSensor('humid') ? 'รอข้อมูลความชื้นล่าสุด' : state.humid > 65 ? 'ความชื้นค่อนข้างสูง' : state.humid >= 40 ? 'ความชื้นระดับทั่วไป' : 'อากาศค่อนข้างแห้ง';
    $('desc-room-people').textContent = !isFreshSensor('people') ? 'รอข้อมูล CiRA CORE ล่าสุด' : state.people === 0 ? 'CiRA CORE ตรวจพบ 0 คน' : 'ข้อมูลล่าสุดจาก CiRA CORE';
}
function renderConnection() {
    const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
    $('mqtt-state').className = `status-label ${state.mqttConnected ? 'is-online' : 'is-offline'}`;
    setText('mqtt-state-text', state.mqttConnected ? 'เชื่อมต่อแล้ว' : 'ยังไม่เชื่อมต่อ');
    let host = 'โบรกเกอร์';
    try { host = new URL(settings.mqttUrl).host; } catch (_) { }
    setText('mqtt-detail', `โบรกเกอร์: ${host}`);
    const online = state.mqttConnected && state.deviceOnline && state.statusQuality === 'fresh';
    $('esp-state').className = `status-label ${online ? 'is-online' : ''}`;
    setText('esp-state-text', online ? 'ออนไลน์ · มีข้อมูลตอบกลับ' : !state.mqttConnected ? 'ตรวจสอบไม่ได้' : state.statusQuality === 'cached' ? 'รอข้อมูลใหม่' : 'รออุปกรณ์ตอบกลับ');
    setText('device-line', state.lastStatusAt ? `ตอบกลับล่าสุด: ${readableAge(state.lastStatusAt)}${state.statusQuality === 'cached' ? ' · ข้อมูลเก่า' : ''}` : 'ยังไม่มีสถานะล่าสุดจากอุปกรณ์');
}
function renderAll() { renderThermostat(); renderEnvironment(); renderConnection(); renderForecast() }
function updateClock() {
    const now = new Date();
    $('ui-datetime').textContent = now.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' • เวลา ' + now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' น.';
}
function forecastContext() { return JSON.stringify([settings.mqttUrl, settings.temp, settings.status, state.ac.power, state.ac.temp, state.ac.mode, state.ac.fan]); }
function recordForecastSample() {
    if (!isFreshSensor('temp') || (!state.deviceOnline || state.statusQuality !== 'fresh') || state.pending) return;
    coolingForecast.record({time:state.sensorAt.temp,temp:state.roomTemp,context:forecastContext()});
}
function changeForecastRate() {
    const rate=Number($('forecast-rate').value);
    if (!Number.isFinite(rate)||rate<.02||rate>.5) { $('forecast-rate').value=assumedCoolingRate.toFixed(2); notice('กรุณาระบุอัตราระหว่าง 0.02–0.50 °C/นาที', 'warning'); return; }
    assumedCoolingRate=rate;
    try { localStorage.setItem('smartCoolingRateV1',String(rate)); } catch(_) {}
    renderForecast();
}
function recordTargetChange(statusFresh, now) {
    const target = statusFresh && state.ac.power === true ? state.ac.temp : null;
    const expiresAt = latestChartTarget ? latestChartTarget.time + DEVICE_STALE_MS : null;
    if (targetHistory.at(-1)?.target != null && expiresAt !== null && expiresAt <= now) {
        targetHistory.push({ time: expiresAt, target: null });
    }
    if (statusFresh) latestChartTarget = { time: state.lastStatusAt, target };
    if (!targetHistory.length || targetHistory.at(-1).target !== target) {
        targetHistory.push({ time: statusFresh ? state.lastStatusAt : now, target });
    }
    const cutoff = now - FORECAST_HISTORY_MS;
    // Keep one earlier value to carry an unchanged target across the left edge.
    while (targetHistory.length > 1 && (targetHistory.length > 80 || targetHistory[1].time <= cutoff)) targetHistory.shift();
}
function renderForecast() {
    if (!$('forecast-eta')) return;
    const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
    recordForecastSample();
    const browserNow = Date.now(), cutoff = browserNow - FORECAST_HISTORY_MS;
    const fresh = isFreshSensor('temp', browserNow);
    const statusFresh = state.mqttConnected && state.deviceOnline && state.statusQuality === 'fresh' &&
        browserNow >= state.lastStatusAt && browserNow - state.lastStatusAt < DEVICE_STALE_MS;
    recordTargetChange(statusFresh, browserNow);
    const prediction = coolingForecast.sync({ roomTemp: state.roomTemp, target: state.ac.temp, power: state.ac.power, mode: state.ac.mode,
        sensorAt: fresh ? state.sensorAt.temp : 0, statusAt: state.lastStatusAt,
        statusFresh, pending: !!state.pending, assumedRate: assumedCoolingRate }, forecastContext());
    const { duration, clockTime, remainingMinutes } = SmartCoolingForecastClient;
    const now = coolingForecast.nowOnServer(), estimating = prediction.kind === 'estimate';
    const dht22 = dht22Temperatures?.series(now) ?? { seen: false, A: null, B: null };
    const sensorCount = Number(Boolean(dht22.A)) + Number(Boolean(dht22.B));
    const legacyLive = sensorCount === 0 && fresh && Number.isFinite(state.roomTemp);
    const showLegacy = sensorCount === 0 && (!dht22.seen || legacyLive);
    const lastTemperature = latestChartTemperature?.time >= cutoff ? latestChartTemperature : null;
    const lastTarget = latestChartTarget?.time >= cutoff ? latestChartTarget : null;
    const targetLive = statusFresh && state.ac.power === true;
    const hasLegacySeries = showLegacy && !!lastTemperature;
    let sensorStatus = 'รอข้อมูล DHT22';
    if (sensorCount === 2) sensorStatus = 'ตรวจพบ DHT22 2 ตัว';
    else if (sensorCount === 1) sensorStatus = `ตรวจพบ DHT22 1 ตัว (${dht22.A ? 'A' : 'B'})`;
    else if (legacyLive) sensorStatus = 'ตรวจพบเซนเซอร์ 1 ตัว (ช่องเดิม)';
    else if (hasLegacySeries) sensorStatus = 'ข้อมูลย้อนหลัง (เซนเซอร์เดิม)';
    setText('dht22-chart-status', sensorStatus);
    $('dht22-chart-status').dataset.sensors = String(legacyLive ? 1 : sensorCount);
    $('legend-dht22-a').hidden = !dht22.A;
    $('legend-dht22-b').hidden = !dht22.B;
    $('legend-legacy-temp').hidden = !hasLegacySeries;
    $('legend-forecast').hidden = !estimating;
    $('legend-forecast-range').hidden = !estimating;
    setText('legend-forecast-label', sensorCount ? 'คาดการณ์จากเซนเซอร์เดิม' : 'คาดการณ์');
    const arrival = estimating ? clockTime(prediction.arrivalAt, now) : '—';
    const remaining = estimating ? duration(remainingMinutes(prediction, now)) : '';
    const awaitingReading = estimating && prediction.arrivalAt <= now;
    const readingNote = (id, previous, live) => {
        const historical = previous && !live;
        setText(id, historical ? `ข้อมูลย้อนหลัง · ${clockTime(previous.time + coolingForecast.clockOffset, now)}` : '');
        $(id).hidden = !historical;
    };
    setText('forecast-current', lastTemperature ? lastTemperature.temp.toFixed(1) + '°C' : '—');
    readingNote('forecast-current-note', lastTemperature, fresh);
    setText('forecast-target', lastTarget?.target != null ? lastTarget.target + '°C' : '—');
    readingNote('forecast-target-note', lastTarget?.target != null ? lastTarget : null, targetLive);
    setText('forecast-arrival-label', `คาดว่าจะถึง${targetLive ? ' ' + state.ac.temp + '°C' : 'เป้าหมาย'} เวลา`);
    setText('forecast-arrival', arrival);
    setText('forecast-eta', estimating ? awaitingReading ? 'รอเซนเซอร์ยืนยัน' : 'อีกประมาณ ' + remaining : prediction.kind === 'reached' ? 'ถึงเป้าหมายแล้ว' : prediction.kind === 'loading' ? 'กำลังคำนวณ' : 'ยังประมาณไม่ได้');
    const waiting = state.mqttConnected ? prediction.message : 'รอการเชื่อมต่อ MQTT เพื่อรับข้อมูลล่าสุด';
    setText('forecast-summary', estimating ? awaitingReading ? `ตามแนวโน้มคาดว่าจะถึง ${state.ac.temp}°C เวลา ${arrival} ขณะนี้รอเซนเซอร์ยืนยัน` : `คาดว่าอุณหภูมิห้องจะถึง ${state.ac.temp}°C ประมาณ ${arrival} ใช้เวลาอีกประมาณ ${remaining}` : waiting);
    setText('forecast-source', (prediction.source === 'measured' ? 'เซิร์ฟเวอร์ • แนวโน้มเซนเซอร์' : prediction.source === 'assumed' ? 'เซิร์ฟเวอร์ • อัตราสมมติ' : prediction.kind === 'loading' ? 'กำลังคำนวณ' : 'รอข้อมูล / เงื่อนไข'));
    setText('forecast-detail', estimating ? prediction.message : '');
    setText('forecast-range', estimating ? `ช่วงเวลาตามสถานการณ์ ${clockTime(prediction.earliestAt, now)} ถึง ${clockTime(prediction.latestAt, now)} • ${prediction.rate.toFixed(2)}°C/นาที${prediction.source === 'assumed' ? ' • อัตราสมมติ ±30%' : ' • ไม่ใช่ช่วงความเชื่อมั่นทางสถิติ'}` : '');
    if (!chart) return;
    const future = prediction.points;
    // Observations use the browser clock; the server returns canonical times.
    const plotOffset = estimating ? future[0].time - state.sensorAt.temp : coolingForecast.clockOffset;
    const past = hasLegacySeries ? temperatureHistory.filter(p => p.time >= cutoff).map(p => ({ x: p.time + plotOffset, y: p.temp })) : [];
    if (hasLegacySeries && temperatureHistory.at(-1) !== lastTemperature) {
        past.push({ x: lastTemperature.time + plotOffset, y: lastTemperature.temp });
    }
    const earliest = Math.min(past[0]?.x ?? Infinity, dht22.A?.[0]?.x ?? Infinity, dht22.B?.[0]?.x ?? Infinity);
    const start = Number.isFinite(earliest) ? Math.min(earliest, now - 60000) : now - FORECAST_HISTORY_MS;
    const end = Math.max(now, past.at(-1)?.x ?? now, future.at(-1)?.time ?? now, dht22.A?.at(-1)?.x ?? now, dht22.B?.at(-1)?.x ?? now);
    const target = [];
    let priorTarget = null;
    for (const event of targetHistory) {
        const time = event.time + plotOffset;
        if (time <= start) { priorTarget = event.target; continue; }
        if (!target.length) target.push({ x: start, y: priorTarget });
        target.push({ x: time, y: priorTarget }, { x: time, y: event.target });
        priorTarget = event.target;
    }
    if (!target.length) target.push({ x: start, y: priorTarget });
    target.push({ x: end, y: priorTarget });
    $('legend-target').hidden = !target.some(point => point.y != null);
    setText('legend-target-label', targetLive ? 'เป้าหมาย' : 'เป้าหมายย้อนหลัง');
    chart.data.datasets[0].data = past;
    chart.data.datasets[1].data = target;
    chart.data.datasets[2].data = future.map(p => ({ x: p.time, y: p.lower }));
    chart.data.datasets[3].data = future.map(p => ({ x: p.time, y: p.upper }));
    chart.data.datasets[4].data = future.map(p => ({ x: p.time, y: p.temp }));
    chart.data.datasets[5].data = estimating && prediction.arrivalAt <= end ? [{ x: prediction.arrivalAt, y: state.ac.temp }] : [];
    chart.data.datasets[6].data = dht22.A ?? [];
    chart.data.datasets[7].data = dht22.B ?? [];
    chart.coolingTimes = estimating ? { now, arrivalAt: prediction.arrivalAt, arrival, target: state.ac.temp } : null;
    chart.options.scales.x.min = start;
    chart.options.scales.x.max = Math.max(start + 60000, end);
    chart.update('none');
}
const coolingTimeMarkers = {
    id: 'coolingTimeMarkers',
    afterDatasetsDraw(graph) {
        const times = graph.coolingTimes;
        if (!times) return;
        const { ctx, chartArea: area, scales: { x } } = graph;
        ctx.save(); ctx.font = '11px Prompt, sans-serif'; ctx.textBaseline = 'top';
        const line = (time, color) => {
            const px = x.getPixelForValue(time);
            if (px < area.left || px > area.right) return null;
            ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
            ctx.beginPath(); ctx.moveTo(px, area.top); ctx.lineTo(px, area.bottom); ctx.stroke(); ctx.setLineDash([]);
            return px;
        };
        const currentX = line(times.now, '#B1B1A7');
        if (currentX !== null) { ctx.fillStyle = '#62625C'; ctx.fillText('ตอนนี้', Math.min(area.right - 34, Math.max(area.left, currentX + 5)), area.top + 3); }
        const arrivalX = line(times.arrivalAt, '#A3131A');
        if (arrivalX !== null) {
            const label = `ถึง ${times.target}°C ≈ ${times.arrival}`;
            const width = ctx.measureText(label).width;
            const left = Math.max(area.left + 2, Math.min(arrivalX - width / 2, area.right - width - 2));
            ctx.fillStyle = '#FFFFFF'; ctx.fillRect(left - 3, area.top + 19, width + 6, 18);
            ctx.fillStyle = '#711015'; ctx.fillText(label, left, area.top + 22);
        }
        ctx.restore();
    }
};
function initChart() {
    $('forecast-rate').value = assumedCoolingRate.toFixed(2);
    if (typeof window.Chart === 'undefined') {
        const marker = document.createElement('p'); marker.className = 'empty-state'; marker.textContent = 'ไม่สามารถโหลด Chart.js ได้ (กราฟต้องโหลดไลบรารีก่อน)';
        $('tempChart').parentNode.appendChild(marker); $('tempChart').style.display = 'none'; return;
    }
    Chart.defaults.font.family = 'Prompt, sans-serif';
    chart = new Chart($('tempChart').getContext('2d'), {
        type: 'line', plugins: [coolingTimeMarkers], data: { datasets: [
            { label: 'อุณหภูมิห้องจริง', data: [], borderColor: '#30302B', borderWidth: 3, pointRadius: 2, spanGaps: false },
            { label: 'อุณหภูมิที่ตั้งไว้', data: [], borderColor: '#85857B', borderWidth: 2, borderDash: [6, 6], pointRadius: 0, spanGaps: false },
            { label: 'สถานการณ์เย็นเร็ว', data: [], borderWidth: 0, pointRadius: 0 },
            { label: 'ช่วงสถานการณ์', data: [], borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(163,19,26,.10)', fill: '-1' },
            { label: 'อุณหภูมิคาดการณ์', data: [], borderColor: '#A3131A', borderWidth: 2, borderDash: [5, 5], pointRadius: 0 },
            { label: 'คาดว่าจะถึงเป้าหมาย', data: [], borderColor: '#711015', backgroundColor: '#711015', pointRadius: 5, pointHoverRadius: 7, showLine: false },
            { label: 'DHT22 A', data: [], borderColor: '#226B45', backgroundColor: '#226B45', borderWidth: 2.5, pointRadius: 3, spanGaps: false },
            { label: 'DHT22 B', data: [], borderColor: '#165D8D', backgroundColor: '#165D8D', borderWidth: 2.5, borderDash: [7, 3], pointRadius: 3, pointStyle: 'triangle', spanGaps: false }
        ] }, options: {
            responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
            plugins: { legend: { display: false }, tooltip: { filter: item => [0, 1, 4, 5, 6, 7].includes(item.datasetIndex), callbacks: {
                title: items => SmartCoolingForecastClient.clockTime(items[0].parsed.x, coolingForecast.nowOnServer()),
                label: item => `${item.dataset.label}: ${item.parsed.y.toFixed(1)}°C`
            } } },
            scales: {
                x: { type: 'linear', grid: { display: false }, ticks: { maxTicksLimit: 6, color: '#62625C', callback: value => new Date(value).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) } },
                y: { grace: '15%', grid: { color: '#ECECE7' }, ticks: { color: '#62625C', callback: value => value + '°C' } }
            }
        }
    });
}
function appendChartPoint() {
    const time = state.sensorAt.temp;
    const previous = latestChartTemperature;
    const gap = previous && time > previous.time && (chartTemperatureInterrupted || time - previous.time >= SENSOR_STALE_MS);
    if (gap) {
        if (temperatureHistory.at(-1) !== previous) temperatureHistory.push(previous);
        temperatureHistory.push({ time: (previous.time + time) / 2, temp: null });
    }
    chartTemperatureInterrupted = false;
    latestChartTemperature = { time, temp: state.roomTemp };
    const last = temperatureHistory.at(-1);
    if (last?.time === time) temperatureHistory[temperatureHistory.length - 1] = latestChartTemperature;
    else if (gap || !last || time - last.time >= SENSOR_STALE_MS) temperatureHistory.push(latestChartTemperature);
    while (temperatureHistory.length > 40 || time - temperatureHistory[0].time > FORECAST_HISTORY_MS) temperatureHistory.shift();
}
function resetChart() {
    dht22Temperatures?.reset();
    latestChartTemperature = null; chartTemperatureInterrupted = false; latestChartTarget = null;
    temperatureHistory.length = 0; targetHistory.length = 0; coolingForecast.reset();
    if (chart) { chart.data.datasets.forEach(d => d.data = []); chart.coolingTimes = null; chart.update('none'); }
}
function healthTick() {
    if (state.pending && Date.now() - state.pending.startedAt > ACK_TIMEOUT_MS) {
        const label = state.pending.label;
        voiceCommandResult(state.pending.id, false, 'ไม่พบการตอบกลับจาก ESP32 • โปรดตรวจอุปกรณ์ก่อนสั่งซ้ำ');
        state.pending = null; state.requested = null; state.verifyState = 'timeout';
        state.commandDetail = `ไม่พบสถานะตอบกลับคำสั่ง “${label}” — ไม่ส่ง IR ซ้ำโดยอัตโนมัติ`;
        logEvent('warning', state.commandDetail);
        notice('ไม่พบการตอบกลับจาก ESP32: ตรวจสถานะแอร์ด้วยตาหรือรีโมทจริงก่อนกดซ้ำ', 'warning', 12000);
    }
    if (state.deviceOnline && Date.now() - state.lastStatusAt > DEVICE_STALE_MS) {
        state.deviceOnline = false; state.statusQuality = 'unknown';
        comfortHistory.length = 0;
        logEvent('warning', 'ESP32 ไม่ตอบ STATUS ตามกำหนด • เว็บยังส่ง MQTT ได้ แต่ไม่ยืนยันว่าอุปกรณ์จะได้รับคำสั่ง');
    }
    renderAll();
}
function recordComfortReading() {
    const at = state.sensorAt.temp, countAge = at - state.sensorAt.people;
    // Capture only a received temperature reading paired with a recent count.
    // Polling and refreshing the recommendation never create measurements.
    if (!at || !state.sensorAt.people || countAge < 0 || countAge > 15_000 || !state.deviceOnline ||
        state.ac.power !== true || state.ac.mode !== 0 || state.pending || !numberInRange(state.roomTemp, 15, 45)) return;
    const last = comfortHistory.at(-1);
    if (last && at <= last.at) return;
    const reading = { at, temperature: state.roomTemp, people: state.people };
    if (last && last.people === reading.people && Math.floor(last.at / COMFORT_SAMPLE_MS) === Math.floor(at / COMFORT_SAMPLE_MS)) {
        // Keep the lowest measured value in the interval so a brief warm spike
        // cannot hide a cooler reading while limiting history to 50 samples.
        if (reading.temperature < last.temperature) comfortHistory[comfortHistory.length - 1] = reading;
        return;
    }
    comfortHistory.push(reading);
    while (comfortHistory.length > 50 || at - comfortHistory[0].at > 300_000) comfortHistory.shift();
}
function comfortMetrics() {
    const now = Date.now();
    const age = at => at ? Math.max(0, now - at) : null;
    const roomMatches = ['mqttUrl', 'command', 'status', 'temp', 'humid', 'people'].every(key => settings[key] === DEFAULTS[key]);
    const sensorFresh = isFreshSensor('temp') && isFreshSensor('humid') && isFreshSensor('people');
    const acAge = state.statusQuality === 'fresh' && state.deviceOnline ? age(state.lastStatusAt) : null;
    const voiceIdle = ['OFF', 'WAIT_CONTINUOUS', 'MIC_PAUSED'].includes(voiceController.state);
    return {
        observedAt: now, peopleStableMs: age(peopleStableSince),
        comfortHistory: comfortHistory.filter(row => row.at <= now && now - row.at <= 300_000),
        temperature: { value: state.roomTemp, ageMs: age(state.sensorAt.temp) },
        humidity: { value: state.humid, ageMs: age(state.sensorAt.humid) },
        people: { value: state.people, ageMs: age(state.sensorAt.people) },
        ac: { ...state.ac, ageMs: acAge },
        roomMatches, sensorFresh, mqttConnected: state.mqttConnected, pending: !!state.pending,
        canApply: roomMatches && sensorFresh && voiceIdle && state.mqttConnected && acAge !== null &&
            acAge < DEVICE_STALE_MS && !state.pending && state.ac.power === true && state.ac.mode === 0
    };
}
async function applyComfort({ target }) {
    const metrics = comfortMetrics(), settingRef = settings, connection = mqttClient, revision = state.requestCount;
    const reject = () => { if (!sessionEnded && !sessionSuspended) notice('ข้อมูลเปลี่ยนแล้ว กรุณาตรวจคำแนะนำล่าสุดก่อนกดใช้', 'warning'); return false; };
    if (!metrics.canApply || !Number.isInteger(target) || target < MIN_TEMP || target > MAX_TEMP ||
        Math.abs(target - metrics.ac.temp) !== 1) return reject();
    try {
        const response = await appFetch('/api/comfort/recommendation', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(metrics), signal: AbortSignal.timeout(3500), cache: 'no-store'
        });
        if (!response.ok) return reject();
        const { recommendation, pose } = await response.json();
        const receivedAt = Date.now();
        const validate = () => {
            const latest = comfortMetrics();
            return latest.canApply && settings === settingRef && mqttClient === connection && state.requestCount === revision &&
                pose?.activity && !pose.stale && Number.isFinite(pose.ageMs) && pose.ageMs + (Date.now() - receivedAt) <= 5000 && pose.activity.total_people === latest.people.value &&
                metrics.observedAt - metrics.peopleStableMs === latest.observedAt - latest.peopleStableMs &&
                recommendation?.status === 'suggested' && recommendation.target === target && recommendation.currentTarget === latest.ac.temp &&
                ['power', 'mode', 'fan', 'temp'].every(key => metrics.ac[key] === latest.ac[key]) &&
                ['temperature', 'humidity', 'people'].every(key => metrics[key].value === latest[key].value);
        };
        if (!validate()) return reject();
        return Boolean(await sendAcCommand({ ...state.ac, temp: target }, `ใช้อุณหภูมิแนะนำ ${target}°C`, { validate })) || reject();
    } catch (_) { return reject(); }
}
window.addEventListener('DOMContentLoaded', () => {
    $('ui-room-name').textContent = ROOM_NAME;
    loadSettings(); updateClock(); initChart(); renderThermostat(); renderEnvironment(); renderConnection();
    $('btn-logout')?.closest('form')?.addEventListener('submit', () => pauseDashboardSession(true));
    handsFreeStartup.install();
    void refreshDashboardSession();
    setInterval(() => { if (!sessionEnded && !sessionSuspended) updateClock(); }, 30000);
    setInterval(() => { if (sessionAuthorized) healthTick(); }, 1000);
    setInterval(() => { if (!document.hidden) void refreshDashboardSession(); }, 15000);
    setInterval(() => { if (commandAllowed()) requestDeviceStatus(false); }, 30000);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshDashboardSession(); });
window.addEventListener('pagehide', () => { if (!sessionEnded) pauseDashboardSession(); });
window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    if (sessionEnded) { location.replace('/login'); return; }
    if (!sessionSuspended) pauseDashboardSession();
    sessionSuspended = false;
    void refreshDashboardSession();
});

// Presentation is separate from local voice capture and its command/session safeguards.
function answerRoomQuestion(query) {
    const now = Date.now();
    let reading = null;
    if (state.mqttConnected) {
        if (query === 'room_temperature' && isFreshSensor('temp', now)) reading = state.roomTemp;
        else if (query === 'room_humidity' && isFreshSensor('humid', now)) reading = state.humid;
        else if (query === 'people_count' && isFreshSensor('people', now)) reading = state.people;
        else if ((query === 'ac_setpoint' || query === 'ac_power') && !state.pending && state.deviceOnline &&
            state.statusQuality === 'fresh' && state.lastStatusAt > 0 && now >= state.lastStatusAt && now - state.lastStatusAt < DEVICE_STALE_MS) {
            reading = query === 'ac_power' ? state.ac.power : state.ac.temp;
        }
    }
    return SmartVoiceFeedback.answerQuestion(query, reading);
}

const voiceLabels = {
    INIT: 'กำลังเตรียมไมค์และโมเดล',
    WAIT_CONTINUOUS: 'กำลังฟังคำเรียก “เอ็นจี้” หรือ “Engi”', READY: 'พูดได้เลย',
    WAIT_COMMAND: 'พูดคำสั่งได้เลย', CAPTURE_COMMAND: 'กำลังรับคำสั่ง',
    PROCESSING_COMMAND: 'กำลังประมวลผลคำสั่ง', DRAINING: 'กำลังรับประโยคถัดไป',
    SPEAKING: 'กำลังพูดตอบกลับ', MIC_PAUSED: 'ไมค์หยุดส่งเสียง · รอไมค์กลับมา', RECOVERING: 'กำลังเชื่อมระบบเสียงใหม่'
};
const voiceController = new SmartVoiceController({
    fetch: appFetch, id: () => crypto.randomUUID(), canStart: () => sessionAuthorized && !sessionEnded && !sessionSuspended,
    audio: callbacks => new SmartVoiceAudio.VoiceAudio(callbacks), wav: SmartVoiceAudio.wav,
    localModel: () => new SmartLocalSpeechRecognizer({ onStatus: text => logEvent('info', text) }),
    device: () => JSON.stringify([settings.mqttUrl, settings.command]),
    current: () => ({ ...currentDesired() }), revision: () => state.requestCount, pending: () => !!state.pending,
    send: sendAcCommand, answer: answerRoomQuestion, notice, log: logEvent, feedback: SmartVoiceFeedback.describe, variant: SmartVoiceFeedback.variant,
    onHandsFreeFault: error => handsFreeStartup.recover(error),
    onDirectEnd: () => handsFreeStartup.resume(),
    render: (phase, handsFree, label) => {
        const enabled = handsFreeStartup.enabled, directActive = !handsFree && phase !== 'OFF';
        const waitingForName = handsFree && !voiceController.wakeToken && !voiceController.followUp
            && ['WAIT_CONTINUOUS', 'CAPTURE_COMMAND', 'PROCESSING_COMMAND', 'DRAINING'].includes(phase);
        const checkingName = waitingForName && ['PROCESSING_COMMAND', 'DRAINING'].includes(phase);
        const status = waitingForName ? (checkingName ? label || 'กำลังตรวจคำเรียก Engi…' : voiceLabels.WAIT_CONTINUOUS) : label || voiceLabels[phase]
            || (enabled ? 'กำลังเตรียมกลับมาฟัง' : 'ปิดการรอเรียก Engi');
        const statusElement = $('engi-status');
        if (statusElement && statusElement.textContent !== status) statusElement.textContent = status;
        $('wake-btn-text').textContent = enabled ? 'เปิดรอเรียก Engi อยู่' : 'เปิดรับคำเรียก Engi';
        $('btn-wake-toggle').setAttribute('aria-pressed', String(enabled));
        const btn = $('btn-voice-cmd');
        btn.classList.toggle('is-listening', directActive);
        btn.setAttribute('aria-busy', String(directActive && ['INIT', 'PROCESSING_COMMAND', 'SPEAKING'].includes(phase)));
        btn.title = directActive ? 'กดเพื่อยกเลิกคำสั่งที่กำลังฟัง' : 'กดเพื่อพูดคำสั่งโดยไม่ต้องเรียกชื่อ';
        $('voice-btn-text').textContent = directActive ? 'ยกเลิกการฟังครั้งนี้' : 'กดเพื่อพูดกับเอ็นจี้';
    }
});
let voicePreferences;
try { voicePreferences = window.localStorage; } catch (_) { }
const handsFreeStartup = new SmartHandsFreeStartup({
    controller: voiceController, document, window, storage: voicePreferences,
    permission: () => navigator.permissions.query({ name: 'microphone' })
});
function toggleAlwaysOnWakeMode() {
    if (!sessionAuthorized) return;
    if (handsFreeStartup.enabled) handsFreeStartup.stopByUser();
    else void handsFreeStartup.startByUser();
}
function handleVoiceButtonClick() {
    if (!sessionAuthorized) return;
    if (voiceController.state !== 'OFF' && !voiceController.handsFree) {
        voiceController.finishDirect();
    } else {
        handsFreeStartup.pause();
        void voiceController.start(false);
    }
}
function voiceCommandResult(id, success, message) { voiceController.deviceResult(id, success, message); }
$('voice-btn-text').setAttribute('aria-live', 'polite');
