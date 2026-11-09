(function (root) {
    'use strict';
    const preferenceKey = 'smartClassroomLocalVoiceV1';
    class HandsFreeStartup {
        constructor({ controller, document, window, storage, permission }) {
            Object.assign(this, { controller, document, window, storage, permission });
            this.enabled = false; this.version = 0;
            try { this.enabled = storage?.getItem(preferenceKey) === 'on'; } catch (_) { }
            this.gesture = event => {
                if (!this.enabled || !this.awaitingGesture || this.document.hidden) return;
                // Keep existing button actions independent; voice buttons have their own click handlers.
                if (event.target?.closest?.('button, a, input, select, textarea, [contenteditable="true"]')) return;
                if (event.type === 'keydown' && (event.ctrlKey || event.metaKey || event.altKey || event.key === 'Escape')) return;
                this.awaitingGesture = false;
                void this.attempt(false);
            };
            this.visibility = () => {
                if (this.document.hidden) this.controller.stop();
                else { this.resumePending = true; this.scheduleRestore(); }
            };
            this.hide = () => this.controller.stop();
            this.permissionChanged = () => {
                if (!this.enabled) return;
                if (this.permissionStatus?.state === 'denied') {
                    this.controller.stop(); this.awaitingGesture = false;
                    this.controller.setState('OFF', 'กรุณาอนุญาตไมโครโฟนเพื่อเรียก Engi');
                } else if (this.permissionStatus?.state === 'granted') { this.resumePending = true; this.scheduleRestore(); }
            };
        }
        scheduleRestore() {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = setTimeout(() => { void this.restore(); }, 0);
        }
        install() {
            this.document.addEventListener('pointerdown', this.gesture, true);
            this.document.addEventListener('keydown', this.gesture, true);
            this.document.addEventListener('visibilitychange', this.visibility);
            this.window.addEventListener('pagehide', this.hide);
            this.window.addEventListener('pageshow', this.visibility);
            void this.restore();
        }
        setEnabled(enabled) {
            this.enabled = enabled; this.awaitingGesture = false; this.version++;
            try { this.storage?.setItem(preferenceKey, enabled ? 'on' : 'off'); } catch (_) { }
        }
        startByUser() {
            this.setEnabled(true);
            // Do not query permissions before this call: preserve the browser's user activation.
            return this.attempt(false);
        }
        stopByUser() { this.setEnabled(false); this.controller.stop(); }
        waitForGesture() {
            this.awaitingGesture = true;
            this.controller.setState('OFF', 'แตะหน้าจอครั้งเดียวเพื่อเปิด Engi');
        }
        async restore() {
            if (!this.enabled || this.document.hidden || this.checking || this.starting || this.controller.state !== 'OFF') return;
            this.resumePending = false;
            const version = this.version;
            this.checking = true;
            try {
                let permission = 'prompt';
                try {
                    const status = await this.permission();
                    permission = typeof status === 'string' ? status : status.state;
                    if (typeof status !== 'string' && this.permissionStatus !== status) {
                        this.permissionStatus?.removeEventListener('change', this.permissionChanged);
                        this.permissionStatus = status;
                        status.addEventListener('change', this.permissionChanged);
                    }
                } catch (_) { }
                if (version !== this.version || !this.enabled || this.document.hidden || this.controller.state !== 'OFF') return;
                if (permission === 'denied') {
                    this.awaitingGesture = false;
                    this.controller.setState('OFF', 'กรุณาอนุญาตไมโครโฟนเพื่อเรียก Engi');
                } else if (permission === 'granted') await this.attempt(true);
                else this.waitForGesture();
            } finally { this.checking = false; if (this.resumePending && this.enabled && !this.document.hidden) this.scheduleRestore(); }
        }
        async attempt(automatic) {
            if (this.starting || !this.enabled || this.document.hidden) return false;
            this.starting = true; const version = this.version;
            try {
                const started = await this.controller.start(true, { automatic });
                if (version === this.version && this.enabled && !this.document.hidden && this.controller.state === 'OFF' && this.controller.lastStartError?.code === 'VOICE_GESTURE_REQUIRED') this.waitForGesture();
                return started;
            } finally { this.starting = false; if (this.resumePending && this.enabled && !this.document.hidden) this.scheduleRestore(); }
        }
        destroy() {
            clearTimeout(this.resumeTimer); this.enabled = false; this.awaitingGesture = false; this.version++;
            this.document.removeEventListener('pointerdown', this.gesture, true);
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
