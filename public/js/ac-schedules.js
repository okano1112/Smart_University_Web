(function (root) {
    'use strict';
    const TIMEZONE = 'Asia/Bangkok';

    function brokerHost(value) {
        try { return new URL(value).hostname.toLowerCase().replace(/\.$/, ''); }
        catch (_) { return ''; }
    }
    function connectionMatches(connection, status) {
        if (!connection || !status) return false;
        const host = brokerHost(connection.mqttUrl);
        return Boolean(host && host === brokerHost(status.brokerUrl) && connection.command && connection.status &&
            connection.command === status.commandTopic && connection.status === status.statusTopic);
    }
    function bangkokParts(time = Date.now()) {
        return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
            timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(time).map(part => [part.type, part.value]));
    }
    function bangkokDate(time = Date.now()) {
        const p = bangkokParts(time);
        return `${p.year}-${p.month}-${p.day}`;
    }
    function formatDateTime(value) {
        if (value === null || value === undefined || value === '') return '—';
        const time = typeof value === 'number' ? value : Date.parse(value);
        if (!Number.isFinite(time)) return '—';
        return new Intl.DateTimeFormat('th-TH', {
            timeZone: TIMEZONE, day: 'numeric', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).format(time) + ' น.';
    }
    function validateDraft(draft, { now = Date.now() } = {}) {
        const value = {
            label: String(draft.label || '').trim(), power: draft.power,
            repeat: draft.repeat, time: draft.time, enabled: draft.enabled,
            temp: Number(draft.temp), mode: Number(draft.mode), fan: Number(draft.fan)
        };
        const error = message => ({ error: message });
        if (value.label.length > 80) return error('ชื่อกำหนดเวลาต้องไม่เกิน 80 ตัวอักษร');
        if (typeof value.power !== 'boolean' || typeof value.enabled !== 'boolean') return error('กรุณาเลือกการทำงานและสถานะกำหนดเวลา');
        if (!['once', 'daily'].includes(value.repeat)) return error('กรุณาเลือกความถี่ของกำหนดเวลา');
        if (typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return error('กรุณาระบุเวลาให้ครบ');
        if (!Number.isInteger(value.temp) || value.temp < 21 || value.temp > 27 || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 2 || !Number.isInteger(value.fan) || value.fan < 0 || value.fan > 3) return error('ค่าแอร์ไม่ถูกต้อง กรุณาเลือกใหม่');
        if (value.repeat === 'once') {
            const date = draft.date;
            if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return error('กรุณาเลือกวันที่');
            const at = Date.parse(`${date}T${value.time}:00+07:00`);
            if (!Number.isFinite(at) || bangkokDate(at) !== date) return error('วันที่ไม่ถูกต้อง กรุณาเลือกใหม่');
            if (value.enabled && at <= now) return error('กรุณาเลือกวันและเวลาในอนาคตตามเวลาประเทศไทย');
            value.date = date;
        }
        return { value };
    }

    function install({ document, fetch, notice = () => {}, connection = () => null, current = () => ({}) }) {
        const $ = id => document.getElementById(id);
        const ids = ['schedule-list', 'schedule-status', 'schedule-server-detail', 'schedule-message', 'btn-add-schedule',
            'schedule-editor', 'schedule-form', 'schedule-id', 'schedule-label', 'schedule-power', 'schedule-repeat',
            'schedule-date', 'schedule-time', 'schedule-temp', 'schedule-mode', 'schedule-fan', 'schedule-enabled',
            'btn-save-schedule', 'btn-cancel-schedule', 'schedule-date-field', 'schedule-ac-fields'];
        if (ids.some(id => !$(id))) return { refresh: async () => {}, destroy() {}, openEditor() {} };
        const fields = ['schedule-label', 'schedule-power', 'schedule-repeat', 'schedule-date', 'schedule-time', 'schedule-temp', 'schedule-mode', 'schedule-fan', 'schedule-enabled'];
        let schedules = [], status = null, loaded = false, loadError = '', busy = false, destroyed = false;
        let confirming = null, query = 0, readController = null, listSignature = '', refreshing = false, clockOffset = 0, focusAddWhenReady = false;
        const controllers = new Set(), listeners = [];
        const listen = (element, type, handler) => { element.addEventListener(type, handler); listeners.push(() => element.removeEventListener(type, handler)); };
        const message = (text, kind = 'info', announce = false) => {
            $('schedule-message').textContent = text;
            $('schedule-message').dataset.kind = kind;
            if (announce) notice(text, kind);
        };
        const mismatch = () => !connectionMatches(connection(), status);
        const setText = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
        const create = (tag, className, text) => {
            const element = document.createElement(tag);
            if (className) element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        };
        const button = (text, className, handler, id) => {
            const element = create('button', className, text);
            element.type = 'button'; element.disabled = busy;
            if (id) element.id = id;
            element.addEventListener('click', handler);
            return element;
        };
        const itemName = item => item.label || `${item.power ? 'เปิด' : 'ปิด'}แอร์ ${item.time} น.`;
        function renderStatus() {
            let text;
            if (!loaded && !loadError) text = 'กำลังตรวจการเชื่อมต่อเซิร์ฟเวอร์จัดเวลา…';
            else if (loadError) text = 'ติดต่อเซิร์ฟเวอร์จัดเวลาไม่ได้';
            else if (status?.storageReady === false) text = 'บันทึกตารางเวลาไม่ได้ · กรุณาตรวจเซิร์ฟเวอร์';
            else if (mismatch()) text = 'ปลายทางไม่ตรงกัน — ยังเปิดใช้กำหนดเวลาไม่ได้';
            else if (status?.brokerConnected && status?.deviceOnline) text = 'เซิร์ฟเวอร์พร้อมส่งคำสั่งตามเวลา';
            else if (status?.brokerConnected) text = 'เซิร์ฟเวอร์เชื่อมต่อแล้ว · รอสถานะ ESP32';
            else text = 'เซิร์ฟเวอร์ยังไม่เชื่อมต่อกับระบบแอร์';
            setText('schedule-status', text);
            $('schedule-status').dataset.state = loadError || status?.storageReady === false ? 'error' : mismatch() ? 'warning' : status?.brokerConnected && status?.deviceOnline ? 'ready' : 'waiting';
            let detail = 'เวลาประเทศไทย (UTC+7) · ต้องเปิดเซิร์ฟเวอร์ไว้เมื่อถึงเวลาที่ตั้ง';
            if (loaded && mismatch()) detail += ' · กรุณาตั้ง Broker และ Topic ของเว็บให้ตรงกับเซิร์ฟเวอร์';
            if (status) detail += ` · เซิร์ฟเวอร์: ${brokerHost(status.brokerUrl) || '—'} · Command: ${status.commandTopic || '—'} · Status: ${status.statusTopic || '—'}`;
            if (status?.lastStatusAt) detail += ` · รับสถานะล่าสุด ${formatDateTime(status.lastStatusAt)}`;
            if (status?.storageReady === false && status.storageError) detail += ` · ${status.storageError}`;
            if (loadError && loaded) detail += ' · รายการด้านล่างเป็นข้อมูลที่โหลดไว้ก่อนหน้า';
            setText('schedule-server-detail', detail);
        }
        function lastRunText(run) {
            if (!run) return '';
            const names = { sending: 'กำลังส่งคำสั่ง', sent: 'ส่งคำสั่ง MQTT แล้ว', failed: 'ส่งไม่สำเร็จ', missed: 'พลาดเวลาทำงาน' };
            const label = names[run.status] || 'รอผลการทำงาน';
            return `${label} ${formatDateTime(run.scheduledAt || run.startedAt)}${run.message ? ' · ' + run.message : ''}`;
        }
        function renderList() {
            const signature = JSON.stringify([schedules, busy, confirming, mismatch(), loaded, loadError]);
            if (signature === listSignature) return;
            listSignature = signature;
            const list = $('schedule-list'), active = list.contains(document.activeElement) ? document.activeElement.id : null;
            list.replaceChildren();
            if (!schedules.length) {
                list.append(create('p', 'empty-state', !loaded ? loadError ? 'โหลดกำหนดเวลาไม่สำเร็จ กำลังรอลองใหม่' : 'กำลังโหลดกำหนดเวลา…' : 'ยังไม่มีกำหนดเวลา เพิ่มเวลาเปิดหรือปิดแอร์ได้ที่นี่'));
                return;
            }
            for (const item of schedules) {
                const row = create('article', 'schedule-row');
                row.setAttribute('aria-label', itemName(item));
                const main = create('div', 'schedule-main');
                main.append(create('div', 'schedule-time', `${item.time} น.`), create('div', 'schedule-name', itemName(item)));
                const operation = item.power ? `เปิดแอร์ · ${item.temp}°C · ${['เย็น', 'ลดความชื้น', 'พัดลม'][item.mode] || '—'} · ลม${['อัตโนมัติ', 'เบา', 'กลาง', 'แรง'][item.fan] || '—'}` : 'ปิดแอร์';
                const repeat = item.repeat === 'daily' ? 'ทุกวัน' : item.date ? formatDateTime(`${item.date}T${item.time}:00+07:00`) : 'ครั้งเดียว';
                main.append(create('p', 'schedule-meta', `${operation} · ${repeat}`));
                if (item.enabled && item.nextRunAt) main.append(create('p', 'schedule-meta text-muted', 'ครั้งถัดไป ' + formatDateTime(item.nextRunAt)));
                else if (!item.enabled) main.append(create('p', 'schedule-meta text-muted', 'พักกำหนดเวลานี้ไว้'));
                if (item.destinationMismatch) main.append(create('p', 'schedule-meta schedule-pause-warning', 'พักไว้เพื่อรอยืนยันปลายทาง: ' + (item.pauseReason || 'การเชื่อมต่อของเซิร์ฟเวอร์เปลี่ยนไป')));
                if (item.lastRun) main.append(create('p', 'schedule-meta text-muted', lastRunText(item.lastRun)));
                const actions = create('div', 'schedule-actions'), id = `schedule-${encodeURIComponent(item.id)}`;
                const toggle = button(item.destinationMismatch ? 'ใช้กับปลายทางนี้' : item.enabled ? 'เปิดใช้' : 'พักไว้', 'schedule-switch' + (item.enabled ? ' is-on' : ''), () => toggleItem(item), id + '-toggle');
                toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(Boolean(item.enabled)));
                toggle.setAttribute('aria-label', item.destinationMismatch ? `เปิดใช้กับปลายทางปัจจุบัน: ${itemName(item)}` : `เปิดใช้กำหนดเวลา ${itemName(item)}`);
                toggle.disabled = busy || (!item.enabled && mismatch());
                if (!item.enabled && mismatch()) toggle.title = 'ตั้งการเชื่อมต่อของเว็บให้ตรงกับเซิร์ฟเวอร์ก่อน';
                actions.append(toggle, button('แก้ไข', 'btn btn-secondary btn-small', () => openEditor(item), id + '-edit'));
                if (confirming === item.id) {
                    const yes = button('ยืนยันลบ', 'btn btn-danger btn-small', () => removeItem(item), id + '-delete-confirm');
                    yes.setAttribute('aria-label', `ยืนยันลบกำหนดเวลา ${itemName(item)}`);
                    actions.append(yes, button('ยกเลิก', 'btn btn-secondary btn-small', () => { confirming = null; renderList(); $(id + '-delete')?.focus(); }, id + '-delete-cancel'));
                } else actions.append(button('ลบ', 'btn btn-secondary btn-small', () => { confirming = item.id; renderList(); message(`กด “ยืนยันลบ” เพื่อลบ ${itemName(item)}`); $(id + '-delete-confirm')?.focus(); }, id + '-delete'));
                row.append(main, actions); list.append(row);
            }
            if (active) $(active)?.focus();
        }
        function renderBusy() {
            $('btn-add-schedule').disabled = busy;
            $('btn-save-schedule').disabled = busy;
            $('btn-cancel-schedule').disabled = busy;
            $('btn-save-schedule').textContent = busy ? 'กำลังบันทึก…' : 'บันทึกกำหนดเวลา';
            $('schedule-form').setAttribute('aria-busy', String(busy));
            for (const id of fields) $(id).disabled = busy;
            renderList();
            if (!busy && focusAddWhenReady) { focusAddWhenReady = false; $('btn-add-schedule').focus(); }
        }
        function updateFields() {
            const once = $('schedule-repeat').value === 'once';
            $('schedule-date-field').hidden = !once;
            $('schedule-date').required = once;
            $('schedule-ac-fields').hidden = $('schedule-power').value !== '1';
        }
        function openEditor(item = null) {
            if (busy || destroyed) return;
            confirming = null; renderList();
            const desired = current() || {}, future = bangkokParts(Date.now() + clockOffset + 5 * 60000);
            $('schedule-id').value = item?.id || '';
            $('schedule-label').value = item?.label || '';
            $('schedule-power').value = item ? item.power ? '1' : '0' : '1';
            $('schedule-repeat').value = item?.repeat || 'once';
            $('schedule-date').value = item?.date || `${future.year}-${future.month}-${future.day}`;
            $('schedule-time').value = item?.time || `${future.hour}:${future.minute}`;
            $('schedule-temp').value = String(item?.temp ?? (Number.isInteger(desired.temp) && desired.temp >= 21 && desired.temp <= 27 ? desired.temp : 25));
            $('schedule-mode').value = String(item?.mode ?? (Number.isInteger(desired.mode) && desired.mode >= 0 && desired.mode <= 2 ? desired.mode : 0));
            $('schedule-fan').value = String(item?.fan ?? (Number.isInteger(desired.fan) && desired.fan >= 0 && desired.fan <= 3 ? desired.fan : 0));
            $('schedule-enabled').checked = item ? Boolean(item.enabled) : true;
            $('schedule-editor').hidden = false;
            updateFields();
            message(item?.destinationMismatch ?
                `รายการนี้พักไว้: ${item.pauseReason || 'การเชื่อมต่อของเซิร์ฟเวอร์เปลี่ยนไป'} · ปลายทางปัจจุบัน: ${brokerHost(status?.brokerUrl) || '—'} / ${status?.commandTopic || '—'} · หากต้องการใช้กับปลายทางนี้ ให้เลือก “เปิดใช้งานรายการนี้” แล้วบันทึก` :
                item ? 'แก้ไขกำหนดเวลา แล้วกดบันทึก' : 'ตั้งเวลาตามเวลาประเทศไทย แล้วกดบันทึก');
            $('schedule-label').focus();
        }
        function closeEditor() {
            $('schedule-editor').hidden = true;
            $('schedule-id').value = '';
            if (busy) focusAddWhenReady = true; else $('btn-add-schedule').focus();
        }
        async function request(url, options = {}) {
            const controller = new AbortController(); controllers.add(controller);
            if ((options.method || 'GET') === 'GET') readController = controller;
            let timer;
            try {
                return await Promise.race([
                    (async () => {
                        const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
                        let data;
                        try { data = await response.json(); } catch (_) { data = {}; }
                        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : 'เซิร์ฟเวอร์บันทึกข้อมูลไม่สำเร็จ');
                        return data;
                    })(),
                    new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); const error = new Error('ติดต่อเซิร์ฟเวอร์นานเกินไป'); error.name = 'TimeoutError'; reject(error); }, 10000); })
                ]);
            } finally {
                clearTimeout(timer); controllers.delete(controller);
                if (readController === controller) readController = null;
            }
        }
        async function refresh() {
            if (destroyed || busy || document.hidden || refreshing) return;
            refreshing = true;
            const sequence = ++query;
            try {
                const data = await request('/api/schedules');
                if (destroyed || sequence !== query || busy) return;
                if (!Array.isArray(data.schedules) || !data.status || typeof data.status !== 'object') throw new Error('ข้อมูลกำหนดเวลาจากเซิร์ฟเวอร์ไม่ครบ');
                schedules = data.schedules; status = data.status; loaded = true; loadError = '';
                if (Number.isFinite(status.serverTime)) clockOffset = status.serverTime - Date.now();
            } catch (error) {
                if (destroyed || sequence !== query || busy) return;
                loadError = error.message || 'โหลดข้อมูลไม่สำเร็จ';
            } finally {
                if (sequence === query) { refreshing = false; renderStatus(); renderList(); }
            }
        }
        function invalidateRead() {
            query++; refreshing = false; readController?.abort(); readController = null;
        }
        async function mutate(url, method, value, success) {
            if (busy || destroyed) return false;
            busy = true; invalidateRead(); renderBusy();
            try {
                await request(url, { method, headers: { 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
                if (destroyed) return false;
                success(); return true;
            } catch (error) {
                if (!destroyed) message(error.name === 'TimeoutError' ? 'ยังยืนยันการบันทึกไม่ได้ กำลังโหลดรายการใหม่ กรุณาตรวจรายการก่อนบันทึกซ้ำ' : error.message || 'บันทึกไม่สำเร็จ กรุณาลองใหม่', 'error', true);
                return false;
            } finally {
                busy = false;
                if (!destroyed) { renderBusy(); await refresh(); }
            }
        }
        function mayEnable() {
            if (!loaded || loadError) { message('กรุณารอการเชื่อมต่อกับเซิร์ฟเวอร์ก่อนเปิดใช้กำหนดเวลา', 'warning', true); return false; }
            if (status?.storageReady === false) { message('เซิร์ฟเวอร์บันทึกตารางเวลาไม่ได้ กรุณาตรวจเซิร์ฟเวอร์ก่อนเปิดใช้งาน', 'warning', true); return false; }
            if (mismatch()) { message('Broker หรือ Topic ของเว็บไม่ตรงกับเซิร์ฟเวอร์ กรุณาตั้งให้ตรงกันก่อนเปิดใช้กำหนดเวลา', 'warning', true); return false; }
            return true;
        }
        async function save(event) {
            event.preventDefault();
            if (busy || !$('schedule-form').reportValidity()) return;
            const checked = validateDraft({
                label: $('schedule-label').value, power: $('schedule-power').value === '1',
                repeat: $('schedule-repeat').value, date: $('schedule-date').value, time: $('schedule-time').value,
                temp: $('schedule-temp').value, mode: $('schedule-mode').value, fan: $('schedule-fan').value,
                enabled: $('schedule-enabled').checked
            }, { now: Date.now() + clockOffset });
            if (checked.error) { message(checked.error, 'warning'); return; }
            if (checked.value.enabled && !mayEnable()) return;
            const id = $('schedule-id').value;
            await mutate('/api/schedules' + (id ? '/' + encodeURIComponent(id) : ''), id ? 'PATCH' : 'POST', checked.value, () => {
                closeEditor(); message('บันทึกกำหนดเวลาแล้ว', 'success', true);
            });
        }
        async function toggleItem(item) {
            const enabled = !item.enabled;
            if (enabled && !mayEnable()) return;
            await mutate('/api/schedules/' + encodeURIComponent(item.id), 'PATCH', { enabled }, () => message(enabled ? 'เปิดใช้กำหนดเวลาแล้ว' : 'พักกำหนดเวลาแล้ว', 'success'));
        }
        async function removeItem(item) {
            await mutate('/api/schedules/' + encodeURIComponent(item.id), 'DELETE', undefined, () => {
                confirming = null;
                if ($('schedule-id').value === item.id) closeEditor();
                else focusAddWhenReady = true;
                message('ลบกำหนดเวลาแล้ว', 'success');
            });
        }
        listen($('btn-add-schedule'), 'click', () => openEditor());
        listen($('btn-cancel-schedule'), 'click', () => { if (!busy) { closeEditor(); message('ยกเลิกการแก้ไขแล้ว'); } });
        listen($('schedule-form'), 'submit', save);
        listen($('schedule-repeat'), 'change', updateFields);
        listen($('schedule-power'), 'change', updateFields);
        listen(document, 'visibilitychange', () => {
            if (document.hidden) invalidateRead(); else refresh();
        });
        const poll = setInterval(() => refresh(), 15000);
        updateFields(); renderBusy(); renderStatus(); refresh();
        return {
            refresh, openEditor,
            destroy() { destroyed = true; query++; clearInterval(poll); controllers.forEach(controller => controller.abort()); listeners.forEach(remove => remove()); }
        };
    }

    const api = { install, connectionMatches, formatDateTime, bangkokDate, validateDraft };
    root.SmartAcSchedules = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
