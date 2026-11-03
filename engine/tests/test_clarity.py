import sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import _test_env
from vcengine.audio import AudioEngine
from vcengine import server
from fastapi import HTTPException
from unittest.mock import patch

class ClarityTests(unittest.TestCase):
    def engine(self):
        models=type('Models',(),{
            'voice_paths':lambda self,vid:('model.pth','model.index' if vid=='indexed' else None),
            'list_voices':lambda self:[
                {'id':'indexed','suggestedPitch':-3,'recommendedParams':{'index_rate':.75,'protect':.33}},
                {'id':'plain','suggestedPitch':-2,'recommendedParams':{'index_rate':0.,'protect':.33}},
            ],
        })()
        engine=AudioEngine(models);engine.select_voice('indexed');return engine

    def test_enable_preserves_pitch_devices_and_gain(self):
        e=self.engine();e.devices={'input':1,'output':2,'monitor':3};e.params['input_gain']=1.5
        e.update_params({'clarity_mode':True})
        self.assertEqual((e.params['index_rate'],e.params['protect']),(.4,.1))
        self.assertEqual(e.params['pitch'],-3)
        self.assertEqual(e.params['input_gain'],1.5)
        self.assertEqual(e.devices['input'],1)

    def test_mode_is_remembered_per_voice_without_enabling_missing_index(self):
        e=self.engine();e.update_params({'clarity_mode':True});e.select_voice('plain')
        self.assertFalse(e.params['clarity_mode'])
        self.assertEqual(e.params['index_rate'],0.)
        self.assertEqual(e.params['protect'],.33)
        e.select_voice('indexed')
        self.assertTrue(e.params['clarity_mode'])
        self.assertEqual(e.params['index_rate'],.4)

    def test_disable_restores_selected_voice_profile(self):
        e=self.engine();e.update_params({'clarity_mode':True});e.update_params({'clarity_mode':False})
        self.assertEqual((e.params['index_rate'],e.params['protect']),(.75,.33))
        self.assertEqual(e.params['pitch'],-3)

    def test_mode_is_typed_and_cannot_be_overridden_by_other_sliders(self):
        e=self.engine()
        with self.assertRaises(ValueError):e.update_params({'clarity_mode':'yes'})
        e.update_params({'clarity_mode':True});e.update_params({'index_rate':.9,'protect':.5})
        self.assertEqual((e.params['index_rate'],e.params['protect']),(.4,.1))

    def test_source_registry_contains_checked_public_links(self):
        data=server.voice_sources()
        self.assertGreaterEqual(len(data['sources']),2)
        self.assertTrue(data['checkedAt'])
        self.assertTrue(all(s['url'].startswith('https://') for s in data['sources']))
        self.assertTrue(all(s['httpStatus']==200 for s in data['sources']))

    def test_missing_source_registry_is_an_actionable_error(self):
        with patch.object(server,'CATALOG_FILE',Path(_test_env._tmp.name)/'absent/voices.json'):
            with self.assertRaises(HTTPException) as ctx:server.voice_sources()
        self.assertEqual(ctx.exception.status_code,503)

if __name__=='__main__':unittest.main()
