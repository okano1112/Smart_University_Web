"""Build bundled Thai speech on macOS; the running web app needs no macOS TTS."""
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]
phrases = json.loads(subprocess.check_output([
    'node', '-e', "console.log(JSON.stringify(require('./public/js/voice-feedback').phrases))"
], cwd=ROOT))
output = ROOT / 'public/audio/voice'
output.mkdir(parents=True, exist_ok=True)
number_words = dict(zip(range(21, 28), ['ยี่สิบเอ็ด', 'ยี่สิบสอง', 'ยี่สิบสาม', 'ยี่สิบสี่', 'ยี่สิบห้า', 'ยี่สิบหก', 'ยี่สิบเจ็ด']))
with tempfile.TemporaryDirectory(prefix='smart-voice-build-') as temporary:
    for key, text in phrases.items():
        for number, word in number_words.items():
            text = text.replace(str(number), word)
        aiff, wav = Path(temporary) / 'speech.aiff', Path(temporary) / 'speech.wav'
        subprocess.run(['say', '-v', 'Kanya', '-r', '195', '-o', str(aiff), text], check=True)
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16@24000', str(aiff), str(wav)], check=True)
        with wave.open(str(wav), 'rb') as source:
            params, frames = source.getparams(), source.readframes(source.getnframes())
        samples = struct.unpack('<' + 'h' * (len(frames) // 2), frames)
        # Remove synthesized padding; keep 30 ms attack and 60 ms room at the end.
        voiced = [i for i, sample in enumerate(samples) if abs(sample) > 120]
        first = max(0, voiced[0] - 720) if voiced else 0
        last = min(len(samples), voiced[-1] + 1440) if voiced else len(samples)
        with wave.open(str(output / f'{key}.wav'), 'wb') as target:
            target.setparams(params)
            target.writeframes(frames[first * 2:last * 2])
print(f'Built {len(phrases)} Thai voice clips in {output}')
