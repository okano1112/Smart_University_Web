(function (root) {
    'use strict';
    const preferenceKey = 'smartClassroomLocalVoiceV1';
    class HandsFreeStartup {
        constructor({ controller, document, window, storage, permission }) {
            Object.assign(this, { controller, document, window, storage, permission });
            this.enabled = false; this.version = 0; this.failures = 0;
            try { this.enabled = storage?.getItem(preferenceKey) === 'on'; } catch (_) { }
            this.gesture = event => {
                if (!this.enabled || !this.awaitingGesture || this.document.hidden) return;
                // A dedicated voice control owns its own click. Other ordinary user
                // gestures can satisfy browser activation without another click.
                if (event.target?.closest?.('#btn-wake-toggle, #btn-voice-cmd')) return;
                if (event.type === 'keydown' && (event.ctrlKey || event.metaKey || event.altKey || event.key === 'Escape')) return;
                this.awaitingGesture = false;
                void this.attempt(false);
            };
            this.visibility = () => {
                if (this.document.hidden) this.pause('พักการฟังขณะไม่ได้เปิดแท็บนี้');
                else this.resume();
            };
            this.hide = () => this.pause('พักการฟังขณะไม่ได้เปิดหน้านี้');
            this.permissionChanged = () => {
                if (!this.enabled) return;
                if (this.permissionStatus?.state === 'denied') {
                    this.pause('รออนุญาตไมโครโฟน');
                } else if (this.permissionStatus?.state === 'granted') this.resume();
            };
        }
        pause(label) {
            this.version++; this.awaitingGesture = false;
            this.resumePending = false;
            clearTimeout(this.retryTimer); clearTimeout(this.resumeTimer);
            this.controller.stop();
            if (this.enabled && label) this.controller.setState('OFF', label);
        }
        resume() {
            if (!this.enabled) return;
            this.resumePending = true; this.scheduleRestore();
        }
        scheduleRestore() {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = setTimeout(() => { void this.restore(); }, 0);
        }
        install() {
            this.document.addEventListener('click', this.gesture, true);
            this.document.addEventListener('keydown', this.gesture, true);
            this.document.addEventListener('visibilitychange', this.visibility);
            this.window.addEventListener('pagehide', this.hide);
            this.window.addEventListener('pageshow', this.visibility);
            void this.restore();
        }
        setEnabled(enabled) {
            this.enabled = enabled; this.awaitingGesture = false; this.version++;
            this.resumePending = false;
            clearTimeout(this.retryTimer); clearTimeout(this.resumeTimer);
            this.failures = 0;
            try { this.storage?.setItem(preferenceKey, enabled ? 'on' : 'off'); } catch (_) { }
        }
        startByUser() {
            this.setEnabled(true);
            if (this.starting) { this.resume(); return Promise.resolve(false); }
            // Do not query permissions before this call: preserve the browser's user activation.
            const started = this.attempt(false);
            void this.readPermission();
            return started;
        }
        stopByUser() { this.setEnabled(false); this.controller.stop(); }
        waitForGesture(label = 'แตะหน้าจอเพื่อเริ่มฟัง') {
            this.awaitingGesture = true;
            this.controller.setState('OFF', label);
        }
        async readPermission() {
            try {
                const status = await this.permission();
                if (typeof status !== 'string' && !this.destroyed && this.permissionStatus !== status) {
                    this.permissionStatus?.removeEventListener('change', this.permissionChanged);
                    this.permissionStatus = status;
                    status.addEventListener('change', this.permissionChanged);
                }
                return typeof status === 'string' ? status : status.state;
            } catch (_) { return 'prompt'; }
        }
        async restore() {
            if (!this.enabled || this.document.hidden || this.checking || this.starting || this.controller.state !== 'OFF') return;
            this.resumePending = false;
            const version = this.version;
            this.checking = true;
            try {
                const permission = await this.readPermission();
                if (version !== this.version || !this.enabled || this.document.hidden || this.controller.state !== 'OFF') return;
                if (permission === 'denied') {
                    this.awaitingGesture = false;
                    this.controller.setState('OFF', 'รออนุญาตไมโครโฟน');
                } else if (permission === 'granted') await this.attempt(true);
                else this.waitForGesture();
            } finally { this.checking = false; if (this.resumePending && this.enabled && !this.document.hidden) this.scheduleRestore(); }
        }
        async attempt(automatic) {
            if (this.starting || !this.enabled || this.document.hidden || this.controller.state !== 'OFF') return false;
            this.starting = true; const version = this.version;
            try {
                const started = await this.controller.start(true, { automatic });
                if (started && version === this.version) this.lastStartedAt = Date.now();
                if (version === this.version && this.enabled && !this.document.hidden && this.controller.state === 'OFF' && this.controller.lastStartError?.code === 'VOICE_GESTURE_REQUIRED') this.waitForGesture();
                return started;
            } finally { this.starting = false; if (this.resumePending && this.enabled && !this.document.hidden) this.scheduleRestore(); }
        }
        recover(error) {
            if (!this.enabled || this.document.hidden) return;
            if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
                this.awaitingGesture = false;
                this.controller.setState('OFF', 'รออนุญาตไมโครโฟน');
                return;
            }
            if (error.code === 'VOICE_GESTURE_REQUIRED') { this.waitForGesture(); return; }
            if (error.code === 'VOICE_MIC_PERMISSION_TIMEOUT') { this.waitForGesture(error.message); return; }
            if (Date.now() - (this.lastStartedAt || Date.now()) > 30000) this.failures = 0;
            this.lastStartedAt = 0;
            const delay = Math.min(30, 2 ** Math.min(this.failures++, 5));
            const version = this.version;
            const reason = error.message || 'การฟังขาดช่วง';
            this.controller.setState('OFF', `${reason} · ลองใหม่ใน ${delay} วินาที`);
            clearTimeout(this.retryTimer);
            this.retryTimer = setTimeout(() => {
                if (version === this.version) this.resume();
            }, delay * 1000);
        }
        destroy() {
            this.destroyed = true;
            clearTimeout(this.resumeTimer); clearTimeout(this.retryTimer); this.enabled = false; this.awaitingGesture = false; this.version++;
            this.document.removeEventListener('click', this.gesture, true);
            this.document.removeEventListener('keydown', this.gesture, true);
            this.document.removeEventListener('visibilitychange', this.visibility);
            this.window.removeEventListener('pagehide', this.hide);
            this.window.removeEventListener('pageshow', this.visibility);
            this.permissionStatus?.removeEventListener('change', this.permissionChanged);
            this.controller.stop();
        }
    }
    root.SmartHandsFreeStartup = HandsFreeStartup;
    if (typeof module !== 'undefined') module.exports = { HandsFreeStartup, preferenceKey };
})(typeof window === 'undefined' ? globalThis : window);
