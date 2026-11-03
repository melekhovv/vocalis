"""Personal model tuning regressions; no audio devices or weights are opened."""
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _test_env
import numpy as np
from fastapi import HTTPException
from vcengine.audio import AudioEngine
from vcengine import server


class Models:
    def voice_paths(self, vid):
        if vid not in ('a', 'b'):
            raise ValueError('unknown voice')
        return 'model.pth', 'model.index' if vid == 'a' else None

    def list_voices(self):
        return [{'id': 'a', 'suggestedPitch': -3, 'recommendedParams': {'index_rate': .75, 'protect': .2, 'f0_method': 'crepe'}},
                {'id': 'b', 'suggestedPitch': 0}]

    def base_assets_status(self):
        return {'ready': True}


DEVICES = {'inputs': [{'id': 1, 'name': 'mic'}],
           'outputs': [{'id': 2, 'name': 'phones', 'isVirtualCable': False}],
           'defaultInput': 1, 'defaultOutput': 2, 'virtualCable': None}


class VoiceProfileTests(unittest.TestCase):
    def engine(self):
        e = AudioEngine(Models())
        e.select_voice('a')
        return e

    def test_switch_isolated_defaults_and_no_index(self):
        e = self.engine()
        e.params.update(input_gain=1.8, monitor=True)
        e.devices = {'input': 1, 'output': 2, 'monitor': 3}
        e.select_voice('b')
        self.assertEqual((e.params['pitch'], e.params['index_rate'], e.params['protect'], e.params['f0_method']), (0, 0, .33, 'rmvpe'))
        e.update_params({'index_rate': .9})
        self.assertEqual(e.params['index_rate'], 0)
        self.assertEqual(e.params['input_gain'], 1.8)
        self.assertTrue(e.params['monitor'])
        self.assertEqual(e.devices, {'input': 1, 'output': 2, 'monitor': 3})

    def test_remember_a_b_a_and_clarity_non_destructive(self):
        e = self.engine()
        e.update_params({'pitch': 2, 'index_rate': .8, 'protect': .4, 'clarity_mode': True})
        self.assertEqual((e.params['index_rate'], e.params['protect']), (.4, .1))
        e.select_voice('b')
        e.update_params({'pitch': -6})
        e.select_voice('a')
        self.assertEqual(e.params['pitch'], 2)
        e.update_params({'clarity_mode': False})
        self.assertEqual((e.params['index_rate'], e.params['protect']), (.8, .4))
        e.select_voice('b')
        self.assertEqual(e.params['pitch'], -6)

    def test_preset_changes_only_active_voice_f0(self):
        e = self.engine()
        e.set_preset('performance')
        self.assertEqual(e.params['f0_method'], 'fcpe')
        e.select_voice('b')
        self.assertEqual(e.params['f0_method'], 'rmvpe')
        self.assertEqual(e.preset, 'performance')
        e.select_voice('a')
        self.assertEqual(e.params['f0_method'], 'fcpe')

    def test_reset_and_stale_guards(self):
        e = self.engine()
        e.update_params({'pitch': 4})
        with patch.object(server, 'engine', e), patch.object(server, 'save_settings'):
            for action, body in ((server.reset_voice_profile, {'id': 'b'}), (server.params, {'voiceId': 'b', 'pitch': 12})):
                with self.assertRaises(HTTPException) as ctx:
                    action(body)
                self.assertEqual(ctx.exception.status_code, 409)
            result = server.reset_voice_profile({'id': 'a'})
        self.assertEqual(e.params['pitch'], -3)
        self.assertFalse(result['voiceProfile']['saved'])
        self.assertTrue(result['voiceProfile']['hasIndex'])

    def test_persistence_migration_and_invalid_saved_values(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'settings.json'
            e = self.engine()
            with patch.object(server, 'engine', e), patch.object(server, 'models', e.models), patch.object(server, 'SETTINGS_FILE', file), patch.object(server.audio_mod, 'list_devices', return_value=DEVICES):
                file.write_text(json.dumps({'voiceId': 'a', 'params': {'pitch': 7, 'input_gain': 1.4}}))
                server.load_settings()
                e.select_voice('b')
                self.assertEqual(e.params['pitch'], 0)
                e.update_params({'pitch': -8})
                server.save_settings()
                restored = AudioEngine(e.models)
                with patch.object(server, 'engine', restored):
                    server.load_settings()
                restored.select_voice('a')
                self.assertEqual(restored.params['pitch'], 7)
                restored.select_voice('b')
                self.assertEqual(restored.params['pitch'], -8)
                self.assertEqual(restored.params['input_gain'], 1.4)
                file.write_text(json.dumps({'voiceId': 'a', 'voiceProfiles': {'a': {'pitch': 'bad', 'protect': 99, 'f0_method': 'invalid', 'index_rate': .6}, 'b': []}}))
                server.load_settings()
                self.assertEqual(e.params['pitch'], -3)
                self.assertEqual(e.params['protect'], .2)
                self.assertEqual(e.params['index_rate'], .6)
                file.write_text(json.dumps({'voiceId': 'a', 'params': {'pitch': 'bad'}}))
                server.load_settings()
                self.assertEqual(e.params['pitch'], -3)
                self.assertFalse(e.status()['voiceProfile']['saved'])

    def test_preview_uses_target_saved_tuning(self):
        e = self.engine()
        e.update_params({'pitch': 6, 'f0_method': 'fcpe', 'clarity_mode': True})
        expected = dict(e.effective_voice_profile('a'))
        e.select_voice('b')
        e.state = 'stopped'
        with patch.object(server, 'engine', e), patch.object(server, 'models', e.models), patch.object(server, '_preview_lock', asyncio.Lock()), patch.object(server, 'demo_clip', return_value=np.ones(4800, dtype=np.float32) * .1), patch.object(server.audio_mod, 'convert_clip', return_value=np.ones(4800, dtype=np.float32) * .1) as convert:
            asyncio.run(server.preview_convert({'voiceId': 'a'}))
        self.assertEqual(convert.call_args.args[3], expected)
        self.assertEqual(e.voice_id, 'b')


if __name__ == '__main__':
    unittest.main()
