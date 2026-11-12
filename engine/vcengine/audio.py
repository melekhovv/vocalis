"""Real-time audio routing: microphone -> RVC -> virtual cable (+ optional monitor).

Threading model
- PortAudio input callback: copies the mono block into ``in_q`` (bounded; the
  oldest block is dropped when inference falls behind, so latency can't grow).
- Worker thread: runs filtering/gating and the RVC VoiceChanger on each block,
  then appends samples to the output FIFOs.
- PortAudio output callbacks: drain the FIFOs; an underrun outputs silence.
  FIFOs are capped, excess audio is discarded instead of accumulating delay.
"""

import ctypes
import math
import queue
import sys
import threading
import time
from collections import deque

import numpy as np
import sounddevice as sd
from scipy.signal import butter, sosfilt, sosfilt_zi

SR = 48000
JITTER_S = 0.05  # output jitter buffer

PRESETS = {
    # block_frame must be a multiple of 480 samples (10 ms @ 48 kHz).
    "performance": {"block_frame": 5760, "crossfade": 0.05, "extra": 0.5, "f0_method": "fcpe"},
    "balanced": {"block_frame": 9600, "crossfade": 0.08, "extra": 1.0, "f0_method": "rmvpe"},
    "quality": {"block_frame": 14400, "crossfade": 0.10, "extra": 2.0, "f0_method": "rmvpe"},
}

DEFAULT_PARAMS = {
    "clarity_mode": False,    # optional speech-first settings; preserve existing timbre by default
    "pitch": 0,               # semitones (f0_up_key)
    "index_rate": 0.5,
    "protect": 0.33,
    "f0_method": "rmvpe",
    "noise_gate_db": -50.0,   # blocks quieter than this are muted
    "noise_filter": True,     # 80 Hz high-pass on the input
    "vad": False,             # WebRTC voice activity detection gate
    "input_gain": 1.0,
    "output_gain": 1.0,
    "monitor_gain": 0.8,
    "monitor": False,
    "bypass": False,          # pass the original voice through, streams keep running
    "ptt": False,
    "ptt_vk": 0x14,           # CapsLock by default; any Win32 virtual-key code
    "volume_envelope": 1.0,
}


def _rms_db(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    r = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return 20 * np.log10(r) if r > 1e-7 else -120.0


def _key_down(vk: int) -> bool:
    if sys.platform != "win32":
        return True
    return bool(ctypes.windll.user32.GetAsyncKeyState(int(vk)) & 0x8000)


# --------------------------------------------------------------------- devices
def _fix_name(name: str) -> str:
    """PortAudio may hand back UTF-8 bytes decoded as the ANSI codepage (mojibake)."""
    for cp in ("cp1251", "cp1252"):
        try:
            fixed = name.encode(cp).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
        if fixed != name:
            return fixed
    return name


def _hostapi_names():
    try:
        return [h["name"] for h in sd.query_hostapis()]
    except Exception:
        return []


def list_devices(refresh=False):
    if refresh:
        # PortAudio caches the device list; re-init to pick up hot-plugged devices.
        sd._terminate()
        sd._initialize()
    apis = _hostapi_names()
    preferred = "Windows WASAPI" if "Windows WASAPI" in apis else (apis[0] if apis else None)
    inputs, outputs = [], []
    try:
        devices = sd.query_devices()
    except Exception:
        devices = []
    for d in devices:
        api = apis[d["hostapi"]] if d["hostapi"] < len(apis) else "?"
        if api != preferred:
            continue
        name = _fix_name(d["name"])
        is_cable = "cable" in name.lower() and ("vb-audio" in name.lower() or "cable input" in name.lower() or "cable output" in name.lower())
        entry = {
            "id": d["index"],
            "name": name,
            "hostApi": api,
            "defaultSampleRate": d["default_samplerate"],
            "isVirtualCable": is_cable,
        }
        if d["max_input_channels"] > 0:
            inputs.append({**entry, "channels": d["max_input_channels"]})
        if d["max_output_channels"] > 0:
            outputs.append({**entry, "channels": d["max_output_channels"]})
    def_in = _default_for(apis, preferred, "input")
    def_out = _default_for(apis, preferred, "output")
    return {
        "hostApi": preferred,
        "inputs": inputs,
        "outputs": outputs,
        "defaultInput": def_in,
        "defaultOutput": def_out,
        "virtualCable": next((o["id"] for o in outputs if o["isVirtualCable"] and "input" in o["name"].lower()), None),
    }


def _default_for(apis, api_name, kind):
    try:
        idx = apis.index(api_name)
        info = sd.query_hostapis(idx)
        dev = info["default_input_device" if kind == "input" else "default_output_device"]
        return dev if dev >= 0 else None
    except Exception:
        return None


def _com_init():
    """WASAPI streams fail to start from threads without COM ("Unanticipated host error")."""
    if sys.platform == "win32":
        ctypes.windll.ole32.CoInitializeEx(None, 0)  # S_FALSE if already initialised: fine


def _extra(device_id):
    _com_init()
    try:
        api = _hostapi_names()[sd.query_devices(device_id)["hostapi"]]
    except Exception:
        return None
    if "WASAPI" in api:
        return sd.WasapiSettings(exclusive=False, auto_convert=True)
    return None


def test_output(device_id, seconds=0.6):
    """Play a short 440 Hz tone; raises if the device can't be opened."""
    t = np.arange(int(SR * seconds)) / SR
    tone = (0.2 * np.sin(2 * np.pi * 440 * t) * np.hanning(t.size)).astype(np.float32)
    ch = min(2, sd.query_devices(device_id)["max_output_channels"])
    sd.play(np.repeat(tone[:, None], ch, axis=1), SR, device=device_id, extra_settings=_extra(device_id), blocking=True)


def test_input(device_id, seconds=1.0):
    ch = min(2, sd.query_devices(device_id)["max_input_channels"])
    rec = sd.rec(int(SR * seconds), SR, channels=ch, dtype="float32", device=device_id, extra_settings=_extra(device_id), blocking=True)
    mono = rec.mean(axis=1)
    return {"rmsDb": _rms_db(mono), "peakDb": 20 * np.log10(max(float(np.abs(mono).max()), 1e-7))}


def record(device_id, seconds):
    ch = min(2, sd.query_devices(device_id)["max_input_channels"])
    rec = sd.rec(int(SR * seconds), SR, channels=ch, dtype="float32", device=device_id, extra_settings=_extra(device_id), blocking=True)
    return rec.mean(axis=1).astype(np.float32)


# --------------------------------------------------------------------- engine
class _Fifo:
    """Thread-safe sample FIFO with a hard cap (drops oldest samples)."""

    def __init__(self, cap, prime):
        self.cap = cap
        # Jitter buffer: after running dry, wait until `prime` samples are queued
        # so inference-time jitter doesn't turn into a click on every block.
        self.prime = prime
        self.primed = False
        self.buf = deque()
        self.size = 0
        self.lock = threading.Lock()
        self.underruns = 0
        self.dropped = 0

    def push(self, x: np.ndarray):
        with self.lock:
            self.buf.append(x)
            self.size += x.size
            while self.size > self.cap and self.buf:
                old = self.buf.popleft()
                self.size -= old.size
                self.dropped += 1

    def pull(self, n) -> np.ndarray:
        out = np.zeros(n, dtype=np.float32)
        with self.lock:
            if not self.primed:
                if self.size < self.prime:
                    return out
                self.primed = True
            if self.size == 0:
                self.underruns += 1
                self.primed = False
                return out
            filled = 0
            while filled < n and self.buf:
                head = self.buf[0]
                take = min(n - filled, head.size)
                out[filled:filled + take] = head[:take]
                filled += take
                if take == head.size:
                    self.buf.popleft()
                else:
                    self.buf[0] = head[take:]
                self.size -= take
        return out

    def clear(self):
        with self.lock:
            self.buf.clear()
            self.size = 0
            self.primed = False


class AudioEngine:
    def __init__(self, models, on_state=None):
        self.models = models
        self.on_state = on_state or (lambda: None)
        self.params = dict(DEFAULT_PARAMS)
        self.preset = "balanced"
        self.state = "stopped"  # stopped | loading | running | error
        self.error = None
        self.voice_id = None
        self.pending_voice = None
        self.voice_profiles: dict[str, dict] = {}
        self.devices = {"input": None, "output": None, "monitor": None}
        self.vc = None
        self.streams = []
        self._streams_lock = threading.RLock()
        self.in_q = queue.Queue(maxsize=3)
        self.out_fifo = None
        self.mon_fifo = None
        self.worker = None
        self.stop_evt = threading.Event()
        self.lock = threading.Lock()
        self.stats = self._empty_stats()
        self.hp_sos = butter(2, 80, btype="highpass", fs=SR, output="sos")
        self.hp_zi = None
        self.device_name = None
        self.compute = "auto"  # auto (CUDA if available) | cpu

    def _empty_stats(self):
        return {
            "inputDb": -120.0, "outputDb": -120.0, "inferMs": 0.0, "inferMsAvg": 0.0,
            "blockMs": 0.0, "streamLatencyMs": 0.0, "bufferMs": 0.0, "totalLatencyMs": 0.0,
            "inputDrops": 0, "outputUnderruns": 0, "gated": False, "pttHeld": True,
            "device": None, "realtimeFactor": 0.0,
        }

    # ------------------------------------------------------------ control
    @staticmethod
    def validate_params(changes: dict):
        # Validation has no side effects, including when recovering settings.
        limits = {"pitch": (-24, 24), "index_rate": (0, 1), "protect": (0, .5),
                  "noise_gate_db": (-120, 0), "input_gain": (0, 3), "output_gain": (0, 3),
                  "monitor_gain": (0, 2), "volume_envelope": (0, 1), "ptt_vk": (1, 254)}
        for key, value in changes.items():
            if key not in DEFAULT_PARAMS:
                raise ValueError(f"Неизвестный параметр: {key}")
            kind = type(DEFAULT_PARAMS[key])
            if kind is bool and not isinstance(value, bool):
                raise ValueError(f"{key}: ожидается true/false")
            if kind in (int, float):
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise ValueError(f"{key}: ожидается конечное число")
                if kind is int and int(value) != value:
                    raise ValueError(f"{key}: ожидается целое число")
                if key in limits and not limits[key][0] <= value <= limits[key][1]:
                    raise ValueError(f"{key}: значение вне диапазона")
            if key == "f0_method" and value not in ("rmvpe", "fcpe", "crepe"):
                raise ValueError("Неподдерживаемый метод F0")
    def update_params(self, changes: dict):
        self.validate_params(changes)
        if changes.get("clarity_mode") is False:
            voice = next((v for v in self.models.list_voices() if v["id"] == self.voice_id), {})
            profile = voice.get("recommendedParams") or {}
            # Turning the speech preset off restores the selected voice's timbre profile.
            changes = {"index_rate": profile.get("index_rate", DEFAULT_PARAMS["index_rate"]),
                       "protect": profile.get("protect", DEFAULT_PARAMS["protect"]), **changes}
        with self.lock:
            for k, v in changes.items():
                if k not in self.params:
                    continue
                kind = type(DEFAULT_PARAMS[k])
                if kind is bool and not isinstance(v, bool):
                    raise ValueError(f"{k}: ожидается true/false")
                if kind in (int, float) and (isinstance(v, bool) or not isinstance(v, (int, float))):
                    raise ValueError(f"{k}: ожидается число")
                self.params[k] = kind(v)
            if self.voice_id:
                vp = self.voice_profiles.setdefault(self.voice_id, {})
                for k in ("pitch", "index_rate", "protect", "f0_method", "volume_envelope"):
                    if k in changes and not (self.params["clarity_mode"] and k in ("index_rate", "protect")):
                        vp[k] = self.params[k]
            if self.params["clarity_mode"]:
                self.params["index_rate"] = min(self.params["index_rate"], 0.4)
                self.params["protect"] = min(self.params["protect"], 0.1)
        if self.vc is not None and "noise_gate_db" in changes:
            self.vc.vc_model.input_sensitivity = 10 ** (self.params["noise_gate_db"] / 20)
        if self.vc is not None and "f0_method" in changes:
            self._pending_cfg({"f0_method": self.params["f0_method"]})
        if self.vc is not None and "vad" in changes:
            self._pending_cfg({"vad_enabled": self.params["vad"], "vad_sensitivity": 3})
        if "monitor" in changes and self.state == "running":
            # Monitor stream is opened lazily; reopen streams to add/remove it.
            self._restart_streams()
        self.on_state()

    def _pending_cfg(self, cfg):
        with self.lock:
            self._cfg_queue = getattr(self, "_cfg_queue", [])
            self._cfg_queue.append(cfg)

    def set_preset(self, name):
        if name not in PRESETS:
            raise ValueError("Неизвестный режим")
        self.preset = name
        self.params["f0_method"] = PRESETS[name]["f0_method"]
        if self.state in ("running", "loading"):
            self.restart()
        self.on_state()

    def set_devices(self, input_id=None, output_id=None, monitor_id=None):
        changed = False
        for k, v in (("input", input_id), ("output", output_id), ("monitor", monitor_id)):
            if v is not None and self.devices[k] != v:
                self.devices[k] = v
                changed = True
        if changed and self.state == "running":
            self._restart_streams()
        self.on_state()

    def _voice_defaults(self, voice_id, index):
        voice = next((v for v in self.models.list_voices() if v["id"] == voice_id), {})
        profile = voice.get("recommendedParams") or {}
        defaults = {
            "pitch": voice.get("suggestedPitch", 0),
            "index_rate": profile.get("index_rate", DEFAULT_PARAMS["index_rate"] if index else 0.0),
            "protect": profile.get("protect", DEFAULT_PARAMS["protect"]),
            "f0_method": profile.get("f0_method", PRESETS[self.preset]["f0_method"]),
            "volume_envelope": profile.get("volume_envelope", DEFAULT_PARAMS["volume_envelope"]),
        }
        return defaults

    def select_voice(self, voice_id):
        """Select a validated model and its own timbre settings for UI and hotkeys."""
        pth, index = self.models.voice_paths(voice_id)
        defaults = self._voice_defaults(voice_id, index)
        saved = self.voice_profiles.get(voice_id)
        if isinstance(saved, dict):
            for k in ("pitch", "index_rate", "protect", "f0_method", "volume_envelope"):
                if k in saved:
                    defaults[k] = saved[k]
        if not index:
            defaults["index_rate"] = 0.0
        with self.lock:
            self.voice_id = voice_id
            self.params.update(defaults)
            if self.params["clarity_mode"]:
                self.params["index_rate"] = min(self.params["index_rate"], 0.4)
                self.params["protect"] = min(self.params["protect"], 0.1)
            if self.vc is not None and self.state == "running":
                self._cfg_queue = getattr(self, "_cfg_queue", [])
                self._cfg_queue.append({
                    "model_path": pth, "index_path": index or "",
                    "f0_method": self.params["f0_method"], "index_rate": self.params["index_rate"],
                })
        self.on_state()

    def reset_voice_profile(self, voice_id=None):
        vid = voice_id or self.voice_id
        if not vid:
            return
        self.voice_profiles.pop(vid, None)
        if vid == self.voice_id:
            self.select_voice(vid)
        else:
            self.on_state()

    def start(self):
        if self.worker is not None and self.worker.is_alive() and self.stop_evt.is_set():
            raise RuntimeError("Предыдущая обработка ещё завершается. Повторите запуск через несколько секунд.")
        if self.state in ("running", "loading"):
            return
        if not self.voice_id:
            raise RuntimeError("Сначала выберите голос")
        if self.devices["input"] is None or self.devices["output"] is None:
            raise RuntimeError("Выберите микрофон и устройство вывода")
        self.models.voice_paths(self.voice_id)
        if not self.models.base_assets_status()["ready"]:
            raise RuntimeError("Базовые модели (ContentVec, RMVPE) ещё не загружены")
        self.state = "loading"
        self.error = None
        self.stop_evt.clear()
        self.on_state()
        self.worker = threading.Thread(target=self._run, daemon=True, name="vc-worker")
        self.worker.start()

    def stop(self):
        self.stop_evt.set()
        self._close_streams()
        w = self.worker
        if w and w.is_alive() and w is not threading.current_thread():
            w.join(timeout=5)
        # Never release a model while the worker is still warming it up or
        # using it. The worker performs deferred cleanup before it exits.
        if not w or not w.is_alive():
            self.worker = None
            self._release_vc()
        with self.lock:
            self._cfg_queue = []
        self.state = "stopped"
        self.stats = self._empty_stats()
        self.on_state()

    def restart(self):
        self.stop()
        self.start()

    # ------------------------------------------------------------ internals
    def _build_vc(self):
        from rvc.realtime.core import VoiceChanger

        p = PRESETS[self.preset]
        pth, index = self.models.voice_paths(self.voice_id)
        vc = VoiceChanger(
            block_frame=p["block_frame"],
            cross_fade_overlap_size=p["crossfade"],
            extra_convert_size=p["extra"],
            model_path=pth,
            index_path=index or "",
            f0_method=self.params["f0_method"],
            embedder_model="contentvec",
            silent_threshold=int(self.params["noise_gate_db"]),
            vad_enabled=self.params["vad"],
            vad_sensitivity=3,
            device="cpu" if self.compute == "cpu" else None,
        )
        # Warm up kernels so the first spoken block doesn't stall.
        vc.warmup(index_rate=self.params["index_rate"])
        return vc

    def _open_streams(self):
        with self._streams_lock:
            if self.stop_evt.is_set():
                return
            self._open_streams_unlocked()

    def _open_streams_unlocked(self):
        p = PRESETS[self.preset]
        block = p["block_frame"]
        prime = int(JITTER_S * SR)
        self.out_fifo = _Fifo(cap=block * 2, prime=prime)
        self.mon_fifo = _Fifo(cap=block * 2, prime=prime)
        self.hp_zi = sosfilt_zi(self.hp_sos) * 0.0
        while not self.in_q.empty():
            try:
                self.in_q.get_nowait()
            except queue.Empty:
                break

        in_dev, out_dev, mon_dev = self.devices["input"], self.devices["output"], self.devices["monitor"]
        in_ch = min(2, sd.query_devices(in_dev)["max_input_channels"])
        out_ch = min(2, sd.query_devices(out_dev)["max_output_channels"])
        drops = {"n": 0}
        # The device runs with a small hardware buffer (10 ms); blocks for the
        # model are assembled here. A large PortAudio blocksize would make
        # WASAPI allocate ~2 blocks of driver latency on top of ours.
        acc = np.zeros(block, dtype=np.float32)
        fill = {"n": 0}

        def emit(blk):
            try:
                self.in_q.put_nowait(blk)
            except queue.Full:
                try:
                    self.in_q.get_nowait()
                except queue.Empty:
                    pass
                drops["n"] += 1
                self.stats["inputDrops"] = drops["n"]
                try:
                    self.in_q.put_nowait(blk)
                except queue.Full:
                    pass

        def in_cb(indata, frames, t, status):
            mono = indata.mean(axis=1) if indata.shape[1] > 1 else indata[:, 0]
            pos = 0
            while pos < frames:
                take = min(block - fill["n"], frames - pos)
                acc[fill["n"]:fill["n"] + take] = mono[pos:pos + take]
                fill["n"] += take
                pos += take
                if fill["n"] == block:
                    emit(acc.copy())
                    fill["n"] = 0

        def make_out_cb(fifo, gain_key):
            def cb(outdata, frames, t, status):
                x = fifo.pull(frames) * self.params[gain_key]
                np.clip(x, -1.0, 1.0, out=x)
                outdata[:] = x[:, None]
            return cb

        # Register each stream immediately: constructing or starting a later
        # device can fail, and all previously opened handles must be closed.
        streams = []
        self.streams = streams
        try:
            streams.append(sd.InputStream(
                device=in_dev, samplerate=SR, blocksize=480, channels=in_ch, dtype="float32",
                latency="low", callback=in_cb, extra_settings=_extra(in_dev)))
            streams.append(sd.OutputStream(
                device=out_dev, samplerate=SR, blocksize=0, channels=out_ch, dtype="float32",
                latency="low", callback=make_out_cb(self.out_fifo, "output_gain"), extra_settings=_extra(out_dev)))
            if self.params["monitor"] and mon_dev is not None:
                mon_ch = min(2, sd.query_devices(mon_dev)["max_output_channels"])
                streams.append(sd.OutputStream(
                    device=mon_dev, samplerate=SR, blocksize=0, channels=mon_ch, dtype="float32",
                    latency="low", callback=make_out_cb(self.mon_fifo, "monitor_gain"),
                    extra_settings=_extra(mon_dev)))
            for stream in streams:
                stream.start()
        except Exception:
            self._close_streams()
            raise
        lat = streams[0].latency + streams[1].latency
        self.stats["streamLatencyMs"] = lat * 1000
        self.stats["blockMs"] = block / SR * 1000

    def _close_streams(self):
        with self._streams_lock:
            self._close_streams_unlocked()

    def _close_streams_unlocked(self):
        streams, self.streams = self.streams, []
        for s in streams:
            try:
                s.abort()
            except Exception:
                pass
            try:
                s.close()
            except Exception:
                pass

    def _restart_streams(self):
        self._close_streams()
        try:
            self._open_streams()
        except Exception as e:
            self._fail(f"Не удалось открыть аудиоустройство: {e}")

    def _fail(self, msg):
        self.error = msg
        self.state = "error"
        self.stop_evt.set()
        self._close_streams()
        if not self.worker or not self.worker.is_alive() or self.worker is threading.current_thread():
            self._release_vc()
        self.on_state()

    def _release_vc(self):
        self.vc = None
        try:
            import gc

            import torch

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def _apply_cfg_queue(self):
        with self.lock:
            q = getattr(self, "_cfg_queue", [])
            self._cfg_queue = []
        if not q:
            return
        from rvc.realtime.worker import _apply_config

        for cfg in q:
            _apply_config(self.vc, cfg)
        self.on_state()

    def _run(self):
        try:
            self._process()
        finally:
            if self.stop_evt.is_set():
                self._close_streams()
                self._release_vc()

    def _process(self):
        try:
            self.vc = self._build_vc()
            self.device_name = str(self.vc.device)
            self.stats["device"] = self.device_name
        except Exception as e:
            self.vc = None
            self._fail(f"Не удалось загрузить модель: {e}")
            return
        if self.stop_evt.is_set():
            return
        try:
            self._open_streams()
        except Exception as e:
            self._fail(f"Не удалось открыть аудиоустройство: {e}")
            return
        if self.stop_evt.is_set():
            return
        self.state = "running"
        self.on_state()
        infer_hist = deque(maxlen=50)
        block_s = PRESETS[self.preset]["block_frame"] / SR

        while not self.stop_evt.is_set():
            try:
                block = self.in_q.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                self._apply_cfg_queue()
                p = self.params
                x = block * p["input_gain"]
                if p["noise_filter"]:
                    x, self.hp_zi = sosfilt(self.hp_sos, x, zi=self.hp_zi)
                    x = x.astype(np.float32)
                in_db = _rms_db(x)
                held = (not p["ptt"]) or _key_down(p["ptt_vk"])
                gated = in_db < p["noise_gate_db"]
                t0 = time.perf_counter()
                if not held:
                    y = np.zeros_like(x)
                elif p["bypass"]:
                    y = np.zeros_like(x) if gated else x
                else:
                    y, _vol, _perf = self.vc.on_request(
                        x,
                        f0_up_key=p["pitch"],
                        index_rate=p["index_rate"],
                        protect=p["protect"],
                        volume_envelope=p["volume_envelope"],
                    )
                    y = np.asarray(y, dtype=np.float32)
                infer_ms = (time.perf_counter() - t0) * 1000
                infer_hist.append(infer_ms)
                self.out_fifo.push(y)
                if p["monitor"]:
                    self.mon_fifo.push(y)
                st = self.stats
                st["inputDb"] = in_db
                st["outputDb"] = _rms_db(y * p["output_gain"])
                st["inferMs"] = infer_ms
                st["inferMsAvg"] = float(np.mean(infer_hist))
                st["realtimeFactor"] = st["inferMsAvg"] / (block_s * 1000)
                st["bufferMs"] = self.out_fifo.size / SR * 1000
                st["outputUnderruns"] = self.out_fifo.underruns
                st["gated"] = bool(gated)
                st["pttHeld"] = bool(held)
                # Estimate: one block of capture + inference + jitter buffer + device buffers.
                st["totalLatencyMs"] = st["blockMs"] + st["inferMsAvg"] + JITTER_S * 1000 + st["streamLatencyMs"]
            except Exception as e:
                import traceback

                traceback.print_exc()
                self._fail(f"Ошибка обработки: {e}")
                return

    # ------------------------------------------------------------ status
    def status(self):
        return {
            "state": self.state,
            "error": self.error,
            "voiceId": self.voice_id,
            "preset": self.preset,
            "params": self.params,
            "devices": self.devices,
            "compute": self.compute,
            "stats": self.stats,
            "hasCustomProfile": bool(self.voice_id and self.voice_id in self.voice_profiles),
        }


# --------------------------------------------------------------------- offline preview
def convert_clip(models, voice_id, audio: np.ndarray, params: dict, preset="quality", compute="auto"):
    """Full-utterance inference: previews have no real-time latency budget."""
    import tempfile
    import soundfile as sf
    import soxr
    import torch
    from pathlib import Path
    from rvc.infer.infer import VoiceConverter
    from rvc.configs.config import inference_config

    pth, index = models.voice_paths(voice_id)
    from copy import copy
    config = copy(inference_config())
    if compute == "cpu":
        config.device = "cpu"
    f0 = params.get("f0_method")
    if f0 not in ("rmvpe", "fcpe", "crepe"):
        f0 = "rmvpe"
    vc = VoiceConverter(config=config)
    try:
        with tempfile.TemporaryDirectory(prefix="vocalis-preview-") as tmp:
            source, target = Path(tmp) / "input.wav", Path(tmp) / "output.wav"
            sf.write(source, audio, SR, subtype="FLOAT")
            vc.convert_audio(
                str(source), str(target), pth, index or "",
                pitch=int(params.get("pitch", 0)), f0_method=f0,
                index_rate=float(params.get("index_rate", 0.75)) if index else 0.0,
                protect=float(params.get("protect", 0.33)),
                volume_envelope=float(params.get("volume_envelope", 1.0)),
                inference_engine="torch",
            )
            out, sr = sf.read(target, dtype="float32")
            if sr != SR:
                out = soxr.resample(out, sr, SR)
            if not np.isfinite(out).all() or _rms_db(out) < -65:
                raise RuntimeError("Модель выдала тишину. Попробуйте другой голос или запишите отчётливую речь.")
            return np.asarray(out, dtype=np.float32)
    finally:
        del vc
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
