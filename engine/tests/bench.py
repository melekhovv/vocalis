"""Measure per-block RVC inference time through the real-time pipeline.

Usage: python -m tests.bench [voice_id ...] [--preset balanced] [--pitch N]
Writes converted clips to tests/out/<voice>-<preset>.wav and prints timing
statistics. Real time is sustainable when p95 inference < block length.
"""

import argparse
import sys
import time
from pathlib import Path

from vcengine.paths import prepare_runtime

ROOT = Path(__file__).resolve().parent
prepare_runtime()

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import soxr  # noqa: E402

from vcengine.audio import PRESETS, SR  # noqa: E402
from vcengine.models import ModelManager  # noqa: E402


def load_clip(path):
    x, sr = sf.read(path, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    if sr != SR:
        x = soxr.resample(x, sr, SR)
    return x.astype(np.float32)


def bench(models, voice_id, clip, preset, pitch, device=None, index_rate=0.5):
    from rvc.realtime.core import VoiceChanger

    p = PRESETS[preset]
    pth, index = models.voice_paths(voice_id)
    t0 = time.perf_counter()
    vc = VoiceChanger(
        block_frame=p["block_frame"], cross_fade_overlap_size=p["crossfade"], extra_convert_size=p["extra"],
        model_path=pth, index_path=index or "", f0_method=p["f0_method"], embedder_model="contentvec",
        silent_threshold=-90, device=device,
    )
    vc.warmup(index_rate=index_rate)
    load_s = time.perf_counter() - t0
    block = p["block_frame"]
    n = int(np.ceil(clip.size / block)) * block
    padded = np.zeros(n + block, dtype=np.float32)
    padded[: clip.size] = clip
    times, out = [], []
    for i in range(0, padded.size, block):
        t = time.perf_counter()
        y, _, _ = vc.on_request(padded[i:i + block], f0_up_key=pitch, index_rate=index_rate, protect=0.33)
        times.append((time.perf_counter() - t) * 1000)
        out.append(np.asarray(y, dtype=np.float32))
    y = np.concatenate(out)
    outdir = ROOT / "out"
    outdir.mkdir(exist_ok=True)
    sf.write(outdir / f"{voice_id}-{preset}.wav", y, SR)
    t = np.array(times)
    block_ms = block / SR * 1000
    return {
        "voice": voice_id, "preset": preset, "device": str(vc.device), "loadS": round(load_s, 2),
        "blockMs": block_ms, "mean": round(float(t.mean()), 1), "p95": round(float(np.percentile(t, 95)), 1),
        "max": round(float(t.max()), 1), "rtf": round(float(np.percentile(t, 95)) / block_ms, 2),
        "outRms": round(float(np.sqrt(np.mean(y ** 2))), 4),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("voices", nargs="*")
    ap.add_argument("--preset", default="all")
    ap.add_argument("--pitch", type=int, default=None)
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--clip", default=str(ROOT / "data" / "speech.wav"))
    a = ap.parse_args()
    models = ModelManager()
    voices = a.voices or [v["id"] for v in models.list_voices() if v["status"] == "ready"]
    presets = list(PRESETS) if a.preset == "all" else [a.preset]
    clip = load_clip(a.clip)
    for vid in voices:
        sugg = next((v.get("suggestedPitch", 0) for v in models.list_voices() if v["id"] == vid), 0)
        for preset in presets:
            r = bench(models, vid, clip, preset, a.pitch if a.pitch is not None else sugg, "cpu" if a.cpu else None)
            print(r, flush=True)


if __name__ == "__main__":
    sys.exit(main())
