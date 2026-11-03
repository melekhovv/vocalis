"""Conservative RVC starting profiles and offline signal diagnostics.

These are supported parameter choices, not an assertion that a particular voice
has passed listening tests. Never infer a pitch shift from a name or gender.
"""
import math

import numpy as np


QUALITY_PRESETS = {"Balanced": "balanced", "HighQuality": "quality", "LowLatency": "performance"}
REALTIME_PRESETS = {
    "performance": {"block_frame": 5760, "crossfade": .05, "extra": .5, "f0_method": "fcpe"},
    "balanced": {"block_frame": 9600, "crossfade": .08, "extra": 1., "f0_method": "rmvpe"},
    "quality": {"block_frame": 14400, "crossfade": .10, "extra": 2., "f0_method": "rmvpe"},
}


def normalize_preset(name):
    if not isinstance(name, str):
        raise ValueError("Неизвестный режим качества")
    if name in REALTIME_PRESETS:
        return name
    if name in QUALITY_PRESETS:
        return QUALITY_PRESETS[name]
    raise ValueError("Неизвестный режим качества")


def model_applicability(checkpoint, has_index):
    # Only inspected metadata can establish absence of F0. Missing metadata in
    # older manifests remains compatible with the previously supported controls.
    f0 = not (isinstance(checkpoint, dict) and checkpoint.get("f0") is False)
    return {"pitch": f0, "f0": f0, "index": bool(has_index), "protect": f0}


def constrain_profile(params, applicability):
    result = dict(params)
    if not applicability["index"]:
        result["index_rate"] = 0.
    if not applicability["f0"]:
        result["pitch"] = 0
        result["protect"] = .5  # No unvoiced/F0 blend is performed by non-F0 RVC.
    return result


def apply_model_constraints(params, checkpoint, has_index):
    return constrain_profile(params, model_applicability(checkpoint, has_index))


def model_quality_defaults(checkpoint=None, has_index=False, preset="Balanced"):
    mode = normalize_preset(preset)
    return apply_model_constraints({"pitch": 0, "index_rate": .5,
                                    "protect": .33, "f0_method": REALTIME_PRESETS[mode]["f0_method"],
                                    "clarity_mode": False, "volume_envelope": 1.}, checkpoint, has_index)


def signal_metrics(samples, sample_rate=48000):
    """Offline diagnostics; never call from the PortAudio callback.

    maxStep reports adjacent-sample discontinuity, not a speech quality score.
    Silence is defined by RMS < -65 dBFS, matching the existing preview check.
    """
    if not isinstance(sample_rate, (int, float)) or isinstance(sample_rate, bool) or not math.isfinite(sample_rate) or sample_rate <= 0:
        raise ValueError("Некорректная частота дискретизации")
    x = np.asarray(samples, dtype=np.float64)
    if x.ndim != 1:
        raise ValueError("Ожидается одноканальный сигнал")
    finite = bool(np.isfinite(x).all())
    if not finite:
        return {"finite": False, "silent": False, "samples": int(x.size), "durationMs": x.size / sample_rate * 1000,
                "rmsDb": None, "peak": None, "clippedFraction": None, "maxStep": None}
    rms = float(np.sqrt(np.mean(x * x))) if x.size else 0.
    rms_db = 20 * math.log10(rms) if rms > 1e-12 else -240.
    return {"finite": True, "silent": rms_db < -65, "samples": int(x.size),
            "durationMs": x.size / sample_rate * 1000, "rmsDb": rms_db,
            "peak": float(np.max(np.abs(x))) if x.size else 0.,
            "clippedFraction": float(np.mean(np.abs(x) >= 1.)) if x.size else 0.,
            "maxStep": float(np.max(np.abs(np.diff(x)))) if x.size > 1 else 0.}
