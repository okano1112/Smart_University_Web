"""Persistent, local-only TFLite worker. JSON lines on stdin/stdout; diagnostics on stderr."""
import os
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('NUMBA_NUM_THREADS', '2')
os.environ.setdefault('OMP_NUM_THREADS', '2')
import base64
import io
import json
import sys
import wave
from pathlib import Path
import numpy as np
import librosa
import tensorflow as tf

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / 'models/ac_voice_model.json').read_text())

class Classifier:
    def __init__(self):
        self.model = tf.lite.Interpreter(model_path=str(ROOT / 'models' / CONFIG['file']), num_threads=2)
        self.model.allocate_tensors()
        self.input = self.model.get_input_details()[0]
        self.output = self.model.get_output_details()[0]
        if list(self.input['shape']) != [1, 41, 13, 1] or self.input['dtype'] != np.float32:
            raise ValueError('Unexpected model input')
        if list(self.output['shape']) != [1, len(CONFIG['labels'])] or self.output['dtype'] != np.float32:
            raise ValueError('Unexpected model output')

    def features(self, samples):
        # Training used librosa defaults; lock them explicitly here for reproducibility.
        features = librosa.feature.mfcc(y=samples, sr=16000, n_mfcc=13,
            n_fft=512, hop_length=600, win_length=512, window='hann', center=True,
            pad_mode='constant', power=2.0, n_mels=128, fmin=0.0, fmax=8000.0,
            htk=False, dct_type=2, norm='ortho', lifter=0, mel_norm='slaney')
        return ((features.T - CONFIG['mean']) / (CONFIG['std'] + 1e-6)).astype(np.float32)[None, ..., None]

    def predict(self, samples):
        features = self.features(samples)
        self.model.set_tensor(self.input['index'], features)
        self.model.invoke()
        return self.model.get_tensor(self.output['index'])[0].astype(float)

    def classify(self, data):
        with wave.open(io.BytesIO(data), 'rb') as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, 'NONE'):
                raise ValueError('Expected mono 16 kHz PCM16 WAV')
            if not 800 <= wav.getnframes() <= 240000:
                raise ValueError('Invalid audio duration')
            raw = wav.readframes(wav.getnframes())
            if len(raw) != wav.getnframes() * 2:
                raise ValueError('Truncated WAV')
        samples = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
        if float(np.sqrt(np.mean(samples ** 2))) < 0.002:
            return {'accepted': False, 'reason': 'silence'}
        # Preserve an already-sized training window: re-trimming/re-centering it
        # changes MFCC timing. Only remove VAD padding when the window is too long.
        if len(samples) > CONFIG['samples']:
            samples, _ = librosa.effects.trim(samples, top_db=25)
        if len(samples) > CONFIG['samples']:
            return {'accepted': False, 'reason': 'too_long'}
        if len(samples) < 1600:
            return {'accepted': False, 'reason': 'too_short'}
        padding = CONFIG['samples'] - len(samples)
        samples = np.pad(samples, (padding // 2, padding - padding // 2))
        scores = self.predict(samples)
        if not np.isfinite(scores).all():
            raise ValueError('Invalid model result')
        order = np.argsort(scores)
        index = int(order[-1]); confidence = float(scores[index]); margin = confidence - float(scores[order[-2]])
        accepted = index != 6 and confidence >= CONFIG['threshold'] and margin >= CONFIG['margin']
        return {'accepted': accepted, 'label': CONFIG['labels'][index],
            'confidence': confidence, 'margin': margin, 'reason': 'matched' if accepted else 'uncertain'}


def main():
    classifier = Classifier()
    classifier.predict(np.zeros(CONFIG['samples'], dtype=np.float32))  # compile DSP once, not per request
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 700000:
                raise ValueError('Request too large')
            request = json.loads(line)
            result = classifier.classify(base64.b64decode(request['audio'], validate=True))
            print(json.dumps({'id': request['id'], **result}), flush=True)
        except Exception as exc:
            print(json.dumps({'id': request.get('id'), 'error': str(exc)}), flush=True)

if __name__ == '__main__':
    main()
