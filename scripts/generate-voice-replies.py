"""Build bundled Thai speech on macOS; the running web app needs no macOS TTS."""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]
cli = argparse.ArgumentParser(description=__doc__)
cli.add_argument('--force', action='store_true', help='replace already bundled WAV files')
options = cli.parse_args()
phrases = json.loads(subprocess.check_output([
    'node', '-e', "console.log(JSON.stringify(require('./public/js/voice-feedback').phrases))"
], cwd=ROOT))
output = ROOT / 'public/audio/voice'
output.mkdir(parents=True, exist_ok=True)
number_words = dict(zip(range(21, 28), ['ยี่สิบเอ็ด', 'ยี่สิบสอง', 'ยี่สิบสาม', 'ยี่สิบสี่', 'ยี่สิบห้า', 'ยี่สิบหก', 'ยี่สิบเจ็ด']))
created = 0
with tempfile.TemporaryDirectory(prefix='smart-voice-build-') as temporary:
    for key, text in phrases.items():
        destination = output / f'{key}.wav'
        if destination.exists() and not options.force:
            continue
        for number, word in number_words.items():
            text = text.replace(str(number), word)
        aiff, wav = Path(temporary) / 'speech.aiff', Path(temporary) / 'speech.wav'
        subprocess.run(['say', '-v', 'Kanya', '-r', '195', '-o', str(aiff), text], check=True)
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16@24000', str(aiff), str(wav)], check=True)
        with wave.open(str(wav), 'rb') as source:
            params, frames = source.getparams(), source.readframes(source.getnframes())
        samples = struct.unpack('<' + 'h' * (len(frames) // 2), frames)
        # Keep less silence on fragments so concatenated numbers read together.
        voiced = [i for i, sample in enumerate(samples) if abs(sample) > 120]
        if not voiced:
            raise RuntimeError(f'Kanya produced no speech for {key}')
        before, after = (288, 480) if key.startswith('num-') else (720, 1440)
        first = max(0, voiced[0] - before)
        last = min(len(samples), voiced[-1] + after + 1)
        with wave.open(str(destination), 'wb') as target:
            target.setparams(params)
            target.writeframes(frames[first * 2:last * 2])
        created += 1
print(f'Built {created} Thai voice clips in {output} ({len(phrases) - created} kept)')
