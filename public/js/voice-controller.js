(function (root) {
    'use strict';
    class VoiceController {
        constructor(options) {
            this.options = options;
            this.state = 'OFF'; this.epoch = 0; this.controllers = new Set();
            this.delivered = new Set(); this.handledAudio = new WeakSet(); this.lastErrorAt = 0; this.wakeReplyIndex = 0;
        }
        setState(state, label) {
            this.state = state;
            this.options.render(state, this.handsFree, label);
        }
        active(epoch) {
            return this.epoch === epoch && this.state !== 'OFF' && this.device === this.options.device();
        }
        clearTimer() { clearTimeout(this.listenTimer); this.listenTimer = null; }
        async json(url, body, epoch, timeout = 14000) {
            const controller = new AbortController();
            this.controllers.add(controller);
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await this.options.fetch(url, { method: 'POST',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
                const data = await response.json();
                if (!this.active(epoch)) {
                    if (url === '/api/voice-session' && data.sessionId) this.options.fetch('/api/voice-session/cancel', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: data.sessionId }),
                        signal: AbortSignal.timeout(3000)
                    }).catch(() => {});
                    throw new Error('CANCELLED');
                }
                if (!response.ok) throw Object.assign(new Error(data.message || 'ระบบเสียงไม่พร้อม'), { status: response.status });
                return data;
            } finally { clearTimeout(timer); this.controllers.delete(controller); }
        }
        body(extra = {}) { return { sessionId: this.sessionId, device: this.device, ...extra }; }
        stop() {
            const oldSession = this.sessionId;
            this.epoch++; this.clearTimer(); clearTimeout(this.deviceTimer); clearInterval(this.keepAliveTimer);
            for (const controller of this.controllers) controller.abort();
            this.controllers.clear(); this.audio?.close(); this.audio = null;
            this.sessionId = null; this.token = null; this.claimPromise = null;
            this.queued = null; this.queuedSpeaking = false; this.commandId = null;
            this.handsFree = false; this.setState('OFF');
            if (oldSession) this.options.fetch('/api/voice-session/cancel', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: oldSession }),
                keepalive: true, signal: AbortSignal.timeout(3000) }).catch(() => {});
        }
        async start(handsFree, { automatic = false } = {}) {
            this.lastStartError = null;
            this.stop();
            const epoch = this.epoch;
            this.failures = 0; this.handsFree = handsFree; this.device = this.options.device();
            this.setState('INIT');
            const audio = this.options.audio({
                onStart: () => this.onStart(epoch), onEnd: samples => { void this.onEnd(samples, epoch); },
                onMisfire: () => this.onMisfire(epoch), onError: error => this.fatal(error, epoch)
            });
            this.audio = audio;
            try {
                // Start AudioContext from the click before waiting for network permission/session work.
                let initTimer;
                try {
                    await Promise.race([audio.start({ automatic }), new Promise((_, reject) => {
                        initTimer = setTimeout(() => reject(new Error('เตรียมไมค์นานเกินไป กรุณาอนุญาตไมโครโฟนแล้วเปิดใหม่')), 15000);
                    })]);
                } finally { clearTimeout(initTimer); }
                if (!this.active(epoch)) { audio.close(); return; }
                const data = await this.json('/api/voice-session', { device: this.device }, epoch);
                this.sessionId = data.sessionId;
                this.keepAliveTimer = setInterval(() => {
                    this.json('/api/voice-session/ping', this.body(), epoch, 5000).catch(error => this.fatal(error, epoch));
                }, 4 * 60 * 1000);
                if (handsFree) {
                    this.setState('WAIT_WAKE');
                    this.options.notice('ฟังคำสั่งต่อเนื่องบนเครื่อง • พูด เปิดแอร์ / ปิดแอร์ / เพิ่มอุณหภูมิ / ลดอุณหภูมิ / โหมดเทอร์โบ / โหมดประหยัด โดยไม่เรียกชื่อ Engi', 'info', 8000);
                } else {
                    this.setState('READY');
                    await audio.beep('ready');
                    if (!this.active(epoch)) return;
                    this.setState('WAIT_COMMAND'); this.listenTimeout(epoch, 9000);
                    if (this.queuedSpeaking) this.beginCommand(epoch);
                    else this.flushQueued(epoch);
                }
                if (audio.kind === 'rms') this.options.notice('ใช้ระบบรับเสียงสำรอง • หากมีเสียงรบกวนมาก แนะนำกดเพื่อพูด', 'warning', 6000);
                return true;
            } catch (error) {
                this.lastStartError = error;
                if (automatic && error.code === 'VOICE_GESTURE_REQUIRED' && this.epoch === epoch) {
                    this.stop(); this.setState('OFF', error.message);
                } else this.fatal(error, epoch);
                return false;
            }
        }
        listenTimeout(epoch, ms) {
            this.clearTimer();
            this.listenTimer = setTimeout(() => {
                if (!this.active(epoch) || this.state !== 'WAIT_COMMAND') return;
                this.options.notice('หมดเวลารับคำสั่ง • พูดคำสั่งใหม่หรือกดเพื่อพูด', 'info', 4000);
                this.rest(epoch);
            }, ms);
        }
        rest(epoch) {
            if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
            this.clearTimer();
            this.token = null; this.claimPromise = null; this.queued = null; this.queuedSpeaking = false;
            if (this.handsFree) this.setState('WAIT_WAKE'); else this.stop();
        }
        fatal(error, epoch) {
            if (this.epoch !== epoch || this.state === 'OFF') return;
            this.stop();
            const message = error.name === 'NotAllowedError' ? 'ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน กรุณาอนุญาตแล้วเปิดใหม่'
                : error.name === 'NotFoundError' ? 'ไม่พบไมโครโฟน กรุณาตรวจสอบอุปกรณ์'
                : error.name === 'AbortError' ? 'ระบบเสียงตอบช้าเกินไป กรุณากดเปิดไมค์ใหม่' : error.message;
            this.options.notice(message === 'CANCELLED' ? 'อุปกรณ์เป้าหมายเปลี่ยนแล้ว กรุณาเปิดไมค์ใหม่' : message, 'error', 6500);
        }
        onStart(epoch) {
            if (!this.active(epoch)) return;
            if (this.state === 'WAIT_WAKE') { this.setState('CAPTURE_WAKE'); return; }
            if (['PROCESSING_WAKE', 'READY'].includes(this.state)) {
                // Bounded look-ahead: preserve a command spoken while the wake API/chime is finishing.
                this.queuedSpeaking = true; return;
            }
            if (this.state === 'WAIT_COMMAND') this.beginCommand(epoch);
        }
        beginCommand(epoch) {
            this.clearTimer(); this.setState('CAPTURE_COMMAND');
            this.claimPromise = this.token ? this.json('/api/voice-session/claim', this.body({ wakeToken: this.token }), epoch, 4000) : Promise.resolve();
            // Attach a rejection handler immediately, even if the speaker has not finished yet.
            this.claimPromise.catch(error => this.fatal(error, epoch));
        }
        onMisfire(epoch) {
            if (!this.active(epoch)) return;
            this.queuedSpeaking = false;
            if (this.state === 'CAPTURE_WAKE') this.setState('WAIT_WAKE');
            if (this.state === 'CAPTURE_COMMAND') {
                // A claimed token is one-shot; never leave a reserved capture stuck waiting forever.
                this.options.notice('เสียงสั้นหรือเบาเกินไป กรุณาพูดคำสั่งใหม่หรือกดเพื่อพูด', 'info', 3500);
                this.rest(epoch);
            }
        }
        async onEnd(samples, epoch) {
            if (!this.active(epoch) || this.handledAudio.has(samples)) return;
            this.handledAudio.add(samples);
            if (['PROCESSING_WAKE', 'READY'].includes(this.state)) {
                this.queuedSpeaking = false;
                if (!this.queued && samples.length <= 16000 * 15) this.queued = samples;
                return;
            }
            if (this.state === 'WAIT_COMMAND') this.beginCommand(epoch);
            if (this.state === 'WAIT_WAKE') this.setState('CAPTURE_WAKE');
            if (!['CAPTURE_WAKE', 'CAPTURE_COMMAND'].includes(this.state)) return;
            const stage = this.state === 'CAPTURE_WAKE' ? 'wake' : this.token ? 'command' : 'direct';
            this.clearTimer();
            if (samples.length < 1600 || samples.length > 16000 * 15) {
                if (stage !== 'wake') this.options.notice('เสียงสั้นหรือยาวเกินไป กรุณาพูดใหม่', 'warning', 4000);
                this.rest(epoch); return;
            }
            this.setState(stage === 'wake' ? 'PROCESSING_WAKE' : 'PROCESSING_COMMAND');
            const previous = this.options.current();
            const desired = JSON.stringify(previous);
            const revision = this.options.revision?.();
            const requestId = this.options.id();
            const controller = new AbortController(); this.controllers.add(controller);
            const timer = setTimeout(() => controller.abort(), 14000);
            try {
                if (stage !== 'wake') await this.claimPromise;
                if (!this.active(epoch)) return;
                const form = new FormData();
                const fields = this.body({ requestId, stage, wakeToken: this.token || '', currentAc: desired });
                for (const [key, value] of Object.entries(fields)) form.append(key, value);
                form.append('audio', this.options.wav(samples), 'voice.wav');
                const response = await this.options.fetch('/api/voice-command', { method: 'POST', body: form, signal: controller.signal });
                const data = await response.json();
                if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
                if (!response.ok) throw Object.assign(new Error(data.message || 'บริการเสียงไม่พร้อม กรุณาลองใหม่'), { status: response.status });
                this.failures = 0;
                if (data.requestId !== requestId) throw new Error('ผลตอบกลับเสียงไม่ตรงกับคำขอ กรุณาลองใหม่');
                if (data.ignored) { this.rest(epoch); return; }
                if (data.wakeOnly) { await this.readyForCommand(data.wakeToken, epoch); return; }
                this.queued = null; this.queuedSpeaking = false;
                if (!data.success) {
                    this.options.notice(data.message || 'ไม่เข้าใจคำสั่ง กรุณาพูดใหม่', 'warning', 5500);
                    await this.say({ text: 'ไม่เข้าใจคำสั่งครับ กรุณาพูดใหม่', clips: ['not-understood'] }, epoch);
                    this.rest(epoch); return;
                }
                if (this.delivered.has(requestId)) { this.rest(epoch); return; }
                // A manual command or a destination switch while ASR was pending invalidates this result.
                if (JSON.stringify(this.options.current()) !== desired || this.options.revision?.() !== revision) {
                    this.options.notice('สถานะคำสั่งเปลี่ยนระหว่างรับเสียง กรุณาพูดคำสั่งใหม่', 'warning', 5000);
                    this.rest(epoch); return;
                }
                this.delivered.add(requestId);
                if (this.delivered.size > 64) this.delivered.delete(this.delivered.values().next().value);
                const sent = this.options.send(data.nextState, `${data.label} [“${data.transcript}”]`);
                if (!sent) { await this.say({ text: 'ยังส่งคำสั่งไม่ได้ครับ กรุณาตรวจสอบการเชื่อมต่อ', clips: ['not-sent'] }, epoch); this.rest(epoch); return; }
                this.options.log('info', `ผลจำแนกเสียง: “${data.transcript}” • ${data.latencyMs} ms`);
                const feedback = data.feedback || this.options.feedback?.(data.nextState, previous);
                if (!sent.demo) {
                    clearTimeout(this.deviceTimer);
                    this.commandId = sent.id;
                    this.deviceTimer = setTimeout(() => this.deviceResult(sent.id, false, 'ไม่พบการตอบกลับจาก ESP32 • กรุณาตรวจอุปกรณ์ก่อนสั่งซ้ำ'), 11000);
                }
                this.options.notice(`${sent.demo ? 'จำลองคำสั่ง' : 'รับคำสั่ง'}: ${feedback?.text || data.label}${sent.demo ? ' • ไม่ส่งจริง' : ' • ส่งแล้ว รอสถานะ ESP32'}`, 'info', 6500);
                await this.say(feedback, epoch);
                // Device monitoring continues independently; do not block the next wake until ACK.
                this.rest(epoch);
            } catch (error) {
                if (!this.active(epoch)) { if (this.epoch === epoch && this.state !== 'OFF') this.stop(); return; }
                if (error.status === 410) { this.fatal(error, epoch); return; }
                const message = error.name === 'AbortError' ? 'บริการเสียงตอบช้าเกินไป • ยังไม่ได้ส่งคำสั่ง กรุณาลองใหม่' : error.message;
                // Report errors even in hands-free mode, without flooding the notice area.
                if (stage !== 'wake' || Date.now() - this.lastErrorAt > 5000) { this.lastErrorAt = Date.now(); this.options.notice(message, 'error', 6000); }
                this.rest(epoch);
                if (this.handsFree && this.active(epoch) && (!error.status || error.status >= 500)) {
                    const delay = Math.min(30000, 2000 * 2 ** this.failures++);
                    this.setState('RECOVERING', `บริการเสียงขัดข้อง • ลองใหม่ใน ${delay / 1000} วินาที`);
                    this.listenTimer = setTimeout(() => this.rest(epoch), delay);
                }
            } finally {
                clearTimeout(timer); this.controllers.delete(controller);
            }
        }
        async readyForCommand(token, epoch) {
            if (!token) throw new Error('ไม่ได้รับรหัสเปิดรับคำสั่ง กรุณาเรียก Engi ใหม่');
            this.token = token;
            // A command already spoken during wake lookup takes priority over a greeting.
            // Pausing capture here would cut off that command midway.
            if (!this.queued && !this.queuedSpeaking) {
                this.setState('ACKNOWLEDGING', 'กำลังขานรับ...');
                const replies = this.options.wakeReplies || [{ text: 'มีอะไรให้ช่วยครับ', clips: ['wake-help'] }];
                const reply = replies[this.wakeReplyIndex++ % replies.length];
                try { await this.audio.reply(reply); }
                catch (_) {
                    if (!this.active(epoch)) return;
                    this.options.notice('เสียงขานรับพูดไม่ได้ • รอเสียงติ๊งแล้วพูดได้เลย', 'warning', 4500);
                    await this.audio.beep('ready');
                }
            }
            if (!this.active(epoch)) return;
            this.setState('READY');
            const armStarted = Date.now();
            const data = await this.json('/api/voice-session/arm', this.body({ wakeToken: token }), epoch, 4000);
            if (!this.active(epoch)) return;
            this.setState('WAIT_COMMAND');
            this.options.notice('Engi พร้อมแล้ว • พูดคำสั่งได้เลย', 'info', 5000);
            this.listenTimeout(epoch, Math.max(0, data.listeningMs - (Date.now() - armStarted)));
            if (this.queuedSpeaking) this.beginCommand(epoch);
            else this.flushQueued(epoch);
        }
        flushQueued(epoch) {
            if (!this.queued || !this.active(epoch)) return;
            const samples = this.queued; this.queued = null;
            this.handledAudio.delete(samples);
            this.beginCommand(epoch); void this.onEnd(samples, epoch);
        }
        async say(feedback, epoch) {
            if (!this.active(epoch) || !feedback) return;
            this.setState('SPEAKING');
            try { await this.audio.reply(feedback); }
            catch (error) {
                if (this.active(epoch)) this.options.notice(`เสียงตอบกลับเล่นไม่ได้ • ${feedback.text || ''}`, 'warning', 6000);
            }
        }
        async deviceResult(id, success, message) {
            if (this.commandId !== id) return;
            const epoch = this.epoch;
            if (!this.active(epoch)) { this.stop(); return; }
            clearTimeout(this.deviceTimer); this.commandId = null;
            this.options.notice(message, success ? 'info' : 'warning', 6000);
            // Never interrupt spoken feedback or a new user utterance with a device tone.
            if (success && this.state === 'WAIT_WAKE') {
                try { await this.audio.beep('confirmed'); }
                catch (_) { /* Spoken command feedback remains the primary acknowledgement. */ }
            }
        }
    }
    root.SmartVoiceController = VoiceController;
    if (typeof module !== 'undefined') module.exports = VoiceController;
})(typeof window === 'undefined' ? globalThis : window);
