(function (root) {
    'use strict';

    const { connectionMatches, formatDateTime } = typeof module !== 'undefined'
        ? require('./ac-schedules') : root.SmartAcSchedules;
    const endpoint = '/api/ac-occupancy';
    const phases = {
        disabled: ['ปิดการควบคุมอัตโนมัติ', 'waiting'],
        'awaiting-reading': ['รอข้อมูลจำนวนคนล่าสุดจาก CiRA CORE', 'waiting'],
        'empty-countdown': ['ห้องว่าง · กำลังรอให้ครบเวลาก่อนปิดแอร์', 'ready'],
        'waiting-device': ['รอการเชื่อมต่อ MQTT หรือสถานะจาก ESP32', 'waiting'],
        empty: ['CiRA CORE ตรวจพบ 0 คน', 'ready'],
        occupied: ['CiRA CORE ตรวจพบคนในห้อง', 'ready'],
        'destination-changed': ['พักอัตโนมัติ · ปลายทางของเซิร์ฟเวอร์เปลี่ยนไป ให้ตรวจสอบแล้วบันทึกอีกครั้ง', 'warning'],
        'storage-error': ['เซิร์ฟเวอร์บันทึกการตั้งค่าไม่ได้', 'error']
    };

    function validDelay(value) {
        return Number.isInteger(value) && value >= 0 && value <= 1440;
    }

    function install({ document, fetch, connection }) {
        const $ = id => document.getElementById(id);
        const form = $('ac-occupancy-form');
        if (!form) return null;
        const statusNode = $('ac-occupancy-status');
        const actionNode = $('ac-occupancy-action');
        const message = $('ac-occupancy-message');
        const fields = $('ac-occupancy-fields');
        const off = $('ac-off-when-empty');
        const on = $('ac-on-when-occupied');
        const delay = $('ac-empty-delay');
        const button = $('btn-save-ac-occupancy');
        let settings, status, loadError = false, dirty = false, destroyed = false;
        let read = null, write = null;

        function matchesDestination() {
            const target = status?.destination;
            const browser = connection();
            return Boolean(target?.fingerprint && connectionMatches(browser, target) && browser.people === target.peopleTopic);
        }

        function render() {
            let [label, state] = Object.hasOwn(phases, status?.phase) ? phases[status.phase] : ['กำลังโหลดการตั้งค่า…', 'waiting'];
            if (status?.phase === 'empty-countdown' && status.offDueAt) {
                label = `ห้องว่าง · กำหนดปิดแอร์ ${formatDateTime(status.offDueAt)}`;
            } else if (status?.phase === 'occupied' && Number.isInteger(status.people)) {
                label = `CiRA CORE ตรวจพบ ${status.people} คน`;
            }
            if (loadError) [label, state] = ['ติดต่อเซิร์ฟเวอร์เพื่อโหลดการตั้งค่าไม่ได้', 'error'];
            else if (status?.destination && !matchesDestination()) {
                [label, state] = ['Broker หรือ Topic ของเว็บกับเซิร์ฟเวอร์ไม่ตรงกัน · กรุณาตรวจการตั้งค่าการเชื่อมต่อ', 'warning'];
            }
            if (statusNode.textContent !== label) statusNode.textContent = label;
            statusNode.dataset.state = state;
            const action = status?.lastAction;
            actionNode.hidden = !action;
            const operation = action?.power ? 'เปิดแอร์' : 'ปิดแอร์';
            const outcome = action?.outcome === 'sent' ? '' : 'ไม่สำเร็จ';
            actionNode.textContent = action ? `ส่งคำสั่ง${operation}${outcome} · ${formatDateTime(action.at)}` : '';
            fields.disabled = !settings || Boolean(write);
            delay.disabled = !off.checked;
            button.disabled = fields.disabled;
            button.textContent = write ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่า';
        }

        function accept(snapshot) {
            const next = snapshot?.settings;
            if (typeof next?.offWhenEmpty !== 'boolean' || typeof next.onWhenOccupied !== 'boolean' ||
                !validDelay(next.emptyDelayMinutes) || !snapshot.status || typeof snapshot.status !== 'object') {
                throw new Error('ข้อมูลการตั้งค่าจากเซิร์ฟเวอร์ไม่ครบ');
            }
            ({ settings, status } = snapshot);
            if (!dirty) {
                off.checked = settings.offWhenEmpty;
                on.checked = settings.onWhenOccupied;
                delay.value = String(settings.emptyDelayMinutes);
            }
            loadError = false;
        }

        async function request(controller, options = {}) {
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetch(endpoint, { ...options, cache: 'no-store', signal: controller.signal });
                const data = await response.json().catch(() => null);
                if (!response.ok) throw new Error(data?.error || data?.message || 'เซิร์ฟเวอร์ไม่สามารถดำเนินการได้');
                return data;
            } finally {
                clearTimeout(timer);
            }
        }

        function cancelRead() {
            read?.abort();
            read = null;
        }

        async function refresh() {
            if (destroyed) return;
            render();
            if (document.hidden || read || write) return;
            const controller = new AbortController();
            read = controller;
            try {
                const snapshot = await request(controller);
                if (read === controller) accept(snapshot);
            } catch (_) {
                if (read === controller) loadError = true;
            } finally {
                if (read === controller) {
                    read = null;
                    render();
                }
            }
        }

        function showMessage(text, kind = 'error') {
            message.textContent = text;
            message.dataset.kind = kind;
        }

        async function save(event) {
            event.preventDefault();
            if (destroyed || write || !settings || !form.reportValidity()) return;
            const minutes = delay.valueAsNumber;
            if (off.checked && !validDelay(minutes)) {
                showMessage('กรุณากรอกจำนวนเต็มระหว่าง 0 ถึง 1440 นาที');
                return;
            }
            if ((off.checked || on.checked) && (loadError || !matchesDestination())) {
                showMessage('ตรวจการเชื่อมต่อของเว็บและเซิร์ฟเวอร์ก่อนเปิดใช้งาน');
                return;
            }
            const body = {
                offWhenEmpty: off.checked,
                onWhenOccupied: on.checked,
                emptyDelayMinutes: validDelay(minutes) ? minutes : settings.emptyDelayMinutes,
                destinationFingerprint: status.destination?.fingerprint ?? null
            };
            cancelRead();
            write = new AbortController();
            showMessage('');
            render();
            try {
                const snapshot = await request(write, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
                });
                if (destroyed) return;
                dirty = false;
                accept(snapshot);
                showMessage('บันทึกการตั้งค่าแล้ว', 'success');
            } catch (error) {
                if (destroyed) return;
                dirty = true;
                showMessage(error.name === 'AbortError' ? 'ยังยืนยันการบันทึกไม่ได้ กรุณาตรวจการเชื่อมต่อ' : error.message);
            } finally {
                write = null;
                if (!destroyed) void refresh();
            }
        }

        function handleInput() {
            dirty = true;
            showMessage('');
            render();
        }

        function handleVisibility() {
            if (document.hidden) cancelRead();
            else void refresh();
        }

        form.addEventListener('input', handleInput);
        form.addEventListener('submit', save);
        document.addEventListener('visibilitychange', handleVisibility);
        const poll = setInterval(refresh, 5000);
        void refresh();
        return {
            refresh,
            destroy() {
                destroyed = true;
                clearInterval(poll);
                cancelRead();
                write?.abort();
                form.removeEventListener('input', handleInput);
                form.removeEventListener('submit', save);
                document.removeEventListener('visibilitychange', handleVisibility);
            }
        };
    }

    const api = { install };
    root.SmartAcOccupancy = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
