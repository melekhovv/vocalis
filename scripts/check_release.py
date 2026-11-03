"""Check the Git staging area/source release without scanning local user data."""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
catalog = json.loads((ROOT / "catalog/voices.json").read_text(encoding="utf-8"))
for voice in catalog["voices"]:
    model = voice["model"]
    # Unified public-source catalogue, approved by the owner on 2026-11-03.
    # A declared licence is information, never a certification of source rights.
    assert isinstance(model.get("license"), str) and model["license"], "Missing declared/unknown licence information"
    assert re.fullmatch(r"[a-fA-F0-9]{40}", str(model.get("revision", ""))), "Missing immutable source revision"
    assert str(model.get("upstream", "")).startswith("https://"), "Missing source URL"
    assets = [model["archive"]] if isinstance(model.get("archive"), dict) else model.get("files", [])
    assert assets, "Missing model files"
    for asset in assets:
        assert isinstance(asset.get("size"), int) and not isinstance(asset["size"], bool) and asset["size"] > 0, "Missing file size"
        assert re.fullmatch(r"[a-fA-F0-9]{64}", str(asset.get("sha256", ""))), "Missing SHA-256"

if (ROOT / ".git").exists():
    paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode("utf-8").split("\0")
else:
    # A clean source export intentionally has no repository history. Inspect
    # every exported file instead of requiring the recipient to run git init.
    paths = [p.relative_to(ROOT).as_posix() for p in ROOT.rglob("*") if p.is_file()]
for relative in filter(None, paths):
    path = ROOT / relative
    assert not re.search(r"(^|/)(node_modules|\.venv|\.qa-venv|\.build-cache|\.build-tmp|\.build-tools|model-downloads|qa-[^/]*|research-[^/]*)(/|$)", relative), relative
    assert path.suffix.lower() not in {".pth", ".pt", ".onnx", ".bin", ".index", ".ckpt", ".safetensors", ".wav", ".mp3", ".flac", ".zip", ".7z", ".exe"}, relative
    assert path.stat().st_size < 10 * 1024 * 1024, f"Unexpected large source file: {relative}"
    if path.suffix.lower() in {".py", ".ts", ".tsx", ".json", ".md", ".ps1", ".yml", ".yaml", ".txt"}:
        content = path.read_text(encoding="utf-8-sig")
        assert not re.search(r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)", content), f"Possible secret in {relative}"
        assert not re.search(r"[A-Za-z]:[/\\]+Users[/\\]+", content), f"Personal absolute path in {relative}"
print(f"PASS: catalog policy; {len(list(filter(None, paths)))} tracked files contain no model/audio binaries, generated output or detected secrets")
