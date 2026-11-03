"""Long-running stability test against a live engine (HTTP API).

Usage: python -m tests.soak --port 47800 --token devtoken --minutes 10 --voice rick-sanchez
Runs the real audio pipeline with the noise gate fully open (every block goes
through the network) and output gain 0, sampling memory, latency and dropouts.
"""

import argparse
import json
import time
import urllib.request


def call(base, token, path, body=None):
    req = urllib.request.Request(
        base + path,
        data=None if body is None else json.dumps(body).encode(),
        method="GET" if body is None else "POST",
        headers={"X-Vocalis-Token": token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=47800)
    ap.add_argument("--token", default="devtoken")
    ap.add_argument("--minutes", type=float, default=10)
    ap.add_argument("--voice", default="rick-sanchez")
    ap.add_argument("--preset", default="balanced")
    ap.add_argument("--interval", type=float, default=30)
    a = ap.parse_args()
    base = f"http://127.0.0.1:{a.port}"
    c = lambda p, b=None: call(base, a.token, p, b)  # noqa: E731

    c("/engine/stop", {})
    c("/engine/voice", {"id": a.voice})
    c("/engine/preset", {"name": a.preset})
    saved = c("/status")["engine"]["params"]
    c("/engine/params", {"noise_gate_db": -120, "output_gain": 0.0, "monitor": False, "bypass": False, "ptt": False})
    c("/engine/start", {})
    t0 = time.time()
    while c("/status")["engine"]["state"] == "loading":
        time.sleep(0.5)
    print(f"loaded in {time.time() - t0:.1f}s", flush=True)
    rows = []
    try:
        end = time.time() + a.minutes * 60
        while time.time() < end:
            time.sleep(a.interval)
            st = c("/status")
            e, s, sy = st["engine"], st["engine"]["stats"], st["system"]
            g = sy.get("gpu") or {}
            row = {
                "t": round(time.time() - t0),
                "state": e["state"],
                "inferAvg": round(s["inferMsAvg"], 1),
                "rtf": round(s["realtimeFactor"], 2),
                "latency": round(s["totalLatencyMs"]),
                "buf": round(s["bufferMs"]),
                "drops": s["inputDrops"],
                "under": s["outputUnderruns"],
                "ramMb": round(sy["processRamMb"]),
                "vramMb": round(g.get("memUsedMb", 0)),
                "gpu": g.get("util"),
                "cpu": sy["cpu"],
            }
            rows.append(row)
            print(json.dumps(row), flush=True)
            if e["state"] != "running":
                print("ENGINE LEFT RUNNING STATE:", e["error"], flush=True)
                break
    finally:
        c("/engine/stop", {})
        c("/engine/params", {k: saved[k] for k in ("noise_gate_db", "output_gain")})
    if len(rows) >= 2:
        first, last = rows[0], rows[-1]
        print(
            f"SUMMARY ram {first['ramMb']}->{last['ramMb']}MB, vram {first['vramMb']}->{last['vramMb']}MB, "
            f"latency {first['latency']}->{last['latency']}ms, drops {last['drops']}, underruns {last['under']}",
            flush=True,
        )


if __name__ == "__main__":
    main()
