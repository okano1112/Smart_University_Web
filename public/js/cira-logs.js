(function () {
    'use strict';

    const panel = document.getElementById('cira-logs');
    if (!panel) return;
    const status = document.getElementById('cira-log-status');
    const counters = document.getElementById('cira-log-counters');
    const list = document.getElementById('cira-log-events');
    const refresh = document.getElementById('cira-log-refresh');
    const steps = Object.fromEntries(Array.from(document.querySelectorAll('[data-cira-step]')).map(node => [node.dataset.ciraStep, {
        node, value: node.querySelector('[data-cira-value]'), detail: node.querySelector('[data-cira-detail]')
    }]));
    const STALE_MS = 30_000, POLL_MS = 5000, REQUEST_MS = 4000, SAMPLE_MS = 1000;
    const timeFormat = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const bridgeLabels = { capture: 'รับผลจาก CiRA', validate: 'ตรวจข้อมูลผ่าน', forward: 'ส่งต่อไปยังโหนด MQTT', rejected: 'ข้ามข้อมูลจาก CiRA', stale: 'ผล CiRA หมดอายุ', test: 'ทดสอบภายใน Node-RED' };
    const browserLabels = { received: 'รับข้อความ MQTT', rejected: 'ข้ามข้อมูลบนเว็บ', displayed: 'แสดงจำนวนคนแล้ว', stale: 'จำนวนคนหมดอายุ', disconnected: 'MQTT ของเว็บหลุดการเชื่อมต่อ' };
    const browserReject = { RETAINED: 'ไม่ใช้ข้อความ MQTT ที่เก็บค้างไว้', STALE: 'ข้อมูลเกินเวลาที่เว็บใช้แสดงผล', STALE_SAMPLE: 'ข้อมูลเกินเวลาที่เว็บใช้แสดงผล' };
    const browser = { events: [], sampledAt: {}, reading: null, receivedAt: 0, rejectedAt: 0, rejectedMessage: '', disconnected: false, nextId: 0 };
    let bridge = null, bridgeState = 'loading', clockOffset = 0, hasClock = false;
    let request = null, pollTimer = null, renderTimer = null, ageTimer = null, eventsDirty = true;

    const canRun = () => panel.open && document.visibilityState !== 'hidden';
    const validTime = at => Number.isFinite(at) && at > 0 && at < 8.64e15;
    const validCount = count => Number.isInteger(count) && count >= 0 && count <= 1000;
    const shortText = (value, max = 180) => typeof value === 'string' ? value.trim().slice(0, max) : '';
    const clock = at => validTime(at) ? timeFormat.format(at) : '—';
    const browserClock = at => clock(at + clockOffset);
    function setText(node, value) { if (node.textContent !== value) node.textContent = value; }

    function addBrowserEvent(stage, at, message = '', count = null) {
        const previous = browser.sampledAt[stage];
        if (stage !== 'stale' && stage !== 'disconnected' && previous !== undefined && at >= previous && at - previous < SAMPLE_MS) return;
        browser.sampledAt[stage] = at;
        browser.events.push({ id: `web-${++browser.nextId}`, origin: 'browser', stage, at, message, count });
        if (browser.events.length > 32) browser.events.shift();
        eventsDirty = true;
    }

    function recordBrowser({ stage, at = Date.now(), count, captureAt, code } = {}) {
        if (!validTime(at)) return;
        markExpired(at);
        if (stage === 'connected') {
            browser.disconnected = false;
        } else if (stage === 'received') {
            browser.disconnected = false; browser.receivedAt = at;
            addBrowserEvent(stage, at);
        } else if (stage === 'rejected') {
            browser.rejectedAt = at;
            browser.rejectedMessage = browserReject[shortText(code, 40).toUpperCase()] || 'ข้อมูลไม่ผ่านเงื่อนไขรูปแบบหรืออายุของเว็บ';
            addBrowserEvent(stage, at, browser.rejectedMessage);
        } else if (stage === 'displayed' && validCount(count)) {
            browser.disconnected = false;
            browser.reading = { count, at, captureAt: validTime(captureAt) ? Math.min(at, captureAt) : at, stale: false };
            addBrowserEvent(stage, at, `${count} คน`, count);
        } else if (stage === 'disconnected' && !browser.disconnected) {
            browser.disconnected = true; browser.reading = null; browser.receivedAt = 0; browser.rejectedAt = 0;
            addBrowserEvent(stage, at, 'รอเชื่อมต่อและรับจำนวนคนใหม่');
        } else return;
        scheduleRender();
    }

    function markExpired(now) {
        const reading = browser.reading;
        if (!reading || reading.stale || now - reading.captureAt < STALE_MS) return;
        reading.stale = true;
        addBrowserEvent('stale', reading.captureAt + STALE_MS, `จำนวนคนล่าสุด ${reading.count} คน ไม่ใช้แสดงเป็นค่าปัจจุบัน`);
    }

    function parseBridge(payload) {
        if (!payload || payload.source !== 'cira' || !validTime(payload.serverTime) || !Array.isArray(payload.events) || !payload.counters) throw new Error('Invalid bridge diagnostics');
        const counts = {};
        for (const key of ['received', 'forwarded', 'rejected', 'tests']) {
            if (!Number.isSafeInteger(payload.counters[key]) || payload.counters[key] < 0) throw new Error('Invalid bridge counters');
            counts[key] = payload.counters[key];
        }
        const events = [];
        for (const row of payload.events.slice(-60)) {
            if (!row || !Object.hasOwn(bridgeLabels, row.stage) || !validTime(row.at) || !shortText(row.id, 80)) continue;
            const detail = row.details || {};
            events.push({ id: shortText(row.id, 80), origin: 'bridge', stage: row.stage, at: row.at, warning: row.level === 'warning',
                message: shortText(row.message), count: validCount(detail.totalPeople) ? detail.totalPeople : null,
                code: shortText(detail.code, 45), frameId: shortText(row.frameId, 80),
                sampleAt: validTime(detail.sampleAt) ? detail.sampleAt : null,
                sampleTimeSource: ['camera', 'received'].includes(detail.sampleTimeSource) ? detail.sampleTimeSource : null,
                latencyMs: Number.isFinite(detail.latencyMs) && detail.latencyMs >= 0 ? detail.latencyMs : null });
        }
        const latest = {};
        for (const event of events) latest[event.stage] = event;
        return { events, latest, counts, serverTime: payload.serverTime, eventKey: events.map(event => event.id).join('|') };
    }

    function describeStep(key, value, detail = '', state = '') {
        const target = steps[key];
        if (!target) return;
        setText(target.value, value); setText(target.detail, detail);
        if (target.node.dataset.state !== state) target.node.dataset.state = state;
    }

    function bridgeStepState(event, referenceTime) {
        if (bridgeState !== 'ready' || !event || referenceTime - event.at >= STALE_MS) return '';
        return 'ready';
    }

    function renderBridge(now) {
        const state = bridgeState === 'error' ? 'warning' : bridgeState;
        const detail = bridgeState === 'loading' ? 'กำลังอ่านบันทึก Node-RED…' : bridgeState === 'error'
            ? bridge ? 'อ่านบันทึก Node-RED ไม่ได้ · แสดงบันทึกที่อ่านได้ครั้งล่าสุด' : 'อ่านบันทึก Node-RED ไม่ได้ · ตรวจว่าเปิด Node-RED และโหลด flow CiRA รุ่นที่มี Logs แล้ว'
            : `อ่านบันทึก Node-RED ได้ · ล่าสุด ${clock(bridge?.serverTime)}`;
        setText(status, detail);
        if (status.dataset.state !== state) status.dataset.state = state;
        counters.hidden = !bridge;
        if (!bridge) return;
        const { latest, counts, events } = bridge;
        setText(counters, `Node-RED: รับ ${counts.received} · ส่งต่อ ${counts.forwarded} · ข้าม ${counts.rejected} · ทดสอบ ${counts.tests}`);
        const bridgeNow = now + clockOffset;
        const capture = latest.capture, validate = latest.validate, reject = latest.rejected, forward = latest.forward;
        const historic = bridgeState === 'error' ? ' · จากบันทึกเดิม' : '';
        if (capture) describeStep('capture', 'ได้รับผลจาก CiRA', `Node-RED รับเมื่อ ${clock(capture.at)}${historic}`, bridgeStepState(capture, bridgeNow));
        else describeStep('capture', counts.received === 0 ? 'ยังไม่มีผลจาก CiRA CORE' : 'ไม่พบผลรับในบันทึกล่าสุด');
        if (reject && (!validate || events.indexOf(reject) > events.indexOf(validate))) describeStep('validate', 'ข้อมูลล่าสุดไม่ผ่าน', `${reject.message || reject.code || 'ไม่รับข้อมูลนี้'}${historic}`, 'warning');
        else if (validate) describeStep('validate', validate.count === null ? 'ตรวจข้อมูลผ่าน' : `ตรวจผ่าน ${validate.count} คน`, `${clock(validate.at)}${historic}`, bridgeStepState(validate, bridgeNow));
        else describeStep('validate', 'รอข้อมูลผ่านการตรวจ');
        if (forward) {
            const stale = latest.stale && events.indexOf(latest.stale) > events.indexOf(forward);
            describeStep('forward', stale ? 'ข้อมูลที่ส่งต่อหมดอายุ' : forward.count === null ? 'ส่งต่อไปยัง MQTT แล้ว' : `ส่งต่อ ${forward.count} คน`,
                `โหนด MQTT output · ${clock(forward.at)}${historic}`, stale ? 'warning' : bridgeStepState(forward, bridgeNow));
        } else describeStep('forward', 'ยังไม่พบการส่งต่อ');
    }

    function renderBrowser(now) {
        const reading = browser.reading;
        if (browser.disconnected) return describeStep('browser', 'MQTT ของเว็บขาดการเชื่อมต่อ', 'รอเชื่อมต่อและรับข้อมูลใหม่', 'warning');
        markExpired(now);
        if (reading?.stale) {
            return describeStep('browser', 'จำนวนคนหมดอายุ', `แสดงล่าสุด ${reading.count} คน · ${browserClock(reading.at)}`, 'warning');
        }
        if (reading) return describeStep('browser', `กำลังแสดง ${reading.count} คน`, `เว็บแสดงล่าสุดเมื่อ ${browserClock(reading.at)}`, 'ready');
        if (browser.rejectedAt) return describeStep('browser', 'ยังไม่แสดงจำนวนคน', browser.rejectedMessage, 'warning');
        if (browser.receivedAt) return describeStep('browser', 'รับ MQTT แล้ว', `รับเมื่อ ${browserClock(browser.receivedAt)} · ยังไม่แสดงจำนวนคน`);
        describeStep('browser', 'รอจำนวนคนล่าสุด', 'ยังไม่พบข้อมูลใหม่ที่หน้านี้รับและแสดง');
    }

    function makeNode(tag, className, value) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value) node.textContent = value;
        return node;
    }

    function renderEvents() {
        if (!eventsDirty) return;
        eventsDirty = false;
        const eventTime = event => event.origin === 'browser' ? event.at + clockOffset : event.at;
        const latest = [...(bridge?.events || []), ...browser.events].reverse().sort((a, b) => eventTime(b) - eventTime(a)).slice(0, 40);
        const scroll = list.parentElement;
        const previousTop = scroll.scrollTop;
        const viewportTop = previousTop > 0 ? scroll.getBoundingClientRect().top : 0;
        const previousRow = previousTop > 0 ? Array.from(list.children).find(row => row.getBoundingClientRect().bottom > viewportTop) : null;
        const previousOffset = previousRow ? previousRow.getBoundingClientRect().top - viewportTop : 0;
        const content = document.createDocumentFragment();
        let anchor = null;
        for (const event of latest) {
            const local = event.origin === 'browser';
            const row = makeNode('li', 'cira-log-event');
            row.dataset.key = `${event.origin}:${event.id}`;
            if (row.dataset.key === previousRow?.dataset.key) anchor = row;
            if (event.warning || ['rejected', 'stale', 'disconnected'].includes(event.stage)) row.dataset.level = 'warning';
            const time = makeNode('time', '', clock(eventTime(event)));
            if (validTime(eventTime(event))) time.dateTime = new Date(eventTime(event)).toISOString();
            const description = makeNode('div');
            description.append(makeNode('span', 'cira-log-source', local ? 'เว็บ' : 'Node-RED'), makeNode('strong', '', (local ? browserLabels : bridgeLabels)[event.stage]));
            const parts = [event.message];
            if (!local && event.count !== null) parts.push(`${event.count} คน`);
            if (event.sampleAt && event.sampleTimeSource) parts.push(`${event.sampleTimeSource === 'camera' ? 'เวลาในข้อมูล CiRA' : 'เวลา Node-RED รับ'} ${clock(event.sampleAt)}`);
            if (event.latencyMs !== null && event.latencyMs !== undefined && event.stage === 'validate') parts.push(`ตรวจข้อมูล ${event.latencyMs} มิลลิวินาที`);
            if (event.code) parts.push(event.code);
            if (event.frameId) parts.push(`รหัสผล ${event.frameId}`);
            const metadata = parts.filter(Boolean).join(' · ');
            if (metadata) description.append(makeNode('p', 'cira-log-event-detail', metadata));
            row.append(time, description); content.append(row);
        }
        if (!latest.length) content.append(makeNode('li', 'cira-log-empty', bridgeState === 'error' ? 'ยังไม่มีเหตุการณ์ที่อ่านได้' : 'ยังไม่มีเหตุการณ์จำนวนคน'));
        list.replaceChildren(content);
        if (anchor) scroll.scrollTop += anchor.getBoundingClientRect().top - viewportTop - previousOffset;
        else if (previousTop > 0) scroll.scrollTop = previousTop;
    }

    function render() {
        if (!canRun()) return;
        const now = Date.now();
        renderBridge(now); renderBrowser(now); renderEvents();
    }

    function scheduleRender() {
        if (!canRun() || renderTimer !== null) return;
        renderTimer = setTimeout(() => { renderTimer = null; render(); }, 250);
    }

    async function fetchLogs() {
        clearTimeout(pollTimer); pollTimer = null;
        if (!canRun() || request) return;
        const controller = new AbortController();
        request = controller; refresh.setAttribute('aria-busy', 'true');
        const timeout = setTimeout(() => controller.abort(), REQUEST_MS);
        try {
            const response = await (window.SmartDashboardFetch || fetch)('/api/cira/logs', { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
            if (!response.ok) throw new Error('Bridge diagnostics unavailable');
            const next = parseBridge(await response.json());
            if (request !== controller || !canRun()) return;
            if (!hasClock || next.eventKey !== bridge?.eventKey || Math.abs(next.serverTime - Date.now() - clockOffset) >= 1000) eventsDirty = true;
            bridge = next; bridgeState = 'ready';
            clockOffset = next.serverTime - Date.now(); hasClock = true;
        } catch (_) {
            if (request === controller && canRun()) { bridgeState = 'error'; eventsDirty = true; }
        } finally {
            clearTimeout(timeout);
            if (request === controller) {
                request = null; refresh.removeAttribute('aria-busy');
                if (canRun()) { render(); pollTimer = setTimeout(fetchLogs, POLL_MS); }
            }
        }
    }

    function syncPanel() {
        if (canRun()) {
            if (ageTimer === null) ageTimer = setInterval(render, SAMPLE_MS);
            render();
            if (pollTimer === null && !request) void fetchLogs();
            return;
        }
        clearInterval(ageTimer); ageTimer = null;
        clearTimeout(pollTimer); pollTimer = null;
        clearTimeout(renderTimer); renderTimer = null;
        const current = request; request = null; current?.abort();
        refresh.removeAttribute('aria-busy');
    }

    panel.addEventListener('toggle', syncPanel);
    document.addEventListener('visibilitychange', syncPanel);
    refresh.addEventListener('click', fetchLogs);
    window.SmartCiraLogs = { recordBrowser };
    syncPanel();
})();
