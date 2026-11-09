/* Capture runs outside the UI thread. Always use the AudioContext's real rate. */
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(512); this.offset = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      this.buffer[this.offset++] = sample;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(512);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('smart-voice-capture', VoiceCaptureProcessor);
