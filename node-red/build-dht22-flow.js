'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INPUT_TOPIC = 'spu/classroom/environment/dht22';
const OUTPUT_TOPIC = 'spu/classroom/environment';
const MAX_AGE_MS = 30_000;
const MAX_FUTURE_MS = 5_000;
const MAX_TEMP_SPREAD = 2;

function validateReading(raw, retained, readings, now) {
    if (retained) return { reason: 'retained' };
    if (typeof raw !== 'string' || raw.length > 2048) return { reason: 'invalid_payload' };
    let value;
    try { value = JSON.parse(raw); }
    catch (_) { return { reason: 'invalid_payload' }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: 'invalid_payload' };

    const { sensor_id: id, temperature, humidity, captured_at } = value;
    if (id !== 'A' && id !== 'B') return { reason: 'invalid_sensor' };
    if (!Number.isFinite(temperature) || temperature < -40 || temperature > 80 ||
        !Number.isFinite(humidity) || humidity < 0 || humidity > 100) return { reason: 'invalid_reading' };
    if (!Number.isSafeInteger(captured_at) || captured_at <= 0) return { reason: 'invalid_timestamp' };
    if (now - captured_at >= MAX_AGE_MS) return { reason: 'stale_sample' };
    if (captured_at - now > MAX_FUTURE_MS) return { reason: 'future_sample' };
    if (readings[id] && captured_at <= readings[id].captured_at) return { reason: 'out_of_order' };
    return { id, reading: { temperature, humidity, captured_at } };
}

function makeSnapshot(readings, now) {
    const inspect = reading => {
        if (!reading) return { state: 'waiting', reading: null };
        const stale = now - reading.captured_at >= MAX_AGE_MS || reading.captured_at - now > MAX_FUTURE_MS;
        return { state: stale ? 'stale' : 'fresh', reading };
    };
    const A = inspect(readings.A);
    const B = inspect(readings.B);
    const data = { source: 'dht22', generated_at: now, state: 'waiting', sensors: { A, B }, room: null };
    if (A.state === 'stale' || B.state === 'stale') data.state = 'stale';
    else if (A.state === 'fresh' && B.state === 'fresh') {
        if (Math.abs(A.reading.temperature - B.reading.temperature) > MAX_TEMP_SPREAD + 1e-9) data.state = 'divergent';
        else {
            data.state = 'ready';
            data.room = {
                temperature: (A.reading.temperature + B.reading.temperature) / 2,
                humidity: (A.reading.humidity + B.reading.humidity) / 2
            };
        }
    }
    return data;
}

function buildDht22Flow() {
    const source = fn => fn.toString().replace(/\r\n/g, '\n');
    const shared = `const MAX_AGE_MS = ${MAX_AGE_MS};
const MAX_FUTURE_MS = ${MAX_FUTURE_MS};
const MAX_TEMP_SPREAD = ${MAX_TEMP_SPREAD};
const validateReading = ${source(validateReading)};
const makeSnapshot = ${source(makeSnapshot)};`;
    const live = `${shared}
const now = Date.now();
const readings = context.get('readings') || {};
const watchdog = msg._dht22Watchdog === true;
if (watchdog && !readings.A && !readings.B) return null;
if (!watchdog) {
    const result = validateReading(msg.payload, msg.retain === true, readings, now);
    if (result.reason) return [null, {payload:{event:'dht22_rejected',reason:result.reason}}];
    readings[result.id] = result.reading;
    context.set('readings', readings);
}
const snapshot = makeSnapshot(readings, now);
const states = [snapshot.sensors.A.state, snapshot.sensors.B.state].join('/');
if (watchdog && (snapshot.state !== 'stale' || states === context.get('publishedStates'))) return null;
context.set('publishedStates', states);
const styles = {
    waiting: {fill:'grey',shape:'ring',text:'รอข้อมูล DHT22 ครบสองจุด'},
    stale: {fill:'red',shape:'ring',text:'ข้อมูล DHT22 ขาดช่วง'},
    divergent: {fill:'yellow',shape:'ring',text:'อุณหภูมิสองจุดต่างกันเกิน 2°C'},
    ready: {fill:'green',shape:'dot',text:'ข้อมูล DHT22 สองจุดพร้อม'}
};
node.status(styles[snapshot.state]);
return [{topic:'${OUTPUT_TOPIC}',payload:JSON.stringify(snapshot),qos:0,retain:false},
    {payload:{event:'dht22_snapshot',snapshot}}];`;
    const simulate = `${shared}
const now = Date.now();
const readings = {};
const sampleA = {sensor_id:'A',temperature:25,humidity:50,captured_at:now};
const sampleB = {sensor_id:'B',temperature:26,humidity:54,captured_at:now};
const examples = {
    ready: [sampleA, sampleB],
    missing: [sampleA],
    divergent: [sampleA, {...sampleB,temperature:29}]
};
const samples = examples[msg.payload];
if (!Array.isArray(samples)) return null;
for (const sample of samples) {
    const result = validateReading(JSON.stringify(sample), false, readings, now);
    if (result.reason) return {payload:{event:'dht22_test',scenario:msg.payload,reason:result.reason}};
    readings[result.id] = result.reading;
}
return {payload:{event:'dht22_test',scenario:msg.payload,snapshot:makeSnapshot(readings, now)}};`;

    const tab = 'd422000000000001';
    const broker = 'd422000000000002';
    const liveId = 'd422000000000004';
    const output = 'd422000000000005';
    const liveDebug = 'd422000000000006';
    const simulation = 'd422000000000011';
    const testDebug = 'd422000000000012';
    const testInject = (id, name, payload, y) => ({
        id, type: 'inject', z: tab, name, props: [{ p: 'payload' }], repeat: '', crontab: '',
        once: false, onceDelay: 0.1, payload, payloadType: 'str', x: 210, y, wires: [[simulation]]
    });

    return [
        { id: tab, type: 'tab', label: 'DHT22 • Classroom Environment', disabled: false,
            info: 'รับค่าจาก DHT22 จุด A และ B ตรวจเวลาที่วัด และเผยแพร่ข้อมูลสภาพห้องผ่าน MQTT เฉพาะเพื่ออ่านค่า', env: [] },
        { id: broker, type: 'mqtt-broker', name: 'DHT22 • broker.emqx.io', broker: 'broker.emqx.io', port: '1883',
            clientid: '', autoConnect: true, usetls: false, protocolVersion: '4', keepalive: '30', cleansession: true,
            autoUnsubscribe: true, birthTopic: '', closeTopic: '', willTopic: '' },
        { id: 'd422000000000003', type: 'mqtt in', z: tab, name: 'DHT22 สองจุด A และ B', topic: INPUT_TOPIC,
            qos: '0', datatype: 'utf8', broker, nl: false, rap: true, rh: 0, inputs: 0, x: 210, y: 100, wires: [[liveId]] },
        { id: liveId, type: 'function', z: tab, name: 'ตรวจค่าจริงและรวมข้อมูลห้อง', func: live, outputs: 2, timeout: 1, noerr: 0,
            initialize: "context.set('readings', {});context.set('publishedStates',null);node.status({fill:'grey',shape:'ring',text:'รอข้อมูล DHT22 ครบสองจุด'});",
            finalize: '', libs: [], x: 530, y: 100, wires: [[output], [liveDebug]] },
        { id: output, type: 'mqtt out', z: tab, name: 'สภาพห้อง → MQTT (nonretained)', topic: OUTPUT_TOPIC,
            qos: '0', retain: 'false', broker, x: 880, y: 80, wires: [] },
        { id: liveDebug, type: 'debug', z: tab, name: 'DHT22 • ข้อมูลจริง', active: false, tosidebar: true,
            console: false, tostatus: false, complete: 'payload', targetType: 'msg', x: 865, y: 140, wires: [] },
        { id: 'd422000000000007', type: 'inject', z: tab, name: 'ตรวจข้อมูลขาดช่วงทุก 5 วินาที',
            props: [{ p: '_dht22Watchdog', v: 'true', vt: 'bool' }], repeat: '5', crontab: '', once: false,
            onceDelay: 0.1, x: 215, y: 165, wires: [[liveId]] },
        testInject('d422000000000008', 'ทดสอบ • สองจุดพร้อม', 'ready', 260),
        testInject('d422000000000009', 'ทดสอบ • ขาดข้อมูลจุด B', 'missing', 320),
        testInject('d422000000000010', 'ทดสอบ • สองจุดต่างกัน', 'divergent', 380),
        { id: simulation, type: 'function', z: tab, name: 'ทดสอบกฎด้วยข้อมูลจำลอง', func: simulate,
            outputs: 1, timeout: 1, noerr: 0, initialize: '', finalize: '', libs: [], x: 530, y: 320, wires: [[testDebug]] },
        { id: testDebug, type: 'debug', z: tab, name: 'DHT22 • ผลจำลองใน Debug', active: true, tosidebar: true,
            console: false, tostatus: false, complete: 'payload', targetType: 'msg', x: 870, y: 320, wires: [] }
    ];
}

if (require.main === module) {
    const destination = path.resolve(__dirname, '../node_red_dht22_environment_flow.json');
    fs.writeFileSync(destination, JSON.stringify(buildDht22Flow(), null, 2) + '\n');
    console.log(`Created ${destination}`);
}

module.exports = { buildDht22Flow };
