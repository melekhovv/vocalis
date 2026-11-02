"""Check the Git staging area/source release without scanning local user data."""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
catalog = json.loads((ROOT / "catalog/voices.json").read_text(encoding="utf-8"))
for voice in catalog["voices"]:
    model = voice["model"]
    rights = model.get("rights", {})
    assert model.get("license") == "CC0-1.0", "Unapproved factory voice license"
    assert rights.get("datasetLicense") == "CC0-1.0", "Missing recording rights"
    assert str(rights.get("evidenceUrl", "")).startswith("https://") and rights.get("verifiedAt"), "Missing rights evidence"

paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode("utf-8").split("\0")
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
