"""Real local-ASR regression fixtures are synthesized Kanya speech, not human validation."""
import json
import io
import socket
import subprocess
import unittest
import wave
from pathlib import Path

def no_network(*args, **kwargs):
    raise RuntimeError('External networking forbidden during local ASR test')
socket.socket.connect = no_network
socket.create_connection = no_network
from asr_worker import Recognizer
ROOT=Path(__file__).resolve().parents[1]

class LocalASR(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.asr=Recognizer()
    def test_exact_user_sentences_and_dialogue_with_network_disabled(self):
        expected={'open-please':'เปิดแอร์ให้ผมหน่อย','open':'เปิดแอร์','close':'ปิดแอร์','close-please':'ปิดแอร์ให้ผมหน่อย','temperature-question':'ปรับอุณหภูมิ','temp25':'ยี่สิบห้าองศา','negated':'ไม่ต้องเปิดแอร์'}
        for name,text in expected.items():
            with self.subTest(name=name):
                result=self.asr.classify((ROOT/'test/fixtures/asr'/f'{name}.wav').read_bytes())
                self.assertTrue(result['accepted']);self.assertEqual(result['transcript'].replace(' ',''),text)
    def test_command_longer_than_old_two_second_limit(self):
        result=self.asr.classify((ROOT/'test/fixtures/asr/long-command.wav').read_bytes())
        self.assertTrue(result['accepted']);self.assertIn('เปิดแอร์',result['transcript']);self.assertIn('25',result['transcript'])

    def test_real_local_wake_gate_preserves_names_and_rejects_near_sounds(self):
        # These are synthetic WAVs: เอ็นจี้, named ON/OFF and Thai alias;
        # then เอ็นที่, เอ็นที่เปิดแอร์, เอนจิน,
        # ordinary background speech and commands without the name.
        expected = {
            'name': 'wake', 'name-open': ['ON'], 'name-variant-command': ['ON'], 'name-close': ['OFF'],
            'long-command': ['ON','TEMP:25'], 'near-name': None, 'near-name-open': None,
            'near-engine': None, 'background-talk': None, 'open-please': None, 'close': None,
            'wake-thai-fast': 'wake', 'wake-near-fast': None, 'wake-thai-inline': ['ON'],
            'wake-thai-inline-fast': ['ON'], 'wake-thai-inline-vad': ['ON'], 'wake-english': 'wake', 'wake-english-vad': 'wake',
            'wake-english-vad-offset': 'wake', 'wake-english-inline': ['ON'],
            'wake-not-andy': None, 'wake-not-similar-inline': None, 'wake-not-engine': None,
            'wake-not-unnamed-en': None, 'wake-not-andy-inline': None, 'wake-not-angie': None,
            'status-room-temp': 'room_temperature', 'status-room-people': 'people_count', 'status-unnamed': None,
        }
        results = {}
        for name in expected:
            data = (ROOT/'test/fixtures/asr'/f'{name}.wav').read_bytes()
            results[name] = self.asr.classify(data, wake=True)
            # Exercise the same new recordings with leading/trailing silence
            # like the web VAD's capture, which changes the decoded hypotheses.
            if name.startswith('wake-') and '-vad' not in name:
                with wave.open(io.BytesIO(data)) as source:
                    params, pcm = source.getparams(), source.readframes(source.getnframes())
                padded = io.BytesIO()
                with wave.open(padded, 'wb') as target:
                    target.setparams(params)
                    target.writeframes(bytes(4200 * 2) + pcm + bytes(7500 * 2))
                results[name + '-padded'] = self.asr.classify(padded.getvalue(), wake=True)
        mapped = json.loads(subprocess.check_output(['node', '-e', '''
            const fs=require('node:fs'), {verifiedWakeTranscript,parseSpeech}=require('./local-commands');
            const entries=Object.entries(JSON.parse(fs.readFileSync(0,'utf8')));
            process.stdout.write(JSON.stringify(Object.fromEntries(entries.map(([name,result])=>{
              const text=verifiedWakeTranscript(result), intent=text&&parseSpeech(text);
              return [name,intent?.wakeOnly?'wake':intent?.query||intent?.commands||null];
            }))));
        '''], cwd=ROOT, input=json.dumps(results).encode()))
        for name, actual in mapped.items():
            with self.subTest(sample=name):
                self.assertEqual(actual, expected[name.removesuffix('-padded')],
                    {key:value for key,value in results[name].items() if key.startswith('wake')})

if __name__=='__main__':unittest.main()
