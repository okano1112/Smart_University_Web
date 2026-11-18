'use strict';

// Typhoon ASR Real-time, ONNX from saksornr/typhoon-asr-realtime-webgpu-q4.
// Model: https://huggingface.co/typhoon-ai/typhoon-asr-realtime (CC BY 4.0).
const MODEL_PATH = '/voice-model/typhoon-q4-v1/';
const SAMPLE_RATE = 16000;
const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
const MAX_SAMPLES = SAMPLE_RATE * 5;
const FFT_SIZE = 512;
const HOP = 160;
const MEL_COUNT = 80;
const STATE_SIZE = 640;
const BLANK_ID = 2048;
let engine;
let initializing = false;
let busy = false;

function makeSpectrum(window) {
    const reverse = new Uint16Array(FFT_SIZE);
    const cosine = new Float64Array(FFT_SIZE / 2);
    const sine = new Float64Array(FFT_SIZE / 2);
    for (let i = 1; i < FFT_SIZE; i++) reverse[i] = (reverse[i >> 1] >> 1) | ((i & 1) * (FFT_SIZE / 2));
    for (let i = 0; i < cosine.length; i++) {
        const angle = -2 * Math.PI * i / FFT_SIZE;
        cosine[i] = Math.cos(angle);
        sine[i] = Math.sin(angle);
    }
    const real = new Float64Array(FFT_SIZE);
    const imaginary = new Float64Array(FFT_SIZE);
    const power = new Float32Array(FFT_SIZE / 2 + 1);
    const offset = (FFT_SIZE - window.length) / 2;
    return (signal, center) => {
        imaginary.fill(0);
        real.fill(0);
        for (let k = 0; k < window.length; k++) {
            const index = offset + k;
            const sample = signal[center + index - FFT_SIZE / 2] ?? 0;
            real[reverse[index]] = Math.fround(sample * window[k]);
        }
        for (let size = 2; size <= FFT_SIZE; size *= 2) {
            const half = size / 2;
            for (let start = 0; start < FFT_SIZE; start += size) {
                for (let j = 0; j < half; j++) {
                    const phase = j * FFT_SIZE / size;
                    const left = start + j;
                    const right = left + half;
                    const re = real[right] * cosine[phase] - imaginary[right] * sine[phase];
                    const im = real[right] * sine[phase] + imaginary[right] * cosine[phase];
                    real[right] = real[left] - re;
                    imaginary[right] = imaginary[left] - im;
                    real[left] += re;
                    imaginary[left] += im;
                }
            }
        }
        for (let k = 0; k < power.length; k++) {
            const re = Math.fround(real[k]);
            const im = Math.fround(imaginary[k]);
            const magnitude = Math.fround(Math.sqrt(Math.fround(Math.fround(re * re) + Math.fround(im * im))));
            power[k] = magnitude * magnitude;
        }
        return power;
    };
}

function makeFrontend(config) {
    if (config.sampleRate !== SAMPLE_RATE || config.nFft !== FFT_SIZE || config.hopLength !== HOP ||
        config.features !== MEL_COUNT || config.window.length !== 400 || config.melFilters.length !== MEL_COUNT ||
        !config.melFilters.every(filter => filter.length === FFT_SIZE / 2 + 1)) {
        throw new Error('Unexpected Typhoon audio configuration');
    }
    const spectrum = makeSpectrum(config.window);
    const filters = config.melFilters.map(weights => {
        const start = weights.findIndex(weight => weight > 0);
        let end = weights.length;
        while (end > start && weights[end - 1] === 0) end--;
        return { start, weights: weights.slice(start, end) };
    });
    return samples => {
        const signal = new Float32Array(samples.length);
        signal[0] = samples[0];
        for (let i = 1; i < samples.length; i++) signal[i] = Math.fround(samples[i] - Math.fround(config.preemphasis * samples[i - 1]));
        const length = Math.floor(signal.length / HOP);
        // Keep the masked final frame in the exported encoder's input.
        const frames = length + 1;
        const features = new Float32Array(MEL_COUNT * frames);
        for (let frame = 0; frame < length; frame++) {
            const power = spectrum(signal, frame * HOP);
            for (let m = 0; m < MEL_COUNT; m++) {
                const { start, weights } = filters[m];
                let sum = 0;
                for (let i = 0; i < weights.length; i++) sum += power[start + i] * weights[i];
                features[m * frames + frame] = Math.log(Math.fround(Math.fround(sum) + config.logGuard));
            }
        }
        for (let m = 0; m < MEL_COUNT; m++) {
            const offset = m * frames;
            let mean = 0;
            for (let frame = 0; frame < length; frame++) mean += features[offset + frame];
            mean = Math.fround(mean / length);
            let variance = 0;
            for (let frame = 0; frame < length; frame++) variance += (features[offset + frame] - mean) ** 2;
            const std = Math.fround(Math.fround(Math.sqrt(variance / (length - 1))) + config.normalizationEpsilon);
            for (let frame = 0; frame < length; frame++) features[offset + frame] = (features[offset + frame] - mean) / std;
        }
        return { features, frames, length };
    };
}

function audioVariants(samples) {
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const cutoff = Math.max(0.001, peak * 0.018);
    const first = samples.findIndex(sample => Math.abs(sample) >= cutoff);
    if (first < 0) return [];
    let last = samples.length - 1;
    while (Math.abs(samples[last]) < cutoff) last--;
    // Keep a 24 ms guard for quiet consonants. Vary context because the
    // transducer can decode the same fast name differently across alignments.
    const guard = 24 * SAMPLES_PER_MS;
    const voice = samples.subarray(Math.max(0, first - guard), last + guard + 1);
    const pad = (leadMs, tailMs) => {
        const lead = leadMs * SAMPLES_PER_MS;
        const padded = new Float32Array(Math.min(MAX_SAMPLES, voice.length + lead + tailMs * SAMPLES_PER_MS));
        padded.set(voice, lead);
        return padded;
    };
    if (voice.length > MAX_SAMPLES - 80 * SAMPLES_PER_MS) return [];
    const short = last - first < SAMPLE_RATE * 0.8;
    return [short ? pad(40, 160) : pad(0, 80), pad(80, 240)];
}

async function readConfig(file) {
    const response = await fetch(MODEL_PATH + file, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Typhoon assets unavailable');
    return response.json();
}

async function loadEngine() {
    // Check the small configs before asking for the larger runtime and models.
    const [config, tokenizer] = await Promise.all([readConfig('frontend.json'), readConfig('tokenizer.json')]);
    if (tokenizer.blankId !== BLANK_ID || tokenizer.pieces.length !== BLANK_ID) throw new Error('Unexpected Typhoon tokenizer');
    const frontend = makeFrontend(config);
    importScripts('/ort/ort.wasm.min.js');
    const runtime = self.ort;
    runtime.env.wasm.numThreads = 1;
    runtime.env.wasm.proxy = false;
    runtime.env.wasm.wasmPaths = '/ort/';
    const sessions = [];
    try {
        for (const name of ['encoder.q4.onnx', 'predictor.fp32.onnx', 'joint.fp32.onnx']) {
            sessions.push(await runtime.InferenceSession.create(MODEL_PATH + name, { executionProviders: ['wasm'] }));
        }
        const [encoder, predictor, joint] = sessions;
        return { runtime, frontend, tokenizer, encoder, predictor, joint };
    } catch (error) {
        await Promise.allSettled(sessions.map(session => session.release()));
        throw error;
    }
}

async function decode(samples) {
    const { runtime, frontend, tokenizer, encoder, predictor, joint } = engine;
    const { features, frames, length } = frontend(samples);
    const float = samples => new runtime.Tensor('float32', samples, [1, STATE_SIZE]);
    const long = value => new runtime.Tensor('int64', BigInt64Array.of(BigInt(value)), [1]);
    const featureTensor = new runtime.Tensor('float32', features, [1, MEL_COUNT, frames]);
    const lengthTensor = long(length);
    let encoded, encodedLength;
    let h = float(new Float32Array(STATE_SIZE));
    let c = float(new Float32Array(STATE_SIZE));
    async function predict(id) {
        const token = long(id);
        try {
            const output = await predictor.run({ token, h, c }, ['prediction', 'next_c']);
            h.dispose();
            c.dispose();
            h = output.prediction;
            c = output.next_c;
        } finally { token.dispose(); }
    }
    try {
        const result = await encoder.run({ features: featureTensor, length: lengthTensor }, ['encoded', 'encoded_length']);
        encoded = result.encoded;
        encodedLength = result.encoded_length;
        const count = Number(encodedLength.data[0]);
        if (!Number.isInteger(count) || count < 1 || count > Math.ceil(length / 8)) return '';
        await predict(BLANK_ID);
        const ids = [];
        for (let time = 0; time < count; time++) {
            const frame = long(time);
            try {
                for (let i = 0; i < 10; i++) {
                    const { token } = await joint.run({ encoded, frame, prediction: h }, ['token']);
                    const id = Number(token.data[0]);
                    token.dispose();
                    if (id === BLANK_ID) break;
                    if (!Number.isInteger(id) || id < 0 || id >= BLANK_ID || ids.length >= 100) return '';
                    ids.push(id);
                    await predict(id);
                }
            } finally { frame.dispose(); }
        }
        return ids.filter(id => !tokenizer.controlIds.includes(id))
            .map(id => id === tokenizer.unknownId ? tokenizer.unknownSurface : tokenizer.pieces[id])
            .join('').replaceAll('▁', ' ').trim();
    } finally {
        featureTensor.dispose();
        lengthTensor.dispose();
        encoded?.dispose();
        encodedLength?.dispose();
        h.dispose();
        c.dispose();
    }
}

self.onmessage = async ({ data }) => {
    if (data?.type === 'init' && !engine && !initializing) {
        initializing = true;
        try {
            engine = await loadEngine();
            self.postMessage({ type: 'ready' });
        } catch (_) { self.postMessage({ type: 'unavailable' }); }
        return;
    }
    if (data?.type !== 'recognize') return;
    const { id, samples } = data;
    let transcripts = [];
    if (engine && !busy && samples instanceof Float32Array && samples.length >= 1600 &&
        samples.length <= MAX_SAMPLES && samples.every(Number.isFinite)) {
        busy = true;
        try {
            const [first, second] = audioVariants(samples);
            if (first) {
                const initial = await decode(first);
                if (initial) {
                    const corroboration = await decode(second);
                    if (corroboration) transcripts = [initial, corroboration];
                }
            }
        } catch (_) { /* Let the controller use the original recording for recognition. */ }
        finally { busy = false; }
    }
    self.postMessage({ type: 'result', id, transcripts });
};
