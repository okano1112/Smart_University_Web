"""Local CPU speech recognition. No network access, cloud fallback, or audio retention."""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ.setdefault('OMP_NUM_THREADS', '4')
import base64
import io
import json
import re
import sys
import wave
from pathlib import Path
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import pad_or_trim
from faster_whisper.tokenizer import Tokenizer
from faster_whisper.transcribe import get_compression_ratio, get_suppressed_tokens

ROOT = Path(__file__).resolve().parents[1]
WAKE_PROBE = re.compile(r'^(?:เอ็?น|เอ็ง|เอน|อิง|อันดี|eng[ih]|enji|n[ .-]?g\b|andy\b)', re.I)
HARD_WAKE_PROBE = re.compile(r'^(?:เอ็นก[ีิ][่้]?|เอ็งก[ีิ][่้]?|เอ็นด์ก[ีิ][่้]?)')
THAI_WAKE_BOUNDARY = re.compile(r'^เป็น\s*ที่')
THAI_WAKE_NEAR = re.compile(r'^เอ็น\s*ที่')

class Recognizer:
    def __init__(self):
        # Refuse an incomplete install instead of fetching a tokenizer at runtime.
        model_dir = ROOT/'models/whisper-th-small'
        for name in ['model.bin', 'config.json', 'tokenizer.json']:
            if not (model_dir/name).is_file():
                raise ValueError('Missing local ASR file: '+name)
        self.model = WhisperModel(str(ROOT/'models/whisper-th-small'), device='cpu',
            compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)
        self.tokenizer = Tokenizer(self.model.hf_tokenizer, self.model.model.is_multilingual,
            task='transcribe', language='th')
        self.wake_prompt = self.model.get_prompt(self.tokenizer, [], without_timestamps=True)
        self.suppressed_tokens = get_suppressed_tokens(self.tokenizer, [-1])
        self.english_tokenizer = Tokenizer(self.model.hf_tokenizer, self.model.model.is_multilingual,
            task='transcribe', language='en')
        self.english_prompt = self.model.get_prompt(self.english_tokenizer, [], without_timestamps=True)
        self.english_suppressed_tokens = get_suppressed_tokens(self.english_tokenizer, [-1])
        self.wake_alignment = {name:self.tokenizer.encode(name) for name in ('เอ็นจี้', 'เอ็นจี', 'เอ็นกี่', 'เอ็งกี้')}

    def classify(self, data, *, wake=False):
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
        if wake:
            return self.decode_wake(audio, rms)
        segments, _ = self.model.transcribe(audio, language='th', task='transcribe',
            beam_size=3, temperature=0, condition_on_previous_text=False,
            initial_prompt='เปิดแอร์ ปิดแอร์ ปรับอุณหภูมิ',
            without_timestamps=True, vad_filter=False,
            no_speech_threshold=.6, log_prob_threshold=-1, compression_ratio_threshold=2.4)
        segments=list(segments)
        usable=[s for s in segments if s.avg_logprob >= -1 and s.compression_ratio <= 2.4]
        text=' '.join(s.text.strip() for s in usable).strip()
        return {'accepted':bool(text),'transcript':text,'reason':'transcribed' if text else 'uncertain',
            'engine':'LOCAL_WHISPER', 'rms':rms,
            'avgLogprob':sum(s.avg_logprob for s in usable)/len(usable) if usable else None}

    def decode_wake(self, audio, rms):
        # Share the encoder across text hypotheses and acoustic checks. Neither
        # language decoder gets a name or command as a text hint.
        features = self.model.feature_extractor(audio)[..., :-1]
        encoded = self.model.encode(pad_or_trim(features))
        candidates, no_speech = self.wake_beams(encoded, self.tokenizer, self.wake_prompt, self.suppressed_tokens, 6)
        first = candidates[0] if candidates else {}
        output = {'accepted':bool(first.get('transcript')), 'transcript':first.get('transcript',''),
            'reason':'transcribed' if first.get('transcript') else 'uncertain',
            'engine':'LOCAL_WHISPER', 'rms':rms, 'wakeCandidates':candidates, 'noSpeechProbability':no_speech}
        if not candidates or no_speech >= .6:
            return output
        leads = [re.sub(r'^(?:hey|hi|hello|เฮ้ย?|เฮย|เฮ|หวัดดี|วัดดี|สวัสดี)[\s,.!]*', '', c['transcript'].lower()).lstrip()
            for c in candidates]
        hard = any(HARD_WAKE_PROBE.match(text) for text in leads)
        shifted_thai = THAI_WAKE_BOUNDARY.match(leads[0]) and any(THAI_WAKE_NEAR.match(text) for text in leads[1:])
        if WAKE_PROBE.match(leads[0]) or hard or shifted_thai:
            names = ('เอ็นกี่', 'เอ็งกี้') if hard else ('เอ็นจี้', 'เอ็นจี')
            try:
                output['wakeAcoustics'] = [self.acoustic_prefix(encoded, features.shape[-1], name) for name in names]
            except (ValueError, RuntimeError, IndexError):
                # No alignment means no acoustic fallback; keep usable neutral text.
                output['wakeAcoustics'] = []
            if (not hard and len(audio) <= 32000 and no_speech < .08 and first['score'] >= -1.15
                    and re.fullmatch(r'เอ็น\s*ที่[.!?]*', leads[0])
                    and not any(e['score'] >= -1.6 and e['consonant'] >= .012 and e['ending'] >= .16 for e in output['wakeAcoustics'])):
                # Re-align only a short, ambiguous Thai name with browser pre-roll.
                # Keep the second alignment separate so it cannot authorize a command suffix.
                active = np.flatnonzero(np.abs(audio) >= np.max(np.abs(audio)) * .006)
                if active.size and active[0] >= 1600 and active[-1] - active[0] < 16000:
                    onset = int(active[0])
                    end = int(active[-1])
                    normalized = np.pad(audio[onset - 80:end + 3280], (1600, 0))
                    short_features = self.model.feature_extractor(normalized)[..., :-1]
                    try:
                        short_encoded = self.model.encode(pad_or_trim(short_features))
                        output['wakeShortAcoustics'] = [self.acoustic_prefix(short_encoded, short_features.shape[-1], 'เอ็นจี้')]
                    except (ValueError, RuntimeError, IndexError):
                        pass
        if hard or re.match(r'^(?:eng[ih]|enji|n[ .-]?g\b)', leads[0]):
            english, probability = self.wake_beams(encoded, self.english_tokenizer,
                self.english_prompt, self.english_suppressed_tokens, 4)
            output['wakeEnglish'] = {'candidates': english, 'noSpeechProbability': probability}
            output['accepted'] = output['accepted'] or bool(english and english[0]['transcript'])
        return output

    def wake_beams(self, encoded, tokenizer, prompt, suppressed, width):
        result = self.model.model.generate(encoded, [prompt], beam_size=width,
            num_hypotheses=width, max_length=128, return_scores=True, return_no_speech_prob=True,
            suppress_blank=True, suppress_tokens=suppressed)[0]
        candidates = []
        for tokens, score in zip(result.sequences_ids, result.scores):
            text = tokenizer.decode(tokens).strip()
            if not text or get_compression_ratio(text) > 2.4:
                # Keep a placeholder so a lower beam cannot become the top beam.
                candidates.append({'transcript':'', 'score':float(score)})
            else:
                candidates.append({'transcript':text, 'score':float(score)})
        return candidates, float(result.no_speech_prob)

    def acoustic_prefix(self, encoded, frames, name):
        # Alignment scores the proposed tokens against the audio starting at the
        # first word; it never generates a command or inserts a wake word.
        tokens = self.wake_alignment[name]
        alignment = self.model.model.align(encoded, self.wake_prompt, [tokens], frames)[0]
        probabilities = np.asarray(alignment.text_token_probs)
        if len(probabilities) != len(tokens) or not np.all(np.isfinite(probabilities)):
            return {'name':name, 'score':-100, 'consonant':0, 'ending':0}
        return {'name':name, 'score':float(np.log(np.clip(probabilities, 1e-9, 1)).mean()),
            'consonant':float(probabilities[-2]), 'ending':float(probabilities[-1])}

def main():
    recognizer=Recognizer()
    print(json.dumps({'ready':True,'engine':'LOCAL_WHISPER'}),flush=True)
    for line in sys.stdin:
        request={}
        try:
            if len(line)>700000: raise ValueError('Request too large')
            request=json.loads(line)
            result=recognizer.classify(base64.b64decode(request['audio'],validate=True), wake=request.get('wake') is True)
            print(json.dumps({'id':request['id'],**result},ensure_ascii=False),flush=True)
        except Exception as exc:
            print(json.dumps({'id':request.get('id'),'error':str(exc)}),flush=True)

if __name__=='__main__':main()
