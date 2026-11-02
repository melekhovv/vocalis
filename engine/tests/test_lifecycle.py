"""Cancellation, parameter validation and damaged model regressions."""
import json
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import _test_env
from vcengine.audio import AudioEngine, validate_params
from vcengine.models import ModelManager, ModelError, Job, sha256_file
from vcengine import server


def models():
    return SimpleNamespace(voice_paths=lambda _: ("voice.pth", None),
                           base_assets_status=lambda: {"ready": True}, list_voices=lambda: [])


class LifecycleTests(unittest.TestCase):
    def test_restart_waits_for_old_inference_and_can_be_cancelled(self):
        for cancel in (False, True):
            engine = AudioEngine(models())
            engine.voice_id = "voice"
            engine.devices.update(input=0, output=1)
            entered, resume, replacement = threading.Event(), threading.Event(), threading.Event()
            calls = []

            def process():
                calls.append(1)
                if len(calls) == 1:
                    entered.set()
                    resume.wait(3)
                else:
                    replacement.set()

            with patch.object(engine, "_run", side_effect=process):
                engine.start()
                self.assertTrue(entered.wait(1))
                first_worker = engine.worker
                try:
                    engine.restart()
                    self.assertEqual(engine.state, "loading")
                    if cancel:
                        engine.stop()
                    resume.set()
                    first_worker.join(3)
                    if not cancel:
                        self.assertTrue(replacement.wait(1))
                    self.assertEqual(len(calls), 1 if cancel else 2)
                finally:
                    resume.set()
                    engine.stop()

    def test_cancel_during_load_never_reopens_streams_and_blocks_overlapping_start(self):
        engine = AudioEngine(models())
        engine.voice_id = "voice"
        engine.devices.update(input=0, output=1)
        entered, resume = threading.Event(), threading.Event()

        def build():
            entered.set()
            resume.wait(3)
            return SimpleNamespace(device="test")

        with patch.object(engine, "_build_vc", side_effect=build), patch.object(engine, "_open_streams") as opened:
            engine.start()
            self.assertTrue(entered.wait(1))
            try:
                started = time.monotonic()
                engine.stop()
                self.assertLess(time.monotonic() - started, 1)
                self.assertEqual(engine.state, "stopped")
                with self.assertRaisesRegex(RuntimeError, "завершается"):
                    engine.start()
            finally:
                resume.set()
                engine.worker.join(3)
            opened.assert_not_called()
            self.assertFalse(engine.worker.is_alive())
            self.assertIsNone(engine.vc)
            self.assertEqual(engine.state, "stopped")

    def test_stop_does_not_release_a_model_still_used_by_worker(self):
        engine = AudioEngine(models())
        engine.voice_id = "voice"
        engine.devices.update(input=0, output=1)
        entered, resume = threading.Event(), threading.Event()

        def processing():
            engine.vc = object()
            entered.set()
            resume.wait(3)

        with patch.object(engine, "_run", side_effect=processing), patch.object(engine, "_release_vc") as release:
            engine.start()
            self.assertTrue(entered.wait(1))
            try:
                engine.stop()
                release.assert_not_called()
            finally:
                resume.set()
                engine.worker.join(3)
            release.assert_called_once()

    def test_invalid_patch_is_atomic_and_rejects_non_finite_and_out_of_range_values(self):
        engine = AudioEngine(models())
        for invalid in [float("nan"), float("inf"), -1, 4, "1", True]:
            before = dict(engine.params)
            with self.assertRaises(ValueError):
                engine.update_params({"pitch": 12, "input_gain": invalid})
            self.assertEqual(engine.params, before)
        for patch_data in [{"pitch": 0.5}, {"f0_method": "missing"}, {"monitor": "yes"}, {"ptt_vk": 0}]:
            with self.assertRaises(ValueError):
                validate_params(patch_data)

    def test_monitor_failure_rolls_back_every_parameter_in_patch(self):
        engine = AudioEngine(models())
        engine.state = "running"
        before = dict(engine.params)
        with patch.object(engine, "_validate_monitor_device"), patch.object(engine, "_sync_monitor_stream", side_effect=RuntimeError("offline")):
            with self.assertRaises(RuntimeError):
                engine.update_params({"pitch": 8, "monitor": True})
        self.assertEqual(engine.params, before)

    def test_loading_rejects_preset_and_voice_changes_without_modifying_selection(self):
        engine = AudioEngine(models())
        engine.state = "loading"
        for call in [lambda: engine.set_preset("quality"), lambda: engine.select_voice("other")]:
            with self.assertRaises(RuntimeError):
                call()
        self.assertEqual(engine.preset, "balanced")
        self.assertIsNone(engine.voice_id)


class PersistenceTests(unittest.TestCase):
    def test_invalid_saved_settings_do_not_break_startup(self):
        settings = Path(_test_env._tmp.name) / "invalid-settings.json"
        devices = {"inputs": [{"id": 0, "name": "mic"}], "outputs": [{"id": 1, "name": "headphones", "isVirtualCable": False}],
                   "defaultInput": 0, "defaultOutput": 1, "virtualCable": None}
        for content in ["[]", '{"params":[],"preset":[],"voiceId":[]}', '{"params":{"pitch":"bad","monitor":"yes","input_gain":-3},"devices":[],"compute":"bad"}']:
            settings.write_text(content, encoding="utf-8")
            engine = AudioEngine(models())
            with patch.object(server, "engine", engine), patch.object(server, "SETTINGS_FILE", settings), patch.object(server.audio_mod, "list_devices", return_value=devices):
                server.load_settings()
            self.assertEqual(engine.params["pitch"], 0)
            self.assertFalse(engine.params["monitor"])
            self.assertEqual(engine.params["input_gain"], 1)
            self.assertEqual(engine.compute, "auto")
            self.assertEqual(engine.devices["input"], 0)

    def test_verification_cannot_make_an_incompatible_checkpoint_ready(self):
        import tempfile
        from vcengine import models as mod
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp, patch.object(mod, "VOICES_DIR", Path(tmp)):
            manager = ModelManager()
            folder = Path(tmp) / "custom-broken"
            folder.mkdir()
            weights = folder / "model.pth"
            weights.write_bytes(b"not a checkpoint")
            manager._write_manifest("custom-broken", {"status": "incompatible", "files": {"pth": {"name": "model.pth", "sha256": sha256_file(weights)}}})
            with patch.object(mod, "inspect_checkpoint", side_effect=ModelError("incompatible")):
                self.assertFalse(manager.verify("custom-broken")["ok"])
            with self.assertRaises(ModelError):
                manager.voice_paths("custom-broken")

    def test_active_download_cannot_be_deleted_or_verified(self):
        manager = ModelManager()
        manager.jobs["custom-downloading"] = Job("custom-downloading")
        for operation in (manager.delete, manager.verify):
            with self.assertRaises(ModelError):
                operation("custom-downloading")


if __name__ == "__main__":
    unittest.main()
