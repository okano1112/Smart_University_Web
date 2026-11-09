import io
import unittest
import wave
import librosa
import numpy as np
from worker import Classifier, CONFIG

class Features(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = Classifier()
    def test_exact_training_defaults(self):
        y = np.random.default_rng(42).normal(0, .05, 24000).astype(np.float32)
        original = librosa.feature.mfcc(y=y, sr=16000, n_mfcc=13, n_fft=512, hop_length=600).T
        expected = ((original - CONFIG['mean']) / (CONFIG['std'] + 1e-6))[None, ..., None]
        np.testing.assert_allclose(self.model.features(y), expected, atol=1e-6)
    def test_does_not_crop_long_command_into_different_intent(self):
        y = np.random.default_rng(43).normal(0, .1, 48000)
        f = io.BytesIO()
        with wave.open(f, 'wb') as w:
            w.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            w.writeframes((y * 32767).astype('<i2').tobytes())
        self.assertEqual(self.model.classify(f.getvalue())['reason'], 'too_long')

if __name__ == '__main__': unittest.main()
