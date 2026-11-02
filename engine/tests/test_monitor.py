"""Monitor lifecycle regressions without opening hardware or loading a model.

Run from engine: python -m unittest discover -s tests -p test_monitor.py -v
"""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from vcengine.audio import AudioEngine, default_monitor_device


class FakeStream:
    def __init__(self, **kwargs):
        self.device = kwargs["device"]
        self.callback = kwargs["callback"]
        self.channels = kwargs["channels"]
        self.latency = 0.01
        self.started = False
        self.closed = False

    def start(self):
        if self.device == 3:
            raise RuntimeError("device disconnected")
        self.started = True

    def abort(self):
        self.started = False

    def close(self):
        self.closed = True


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.devices = {
            "outputs": [
                {"id": 0, "channels": 2, "isVirtualCable": False},
                {"id": 1, "channels": 2, "isVirtualCable": True},
                {"id": 2, "channels": 2, "isVirtualCable": False},
                {"id": 3, "channels": 2, "isVirtualCable": False},
            ],
            "defaultOutput": 1,
        }
        self.created = []

        def stream(**kwargs):
            result = FakeStream(**kwargs)
            self.created.append(result)
            return result

        for name, replacement in (
            ("list_devices", lambda: self.devices),
            ("_extra", lambda device: None),
            ("sd.query_devices", lambda device: {"max_input_channels": 1, "max_output_channels": 2}),
            ("sd.InputStream", stream),
            ("sd.OutputStream", stream),
        ):
            p = patch("vcengine.audio." + name, replacement)
            p.start()
            self.addCleanup(p.stop)
        self.engine = AudioEngine(None)
        self.engine.devices.update(input=4, output=1, monitor=0)
        self.engine._open_streams()
        self.engine.state = "running"
        self.addCleanup(self.engine._close_streams)

    def test_toggle_keeps_microphone_cable_model_and_output_buffer(self):
        main = list(self.engine.streams)
        model = self.engine.vc = object()
        fifo = self.engine.out_fifo
        fifo.push(np.ones(4800, dtype=np.float32))
        for _ in range(3):
            self.engine.update_params({"monitor": True})
            monitor = self.engine.monitor_stream
            self.assertIsNotNone(monitor)
            self.engine.update_params({"monitor": False})
            self.assertTrue(monitor.closed)
        self.assertEqual(self.engine.streams, main)
        self.assertTrue(all(s.started and not s.closed for s in main))
        self.assertIs(self.engine.vc, model)
        self.assertIs(self.engine.out_fifo, fifo)
        self.assertEqual(fifo.size, 4800)
        self.assertEqual(self.engine.state, "running")

    def test_repeated_enable_and_gain_do_not_reopen_monitor(self):
        self.engine.update_params({"monitor": True})
        monitor = self.engine.monitor_stream
        self.engine.update_params({"monitor": True, "monitor_gain": 0.25})
        self.assertIs(self.engine.monitor_stream, monitor)
        self.assertEqual(len(self.created), 3)

    def test_switch_changes_only_monitor_and_clears_old_audio(self):
        self.engine.update_params({"monitor": True})
        old = self.engine.monitor_stream
        self.engine.mon_fifo.push(np.ones(4800, dtype=np.float32))
        self.engine.set_devices(monitor_id=2)
        self.assertTrue(old.closed)
        self.assertEqual(self.engine.monitor_stream.device, 2)
        self.assertEqual(self.engine.mon_fifo.size, 0)
        self.assertFalse(self.engine.mon_fifo.primed)
        self.assertTrue(all(s.started for s in self.engine.streams))

    def test_failed_device_switch_keeps_old_monitor_and_live_output(self):
        self.engine.update_params({"monitor": True})
        old = self.engine.monitor_stream
        with self.assertRaisesRegex(RuntimeError, "device disconnected"):
            self.engine.set_devices(monitor_id=3)
        self.assertEqual(self.engine.devices["monitor"], 0)
        self.assertIs(self.engine.monitor_stream, old)
        self.assertTrue(old.started)
        self.assertTrue(self.created[-1].closed)
        self.assertTrue(all(s.started for s in self.engine.streams))
        self.assertEqual(self.engine.state, "running")

    def test_failed_enable_rolls_back_without_interrupting_conversion(self):
        self.engine.set_devices(monitor_id=3)
        with self.assertRaisesRegex(RuntimeError, "device disconnected"):
            self.engine.update_params({"monitor": True})
        self.assertFalse(self.engine.params["monitor"])
        self.assertIsNone(self.engine.monitor_stream)
        self.assertTrue(all(s.started for s in self.engine.streams))

    def test_virtual_or_missing_monitor_is_rejected(self):
        for device in (1, 99):
            self.engine.set_devices(monitor_id=device)
            with self.assertRaisesRegex(RuntimeError, "наушники"):
                self.engine.update_params({"monitor": True})
            self.assertFalse(self.engine.params["monitor"])

    def test_monitor_cannot_duplicate_the_main_output(self):
        self.engine.set_devices(output_id=0)
        with self.assertRaisesRegex(RuntimeError, "основной вывод"):
            self.engine.update_params({"monitor": True})
        self.assertFalse(self.engine.params["monitor"])

    def test_monitor_receives_converted_audio_with_independent_gain(self):
        self.engine._close_streams()
        self.engine.params.update(monitor=True, monitor_gain=0.25, output_gain=0.8, noise_filter=False)
        converted = np.full(9600, 0.5, dtype=np.float32)

        def convert(*args, **kwargs):
            self.engine.stop_evt.set()
            return converted, None, None

        model = SimpleNamespace(device="test", on_request=convert)
        original_open = self.engine._open_streams

        def open_with_input():
            original_open()
            self.engine.in_q.put(np.ones(9600, dtype=np.float32))

        with patch.object(self.engine, "_build_vc", return_value=model), patch.object(self.engine, "_open_streams", open_with_input):
            self.engine._run()
        cable = np.zeros((4800, 2), dtype=np.float32)
        headphones = np.zeros_like(cable)
        self.engine.streams[1].callback(cable, 4800, None, None)
        self.engine.monitor_stream.callback(headphones, 4800, None, None)
        np.testing.assert_allclose(cable, 0.4)
        np.testing.assert_allclose(headphones, 0.125)
        self.assertIs(self.engine.vc, model)

    def test_partial_stream_start_failure_closes_every_created_stream(self):
        self.engine._close_streams()
        self.engine.devices["output"] = 3
        with self.assertRaisesRegex(RuntimeError, "device disconnected"):
            self.engine._open_streams()
        self.assertTrue(all(s.closed for s in self.created))
        self.assertEqual(self.engine.streams, [])

    def test_default_monitor_skips_virtual_cable_and_preserves_zero(self):
        self.assertEqual(default_monitor_device(self.devices), 0)
        self.devices["defaultOutput"] = 2
        self.assertEqual(default_monitor_device(self.devices), 2)
        self.devices["outputs"] = [self.devices["outputs"][1]]
        self.assertIsNone(default_monitor_device(self.devices))


if __name__ == "__main__":
    unittest.main()
