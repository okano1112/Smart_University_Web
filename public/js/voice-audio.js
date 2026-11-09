(function (root) {
    'use strict';
    function merge(chunks) {
        const result = new Float32Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        return result;
    }
    function resample(samples, rate, target = 16000) {
        if (rate === target) return samples;
        const ratio = rate / target;
        const output = new Float32Array(Math.floor(samples.length / ratio));
        // Average all covered input samples when downsampling; no mislabeled WAV rate.
        for (let i = 0; i < output.length; i++) {
            const start = i * ratio, end = (i + 1) * ratio;
            let total = 0;
            for (let j = Math.floor(start); j < Math.ceil(end); j++) {
                total += samples[Math.min(j, samples.length - 1)] * Math.max(0, Math.min(end, j + 1) - Math.max(start, j));
            }
            output[i] = total / ratio;
        }
        return output;
    }
    function wav(samples) {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);
        function str(offset, value) { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); }
        str(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); str(8, 'WAVE');
        str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        str(36, 'data'); view.setUint32(40, samples.length * 2, true);
        // Keep the waveform identical to training: DC removal changes MFCCs,
        // especially silent padding. Only encode and clamp to PCM16.
        for (let i = 0; i < samples.length; i++) {
            const sample = Number.isFinite(samples[i]) ? samples[i] : 0;
            view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), true);
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }

    class VoiceAudio {
        constructor(callbacks) { this.callbacks = callbacks; this.closed = false; this.speaking = false; this.clipCache = new Map(); this.replyId = 0; this.inputEpoch = 0; this.assetController = new AbortController(); }
        async start({ automatic = false } = {}) {
            const Context = root.AudioContext || root.webkitAudioContext;
            if (!Context || !navigator.mediaDevices?.getUserMedia) throw new Error('กรุณาใช้ HTTPS หรือ localhost และอนุญาตไมโครโฟน');
            // Called synchronously from the user's click, before the first await.
            this.context = new Context();
            const resumed = this.context.resume();
            if (automatic) {
                let gestureTimer;
                try {
                    await Promise.race([resumed, new Promise((_, reject) => {
                        gestureTimer = setTimeout(() => reject(Object.assign(new Error('แตะหน้าจอครั้งเดียวเพื่อเริ่มฟัง Engi'), { code: 'VOICE_GESTURE_REQUIRED' })), 500);
                    })]);
                } finally { clearTimeout(gestureTimer); }
            } else await resumed;
            if (this.closed) return;
            if (this.context.state !== 'running') throw new Error('ระบบเสียงยังไม่พร้อม กรุณากดเปิดไมค์ใหม่');
            this.context.onstatechange = () => {
                if (!this.closed && this.ready && this.context.state !== 'running') this.callbacks.onError(new Error('ระบบเสียงหยุดทำงาน กรุณากดเปิดไมค์ใหม่'));
            };
            const stream = await navigator.mediaDevices.getUserMedia({ audio: {
                echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1
            } });
            if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
            this.stream = stream;
            stream.getAudioTracks().forEach(track => {
                track.onended = () => { if (!this.closed) this.callbacks.onError(new Error('ไมโครโฟนถูกตัดการเชื่อมต่อ กรุณาเปิดไมค์ใหม่')); };
                track.onmute = () => { if (!this.closed) this.callbacks.onError(new Error('ไมโครโฟนหยุดส่งเสียง กรุณาเปิดไมค์ใหม่')); };
            });
            this.source = this.context.createMediaStreamSource(stream);
            try {
                if (!root.vad?.AudioNodeVAD || !root.ort) throw new Error('VAD assets unavailable');
                this.detector = await root.vad.AudioNodeVAD.new(this.context, {
                    workletURL: '/vad-web/vad.worklet.bundle.min.js', modelURL: '/vad-web/silero_vad.onnx',
                    ortConfig: runtime => { runtime.env.wasm.wasmPaths = '/ort/'; },
                    frameSamples: 512, workletOptions: { processorOptions: { frameSamples: 512 } },
                    positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35,
                    preSpeechPadFrames: 10, // 512/16000 * 10 = 320 ms.
                    redemptionFrames: 10, // 320 ms of silence; finish short commands sooner.
                    minSpeechFrames: 3, // 96 ms; short names are not rejected at 288 ms.
                    onSpeechStart: () => this.speechStart(),
                    onSpeechEnd: samples => this.speechEnd(samples),
                    onVADMisfire: () => { if (this.inputSuppressed) return; this.speaking = false; clearTimeout(this.maxTimer); this.callbacks.onMisfire(); }
                });
                if (this.closed) { this.detector.destroy(); return; }
                // Serialize ONNX inference: slow frames must not mutate model state concurrently.
                const processFrame = this.detector.processFrame.bind(this.detector);
                let frames = Promise.resolve(), pending = 0;
                this.detector.processFrame = frame => {
                    if (this.closed || this.inputSuppressed) return Promise.resolve();
                    const inputEpoch = this.inputEpoch;
                    if (++pending > 64) {
                        this.callbacks.onError(new Error('เครื่องประมวลผลเสียงไม่ทัน กรุณาเปิดไมค์ใหม่'));
                        return Promise.resolve();
                    }
                    frames = frames.then(() => { if (!this.closed && !this.inputSuppressed && inputEpoch === this.inputEpoch) return processFrame(frame); })
                        .catch(error => { if (!this.closed) this.callbacks.onError(error); }).finally(() => { pending--; });
                    return frames;
                };
                this.detector.receive(this.source);
                this.detector.start();
                this.kind = 'silero';
            } catch (error) {
                if (this.closed) return;
                this.detector?.destroy(); this.detector = null;
                console.warn('[Voice] Silero unavailable; AudioWorklet fallback:', error.message);
                await this.startFallback();
                this.kind = 'rms';
            }
            this.ready = true;
            // Small, bundled clips are fetched in the background, never another AI request.
            for (const key of Object.keys(root.SmartVoiceFeedback?.phrases || {})) this.loadClip(key).catch(() => {});
        }
        speechStart() {
            if (this.closed || this.inputSuppressed) return;
            this.speaking = true;
            clearTimeout(this.maxTimer);
            this.maxTimer = setTimeout(() => {
                if (!this.closed && this.speaking) this.callbacks.onError(new Error('เสียงต่อเนื่องเกิน 15 วินาที กรุณาเปิดไมค์ใหม่และพูดให้สั้นลง'));
            }, 15000);
            this.callbacks.onStart();
        }
        speechEnd(samples) {
            if (this.closed || this.inputSuppressed) return;
            this.speaking = false; clearTimeout(this.maxTimer);
            this.callbacks.onEnd(samples);
        }
        async startFallback() {
            await this.context.audioWorklet.addModule('/js/voice-audio-worklet.js');
            if (this.closed) return;
            this.worklet = new AudioWorkletNode(this.context, 'smart-voice-capture');
            this.silentGain = this.context.createGain(); this.silentGain.gain.value = 0;
            this.source.connect(this.worklet); this.worklet.connect(this.silentGain); this.silentGain.connect(this.context.destination);
            let pre = [], chunks = [], duration = 0, silence = 0, voiced = 0, noise = 0.002;
            const frameMs = 512 / this.context.sampleRate * 1000;
            this.resetFallback = () => { pre = []; chunks = []; duration = 0; silence = 0; voiced = 0; };
            this.worklet.port.onmessage = event => {
                if (this.closed || this.inputSuppressed) return;
                const frame = event.data;
                const rms = Math.sqrt(frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length);
                // Reject our two narrow-band chime frequencies in the RMS fallback.
                let tonal = false;
                if (rms > 0.003) for (const hz of [1400, 1800]) {
                    let re = 0, im = 0;
                    for (let i = 0; i < frame.length; i++) {
                        const phase = 2 * Math.PI * hz * i / this.context.sampleRate;
                        re += frame[i] * Math.cos(phase); im += frame[i] * Math.sin(phase);
                    }
                    if (2 * (re * re + im * im) / (frame.length * frame.length * rms * rms) > 0.55) tonal = true;
                }
                const speech = !tonal && rms > Math.max(0.007, noise * 3);
                if (!this.speaking && !speech) noise = Math.min(0.015, noise * 0.98 + rms * 0.02);
                if (speech && !this.speaking) { chunks = pre; pre = []; duration = 0; voiced = 0; silence = 0; this.speechStart(); }
                if (this.speaking) {
                    chunks.push(frame); duration += frameMs;
                    if (speech) { silence = 0; voiced += frameMs; } else silence += frameMs;
                    if (silence >= 350) {
                        const audio = resample(merge(chunks), this.context.sampleRate);
                        chunks = []; duration = 0;
                        if (voiced >= 96) this.speechEnd(audio);
                        else { this.speaking = false; clearTimeout(this.maxTimer); this.callbacks.onMisfire(); }
                    }
                } else { pre.push(frame); while (pre.length * frameMs > 320) pre.shift(); }
            };
        }
        setInputSuppressed(suppressed) {
            this.inputSuppressed = suppressed;
            this.inputEpoch++;
            this.speaking = false; clearTimeout(this.maxTimer);
            this.resetFallback?.();
            if (suppressed) this.detector?.pause();
            else if (!this.closed) this.detector?.start();
        }
        loadClip(key) {
            if (!Object.hasOwn(root.SmartVoiceFeedback?.phrases || {}, key)) return Promise.reject(new Error('ไม่พบข้อความเสียงตอบกลับ'));
            if (!this.clipCache.has(key)) {
                const loading = root.fetch(`/audio/voice/${key}.wav`, { signal: AbortSignal.any([this.assetController.signal, AbortSignal.timeout(4000)]) })
                    .then(response => { if (!response.ok) throw new Error('โหลดเสียงตอบกลับไม่สำเร็จ'); return response.arrayBuffer(); })
                    .then(buffer => this.context.decodeAudioData(buffer));
                this.clipCache.set(key, loading);
                loading.catch(() => { if (this.clipCache.get(key) === loading) this.clipCache.delete(key); });
            }
            return this.clipCache.get(key);
        }
        async reply(feedback) {
            if (this.closed || this.context.state !== 'running') throw new Error('ระบบเสียงตอบกลับยังไม่พร้อม');
            if (!feedback?.clips?.length) throw new Error('ไม่มีข้อความเสียงตอบกลับ');
            const id = ++this.replyId;
            this.setInputSuppressed(true);
            try {
                const buffers = await Promise.all(feedback.clips.map(key => this.loadClip(key)));
                if (this.closed || id !== this.replyId) return false;
                return await new Promise((resolve, reject) => {
                    const sources = [], total = buffers.reduce((sum, buffer) => sum + buffer.duration, 0);
                    let settled = false, timer;
                    const finish = (error, played = true) => {
                        if (settled) return; settled = true; clearTimeout(timer);
                        for (const source of sources) { source.onended = null; try { source.stop(); } catch (_) {} source.disconnect(); }
                        if (this.replyFinish === cancel) this.replyFinish = null;
                        error ? reject(error) : resolve(played);
                    };
                    const cancel = () => finish(null, false);
                    this.replyFinish = cancel;
                    timer = setTimeout(() => finish(new Error('เสียงตอบกลับใช้เวลานานเกินไป')), (total + 2) * 1000);
                    let when = this.context.currentTime + 0.015;
                    try {
                        buffers.forEach((buffer, index) => {
                            const source = this.context.createBufferSource(); source.buffer = buffer;
                            source.connect(this.context.destination); sources.push(source);
                            if (index === buffers.length - 1) source.onended = () => finish();
                            source.start(when); when += buffer.duration;
                        });
                    } catch (error) { finish(error); }
                });
            } finally {
                if (!this.closed && id === this.replyId) this.setInputSuppressed(false);
            }
        }
        async beep(type = 'ready') {
            if (this.closed || this.context.state !== 'running') throw new Error('เล่นเสียงตอบรับไม่ได้ กรุณาเปิดไมค์ใหม่');
            const oscillator = this.context.createOscillator(), gain = this.context.createGain();
            oscillator.connect(gain); gain.connect(this.context.destination);
            const now = this.context.currentTime, duration = type === 'error' ? 0.12 : 0.18;
            oscillator.frequency.setValueAtTime(type === 'ready' ? 1800 : 1400, now);
            if (type === 'confirmed') oscillator.frequency.setValueAtTime(1800, now + 0.09);
            gain.gain.setValueAtTime(0.08, now); gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
            return new Promise(resolve => {
                const done = () => { clearTimeout(timer); oscillator.disconnect(); gain.disconnect(); resolve(); };
                const timer = setTimeout(done, duration * 1000 + 150);
                oscillator.onended = done; oscillator.start(now); oscillator.stop(now + duration);
            });
        }
        close() {
            if (this.closed) return;
            this.closed = true; this.replyId++; this.assetController.abort(); this.replyFinish?.(); clearTimeout(this.maxTimer);
            this.detector?.destroy(); this.worklet?.disconnect(); this.source?.disconnect(); this.silentGain?.disconnect();
            this.stream?.getTracks().forEach(track => track.stop());
            if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
        }
    }
    root.SmartVoiceAudio = { VoiceAudio, wav, resample };
    if (typeof module !== 'undefined') module.exports = root.SmartVoiceAudio;
})(typeof window === 'undefined' ? globalThis : window);
