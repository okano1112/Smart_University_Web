(function (root) {
    'use strict';
    const MODEL_MANIFEST = '/voice-model/typhoon-q4-v1/manifest.json';
    const MAX_SAMPLES = 5 * 16000;
    const RECOGNITION_TIMEOUT = 1800;
    const MODEL_LOAD_TIMEOUT = 240000;

    // This worker uses only the supplied PCM. It cannot activate the mic or
    // switch to a browser or vendor speech service.
    class LocalSpeechRecognizer {
        constructor({ fetch = root.fetch.bind(root), Worker = root.Worker, navigator = root.navigator, onStatus } = {}) {
            Object.assign(this, { fetch, Worker, navigator, onStatus });
            this.abort = new AbortController();
            this.ready = false;
        }
        async prepare() {
            if (this.started || this.abort.signal.aborted) return;
            this.started = true;
            if (!this.Worker || typeof WebAssembly !== 'object' ||
                typeof BigInt64Array !== 'function' || this.navigator?.deviceMemory <= 2 ||
                this.navigator?.connection?.saveData || /^(?:slow-)?2g$/.test(this.navigator?.connection?.effectiveType || '')) {
                this.close('อุปกรณ์หรือโหมดประหยัดข้อมูลใช้ Whisper บนเซิร์ฟเวอร์');
                return;
            }
            this.onStatus?.('กำลังโหลดโมเดลเสียงบนอุปกรณ์ ระหว่างนี้ใช้ Whisper บนเซิร์ฟเวอร์');
            const unavailable = 'โมเดลเสียงบนอุปกรณ์ไม่พร้อม ใช้ Whisper บนเซิร์ฟเวอร์';
            this.loadTimer = setTimeout(() => this.close(unavailable), MODEL_LOAD_TIMEOUT);
            try {
                const response = await this.fetch(MODEL_MANIFEST, { signal: this.abort.signal, priority: 'low' });
                if (this.abort.signal.aborted) return;
                if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return this.close(unavailable);
                const manifest = await response.json();
                if (this.abort.signal.aborted) return;
                if (manifest.id !== 'typhoon-q4-v1' || manifest.schemaVersion !== 1) return this.close(unavailable);

                this.worker = new this.Worker('/js/voice-local-worker.js', { name: 'engi-local-speech' });
                this.worker.onerror = () => this.close(unavailable);
                this.worker.onmessageerror = () => this.close(unavailable);
                this.worker.onmessage = ({ data }) => {
                    if (this.abort.signal.aborted) return;
                    if (data?.type === 'unavailable') return this.close(unavailable);
                    if (data?.type === 'ready') {
                        clearTimeout(this.loadTimer);
                        this.ready = true;
                        this.onStatus?.('โมเดลเสียงบนอุปกรณ์พร้อม Engi จะลองถอดเสียงบน Client ก่อน');
                    }
                    if (data?.type === 'result' && this.job?.id === data.id) {
                        const value = data.transcripts;
                        this.job.finish(Array.isArray(value) && value.length === 2 &&
                            value.every(text => typeof text === 'string' && text.trim() && text.length <= 500) ? value : null);
                    }
                };
                this.worker.postMessage({ type: 'init' });
            } catch (_) { this.close(unavailable); }
        }
        canRecognize(samples) {
            return this.ready && !this.job && samples instanceof Float32Array && samples.length > 0 && samples.length <= MAX_SAMPLES;
        }
        recognize(samples, signal) {
            if (!this.canRecognize(samples) || signal?.aborted) return Promise.resolve(null);
            const id = this.nextId = (this.nextId || 0) + 1;
            return new Promise(resolve => {
                const timeout = setTimeout(() => this.close('อุปกรณ์ถอดเสียงเกิน 1.8 วินาที ใช้ Whisper บนเซิร์ฟเวอร์'), RECOGNITION_TIMEOUT);
                // Let the caller stop waiting immediately while keeping the
                // worker's active slot occupied until its result or deadline.
                const cancel = () => resolve(null);
                const finish = result => {
                    clearTimeout(timeout);
                    signal?.removeEventListener('abort', cancel);
                    if (this.job?.id === id) this.job = null;
                    resolve(result);
                };
                this.job = { id, finish };
                signal?.addEventListener('abort', cancel, { once: true });
                // Preserve the original utterance for a possible Whisper fallback.
                const copy = samples.slice();
                try { this.worker.postMessage({ type: 'recognize', id, samples: copy }, [copy.buffer]); }
                catch (_) { this.close(); }
            });
        }
        close(reason) {
            if (this.abort.signal.aborted) return;
            this.abort.abort();
            clearTimeout(this.loadTimer);
            this.ready = false;
            this.job?.finish(null);
            this.worker?.terminate();
            this.worker = null;
            if (reason) this.onStatus?.(reason);
        }
    }
    root.SmartLocalSpeechRecognizer = LocalSpeechRecognizer;
    if (typeof module !== 'undefined') module.exports = LocalSpeechRecognizer;
})(typeof window === 'undefined' ? globalThis : window);
