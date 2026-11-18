(function (root) {
    'use strict';
    const QUERIES = new Set(['room_temperature', 'people_count', 'room_humidity', 'ac_setpoint', 'ac_power']);
    // The server allows 90 seconds for the local Whisper worker to start.
    const SESSION_START_TIMEOUT_MS = 95000;
    class VoiceController {
        constructor(options) {
            this.options = options;
            this.state = 'OFF'; this.epoch = 0; this.controllers = new Set();
            this.handledAudio = new WeakSet(); this.queue = []; this.queueSpeaking = false; this.failures = 0; this.replyIndex = 0;
        }
        setState(state, label) { this.state = state; this.options.render(state, this.handsFree, label); }
        active(epoch) { return this.epoch === epoch && this.state !== 'OFF' && this.device === this.options.device(); }
        clearTimer() { clearTimeout(this.listenTimer); this.listenTimer = null; }
        clearWake() {
            this.followUp = false; this.commandDeadline = 0; this.wakeToken = null; this.armPromise = null; this.claimPromise = null;
        }
        discardQueuedSpeech() {
            this.queue = []; this.queueSpeaking = false; this.queueRevision = undefined; this.endQueueWait?.();
        }
        async json(url, body, epoch, timeout = 14000) {
            const controller = new AbortController(); this.controllers.add(controller);
            const start = url === '/api/voice-session';
            const timedOut = new Error(start ? 'เซิร์ฟเวอร์ใช้เวลาเปิดโมเดลเสียงนานเกินไป' : 'เซิร์ฟเวอร์เสียงตอบกลับช้าเกินไป');
            const timer = setTimeout(() => controller.abort(timedOut), timeout);
            try {
                const response = await this.options.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
                const data = await response.json().catch(() => null);
                if (!this.active(epoch) || controller.signal.aborted) {
                    if (start && data?.sessionId) this.cancelSession(data.sessionId);
                    controller.signal.throwIfAborted();
                    throw new Error('CANCELLED');
                }
                if (!response.ok || !data || (start && typeof data.sessionId !== 'string')) {
                    const message = data?.message || `เซิร์ฟเวอร์เสียงตอบกลับผิดปกติ (HTTP ${response.status})`;
                    throw Object.assign(new Error(message), { status: response.status });
                }
                return data;
            } catch (error) {
                if (controller.signal.reason === timedOut) throw timedOut;
                if (start && error instanceof TypeError) throw new Error('ติดต่อเซิร์ฟเวอร์เสียงไม่ได้ กรุณาตรวจการเชื่อมต่อ');
                throw error;
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
            this.localModel?.close(); this.localModel = null;
            this.discardQueuedSpeech();
            this.clearWake(); this.inputVersion = 0; this.micMuted = false; this.handsFree = false; this.setState('OFF');
            if (session) this.cancelSession(session);
        }
        async connectSession(epoch) {
            const session = await this.json('/api/voice-session', {
                device: this.device, ...(this.localModel ? { browserRecognition: true } : {})
            }, epoch, SESSION_START_TIMEOUT_MS);
            if (!this.active(epoch)) { this.cancelSession(session.sessionId); return; }
            this.sessionId = session.sessionId; this.engine = session.engine;
        }
        async pingSession(epoch) {
            const session = this.sessionId;
            if (!this.active(epoch) || !session) return;
            try { await this.json('/api/voice-session/ping', this.body(), epoch, 5000); }
            catch (error) {
                // A transport glitch during idle listening should not tear down the mic.
                if (error.status === 410 && this.sessionId === session) await this.reconnectSession(epoch);
            }
        }
        async reconnectSession(epoch) {
            if (!this.active(epoch) || !this.sessionId) return;
            this.sessionId = null;
            this.inputVersion++;
            this.commandRequest?.abort();
            this.clearTimer(); this.clearWake(); this.discardQueuedSpeech();
            this.setState('RECOVERING', 'กำลังเชื่อมต่อเซสชันเสียงใหม่');
            this.audio.resetInput?.();
            try {
                await this.connectSession(epoch);
                if (this.active(epoch)) { this.audio.resetInput?.(); this.listen(epoch); }
            } catch (error) {
                if (this.active(epoch)) this.fatal(error, epoch);
            }
        }
        async start(handsFree, { automatic = false } = {}) {
            if (this.options.canStart?.() === false) return false;
            this.lastStartError = null; this.stop();
            const epoch = this.epoch;
            this.device = this.options.device(); this.handsFree = handsFree; this.failures = 0; this.setState('INIT', 'กำลังเตรียมไมโครโฟน');
            this.localModel = this.options.localModel?.();
            let connection;
            const beginConnection = () => {
                if (connection || !this.active(epoch)) return;
                connection = this.connectSession(epoch);
                connection.catch(() => {});
            };
            const audio = this.options.audio({ onStart: () => this.onStart(epoch), onEnd: samples => { void this.onEnd(samples, epoch); },
                onMisfire: reason => this.onMisfire(epoch, reason), onError: error => this.fatal(error, epoch),
                onPreparation: label => { if (this.active(epoch) && this.state === 'INIT') this.setState('INIT', label); },
                onAvailability: available => this.onAvailability(epoch, available), onMicReady: beginConnection });
            this.audio = audio;
            try {
                await audio.start({ automatic });
                if (!this.active(epoch)) { audio.close(); return false; }
                void this.localModel?.prepare();
                if (!this.sessionId) this.setState('INIT', this.localModel ? 'กำลังเปิดเซสชันเสียง' : 'กำลังโหลดโมเดลเสียงบนเซิร์ฟเวอร์');
                beginConnection();
                await connection;
                if (!this.active(epoch)) return false;
                this.keepAliveTimer = setInterval(() => { void this.pingSession(epoch); }, 4 * 60 * 1000);
                if (!handsFree) {
                    this.setState('READY'); await audio.beep('ready');
                    if (!this.active(epoch)) return false;
                }
                if (this.state !== 'CAPTURE_COMMAND') this.listen(epoch);
                return true;
            } catch (error) {
                if (this.epoch !== epoch) return false;
                this.lastStartError = error;
                if (automatic && error.code === 'VOICE_GESTURE_REQUIRED' && this.epoch === epoch) { this.stop(); this.setState('OFF', error.message); }
                else this.fatal(error, epoch);
                return false;
            }
        }
        body(extra = {}) { return { sessionId: this.sessionId, device: this.device, ...extra }; }
        finishDirect() { this.stop(); this.options.onDirectEnd?.(); }
        listen(epoch) {
            if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
            this.clearTimer();
            if (this.micMuted) { this.setState('MIC_PAUSED'); return; }
            if (this.queueSpeaking) { this.setState('DRAINING'); return; }
            this.setState(this.handsFree && !this.wakeToken ? 'WAIT_CONTINUOUS' : 'WAIT_COMMAND');
            if (!this.handsFree || this.followUp) this.listenTimer = setTimeout(() => {
                if (!this.active(epoch) || !['WAIT_COMMAND','WAIT_CONTINUOUS'].includes(this.state)) return;
                this.clearWake();
                if (this.handsFree) this.listen(epoch);
                else { this.options.notice('หมดเวลารับคำสั่ง กดไมค์เพื่อพูดใหม่', 'info', 3500); this.finishDirect(); }
            }, this.handsFree && this.commandDeadline ? Math.max(0, this.commandDeadline-Date.now()) : 9000);
        }
        rest(epoch) {
            if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
            if (this.micMuted) { this.listen(epoch); return; }
            if (this.queue.length) {
                const packet = this.queue.shift();
                if (Date.now() - packet.time > 20000 || packet.revision !== this.options.revision?.()) {
                    this.queue = []; this.listen(epoch); return;
                }
                this.setState('CAPTURE_COMMAND');
                this.handledAudio.delete(packet.samples); void this.onEnd(packet.samples, epoch); return;
            }
            if (this.handsFree || this.followUp) this.listen(epoch); else this.finishDirect();
        }
        fatal(error, epoch) {
            if (this.epoch !== epoch) return;
            const handsFree = this.handsFree;
            this.stop();
            if (handsFree && this.options.onHandsFreeFault) { this.options.onHandsFreeFault(error); return; }
            const message = error.name === 'NotAllowedError' ? 'กรุณาอนุญาตไมโครโฟนแล้วลองใหม่' : error.message;
            this.options.notice(message === 'CANCELLED' ? 'อุปกรณ์เป้าหมายเปลี่ยน กรุณาเปิดไมค์ใหม่' : message, 'error', 6000);
            if (!handsFree) this.options.onDirectEnd?.();
        }
        async openCommandWindow(data, epoch, inputVersion) {
            // Start a new utterance after the actual acknowledgement. Background
            // speech captured before recognizing the wake word cannot inherit a token.
            this.discardQueuedSpeech();
            if (this.handsFree && !data.wakeToken) throw new Error('ไม่ได้รับสิทธิ์รับคำสั่ง กรุณาเรียกเอ็นจี้ใหม่');
            this.followUp = true;
            const acknowledged = await this.say(data.feedback, epoch, inputVersion);
            if (!this.active(epoch) || inputVersion !== this.inputVersion) return;
            if (this.handsFree) {
                if (!acknowledged) { this.clearWake(); this.rest(epoch); return; }
                this.wakeToken = data.wakeToken; this.claimPromise = null;
                this.setState('READY');
                this.armPromise = this.json('/api/voice-session/arm', this.body({wakeToken:this.wakeToken}), epoch, 4000);
                const armed=await this.armPromise;
                if (!this.active(epoch) || inputVersion !== this.inputVersion) return;
                this.commandDeadline=Date.now()+(armed.listeningMs || 9000);
            }
            if (this.state !== 'CAPTURE_COMMAND') this.rest(epoch);
        }
        claimCommand(epoch) {
            if (!this.handsFree || !this.wakeToken || this.claimPromise) return;
            const token=this.wakeToken, inputVersion=this.inputVersion, body=this.body({wakeToken:token});
            this.claimPromise = Promise.resolve(this.armPromise).then(() => {
                if (!this.active(epoch) || this.inputVersion !== inputVersion || this.wakeToken !== token) throw new Error('CANCELLED');
                return this.json('/api/voice-session/claim', body, epoch, 4000);
            });
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
            if (!this.active(epoch) || this.micMuted) return;
            if (this.handsFree && ['PROCESSING_COMMAND', 'DRAINING'].includes(this.state)) {
                this.queueSpeaking = true; this.queueRevision = this.options.revision?.(); return;
            }
            if (['WAIT_COMMAND', 'WAIT_CONTINUOUS', 'READY'].includes(this.state)) {
                this.clearTimer(); this.setState('CAPTURE_COMMAND'); this.claimCommand(epoch);
            }
        }
        onAvailability(epoch, available) {
            if (!this.active(epoch) || this.micMuted === !available) return;
            this.micMuted = !available;
            this.inputVersion++;
            this.commandRequest?.abort();
            this.discardQueuedSpeech(); this.clearWake();
            if (!this.sessionId || this.state === 'INIT' || this.state === 'RECOVERING') return;
            this.clearTimer();
            if (!available) this.setState('MIC_PAUSED');
            else this.listen(epoch);
        }
        onMisfire(epoch, reason) {
            if (!this.active(epoch)) return;
            if (this.queueSpeaking) { this.queueSpeaking = false; this.endQueueWait?.(); return; }
            if (this.state === 'CAPTURE_COMMAND') {
                if (!this.handsFree || this.wakeToken) {
                    this.options.notice(reason === 'too_long' ? 'ประโยคยาวเกินไป ลองพูดให้สั้นลง' : 'เสียงสั้นหรือเบาเกินไป ลองพูดใกล้ไมค์อีกครั้ง', 'info', 3500);
                }
                if (this.handsFree) this.clearWake();
                this.listen(epoch);
            }
        }
        async onEnd(samples, epoch) {
            if (!this.active(epoch) || this.micMuted || this.handledAudio.has(samples)) return;
            if (this.handsFree && ['PROCESSING_COMMAND', 'DRAINING'].includes(this.state)) {
                this.handledAudio.add(samples); this.queueSpeaking = false;
                if (this.queue.length < 1) this.queue.push({samples, time:Date.now(), revision:this.queueRevision ?? this.options.revision?.()});
                this.endQueueWait?.(); return;
            }
            if (['WAIT_COMMAND', 'WAIT_CONTINUOUS', 'READY'].includes(this.state)) this.onStart(epoch);
            if (this.state !== 'CAPTURE_COMMAND') return;
            this.handledAudio.add(samples); this.clearTimer();
            this.setState('PROCESSING_COMMAND');
            const previous = this.options.current(), desired = JSON.stringify(previous), revision = this.options.revision?.();
            const requestId = this.options.id();
            const controller = new AbortController(); this.controllers.add(controller);
            this.commandRequest = controller;
            const timer = setTimeout(() => controller.abort(), 40000);
            const token = this.handsFree ? this.wakeToken : null;
            const waitingForName = this.handsFree && !token;
            const inputVersion = this.inputVersion;
            try {
                this.claimCommand(epoch); await this.claimPromise;
                if (!this.active(epoch) || inputVersion !== this.inputVersion) return;
                const fields = this.body({ requestId, stage: this.handsFree ? token ? 'command' : 'continuous' : 'direct', wakeToken: token || '' });
                let response, data, browserMs = 0, requestMs;
                if (this.localModel?.canRecognize(samples)) {
                    this.setState('PROCESSING_COMMAND', waitingForName ? 'กำลังตรวจคำเรียก Engi บนอุปกรณ์…' : 'กำลังประมวลผลเสียงบนอุปกรณ์…');
                    const started = performance.now();
                    const transcripts = await this.localModel.recognize(samples, controller.signal);
                    browserMs = Math.round(performance.now() - started);
                    if (!this.active(epoch) || inputVersion !== this.inputVersion) return;
                    controller.signal.throwIfAborted();
                    if (transcripts) {
                        const requestStartedAt = performance.now();
                        response = await this.options.fetch('/api/voice-transcript', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                            body: JSON.stringify({ ...fields, currentAc: previous, transcripts })
                        });
                        data = await response.json().catch(() => null);
                        requestMs = Math.round(performance.now() - requestStartedAt);
                    }
                }
                if (!this.active(epoch) || inputVersion !== this.inputVersion) return;
                controller.signal.throwIfAborted();
                // Only an explicit decline (or an older server lacking the
                // route) allows the same audio to go to the fallback. A
                // successful transcript may already have spent its wake token.
                if (!response || response.status === 404 || (response.ok && data?.useServer === true)) {
                    this.setState('PROCESSING_COMMAND', waitingForName ? 'กำลังตรวจคำเรียก Engi บนเซิร์ฟเวอร์…' : 'กำลังประมวลผลเสียงบนเซิร์ฟเวอร์…');
                    const form = new FormData();
                    for (const [key, value] of Object.entries({ ...fields, currentAc: desired })) form.append(key, value);
                    form.append('audio', this.options.wav(samples), 'voice.wav');
                    const requestStartedAt = performance.now();
                    response = await this.options.fetch('/api/voice-command', { method: 'POST', body: form, signal: controller.signal });
                    data = await response.json().catch(() => null);
                    requestMs = Math.round(performance.now() - requestStartedAt);
                }
                if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
                if (inputVersion !== this.inputVersion) return;
                controller.signal.throwIfAborted();
                if (!response.ok || !data) {
                    const message = data?.message || `เซิร์ฟเวอร์เสียงตอบกลับผิดปกติ (HTTP ${response.status})`;
                    throw Object.assign(new Error(message), { status: response.status });
                }
                if (data.requestId !== requestId) throw new Error('ผลคำสั่งเสียงไม่ตรงกับคำขอ กรุณาพูดใหม่');
                const browser = data.engine === 'LOCAL_BROWSER';
                const asrTiming = Number.isFinite(data.latencyMs) && data.latencyMs >= 0
                    ? `ประมวลผลบนเซิร์ฟเวอร์ ${data.latencyMs} ms · รับส่งและรอคิว ~${Math.max(0, requestMs - data.latencyMs)} ms`
                    : `รอผลเสียง ${requestMs} ms`;
                const timing = browser ? `ถอดเสียงบนอุปกรณ์ ${browserMs} ms · ตรวจคำสั่ง ${requestMs} ms`
                    : browserMs ? `ลองบนอุปกรณ์ ${browserMs} ms · ${asrTiming}` : asrTiming;
                this.failures = 0;
                if (token) this.clearWake();
                const ignored = data.ignored || (waitingForName && data.wakeVerified !== true);
                if (!ignored && (data.followUp || data.wakeOnly)) {
                    this.options.log('info', `เอ็นจี้ยืนยันคำเรียก “${data.transcript}” · ${timing}`);
                    await this.openCommandWindow(data, epoch, inputVersion); return;
                }
                if (ignored) {
                    await this.finishQueuedSpeech(epoch);
                    if (inputVersion === this.inputVersion) this.rest(epoch);
                    return;
                }
                if (!data.success) {
                    this.options.notice(data.message || 'ไม่เข้าใจคำสั่ง กรุณาพูดใหม่', 'warning', 5000);
                    await this.say(data.feedback || { text: 'ไม่เข้าใจคำสั่งครับ กรุณาพูดใหม่', clips: ['not-understood'] }, epoch, inputVersion);
                    if (inputVersion === this.inputVersion) this.rest(epoch);
                    return;
                }
                if (Object.hasOwn(data, 'query')) {
                    // Read observations when the answer is ready, independent of
                    // AC revisions since capture. A query cannot fall through to send().
                    await this.finishQueuedSpeech(epoch);
                    if (!this.active(epoch) || inputVersion !== this.inputVersion) return;
                    this.clearWake();
                    const feedback = QUERIES.has(data.query) ? this.options.answer?.(data.query) : null;
                    if (typeof feedback?.text !== 'string' || !feedback.text.trim() || !Array.isArray(feedback.clips) || !feedback.clips.length) {
                        this.options.notice('ยังอ่านคำตอบไม่ได้ กรุณาถามใหม่', 'warning', 5000);
                    } else {
                        this.options.notice(feedback.text, 'info', 6500);
                        this.options.log('info', `เอ็นจี้ตอบ: ${feedback.text} · ${timing}`);
                        await this.say(feedback, epoch, inputVersion);
                    }
                    if (inputVersion === this.inputVersion) this.rest(epoch);
                    return;
                }
                if (JSON.stringify(this.options.current()) !== desired || this.options.revision?.() !== revision) {
                    this.options.notice('มีคำสั่งอื่นระหว่างประมวลผล กรุณาพูดใหม่', 'warning', 5000); this.rest(epoch); return;
                }
                this.clearWake();
                const beforeRevision = this.options.revision?.();
                const validate = () => this.active(epoch) && inputVersion === this.inputVersion && !controller.signal.aborted &&
                    JSON.stringify(this.options.current()) === desired && this.options.revision?.() === revision;
                const sendStartedAt = performance.now();
                const sent = await this.options.send(data.nextState, `${data.label} [โมเดลในเครื่อง]`, { validate, signal: controller.signal });
                const sendMs = Math.round(performance.now() - sendStartedAt);
                if (!this.active(epoch) || inputVersion !== this.inputVersion) return;
                if (!sent) {
                    await this.say({ text: 'ยังส่งคำสั่งไม่ได้ครับ กรุณาตรวจสอบการเชื่อมต่อ', clips: ['not-sent'] }, epoch, inputVersion);
                    if (inputVersion === this.inputVersion) this.rest(epoch);
                    return;
                }
                const afterRevision = this.options.revision?.();
                for (const packet of this.queue) if (packet.revision === beforeRevision) packet.revision = afterRevision;
                if (this.queueSpeaking && this.queueRevision === beforeRevision) this.queueRevision = afterRevision;
                let feedback = data.feedback || this.options.feedback?.(data.nextState, previous);
                // Short natural variants still describe only the command submitted, never physical completion.
                if (feedback?.clips?.length === 1 && this.replyIndex++ % 2 && this.options.variant) feedback = this.options.variant(feedback);
                this.options.log('info', `ได้ยิน “${data.transcript || data.label}” → ${data.label} • ${timing} · ตรวจสิทธิ์และส่ง MQTT ${sendMs} ms`);
                if (!sent.demo) {
                    clearTimeout(this.deviceTimer); this.commandId = sent.id;
                    this.deviceTimer = setTimeout(() => this.deviceResult(sent.id, false, 'ไม่พบสถานะตอบกลับจาก ESP32 กรุณาตรวจอุปกรณ์'), 11000);
                }
                this.options.notice(`${sent.demo ? 'จำลอง' : 'รับคำสั่ง'}: ${feedback?.text || data.label}${sent.demo ? ' • ไม่ส่งจริง' : ' • ส่งแล้ว รอสถานะ ESP32'}`, 'info', 6500);
                await this.say(feedback, epoch, inputVersion);
                if (inputVersion === this.inputVersion) this.rest(epoch);
            } catch (error) {
                if (!this.active(epoch)) { if (this.epoch === epoch) this.stop(); return; }
                if (inputVersion !== this.inputVersion) return;
                this.clearWake();
                if (error.status === 410) {
                    if (this.handsFree) await this.reconnectSession(epoch);
                    else this.fatal(error, epoch);
                    return;
                }
                if (!waitingForName) this.options.notice(error.name === 'AbortError' ? 'โมเดลตอบช้าเกินไป กรุณาลองใหม่' : error.message, 'error', 5500);
                if (this.handsFree && (!error.status || error.status >= 500)) {
                    const ms = Math.min(30000, 2000 * 2 ** this.failures++);
                    this.setState('RECOVERING', `ลองใหม่ใน ${ms / 1000} วินาที`);
                    this.discardQueuedSpeech(); this.audio.resetInput?.();
                    this.listenTimer = setTimeout(() => {
                        if (!this.active(epoch)) return;
                        this.audio.resetInput?.(); this.listen(epoch);
                    }, ms);
                } else this.rest(epoch);
            } finally {
                clearTimeout(timer); this.controllers.delete(controller);
                if (this.commandRequest === controller) this.commandRequest = null;
            }
        }
        async say(feedback, epoch, inputVersion = this.inputVersion) {
            if (!this.active(epoch) || !feedback) return false;
            await this.finishQueuedSpeech(epoch);
            if (!this.active(epoch) || inputVersion !== this.inputVersion) return false;
            this.setState('SPEAKING');
            try { return (await this.audio.reply(feedback)) !== false; }
            catch (_) {
                if (this.active(epoch)) this.options.notice(`เสียงตอบกลับเล่นไม่ได้ • ${feedback.text}`, 'warning', 5000);
                return false;
            }
        }
        async deviceResult(id, success, message) {
            if (this.commandId !== id) return;
            const epoch = this.epoch;
            if (!this.active(epoch)) return;
            clearTimeout(this.deviceTimer); this.commandId = null;
            this.options.notice(message, success ? 'info' : 'warning', 6000);
        }
    }
    root.SmartVoiceController = VoiceController;
    if (typeof module !== 'undefined') module.exports = VoiceController;
})(typeof window === 'undefined' ? globalThis : window);
