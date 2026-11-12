"""Unit tests for Vocalis 1.2.0 dependency management, voice profiles, A/B test recorder and bug fixes."""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
import soundfile as sf
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import _test_env  # noqa: F401
from vcengine import audio, models as mod, server


class DependencyCleanupTests(unittest.TestCase):
    def test_delete_base_assets_and_clear_cache(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            base = Path(tmp)
            voices = base / "voices"
            cache = base / "cache"
            previews = base / "previews"
            for d in (voices, cache, previews):
                d.mkdir(parents=True)
            asset_rel = "rvc/models/predictors/rmvpe.pt"
            asset_file = base / asset_rel
            asset_file.parent.mkdir(parents=True)
            asset_file.write_bytes(b"weights-data")
            (cache / "temp.zip").write_bytes(b"zip-bytes")
            (previews / "test-raw.wav").write_bytes(b"wav-bytes")

            with patch.object(mod, "DATA_DIR", base), \
                    patch.object(mod, "VOICES_DIR", voices), \
                    patch.object(mod, "CACHE_DIR", cache), \
                    patch.object(mod, "PREVIEW_DIR", previews):
                manager = mod.ModelManager()
                manager.catalog = {
                    "retiredVoiceIds": [],
                    "voices": [],
                    "baseAssets": [{"id": "rmvpe", "title": "RMVPE", "path": asset_rel, "size": 12}],
                }
                info = manager.storage_info()
                self.assertEqual(info["baseBytes"], 12)
                self.assertEqual(info["cacheBytes"], 9)
                self.assertEqual(info["previewsBytes"], 9)

                res_base = manager.delete_base_assets()
                self.assertEqual(res_base["removedBytes"], 12)
                self.assertFalse(asset_file.exists())

                res_cache = manager.clear_cache()
                self.assertEqual(res_cache["removedBytes"], 18)
                self.assertFalse((cache / "temp.zip").exists())
                self.assertFalse((previews / "test-raw.wav").exists())

    def test_delete_voice_cleans_preview_cache_and_saves_settings(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            base = Path(tmp)
            voices = base / "voices"
            cache = base / "cache"
            previews = base / "previews"
            for d in (voices, cache, previews):
                d.mkdir(parents=True)
            vdir = voices / "custom-hero"
            vdir.mkdir()
            (vdir / "model.pth").write_bytes(b"pth")
            (previews / "demo-custom-hero.wav").write_bytes(b"wav")
            (cache / "custom-hero.zip.part").write_bytes(b"part")

            with patch.object(mod, "VOICES_DIR", voices), \
                    patch.object(mod, "CACHE_DIR", cache), \
                    patch.object(mod, "PREVIEW_DIR", previews):
                manager = mod.ModelManager()
                eng = audio.AudioEngine(manager)
                eng.voice_id = "custom-hero"
                eng.voice_profiles["custom-hero"] = {"pitch": 5}
                with patch.object(server, "models", manager), \
                        patch.object(server, "engine", eng), \
                        patch.object(server, "save_settings") as save_mock:
                    server.delete("custom-hero")
                self.assertFalse(vdir.exists())
                self.assertFalse((previews / "demo-custom-hero.wav").exists())
                self.assertFalse((cache / "custom-hero.zip.part").exists())
                self.assertIsNone(eng.voice_id)
                self.assertNotIn("custom-hero", eng.voice_profiles)
                save_mock.assert_called_once()

    def test_delete_base_assets_blocked_while_running(self):
        with patch.object(server.engine, "state", "running"):
            with self.assertRaises(HTTPException) as ctx:
                server.delete_base_assets()
            self.assertEqual(ctx.exception.status_code, 400)


class VoiceProfileTests(unittest.TestCase):
    def _engine(self):
        fake = SimpleNamespace(
            voice_paths=lambda vid: ("m.pth", "m.index"),
            list_voices=lambda: [
                {"id": "a", "suggestedPitch": 2, "recommendedParams": {"index_rate": 0.6, "protect": 0.3, "f0_method": "rmvpe"}},
                {"id": "b", "suggestedPitch": -4, "recommendedParams": {"index_rate": 0.5, "protect": 0.35, "f0_method": "fcpe"}},
            ],
        )
        return audio.AudioEngine(fake)

    def test_per_voice_profile_preserved_and_resettable(self):
        eng = self._engine()
        eng.select_voice("a")
        self.assertEqual(eng.params["pitch"], 2)
        eng.update_params({"pitch": 9, "index_rate": 0.8})
        eng.select_voice("b")
        self.assertEqual(eng.params["pitch"], -4)
        self.assertEqual(eng.params["f0_method"], "fcpe")
        eng.select_voice("a")
        self.assertEqual(eng.params["pitch"], 9)
        self.assertEqual(eng.params["index_rate"], 0.8)
        self.assertTrue(eng.status()["hasCustomProfile"])

        eng.reset_voice_profile("a")
        self.assertEqual(eng.params["pitch"], 2)
        self.assertEqual(eng.params["index_rate"], 0.6)
        self.assertFalse(eng.status()["hasCustomProfile"])

    def test_load_settings_filters_invalid_voice_profiles(self):
        devices = {"inputs": [], "outputs": [], "defaultInput": None, "defaultOutput": None, "virtualCable": None}
        eng = self._engine()
        settings = Mock()
        settings.exists.return_value = True
        settings.read_text.return_value = json.dumps({
            "voiceProfiles": {
                "a": {"pitch": 6, "index_rate": 99, "bad_key": 1},
                "b": "not-a-dict",
            }
        })
        with patch.object(server, "engine", eng), \
                patch.object(server, "SETTINGS_FILE", settings), \
                patch.object(server.audio_mod, "list_devices", return_value=devices):
            server.load_settings()
        self.assertEqual(eng.voice_profiles, {"a": {"pitch": 6}})


class RecordTestAndF0FixTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        server._preview_lock = asyncio.Lock()
        server.engine.state = "stopped"
        server.engine.voice_id = "shrek-ru"
        server.engine.devices["input"] = 0

    async def test_record_test_and_reconvert(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            pdir = Path(tmp)
            t = np.arange(48000, dtype=np.float32) / 48000.0
            speech = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
            with patch.object(server, "PREVIEW_DIR", pdir), \
                    patch.object(server.models, "base_assets_status", return_value={"ready": True}), \
                    patch.object(server.models, "voice_paths", return_value=("m.pth", None)), \
                    patch.object(server.models, "list_voices", return_value=[{"id": "shrek-ru"}]), \
                    patch.object(server.audio_mod, "record", return_value=speech), \
                    patch.object(server.audio_mod, "convert_clip", return_value=speech * 0.5) as conv:
                res = await server.preview_record_test({"seconds": 2})
                self.assertEqual(res["rawUrl"], "/preview/audio/test-raw.wav")
                self.assertEqual(res["convertedUrl"], "/preview/audio/test-converted.wav")
                self.assertTrue((pdir / "test-raw.wav").is_file())
                self.assertTrue((pdir / "test-converted.wav").is_file())
                self.assertEqual(conv.call_count, 1)

                server.engine.params["pitch"] = 5
                res2 = await server.preview_reconvert()
                self.assertEqual(res2["convertedUrl"], "/preview/audio/test-converted.wav")
                self.assertEqual(conv.call_count, 2)
                self.assertEqual(conv.call_args.args[3]["pitch"], 5)

                resp = server.preview_audio("test-converted.wav")
                out, _sr = sf.read(resp.path)
                self.assertGreater(len(out), 0)

    async def test_record_test_rejects_silent_mic(self):
        silent = np.zeros(48000, dtype=np.float32)
        with patch.object(server.models, "base_assets_status", return_value={"ready": True}), \
                patch.object(server.models, "voice_paths", return_value=("m.pth", None)), \
                patch.object(server.audio_mod, "record", return_value=silent):
            with self.assertRaises(HTTPException) as ctx:
                await server.preview_record_test({"seconds": 2})
            self.assertEqual(ctx.exception.status_code, 400)

    def test_setup_f0_crepe_does_not_raise_unbound_local(self):
        from rvc.realtime.pipeline import Realtime_Pipeline

        dummy = SimpleNamespace(use_f0=True, f0_method="rmvpe")
        self.assertIsNone(Realtime_Pipeline.setup_f0(dummy, "crepe"))


if __name__ == "__main__":
    unittest.main()
