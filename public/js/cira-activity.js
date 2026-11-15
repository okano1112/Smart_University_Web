(function (root) {
    'use strict';

    const FRESH_ACTIVITY_MS = 5000;
    const FRESH_RECOMMENDATION_MS = 10_000;
    const FRESH_SENSOR_MS = 30_000;
    const FRESH_AC_MS = 75_000;
    const COMFORT_HISTORY_MS = 5 * 60_000;
    const MAX_COMFORT_SAMPLES = 50;
    const ACTIVITY_KEYS = ['seated', 'standing', 'walking', 'running', 'unknown'];
    const STAGES = {
        received: 'รับข้อมูลกิจกรรม',
        classified: 'จำแนกกิจกรรมแล้ว',
        rejected: 'ข้ามข้อมูลกิจกรรม',
        stale: 'ข้อมูลกิจกรรมหมดอายุ'
    };
    const REJECTIONS = {
        INVALID_FRAME: 'รูปแบบข้อมูลกิจกรรมไม่ถูกต้อง',
        PROCESSING_ERROR: 'ประมวลผลกิจกรรมไม่สำเร็จ',
        CONTENT_TYPE: 'ไม่รองรับชนิดข้อมูล',
        TOO_LARGE: 'ข้อมูลเกินขนาดที่รองรับ'
    };
    const RECOMMENDATION_LABELS = { suggested: 'มีคำแนะนำ', hold: 'คงอุณหภูมิเดิม', unavailable: 'ยังให้คำแนะนำไม่ได้' };
    const timeFormat = new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const range = (value, lo, hi) => Number.isFinite(value) && value >= lo && value <= hi;
    const stamp = value => Number.isSafeInteger(value) && range(value, 1, 8.64e15) ? value : null;
    const age = value => range(value, 0, Number.MAX_SAFE_INTEGER) ? value : null;
    const count = value => Number.isInteger(value) && range(value, 0, 1000);
    const target = value => Number.isInteger(value) && range(value, 21, 27);
    const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
    const clock = at => stamp(at) ? timeFormat.format(at) : '—';

    function readMetrics(value) {
        const input = object(value) ? value : {};
        const result = {};
        for (const [key, min, max] of [['temperature', -10, 60], ['humidity', 0, 100], ['people', 0, 1000]]) {
            const measurement = input[key];
            if (object(measurement) && range(measurement.value, min, max) && (key !== 'people' || count(measurement.value)) && age(measurement.ageMs) !== null) {
                result[key] = { value: measurement.value, ageMs: measurement.ageMs };
            }
        }
        if (object(input.ac)) {
            result.ac = {};
            if (typeof input.ac.power === 'boolean') result.ac.power = input.ac.power;
            if (target(input.ac.temp)) result.ac.temp = input.ac.temp;
            if ([0, 1, 2].includes(input.ac.mode)) result.ac.mode = input.ac.mode;
            if ([0, 1, 2, 3].includes(input.ac.fan)) result.ac.fan = input.ac.fan;
            if (age(input.ac.ageMs) !== null) result.ac.ageMs = input.ac.ageMs;
        }
        for (const key of ['roomMatches', 'mqttConnected', 'canApply', 'pending', 'sensorFresh']) {
            if (typeof input[key] === 'boolean') result[key] = input[key];
        }
        const observedAt = stamp(input.observedAt);
        if (observedAt) {
            result.observedAt = observedAt;
            if (age(input.peopleStableMs) !== null && input.peopleStableMs <= observedAt) result.peopleStableMs = input.peopleStableMs;
            if (Array.isArray(input.comfortHistory)) {
                let previousAt = 0;
                result.comfortHistory = input.comfortHistory.slice(-MAX_COMFORT_SAMPLES).flatMap(sample => {
                    if (!object(sample) || !stamp(sample.at) || sample.at <= previousAt ||
                        !range(observedAt - sample.at, 0, COMFORT_HISTORY_MS) ||
                        !range(sample.temperature, -10, 60) || !count(sample.people)) return [];
                    previousAt = sample.at;
                    return [{ at: sample.at, temperature: sample.temperature, people: sample.people }];
                });
            }
        }
        return result;
    }

    function parseCounts(value) {
        if (!object(value) || !count(value.total_people) || !ACTIVITY_KEYS.every(key => count(value[key]))) return null;
        const counts = Object.fromEntries(ACTIVITY_KEYS.map(key => [key, value[key]]));
        if (ACTIVITY_KEYS.reduce((total, key) => total + counts[key], 0) !== value.total_people) return null;
        return { total_people: value.total_people, ...counts };
    }

    function parseResult(data) {
        if (!object(data) || !stamp(data.serverTime)) throw new Error('Invalid recommendation response');
        let pose = null;
        if (object(data.pose) && data.pose.source === 'cira' && stamp(data.pose.serverTime)) {
            const raw = data.pose;
            const capture = stamp(raw.activity?.captured_at), receipt = stamp(raw.lastReceivedAt), counts = parseCounts(raw.activity);
            pose = {
                serverTime: raw.serverTime, lastReceivedAt: receipt, ageMs: age(raw.ageMs), stale: raw.stale !== false,
                activity: counts && capture ? { ...counts, captured_at: capture } : null,
                events: (Array.isArray(raw.events) ? raw.events.slice(-50) : []).flatMap(event => {
                    if (!object(event) || !stamp(event.at) || !Object.hasOwn(STAGES, event.stage)) return [];
                    return [{ at: event.at, stage: event.stage, code: Object.hasOwn(REJECTIONS, event.code) ? event.code : null,
                        activity: event.stage === 'classified' ? parseCounts(event.activity) : null }];
                }).sort((a, b) => b.at - a.at).slice(0, 12)
            };
        }
        const raw = data.recommendation;
        let recommendation = null;
        if (object(raw) && Object.hasOwn(RECOMMENDATION_LABELS, raw.status) && stamp(raw.calculatedAt)) {
            const next = target(raw.target) ? raw.target : null;
            const current = target(raw.currentTarget) ? raw.currentTarget : null;
            const validSuggestion = next !== null && current !== null && Math.abs(next - current) === 1 && raw.delta === next - current;
            if (raw.status !== 'suggested' || validSuggestion) {
                recommendation = {
                    status: raw.status, target: next, currentTarget: current,
                    delta: validSuggestion ? raw.delta : null, calculatedAt: raw.calculatedAt,
                    reason: text(raw.reason), evidence: (Array.isArray(raw.evidence) ? raw.evidence.slice(0, 6) : []).map(value => text(value, 150)).filter(Boolean)
                };
            }
        }
        return { serverTime: data.serverTime, pose, recommendation };
    }

    function activityAge(record, now) {
        const pose = record?.data.pose;
        if (!pose?.activity || pose.stale || !pose.lastReceivedAt) return Infinity;
        const captureAge = pose.serverTime - pose.activity.captured_at;
        const receiveAge = pose.serverTime - pose.lastReceivedAt;
        if (captureAge < 0 || receiveAge < 0) return Infinity;
        return Math.max(captureAge, receiveAge, pose.ageMs ?? 0) + Math.max(0, now - record.receivedAt);
    }

    function canApply(recommendation, current) {
        const validSensor = key => !!current[key] && age(current[key].ageMs) !== null && current[key].ageMs < FRESH_SENSOR_MS;
        return recommendation?.status === 'suggested' && target(recommendation.target) && target(recommendation.currentTarget)
            && Math.abs(recommendation.delta) === 1 && recommendation.target === recommendation.currentTarget + recommendation.delta
            && current.roomMatches === true && current.mqttConnected === true && current.canApply === true && current.pending === false
            && current.sensorFresh === true && validSensor('temperature') && validSensor('humidity')
            && current.ac?.power === true && current.ac.mode === 0 && current.ac.temp === recommendation.currentTarget
            && age(current.ac.ageMs) !== null && current.ac.ageMs < FRESH_AC_MS;
    }

    function install({ document = root.document, metrics = () => ({}), apply, fetch = (...args) => root.fetch(...args),
        refreshMs = 3000, now = Date.now } = {}) {
        const $ = id => document?.getElementById(id);
        if (!$('cira-activity-panel')) return null;
        const logs = $('cira-logs'), logRefresh = $('cira-log-refresh'), button = $('cira-comfort-apply');
        let record = null, network = 'loading', request = null, pollTimer = null, renderTimer = null;
        let stopped = false, applying = false, feedback = '', logKey = '';
        const visible = () => !stopped && document.visibilityState !== 'hidden';
        const update = (id, value) => { const node = $(id); if (node.textContent !== value) node.textContent = value; };
        function setStatus(id, value, state = '') {
            const node = $(id);
            if (node.dataset.state !== state) node.dataset.state = state;
            update(id, value);
        }
        function currentMetrics() {
            try { return readMetrics(metrics()); } catch (_) { return {}; }
        }
        function view(current, at) {
            const snapshot = network === 'ready' ? record : null;
            const pose = snapshot?.data.pose;
            const elapsed = activityAge(snapshot, at);
            const activity = elapsed <= FRESH_ACTIVITY_MS ? pose.activity : null;
            const parsed = snapshot?.data.recommendation;
            const ageMs = parsed ? snapshot.data.serverTime - parsed.calculatedAt + Math.max(0, at - snapshot.receivedAt) : Infinity;
            const sent = snapshot?.metrics;
            const sameInputs = sent && ['temperature', 'humidity', 'people'].every(key => sent[key]?.value === current[key]?.value) &&
                ['power', 'mode', 'temp', 'fan'].every(key => sent.ac?.[key] === current.ac?.[key]) &&
                (sent.observedAt - sent.peopleStableMs === current.observedAt - current.peopleStableMs ||
                    (sent.peopleStableMs === undefined && current.peopleStableMs === undefined));
            const recommendation = ageMs >= 0 && ageMs <= FRESH_RECOMMENDATION_MS &&
                (parsed.status !== 'suggested' || (activity && current.roomMatches === true && sameInputs)) ? parsed : null;
            return { pose, activity, elapsed, recommendation };
        }
        function summarize(a) { return `นั่ง ${a.seated} · ยืน ${a.standing} · เดิน ${a.walking} · วิ่ง ${a.running} · ไม่ทราบ ${a.unknown}`; }
        function renderLog(at) {
            if (!logs?.open) return;
            const data = record?.data, events = data?.pose?.events || [], recommendation = data?.recommendation;
            const received = events.find(event => event.stage === 'received');
            const checked = events.find(event => ['classified', 'rejected', 'stale'].includes(event.stage));
            update('cira-activity-log-received', received ? `Node-RED รับเมื่อ ${clock(received.at)}` : 'ยังไม่พบข้อมูลเข้า');
            update('cira-activity-log-classified', checked ? `${STAGES[checked.stage]} · ${clock(checked.at)}` : 'ยังไม่พบผลจำแนก');
            const outcome = recommendation ? RECOMMENDATION_LABELS[recommendation.status] : '';
            const proposed = recommendation?.status === 'suggested' ? ` ${recommendation.target}°C` : '';
            update('cira-activity-log-comfort', recommendation ? `${outcome}${proposed} · ${clock(recommendation.calculatedAt)}` : 'ยังไม่มีผลคำนวณ');
            const reasons = [recommendation?.reason];
            if (network === 'error') reasons.push(record ? 'ติดต่อเซิร์ฟเวอร์ไม่ได้ · กำลังแสดงบันทึกที่อ่านได้ครั้งล่าสุด' : 'ติดต่อเซิร์ฟเวอร์เพื่ออ่านบันทึกไม่ได้');
            else if (record && at - record.receivedAt > FRESH_RECOMMENDATION_MS) reasons.push('ผลคำนวณที่แสดงเป็นบันทึกย้อนหลัง');
            $('cira-activity-log-note').hidden = !reasons.some(Boolean);
            update('cira-activity-log-note', reasons.filter(Boolean).join(' · '));

            const key = JSON.stringify(events);
            if (key === logKey) return;
            logKey = key;
            const items = events.map(event => {
                const row = document.createElement('li'); row.className = 'cira-log-event';
                if (event.stage === 'rejected' || event.stage === 'stale') row.dataset.level = 'warning';
                const time = document.createElement('time');
                time.textContent = clock(event.at); time.dateTime = new Date(event.at).toISOString();
                const content = document.createElement('div');
                const title = document.createElement('strong'); title.textContent = STAGES[event.stage]; content.append(title);
                const description = event.activity ? `${event.activity.total_people} คน · ${summarize(event.activity)}` : REJECTIONS[event.code] || '';
                if (description) {
                    const detail = document.createElement('p'); detail.className = 'cira-log-event-detail'; detail.textContent = description; content.append(detail);
                }
                row.append(time, content);
                return row;
            });
            if (!items.length) {
                const row = document.createElement('li'); row.className = 'cira-log-empty'; row.textContent = 'ยังไม่มีเหตุการณ์กิจกรรม'; items.push(row);
            }
            $('cira-activity-log-events').replaceChildren(...items);
        }

        function render() {
            if (!visible()) return;
            const at = now(), current = currentMetrics(), { activity, pose, elapsed, recommendation } = view(current, at);
            const connectionFailed = network === 'error' || (network === 'ready' && !pose);
            const expired = !activity && (pose?.activity || pose?.lastReceivedAt);
            setStatus('cira-activity-status', activity ? `ตรวจพบในผลล่าสุด ${activity.total_people} คน`
                : network === 'loading' ? 'กำลังตรวจข้อมูลกิจกรรม…'
                    : connectionFailed ? 'ติดต่อข้อมูลกิจกรรมไม่ได้' : expired ? 'ข้อมูลกิจกรรมหมดอายุ' : 'ยังไม่มีข้อมูลกิจกรรม',
            activity ? 'ready' : connectionFailed || expired ? 'warning' : '');
            for (const key of ACTIVITY_KEYS) update(`cira-${key}`, activity ? String(activity[key]) : '—');
            $('cira-activity-freshness').hidden = !activity;
            update('cira-activity-freshness', activity ? `อัปเดต ${clock(activity.captured_at)} · ${Math.floor(elapsed / 1000)} วินาทีที่แล้ว` : '');

            const suggested = recommendation?.status === 'suggested';
            $('cira-comfort-value').hidden = !suggested;
            update('cira-comfort-target', suggested ? `${recommendation.target}°C` : '');
            update('cira-comfort-delta', suggested ? `${recommendation.delta < 0 ? 'ลด' : 'เพิ่ม'} ${Math.abs(recommendation.delta)}°C จากที่ตั้ง ${recommendation.currentTarget}°C` : '');
            const recLabel = recommendation ? RECOMMENDATION_LABELS[recommendation.status]
                : network === 'loading' ? 'กำลังรอคำแนะนำ…' : 'ยังให้คำแนะนำไม่ได้';
            setStatus('cira-comfort-status', recLabel, suggested ? 'ready' : recLabel === 'ยังให้คำแนะนำไม่ได้' ? 'warning' : '');
            update('cira-comfort-reason', recommendation?.reason || (network === 'error' ? 'ติดต่อเซิร์ฟเวอร์เพื่อคำนวณคำแนะนำไม่ได้'
                : current.roomMatches === false ? 'การเชื่อมต่อหน้านี้ไม่ตรงกับห้องที่ผูกกับกล้อง'
                    : network === 'ready' ? 'รอข้อมูลกิจกรรมและสภาพห้องล่าสุด' : ''));
            const evidence = $('cira-comfort-evidence'), findings = recommendation?.evidence || [];
            if (Array.from(evidence.children).map(node => node.textContent).join('\n') !== findings.join('\n')) {
                evidence.replaceChildren(...findings.map(finding => { const item = document.createElement('li'); item.textContent = finding; return item; }));
            }
            evidence.hidden = !findings.length;
            button.hidden = typeof apply !== 'function' || (!suggested && !applying);
            button.disabled = applying || !suggested || !canApply(recommendation, current);
            button.textContent = applying ? 'กำลังตรวจสอบ…' : 'ใช้คำแนะนำ';
            $('cira-comfort-feedback').hidden = !feedback;
            update('cira-comfort-feedback', feedback);
            renderLog(at);
        }

        function refresh() {
            if (!visible()) return Promise.resolve();
            if (request) return request.promise;
            clearTimeout(pollTimer); pollTimer = null;
            const task = { controller: new AbortController(), promise: null };
            request = task;
            task.promise = (async () => {
                const timeout = setTimeout(() => task.controller.abort(), 4000);
                try {
                    const sent = currentMetrics();
                    const response = await fetch('/api/comfort/recommendation', { method: 'POST', cache: 'no-store',
                        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: JSON.stringify(sent), signal: task.controller.signal });
                    if (!response.ok) throw new Error('Recommendation unavailable');
                    const data = parseResult(await response.json());
                    if (request !== task || !visible()) return;
                    record = { data, receivedAt: now(), metrics: sent }; network = 'ready';
                } catch (_) {
                    if (request === task && visible()) network = 'error';
                } finally {
                    clearTimeout(timeout);
                    if (request === task) {
                        request = null;
                        render();
                        if (visible()) pollTimer = setTimeout(refresh, refreshMs);
                    }
                }
            })();
            return task.promise;
        }
        async function handleApply() {
            if (!visible() || applying || typeof apply !== 'function') return;
            const current = currentMetrics(), { recommendation } = view(current, now());
            if (!canApply(recommendation, current)) { render(); return; }
            applying = true; feedback = 'กำลังตรวจข้อมูลล่าสุดก่อนส่งคำสั่ง…'; render();
            try {
                const submitted = await apply({ target: recommendation.target, delta: recommendation.delta, recommendation });
                feedback = submitted === false ? 'ยังไม่ได้ส่งคำสั่ง เพราะสถานะหรือคำแนะนำล่าสุดเปลี่ยนไป'
                    : `ส่งคำสั่งตั้ง ${recommendation.target}°C แล้ว · รอ ESP32 รายงานสถานะ`;
            } catch (_) {
                feedback = 'ส่งคำสั่งไม่ได้ กรุณาตรวจการเชื่อมต่อแล้วลองใหม่';
            } finally {
                applying = false; render(); void refresh();
            }
        }
        function cancelPolling() {
            clearInterval(renderTimer); renderTimer = null;
            clearTimeout(pollTimer); pollTimer = null;
            const active = request; request = null; active?.controller.abort();
        }
        function syncVisibility() {
            if (!visible()) { cancelPolling(); return; }
            if (renderTimer === null) renderTimer = setInterval(render, 1000);
            render(); void refresh();
        }
        function stop() {
            stopped = true; cancelPolling();
            button.removeEventListener('click', handleApply);
            logs?.removeEventListener('toggle', render);
            logRefresh?.removeEventListener('click', refresh);
            document.removeEventListener('visibilitychange', syncVisibility);
        }
        button.addEventListener('click', handleApply);
        logs?.addEventListener('toggle', render);
        logRefresh?.addEventListener('click', refresh);
        document.addEventListener('visibilitychange', syncVisibility);
        syncVisibility();
        return { refresh, stop };
    }

    const api = { install, readMetrics, parseResult, activityAge, canApply };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.CiraActivity = api;
})(typeof window === 'undefined' ? globalThis : window);
