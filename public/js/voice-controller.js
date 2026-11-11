(function (root) {
    'use strict';
    class VoiceController {
        constructor(options) {
            this.options = options;
            this.state = 'OFF'; this.epoch = 0; this.controllers = new Set();
            this.handledAudio = new WeakSet(); this.queue = []; this.queueSpeaking = false; this.failures = 0; this.replyIndex = 0;
        }
        setState(state, label) { this.state = state; this.options.render(state, this.handsFree, label); }
        active(epoch) { return this.epoch === epoch && this.state !== 'OFF' && this.device === this.options.device(); }
        clearTimer() { clearTimeout(this.listenTimer); this.listenTimer = null; }
        async json(url, body, epoch, timeout = 14000) {
            const controller = new AbortController(); this.controllers.add(controller);
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await this.options.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
                const data = await response.json();
                if (!this.active(epoch)) {
                    if (url === '/api/voice-session' && data.sessionId) this.cancelSession(data.sessionId);
                    throw new Error('CANCELLED');
                }
                if (!response.ok) throw Object.assign(new Error(data.message || 'โมเดลในเครื่องไม่พร้อม'), { status: response.status });
                return data;
            } finally { clearTimeout(timer); this.controllers.delete(controller); }
        }
        cancelSession(sessionId) {
            this.options.fetch('/api/voice-session/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId }), keepalive: true, signal: AbortSignal.timeout(3000) }).catch(() => {});
        }
        stop() {
            const session = this.sessionId;
            this.epoch++; this.clearTimer(); clearInterval(this.keepAliveTimer); clearTimeout(this.deviceTimer);
            for (const c of this.controllers) c.abort(); this.controllers.clear();
            this.audio?.close(); this.audio = null; this.sessionId = null; this.commandId = null;
            this.queue = []; this.queueSpeaking = false; this.endQueueWait?.();
            this.followUp = false; this.commandDeadline = 0; this.wakeToken = null; this.armPromise = null; this.claimPromise = null; this.handsFree = false; this.setState('OFF');
            if (session) this.cancelSession(session);
        }
        async start(handsFree, { automatic = false } = {}) {
            this.lastStartError = null; this.stop();
            const epoch = this.epoch;
            this.device = this.options.device(); this.handsFree = handsFree; this.failures = 0; this.setState('INIT');
            const audio = this.options.audio({ onStart: () => this.onStart(epoch), onEnd: samples => { void this.onEnd(samples, epoch); },
                onMisfire: () => this.onMisfire(epoch), onError: error => this.fatal(error, epoch) });
            this.audio = audio;
            try {
                let timer;
                try {
                    await Promise.race([audio.start({ automatic }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('เตรียมไมค์นานเกินไป กรุณาเปิดไมค์ใหม่')), 15000); })]);
                } finally { clearTimeout(timer); }
                if (!this.active(epoch)) { audio.close(); return false; }
                const data = await this.json('/api/voice-session', { device: this.device }, epoch);
                this.sessionId = data.sessionId; this.engine = data.engine;
                this.keepAliveTimer = setInterval(() => { this.json('/api/voice-session/ping', this.body(), epoch, 5000).catch(error => this.fatal(error, epoch)); }, 4 * 60 * 1000);
                if (handsFree) {
                    await audio.beep('ready');
                    if (!this.active(epoch)) return false;
                    this.options.notice('รอเรียก “Engi / เอ็นจี้ / เอนจี้” • พูดชื่อพร้อมคำสั่ง หรือรอเสียงขานรับแล้วพูดต่อ', 'info', 7000);
                } else {
                    this.setState('READY'); await audio.beep('ready');
                    if (!this.active(epoch)) return false;
                }
                if (this.state !== 'CAPTURE_COMMAND') this.listen(epoch);
                return true;
            } catch (error) {
                this.lastStartError = error;
                if (automatic && error.code === 'VOICE_GESTURE_REQUIRED' && this.epoch === epoch) { this.stop(); this.setState('OFF', error.message); }
                else this.fatal(error, epoch);
                return false;
            }
        }
        body(extra = {}) { return { sessionId: this.sessionId, device: this.device, ...extra }; }
        listen(epoch) {
            if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
            this.clearTimer();
            if (this.queueSpeaking) { this.setState('DRAINING'); return; }
            this.setState(this.handsFree && !this.wakeToken ? 'WAIT_CONTINUOUS' : 'WAIT_COMMAND');
            if (!this.handsFree || this.followUp) this.listenTimer = setTimeout(() => {
                if (!this.active(epoch) || !['WAIT_COMMAND','WAIT_CONTINUOUS'].includes(this.state)) return;
                this.commandDeadline = 0; this.wakeToken = null; this.armPromise = null; this.claimPromise = null; this.followUp = false;
                if (this.handsFree) { this.options.notice('หมดเวลารับคำสั่ง กรุณาเรียกเอ็นจี้อีกครั้ง', 'info', 3500); this.listen(epoch); }
                else { this.options.notice('หมดเวลารับคำสั่ง กดไมค์เพื่อพูดใหม่', 'info', 3500); this.stop(); }
            }, this.handsFree && this.commandDeadline ? Math.max(0, this.commandDeadline-Date.now()) : 9000);
        }
        rest(epoch) {
            if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
            if (this.queue.length) {
                const packet = this.queue.shift();
                if (Date.now() - packet.time > 20000 || packet.revision !== this.options.revision?.()) {
                    this.options.notice('มีคำสั่งอื่นเปลี่ยนสถานะหรือเสียงรอนานเกินไป กรุณาพูดใหม่', 'warning', 4000);
                    this.queue = []; this.listen(epoch); return;
                }
                this.setState('CAPTURE_COMMAND');
                this.handledAudio.delete(packet.samples); void this.onEnd(packet.samples, epoch); return;
            }
            if (this.handsFree || this.followUp) this.listen(epoch); else this.stop();
        }
        fatal(error, epoch) {
            if (this.epoch !== epoch) return;
            this.stop();
            const message = error.name === 'NotAllowedError' ? 'กรุณาอนุญาตไมโครโฟนแล้วลองใหม่' : error.message;
            this.options.notice(message === 'CANCELLED' ? 'อุปกรณ์เป้าหมายเปลี่ยน กรุณาเปิดไมค์ใหม่' : message, 'error', 6000);
        }
        async openCommandWindow(data, epoch) {
            this.followUp = true;
            if (!this.queue.length) await this.say(data.feedback, epoch);
            if (!this.active(epoch)) return;
            if (this.handsFree) {
                if (!data.wakeToken) throw new Error('ไม่ได้รับสิทธิ์รับคำสั่ง กรุณาเรียกเอ็นจี้ใหม่');
                this.wakeToken = data.wakeToken; this.claimPromise = null;
                this.setState('READY');
                this.armPromise = this.json('/api/voice-session/arm', this.body({wakeToken:this.wakeToken}), epoch, 4000);
                const armed=await this.armPromise; this.commandDeadline=Date.now()+(armed.listeningMs || 9000);
                if (!this.active(epoch)) return;
            }
            if (this.state !== 'CAPTURE_COMMAND') this.rest(epoch);
        }
        claimCommand(epoch) {
            if (!this.handsFree || !this.wakeToken || this.claimPromise) return;
            const token=this.wakeToken;
            this.claimPromise = Promise.resolve(this.armPromise).then(() => this.json('/api/voice-session/claim', this.body({wakeToken:token}),epoch,4000));
            this.claimPromise.catch(() => {});
        }
        async finishQueuedSpeech(epoch) {
            if (!this.queueSpeaking || !this.active(epoch)) return;
            this.setState('DRAINING');
            await new Promise(resolve => {
                const timer = setTimeout(() => { this.queueSpeaking = false; this.endQueueWait?.(); }, 12500);
                this.endQueueWait = () => { clearTimeout(timer); this.endQueueWait = null; resolve(); };
            });
        }
        onStart(epoch) {
            if (!this.active(epoch)) return;
            if (this.handsFree && ['PROCESSING_COMMAND', 'DRAINING'].includes(this.state)) {
                this.queueSpeaking = true; this.queueRevision = this.options.revision?.(); return;
            }
            if (['WAIT_COMMAND', 'WAIT_CONTINUOUS', 'READY'].includes(this.state)) {
                this.clearTimer(); this.setState('CAPTURE_COMMAND'); this.claimCommand(epoch);
            }
        }
        onMisfire(epoch) {
            if (!this.active(epoch)) return;
            if (this.queueSpeaking) { this.queueSpeaking = false; this.endQueueWait?.(); return; }
            if (this.state === 'CAPTURE_COMMAND') {
                if (Date.now()-(this.lastMisfireAt||0)>5000) { this.lastMisfireAt=Date.now(); this.options.notice('เสียงสั้นหรือเบาเกินไป ลองพูดใกล้ไมค์อีกครั้งครับ', 'info', 3500); }
                this.listen(epoch);
            }
        }
        async onEnd(samples, epoch) {
            if (!this.active(epoch) || this.handledAudio.has(samples)) return;
            if (this.handsFree && ['PROCESSING_COMMAND', 'DRAINING'].includes(this.state)) {
                this.handledAudio.add(samples); this.queueSpeaking = false;
                if (this.queue.length < 1) this.queue.push({samples, time:Date.now(), revision:this.queueRevision ?? this.options.revision?.()});
                else this.options.notice('มีคำสั่งรอประมวลผลอยู่ กรุณารอเสียงตอบก่อนพูดอีกครั้ง', 'warning', 4000);
                this.endQueueWait?.(); return;
            }
            if (['WAIT_COMMAND', 'WAIT_CONTINUOUS', 'READY'].includes(this.state)) this.onStart(epoch);
            if (this.state !== 'CAPTURE_COMMAND') return;
            this.handledAudio.add(samples); this.clearTimer();
            this.setState('PROCESSING_COMMAND');
            const previous = this.options.current(), desired = JSON.stringify(previous), revision = this.options.revision?.();
            const requestId = this.options.id();
            const controller = new AbortController(); this.controllers.add(controller);
            const timer = setTimeout(() => controller.abort(), 40000);
            const token = this.handsFree ? this.wakeToken : null;
            try {
                this.claimCommand(epoch); await this.claimPromise;
                if (!this.active(epoch)) return;
                const form = new FormData();
                for (const [key, value] of Object.entries(this.body({ requestId, stage: this.handsFree ? token ? 'command' : 'continuous' : 'direct', wakeToken: token || '', currentAc: desired }))) form.append(key, value);
                form.append('audio', this.options.wav(samples), 'voice.wav');
                const response = await this.options.fetch('/api/voice-command', { method: 'POST', body: form, signal: controller.signal });
                const data = await response.json();
                if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
                if (!response.ok) throw Object.assign(new Error(data.message || 'โมเดลในเครื่องไม่พร้อม'), { status: response.status });
                if (data.requestId !== requestId) throw new Error('ผลคำสั่งเสียงไม่ตรงกับคำขอ กรุณาพูดใหม่');
                this.failures = 0;
                if (token) { this.commandDeadline=0; this.wakeToken=null; this.claimPromise=null; this.armPromise=null; this.followUp=false; }
                await this.finishQueuedSpeech(epoch);
                if (!this.active(epoch)) return;
                if (data.ignored) {
                    if (data.message && Date.now()-(this.lastUnclearAt||0)>5000) {
                        this.lastUnclearAt=Date.now(); this.options.notice(data.message, 'info', 3500);
                    }
                    this.rest(epoch); return;
                }
                if (data.followUp || data.wakeOnly) {
                    await this.openCommandWindow(data, epoch); return;
                }
                if (!data.success) {
                    this.options.notice(data.message || 'ไม่เข้าใจคำสั่ง กรุณาพูดใหม่', 'warning', 5000);
                    await this.say(data.feedback || { text: 'ไม่เข้าใจคำสั่งครับ กรุณาพูดใหม่', clips: ['not-understood'] }, epoch);
                    this.rest(epoch); return;
                }
                if (JSON.stringify(this.options.current()) !== desired || this.options.revision?.() !== revision) {
                    this.options.notice('มีคำสั่งอื่นระหว่างประมวลผล กรุณาพูดใหม่', 'warning', 5000); this.rest(epoch); return;
                }
                this.followUp = false; this.wakeToken=null; this.armPromise=null; this.claimPromise=null;
                const beforeRevision = this.options.revision?.();
                const sent = this.options.send(data.nextState, `${data.label} [โมเดลในเครื่อง]`);
                if (!sent) { await this.say({ text: 'ยังส่งคำสั่งไม่ได้ครับ กรุณาตรวจสอบการเชื่อมต่อ', clips: ['not-sent'] }, epoch); this.rest(epoch); return; }
                for (const packet of this.queue) if (packet.revision === beforeRevision) packet.revision = this.options.revision?.();
                let feedback = data.feedback || this.options.feedback?.(data.nextState, previous);
                // Short natural variants still describe only the command submitted, never physical completion.
                if (feedback?.clips?.length === 1 && this.replyIndex++ % 2 && this.options.variant) feedback = this.options.variant(feedback);
                this.options.log('info', `ได้ยิน “${data.transcript || data.label}” → ${data.label} • ${data.latencyMs} ms`);
                if (!sent.demo) {
                    clearTimeout(this.deviceTimer); this.commandId = sent.id;
                    this.deviceTimer = setTimeout(() => this.deviceResult(sent.id, false, 'ไม่พบสถานะตอบกลับจาก ESP32 กรุณาตรวจอุปกรณ์'), 11000);
                }
                this.options.notice(`${sent.demo ? 'จำลอง' : 'รับคำสั่ง'}: ${feedback?.text || data.label}${sent.demo ? ' • ไม่ส่งจริง' : ' • ส่งแล้ว รอสถานะ ESP32'}`, 'info', 6500);
                await this.say(feedback, epoch); this.rest(epoch);
            } catch (error) {
                if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
                this.wakeToken=null; this.armPromise=null; this.claimPromise=null; this.followUp=false;
                if (error.status === 410) { this.fatal(error, epoch); return; }
                this.options.notice(error.name === 'AbortError' ? 'โมเดลตอบช้าเกินไป กรุณาลองใหม่' : error.message, 'error', 5500);
                if (this.handsFree && (!error.status || error.status >= 500)) {
                    const ms = Math.min(30000, 2000 * 2 ** this.failures++);
                    this.setState('RECOVERING', `ลองใหม่ใน ${ms / 1000} วินาที`);
                    this.listenTimer = setTimeout(() => this.rest(epoch), ms);
                } else this.rest(epoch);
            } finally { clearTimeout(timer); this.controllers.delete(controller); }
        }
        async say(feedback, epoch) {
            if (!this.active(epoch) || !feedback) return;
            await this.finishQueuedSpeech(epoch);
            if (!this.active(epoch)) return;
            this.setState('SPEAKING');
            try { await this.audio.reply(feedback); }
            catch (_) { if (this.active(epoch)) this.options.notice(`เสียงตอบกลับเล่นไม่ได้ • ${feedback.text}`, 'warning', 5000); }
        }
        async deviceResult(id, success, message) {
            if (this.commandId !== id) return;
            const epoch = this.epoch;
            if (!this.active(epoch)) return;
            clearTimeout(this.deviceTimer); this.commandId = null;
            this.options.notice(message, success ? 'info' : 'warning', 6000);
            if (success && this.state === 'WAIT_CONTINUOUS') { try { await this.audio.beep('confirmed'); } catch (_) {} }
        }
    }
    root.SmartVoiceController = VoiceController;
    if (typeof module !== 'undefined') module.exports = VoiceController;
})(typeof window === 'undefined' ? globalThis : window);
