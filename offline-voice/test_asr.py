"""Real local-ASR regression fixtures are synthesized Kanya speech, not human validation."""
import socket
import unittest
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
        expected={'open-please':'เปิดแอร์ให้ผมหน่อย','open':'เปิดแอร์','close':'ปิดแอร์','close-please':'ปิดแอร์ให้ผมหน่อย','temperature-question':'ปรับอุณหภูมิ','temp25':'ยี่สิบห้าองศา','name':'เอ็นจี้','negated':'ไม่ต้องเปิดแอร์'}
        for name,text in expected.items():
            with self.subTest(name=name):
                result=self.asr.classify((ROOT/'test/fixtures/asr'/f'{name}.wav').read_bytes())
                self.assertTrue(result['accepted']);self.assertEqual(result['transcript'].replace(' ',''),text)
    def test_command_longer_than_old_two_second_limit(self):
        result=self.asr.classify((ROOT/'test/fixtures/asr/long-command.wav').read_bytes())
        self.assertTrue(result['accepted']);self.assertIn('เปิดแอร์',result['transcript']);self.assertIn('25',result['transcript'])

if __name__=='__main__':unittest.main()
