"""Public release: no bundled voices/audio; preview only user-selected WAV."""
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import _test_env
from vcengine import server as api
from vcengine import models as model_mod
from vcengine.models import ModelManager, ModelError
import numpy as np
import soundfile as sf
from fastapi import HTTPException


class PreviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        api._preview_lock = asyncio.Lock()
        api.engine.state = "stopped"
        api.engine.params["pitch"] = 12
        api.engine.compute = "cpu"
        self.clip = (0.1 * np.sin(2 * np.pi * 220 * np.arange(48000) / 48000)).astype(np.float32)
        sf.write(api.PREVIEW_DIR / "user-input.wav", self.clip, 48000, subtype="FLOAT")

    async def test_public_catalog_has_no_unapproved_voices(self):
        self.assertEqual(api.models.catalog["voices"], [])
        self.assertEqual(api.models.catalog["voicePolicy"]["allowedLicenses"], ["CC0-1.0"])

    async def test_catalog_rejects_unapproved_voice(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            p = Path(tmp) / "voices.json"
            p.write_text(json.dumps({"voices": [{"id": "test", "model": {"license": "MIT"}}], "baseAssets": []}))
            with patch.object(model_mod, "CATALOG_FILE", p), self.assertRaises(ModelError):
                ModelManager()

    async def test_preview_uses_selected_audio_not_old_recording_or_active_pitch(self):
        sf.write(api.PREVIEW_DIR / "original.wav", np.zeros(48000), 48000)
        seen = {}
        def convert(models, vid, clip, params, preset, compute):
            seen.update(params=params, preset=preset, compute=compute)
            np.testing.assert_allclose(clip, self.clip)
            return clip
        with patch.object(api.models, "list_voices", return_value=[{"id": "custom-fixture", "suggestedPitch": -2}]), patch.object(api.models, "base_assets_status", return_value={"ready": True}), patch.object(api.models, "voice_paths", return_value=("model.pth", None)), patch.object(api.audio_mod, "convert_clip", side_effect=convert):
            result = await api.preview_convert({"voiceId": "custom-fixture", "params": {"pitch": 24}})
            self.assertEqual(result["url"], "/preview/audio/demo-custom-fixture.wav")
            self.assertTrue(Path(api.preview_audio("demo-custom-fixture.wav").path).is_file())
        self.assertEqual(seen["params"], {"pitch": -2, "index_rate": .75, "protect": .33})
        self.assertEqual(seen["compute"], "cpu")

    async def test_missing_input_has_actionable_error(self):
        (api.PREVIEW_DIR / "user-input.wav").unlink()
        with self.assertRaises(HTTPException) as ctx:
            api.demo_clip()
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("WAV", ctx.exception.detail)

    async def test_preview_rejected_during_live_conversion(self):
        api.engine.state = "running"
        with patch.object(api.models, "list_voices", return_value=[{"id": "custom-fixture"}]), self.assertRaises(HTTPException):
            await api.preview_convert({"voiceId": "custom-fixture"})

    async def test_selected_wav_is_resampled_and_long_files_rejected(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            path = Path(tmp) / "input.wav"
            sf.write(path, np.zeros((24000, 2)), 24000)
            result = await api.preview_input({"path": str(path)})
            self.assertTrue(result["ready"])
            self.assertEqual(api.demo_clip().shape, (48000,))
            sf.write(path, np.zeros(8000 * 31), 8000)
            with self.assertRaises(HTTPException):
                await api.preview_input({"path": str(path)})

    async def test_source_audio_and_traversal_not_served(self):
        for name in ["original.wav", "user-input.wav", "../engine-settings.json", "old-voice.wav"]:
            with self.assertRaises(HTTPException):
                api.preview_audio(name)

    async def test_unknown_voice_rejected(self):
        for vid in ["unknown", "../original", None]:
            with self.assertRaises(HTTPException):
                await api.preview_convert({"voiceId": vid})
            with self.assertRaises(ModelError):
                api.models.voice_paths(vid)

    async def test_initialization_does_not_delete_existing_local_models(self):
        old = model_mod.VOICES_DIR / "old-voice"
        old.mkdir(parents=True, exist_ok=True)
        (old / "model.pth").write_bytes(b"private local fixture")
        ModelManager()
        self.assertTrue((old / "model.pth").exists())

    async def test_start_during_preview_is_rejected(self):
        async with api._preview_lock:
            with self.assertRaises(HTTPException) as ctx:
                api.start()
            self.assertEqual(ctx.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
