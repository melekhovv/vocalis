"""Card preview regressions: fixed speech, no microphone state, Russian catalog."""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import _test_env
from vcengine import server as api
from vcengine.models import ModelManager, ModelError
from vcengine.paths import VOICES_DIR
import numpy as np
import soundfile as sf
from fastapi import HTTPException

class PreviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        api._preview_lock=asyncio.Lock()
        api.engine.state='stopped'
        api.engine.params['pitch']=12
        api.engine.compute='cpu'

    async def test_preview_requires_stopped_engine(self):
        api.engine.state = 'running'
        with patch.object(api.models, 'list_voices', return_value=[{'id': 'custom-russian'}]):
            with self.assertRaises(HTTPException) as exc:
                await api.preview_convert({'voiceId': 'custom-russian'})
        self.assertEqual(exc.exception.status_code, 400)

    async def test_local_system_source_is_cached_only_within_engine_session(self):
        api._demo_ready = False
        calls = []
        def synthesize(*args, **kwargs):
            calls.append(kwargs)
            sf.write(kwargs['env']['VOCALIS_DEMO_OUTPUT'], np.ones(4800, dtype=np.float32) * .1, 48000)
        with patch.object(api.sys, 'platform', 'win32'), patch.object(api.subprocess, 'run', side_effect=synthesize):
            first = api.demo_clip()
            second = api.demo_clip()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['timeout'], 45)
        self.assertEqual(calls[0]['env']['VOCALIS_DEMO_TEXT'], api.DEMO_TEXT)
        np.testing.assert_array_equal(first, second)
        api._demo_ready = False

    async def test_system_voice_failure_is_actionable(self):
        api._demo_ready = False
        with patch.object(api.sys, 'platform', 'win32'), patch.object(api.subprocess, 'run', side_effect=api.subprocess.TimeoutExpired('powershell', 45)):
            with self.assertRaises(HTTPException) as exc:
                api.demo_clip()
        self.assertEqual(exc.exception.status_code, 503)
        self.assertIn('русский системный голос', exc.exception.detail)

    async def test_fallback_ignores_old_microphone_and_selected_voice_settings(self):
        # Simulate a custom profile without a bundled demo.
        demo=np.ones(4800, dtype=np.float32) * .1
        sf.write(api.PREVIEW_DIR/'original.wav',np.zeros(48000),48000)
        seen={}
        def convert(models,vid,clip,params,preset,compute):
            seen.update(params=params,preset=preset,compute=compute)
            np.testing.assert_allclose(clip,demo)
            return clip
        with patch.object(api, 'demo_clip', return_value=demo), patch.object(api.models,'list_voices',return_value=[{'id':'custom-russian','suggestedPitch':-2}]), patch.object(api.models,'base_assets_status',return_value={'ready':True}), patch.object(api.models,'voice_paths',return_value=('model.pth','model.index')), patch.object(api.audio_mod,'convert_clip',side_effect=convert):
            await api.preview_convert({'voiceId':'custom-russian','params':{'pitch':24}})
        self.assertEqual(seen['params'],{'pitch':-2,'index_rate':.5,'protect':.33,'f0_method':'rmvpe','clarity_mode':False,'volume_envelope':1.})
        self.assertEqual(seen['compute'],'cpu')

    async def test_removed_or_unknown_profile_cannot_be_previewed(self):
        for vid in ['goku','spongebob','max-lavrov-ru','../original',None]:
            with self.assertRaises(HTTPException) as e: await api.preview_convert({'voiceId':vid})
            self.assertEqual(e.exception.status_code,404)
        with self.assertRaises(ModelError): api.models.voice_paths('goku')
        with self.assertRaises(ModelError): api.models.voice_paths('max-lavrov-ru')

    async def test_old_recording_and_traversal_not_served(self):
        for name in ['original.wav','../engine-settings.json','goku.wav']:
            with self.assertRaises(HTTPException): api.preview_audio(name)

    async def test_start_during_fallback_is_rejected(self):
        async with api._preview_lock:
            with self.assertRaises(HTTPException) as e: api.start()
            self.assertEqual(e.exception.status_code,409)

    async def test_local_recovery_preserves_existing_model_files(self):
        retired=VOICES_DIR/'goku';retired.mkdir(parents=True,exist_ok=True)
        (retired/'model.pth').write_bytes(b'retired fixture')
        custom=VOICES_DIR/'custom-keep';custom.mkdir(exist_ok=True)
        (custom/'keep.txt').write_text('keep')
        ModelManager()
        self.assertTrue(retired.exists())
        self.assertTrue((custom/'keep.txt').exists())

    async def test_profile_selection_applies_timbre_settings_without_touching_devices(self):
        from vcengine.audio import AudioEngine
        fake=type('Models',(),{
            'voice_paths':lambda self,vid:('model.pth','model.index'),
            'list_voices':lambda self:[{'id':'invoker-ru','suggestedPitch':0,'recommendedParams':{'index_rate':.75,'protect':.33,'f0_method':'rmvpe'}}],
        })()
        engine=AudioEngine(fake)
        engine.params.update(pitch=12,index_rate=.2,f0_method='fcpe',monitor=True)
        engine.devices={'input':1,'output':2,'monitor':3}
        engine.state='running'
        engine.vc=object()
        engine.select_voice('invoker-ru')
        self.assertEqual(engine.params['pitch'],0)
        self.assertEqual(engine.params['index_rate'],.75)
        self.assertEqual(engine.params['f0_method'],'rmvpe')
        self.assertTrue(engine.params['monitor'])
        self.assertEqual(engine.devices,{'input':1,'output':2,'monitor':3})
        self.assertEqual(engine._cfg_queue[0]['index_rate'],.75)
        self.assertEqual(engine._cfg_queue[0]['model_path'],'model.pth')

if __name__=='__main__': unittest.main()
