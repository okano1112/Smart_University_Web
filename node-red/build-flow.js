'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCira } = require('./normalize-cira');
const { CIRA_LOG_KEY, newCiraLog, recordCiraLog } = require('./cira-observability');
const { updatePoseActivity } = require('./pose-activity');
const { CIRA_POSE_KEY, POSE_MAX_AGE_MS, POSE_MAX_BODY_BYTES, handleCiraPose } = require('./cira-pose-bridge');

const tab = 'c1a5402000000001';
const broker = 'c1a5402000000002';
const input = 'c1a5402000000003';
const normalize = 'c1a5402000000004';
const output = 'c1a5402000000005';
const debug = 'c1a5402000000006';
const logsHttpIn = 'c1a5402000000013';
const logsRead = 'c1a5402000000014';
const logsHttpOut = 'c1a5402000000015';
const poseHttpIn = 'c1a5402000000016';
const poseIngest = 'c1a5402000000017';
const poseHttpOut = 'c1a5402000000018';
const activityHttpIn = 'c1a5402000000019';
const activityRead = 'c1a5402000000020';
const poseExpiry = 'c1a5402000000021';

function poseBody(method, useClassifier = false) {
    return `const handleCiraPose = ${handleCiraPose.toString()};
${useClassifier ? `const update = ${updatePoseActivity.toString()};` : 'const update = null;'}
return handleCiraPose(msg, ${method}, {flow, key:'${CIRA_POSE_KEY}', update,
    now:Date.now(), maxAgeMs:${POSE_MAX_AGE_MS}, maxBodyBytes:${POSE_MAX_BODY_BYTES}});`;
}

function buildFlow() {
    const func = `const normalizeCira = ${normalizeCira.toString()};
const newCiraLog = ${newCiraLog.toString()};
const recordCiraLog = ${recordCiraLog.toString()};
const now = Date.now();
const observe = (outcome, details) => {
    const log = flow.get('${CIRA_LOG_KEY}') || newCiraLog(now);
    const sampled = recordCiraLog(log, outcome, now, details);
    flow.set('${CIRA_LOG_KEY}', log);
    return sampled;
};
const numberSetting = (name,fallback) => {
    const value=env.get(name);
    return value === undefined || value === null || value === '' ? fallback : Number(value);
};
const maxAgeMs = numberSetting('CIRA_MAX_AGE_SECONDS',30) * 1000;
if (msg._ciraWatchdog === true) {
    const last = context.get('lastValidAt');
    if (!last || now - last > maxAgeMs) {
        node.status({fill:'red',shape:'ring',text:'รอข้อมูล CiRA ล่าสุด'});
        if (!context.get('staleShown')) {
            context.set('staleShown',true);
            observe('stale', { lastSeen: last || null });
            return [null,{payload:{event:'cira_stale',lastSeen:last || null}}];
        }
    }
    return null;
}
const outputTopic = String(env.get('CIRA_OUTPUT_TOPIC') || 'spu/classroom/cira');
const reject = (code,reason) => {
    node.status({fill:'yellow',shape:'ring',text:reason});
    const sampled = observe(msg._ciraTest === true ? 'test' : 'rejected', {code,reason,validatedAt:Date.now()});
    return [null,sampled ? {payload:{event:'cira_rejected',code,reason}} : null];
};
if (!outputTopic || /[+#\\u0000]/.test(outputTopic) || outputTopic === msg.topic) return reject('topic_loop','Topic รับและส่งต้องต่างกัน');
const result = normalizeCira(msg.payload,{
    now,source:'cira-core',retained:msg.retain === true,maxAgeMs,
    minConfidence:numberSetting('CIRA_MIN_CONFIDENCE',.5),includeProvenance:true
});
if (!result.ok) return reject(result.code,result.reason);
if (msg._ciraTest === true) {
    const sampled = observe('test', {totalPeople:result.data.total_people});
    return [null,sampled ? {payload:{event:'cira_test_only',wouldPublishTo:outputTopic,data:result.data}} : null];
}
const sampled = observe('forwarded', { totalPeople:result.data.total_people,
    sampleAt:result.data.timestamp,sampleTimeSource:result.sampleTimeSource,validatedAt:Date.now() });
context.set('lastValidAt',now);context.set('staleShown',false);
node.status({fill:'green',shape:'dot',text:'CiRA: '+result.data.total_people+' คน'});
return [{topic:outputTopic,payload:JSON.stringify(result.data),qos:0,retain:false},
    sampled ? {payload:{event:'cira_forwarded',topic:outputTopic,total_people:result.data.total_people,at:result.data.received_at}} : null];`;

    const readLogs = `const now = Date.now();
msg.headers = {'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
// Check the socket peer, not user-controlled forwarding headers.
if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(msg.req?.socket?.remoteAddress)) {
    msg.statusCode = 403;
    msg.payload = JSON.stringify({success:false,message:'CiRA logs are available on localhost only'});
    return msg;
}
const log = flow.get('${CIRA_LOG_KEY}');
msg.statusCode = 200;
// Send a JSON string to disable the HTTP response node's JSONP handling.
msg.payload = JSON.stringify({source:'cira',serverTime:now,
    counters:log?.counters || {received:0,forwarded:0,rejected:0,tests:0},events:log?.events || []});
return msg;`;

    return [
        { id: tab, type: 'tab', label: 'CiRA CORE → Classroom Web', disabled: false,
            info: 'Receives CiRA CORE counts from broker.emqx.io:1883, spu/classroom/room/person. Validates counts and forwards nonretained telemetry to the existing web topic. No AC commands or automatic control. Keep only one copy of this bridge active.',
            env: [
                { name: 'CIRA_OUTPUT_TOPIC', value: 'spu/classroom/cira', type: 'str' },
                { name: 'CIRA_MAX_AGE_SECONDS', value: '30', type: 'num' },
                { name: 'CIRA_MIN_CONFIDENCE', value: '0.5', type: 'num' }
            ] },
        { id: broker, type: 'mqtt-broker', name: 'CiRA / Web • broker.emqx.io', broker: 'broker.emqx.io', port: '1883', clientid: '',
            autoConnect: true, usetls: false, protocolVersion: '4', keepalive: '30', cleansession: true, autoUnsubscribe: true,
            birthTopic: '', birthQos: '0', birthPayload: '', birthMsg: {}, closeTopic: '', closeQos: '0', closePayload: '', closeMsg: {},
            willTopic: '', willQos: '0', willPayload: '', willMsg: {} },
        { id: 'c1a5402000000010', type: 'comment', z: tab, name: 'CiRA MQTT → ตรวจจำนวนคน → เว็บเดิม',
            info: 'CiRA publishes {"total_people":2} to spu/classroom/room/person every 1–5 seconds, retain=false. Web listens to spu/classroom/cira on WSS port 8084. MQTT input and output use the same broker; input/output topics must differ.', x: 310, y: 60, wires: [] },
        { id: input, type: 'mqtt in', z: tab, name: 'CiRA • spu/classroom/room/person', topic: 'spu/classroom/room/person',
            qos: '0', datatype: 'utf8', broker, nl: false, rap: true, rh: 0, inputs: 0, x: 215, y: 150, wires: [[normalize]] },
        { id: normalize, type: 'function', z: tab, name: 'ตรวจข้อมูล CiRA + freshness', func, outputs: 2, timeout: 1, noerr: 0,
            initialize: `context.set('lastValidAt',0);context.set('staleShown',false);flow.set('${CIRA_LOG_KEY}',(${newCiraLog.toString()})(Date.now()));node.status({fill:'grey',shape:'ring',text:'รอ CiRA CORE'});`,
            finalize: '', libs: [], x: 570, y: 150, wires: [[output], [debug]] },
        { id: output, type: 'mqtt out', z: tab, name: 'จำนวนคน → เว็บ (nonretained)', topic: '', qos: '0', retain: 'false',
            respTopic: '', contentType: '', userProps: '', correl: '', expiry: '', broker, x: 925, y: 120, wires: [] },
        { id: debug, type: 'debug', z: tab, name: 'CiRA bridge events', active: true, tosidebar: true, console: false, tostatus: false,
            complete: 'payload', targetType: 'msg', statusVal: '', statusType: 'auto', x: 920, y: 205, wires: [] },
        { id: 'c1a5402000000007', type: 'inject', z: tab, name: 'ตรวจข้อมูลขาดหาย (ทุก 5 วินาที)',
            props: [{ p: '_ciraWatchdog', v: 'true', vt: 'bool' }], repeat: '5', crontab: '', once: true, onceDelay: '2',
            x: 220, y: 225, wires: [[normalize]] },
        { id: 'c1a5402000000008', type: 'inject', z: tab, name: 'ทดสอบ 2 คน • ไม่ส่ง MQTT',
            props: [{ p: 'payload' }, { p: 'topic', v: 'local-test', vt: 'str' }, { p: '_ciraTest', v: 'true', vt: 'bool' }],
            repeat: '', crontab: '', once: false, onceDelay: '.1', payload: '{"total_people":2}', payloadType: 'json',
            x: 215, y: 300, wires: [[normalize]] },
        { id: 'c1a5402000000009', type: 'status', z: tab, name: 'สถานะ MQTT socket', scope: [input, output],
            x: 565, y: 375, wires: [[debug]] },
        { id: 'c1a5402000000011', type: 'catch', z: tab, name: 'ข้อผิดพลาดของ bridge', scope: [normalize], uncaught: false,
            x: 565, y: 435, wires: [[debug]] },
        { id: 'c1a5402000000012', type: 'comment', z: tab, name: 'แก้ Broker ที่โหนด MQTT / ค่าอื่นที่ Environment ของแท็บ',
            info: 'CIRA_OUTPUT_TOPIC defaults to spu/classroom/cira. CIRA_MAX_AGE_SECONDS defaults to30. The watchdog reports stale data only; it never republishes old counts and never changes the air conditioner.', x: 385, y: 510, wires: [] },
        { id: logsHttpIn, type: 'http in', z: tab, name: 'CiRA logs • localhost', url: '/cira-observability', method: 'get',
            upload: false, x: 205, y: 580, wires: [[logsRead]] },
        { id: logsRead, type: 'function', z: tab, name: 'อ่านเหตุการณ์ล่าสุดและยอดรวม', func: readLogs, outputs: 1, timeout: 1, noerr: 0,
            initialize: '', finalize: '', libs: [], x: 565, y: 580, wires: [[logsHttpOut]] },
        { id: logsHttpOut, type: 'http response', z: tab, name: 'JSON • no-store', statusCode: '', headers: {}, x: 920, y: 580, wires: [] },
        { id: poseHttpIn, type: 'http in', z: tab, name: 'POST pose • localhost', url: '/cira-pose-frame', method: 'post',
            upload: false, skipBodyParsing: false, x: 215, y: 680, wires: [[poseIngest]] },
        { id: poseIngest, type: 'function', z: tab, name: 'จำแนกท่าทางจาก COCO keypoints',
            func: poseBody("msg._poseExpiry === true ? 'EXPIRE' : 'POST'", true), outputs: 1, timeout: 1, noerr: 0,
            initialize: `flow.set('${CIRA_POSE_KEY}', null);`, finalize: '', libs: [], x: 565, y: 680, wires: [[poseHttpOut]] },
        { id: activityHttpIn, type: 'http in', z: tab, name: 'GET activity • localhost', url: '/cira-activity', method: 'get',
            upload: false, x: 215, y: 820, wires: [[activityRead]] },
        { id: activityRead, type: 'function', z: tab, name: 'อ่านผลรวมท่าทาง • ไม่ส่งข้อมูลดิบ',
            func: poseBody("'GET'"), outputs: 1, timeout: 1, noerr: 0, initialize: '', finalize: '', libs: [],
            x: 565, y: 820, wires: [[poseHttpOut]] },
        { id: poseHttpOut, type: 'http response', z: tab, name: 'Pose / activity JSON • no-store', statusCode: '', headers: {}, x: 930, y: 720, wires: [] },
        { id: poseExpiry, type: 'inject', z: tab, name: 'ล้างสถานะติดตามเก่า (ทุก 2 วินาที)', props: [{ p: '_poseExpiry', v: 'true', vt: 'bool' }],
            repeat: '2', crontab: '', once: false, onceDelay: '.1', x: 225, y: 740, wires: [[poseIngest]] }
    ];
}

if (require.main === module) {
    const destination = path.resolve(__dirname, '../node_red_cira_bridge_flow.json');
    fs.writeFileSync(destination, JSON.stringify(buildFlow(), null, 2) + '\n');
    console.log(`Created ${destination}`);
}
module.exports = { buildFlow };
