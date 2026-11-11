"""Local CPU speech recognition. No network access, cloud fallback, or audio retention."""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ.setdefault('OMP_NUM_THREADS', '4')
import base64
import io
import json
import sys
import wave
from pathlib import Path
import numpy as np
from faster_whisper import WhisperModel

ROOT = Path(__file__).resolve().parents[1]

class Recognizer:
    def __init__(self):
        # Refuse an incomplete install instead of fetching a tokenizer at runtime.
        model_dir = ROOT/'models/whisper-th-small'
        for name in ['model.bin', 'config.json', 'tokenizer.json']:
            if not (model_dir/name).is_file():
                raise ValueError('Missing local ASR file: '+name)
        self.model = WhisperModel(str(ROOT/'models/whisper-th-small'), device='cpu',
            compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)

    def classify(self, data):
        with wave.open(io.BytesIO(data), 'rb') as wav:
            frames = wav.getnframes()
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, 'NONE'):
                raise ValueError('Expected mono 16 kHz PCM16 WAV')
            if not 800 <= frames <= 240000:
                raise ValueError('Invalid duration')
            raw = wav.readframes(frames)
            if len(raw) != frames*2:
                raise ValueError('Truncated WAV')
        audio = np.frombuffer(raw, dtype='<i2').astype(np.float32)/32768
        rms = float(np.sqrt(np.mean((audio-np.mean(audio))**2)))
        if rms < .0015:
            return {'accepted':False,'reason':'silence','transcript':'','engine':'LOCAL_WHISPER'}
        if len(audio) > 12*16000:
            return {'accepted':False,'reason':'too_long','transcript':'','engine':'LOCAL_WHISPER'}
        segments, _ = self.model.transcribe(audio, language='th', task='transcribe',
            beam_size=3, temperature=0, condition_on_previous_text=False,
            initial_prompt='เปิดแอร์ ปิดแอร์ ปรับอุณหภูมิ เอ็นจี้',
            without_timestamps=True, vad_filter=False,
            no_speech_threshold=.6, log_prob_threshold=-1, compression_ratio_threshold=2.4)
        segments=list(segments)
        usable=[s for s in segments if s.avg_logprob >= -1 and s.compression_ratio <= 2.4]
        text=' '.join(s.text.strip() for s in usable).strip()
        return {'accepted':bool(text),'transcript':text,'reason':'transcribed' if text else 'uncertain',
            'engine':'LOCAL_WHISPER', 'rms':rms,
            'avgLogprob':sum(s.avg_logprob for s in usable)/len(usable) if usable else None}

def main():
    recognizer=Recognizer()
    print(json.dumps({'ready':True,'engine':'LOCAL_WHISPER'}),flush=True)
    for line in sys.stdin:
        request={}
        try:
            if len(line)>700000: raise ValueError('Request too large')
            request=json.loads(line)
            result=recognizer.classify(base64.b64decode(request['audio'],validate=True))
            print(json.dumps({'id':request['id'],**result},ensure_ascii=False),flush=True)
        except Exception as exc:
            print(json.dumps({'id':request.get('id'),'error':str(exc)}),flush=True)

if __name__=='__main__':main()
