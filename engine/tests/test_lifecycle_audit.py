"""Regressions for device failures, cancelled warmup, and damaged settings."""
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _test_env
import numpy as np
from vcengine import audio, server


class AudioLifecycleTests(unittest.TestCase):
    def test_partial_stream_open_failure_closes_input(self):
        engine = audio.AudioEngine(Mock())
        engine.devices.update(input=0, output=1)
        stream = Mock()
        with patch.object(audio.sd, 'query_devices', return_value={
                'max_input_channels': 1, 'max_output_channels': 2}), \
                patch.object(audio, '_extra', return_value=None), \
                patch.object(audio.sd, 'InputStream', return_value=stream), \
                patch.object(audio.sd, 'OutputStream', side_effect=RuntimeError('unplugged')):
            with self.assertRaisesRegex(RuntimeError, 'unplugged'):
                engine._open_streams()
        stream.abort.assert_called_once()
        stream.close.assert_called_once()
        self.assertEqual(engine.streams, [])

    def test_stop_serializes_with_device_open(self):
        engine = audio.AudioEngine(Mock())
        entered, finish_open, closing, closed = [threading.Event() for _ in range(4)]
        stream = Mock()
        def open_devices():
            entered.set()
            if not finish_open.wait(2):
                raise RuntimeError("test synchronization timed out")
            engine.streams.append(stream)
        def close_devices():
            engine.stop_evt.set()
            closing.set()
            engine._close_streams()
            closed.set()
        with patch.object(engine, '_open_streams_unlocked', side_effect=open_devices):
            opener = threading.Thread(target=engine._open_streams)
            closer = threading.Thread(target=close_devices)
            opener.start()
            self.assertTrue(entered.wait(2))
            closer.start()
            self.assertTrue(closing.wait(2))
            self.assertFalse(closed.is_set())
            finish_open.set()
            opener.join(2)
            closer.join(2)
        self.assertTrue(closed.is_set())
        stream.close.assert_called_once()
        self.assertEqual(engine.streams, [])

    def test_cancelled_warmup_never_opens_devices(self):
        engine = audio.AudioEngine(Mock())
        def build():
            engine.stop_evt.set()
            return Mock(device='cpu')
        with patch.object(engine, '_build_vc', side_effect=build), \
                patch.object(engine, '_open_streams') as open_streams, \
                patch.object(engine, '_release_vc'):
            engine._run()
        open_streams.assert_not_called()

    def test_restart_rejected_while_previous_worker_exits(self):
        engine = audio.AudioEngine(Mock())
        engine.worker = Mock()
        engine.worker.is_alive.return_value = True
        engine.stop_evt.set()
        with self.assertRaisesRegex(RuntimeError, 'завершается'):
            engine.start()

    def test_clearing_fifo_requires_jitter_priming_again(self):
        fifo = audio._Fifo(cap=100, prime=10)
        fifo.push(np.ones(20, dtype=np.float32))
        fifo.pull(1)
        fifo.clear()
        fifo.push(np.ones(2, dtype=np.float32))
        np.testing.assert_array_equal(fifo.pull(2), [0, 0])


class SettingsRecoveryTests(unittest.TestCase):
    def restore(self, data):
        devices = {'inputs': [{'id': 0, 'name': 'mic'}],
                   'outputs': [{'id': 0, 'name': 'speaker'}],
                   'defaultInput': 9, 'defaultOutput': 8, 'virtualCable': 7}
        engine = audio.AudioEngine(Mock(list_voices=lambda: []))
        settings = Mock()
        settings.exists.return_value = True
        settings.read_text.return_value = json.dumps(data)
        with patch.object(server, 'engine', engine), \
                patch.object(server, 'SETTINGS_FILE', settings), \
                patch.object(server.audio_mod, 'list_devices', return_value=devices):
            server.load_settings()
        return engine

    def test_device_zero_restored(self):
        engine = self.restore({'devices': {'input': 'mic', 'output': 'speaker', 'monitor': 'speaker'}})
        self.assertEqual(engine.devices, {'input': 0, 'output': 0, 'monitor': 0})

    def test_valid_timbre_roundtrip_does_not_depend_on_key_order(self):
        from itertools import permutations
        original = {'index_rate': 0.8, 'protect': 0.25, 'clarity_mode': False}
        for order in permutations(original):
            with self.subTest(order=order):
                params = {key: original[key] for key in order}
                params['pitch'] = 'damaged'
                restored = self.restore({'params': params})
                for key, value in original.items():
                    self.assertEqual(restored.params[key], value)
                # A second restore of the resulting settings is stable as well.
                roundtrip = self.restore({'params': dict(restored.params)})
                self.assertEqual(roundtrip.params, restored.params)

    def test_corrupt_settings_ignored(self):
        for data in [[], {'params': [], 'devices': [], 'preset': [], 'voiceId': []},
                     {'params': {'pitch': 'bad', 'input_gain': -1}, 'compute': 'unsupported'}]:
            with self.subTest(data=data):
                engine = self.restore(data)
                self.assertEqual(engine.params['pitch'], 0)
                self.assertEqual(engine.params['input_gain'], 1)
                self.assertEqual(engine.compute, 'auto')
