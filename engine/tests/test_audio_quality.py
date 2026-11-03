"""Signal/control regressions on CPU arrays only; no RVC weights or hardware."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _test_env
import numpy as np
from vcengine.audio import AudioEngine, _Fifo, SR, PRESETS, validate_params
from vcengine.quality import QUALITY_PRESETS, model_quality_defaults, model_applicability, normalize_preset, signal_metrics


class Models:
    def voice_paths(self, vid):
        return 'fixture.pth', 'fixture.index' if vid == 'voiced' else None

    def list_voices(self):
        return [{'id': 'voiced', 'checkpoint': {'f0': True}},
                {'id': 'plain', 'checkpoint': {'f0': False}}]


class AudioQualityTests(unittest.TestCase):
    def test_presets_are_existing_engine_modes_with_valid_alignment(self):
        self.assertEqual(set(QUALITY_PRESETS), {'Balanced', 'HighQuality', 'LowLatency'})
        for alias, wire in QUALITY_PRESETS.items():
            self.assertEqual(normalize_preset(alias), wire)
            cfg = PRESETS[wire]
            self.assertEqual(cfg['block_frame'] % 480, 0)
            self.assertLess(cfg['crossfade'] * SR, cfg['block_frame'])
            self.assertGreaterEqual(cfg['extra'], cfg['crossfade'])
            validate_params(model_quality_defaults({'f0': True}, True, alias))
        self.assertLess(PRESETS['performance']['block_frame'], PRESETS['balanced']['block_frame'])
        self.assertLess(PRESETS['balanced']['block_frame'], PRESETS['quality']['block_frame'])
        with self.assertRaises(ValueError):
            normalize_preset([])

    def test_model_specific_applicability_and_no_guessed_pitch(self):
        for alias in QUALITY_PRESETS:
            f0 = model_quality_defaults({'f0': True}, True, alias)
            plain = model_quality_defaults({'f0': False}, False, alias)
            self.assertEqual(f0['pitch'], 0)
            self.assertEqual(plain['pitch'], 0)
            self.assertEqual(plain['index_rate'], 0)
            self.assertEqual(plain['protect'], .5)
        self.assertTrue(model_applicability(None, True)['f0'])
        e = AudioEngine(Models())
        e.select_voice('voiced')
        e.update_params({'pitch': 6, 'protect': .2})
        e.select_voice('plain')
        e.update_params({'pitch': 12, 'index_rate': .9, 'clarity_mode': True, 'protect': .1})
        self.assertEqual((e.params['pitch'], e.params['index_rate'], e.params['protect']), (0, 0, .5))
        self.assertFalse(e.status()['voiceProfile']['applicability']['f0'])
        e.select_voice('voiced')
        self.assertEqual((e.params['pitch'], e.params['protect']), (6, .2))

    def test_synthetic_output_silence_clipping_and_continuity_metrics(self):
        t = np.arange(SR, dtype=np.float64) / SR
        tone = .2 * np.sin(2 * np.pi * 440 * t)
        normal = signal_metrics(tone)
        self.assertTrue(normal['finite'])
        self.assertFalse(normal['silent'])
        self.assertEqual(normal['clippedFraction'], 0)
        self.assertLess(normal['maxStep'], .012)
        self.assertEqual(normal['durationMs'], 1000)
        self.assertTrue(signal_metrics(np.zeros(SR))['silent'])
        self.assertTrue(signal_metrics(np.array([]))['silent'])
        self.assertFalse(signal_metrics(np.array([np.nan]))['finite'])
        self.assertGreater(signal_metrics(tone * 10)['clippedFraction'], 0)
        broken = tone.copy()
        broken[1000:2000] += 1.
        self.assertGreater(signal_metrics(broken)['maxStep'], .9)

    def test_fifo_is_sample_continuous_and_delay_remains_bounded_under_overload(self):
        cap, prime = int(.4 * SR), int(.05 * SR)
        fifo = _Fifo(cap, prime)
        t = np.arange(4800) / SR
        tone = (.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        fifo.push(tone[:2400])
        fifo.push(tone[2400:])
        out = np.concatenate([fifo.pull(480) for _ in range(10)])
        np.testing.assert_array_equal(out, tone)
        for _ in range(1000):
            fifo.push(tone)
            self.assertLessEqual(fifo.size / SR * 1000, 400)
        self.assertGreater(fifo.dropped, 0)
        self.assertLessEqual(fifo.size, cap)
        fifo.clear()
        np.testing.assert_array_equal(fifo.pull(480), np.zeros(480))


if __name__ == '__main__':
    unittest.main()
