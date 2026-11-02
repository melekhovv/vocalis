"""Filesystem layout.

The vendored Applio code resolves its base assets relative to the process
working directory (``rvc/models/...``), so the engine chdirs into DATA_DIR
before importing it. Voice models live in DATA_DIR/voices/<id>/.
"""

import os
import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
VENDOR_DIR = ENGINE_DIR / "vendor"


def _default_data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "Vocalis"


DATA_DIR = Path(os.environ.get("VOCALIS_DATA_DIR") or _default_data_dir()).resolve()
VOICES_DIR = DATA_DIR / "voices"
CACHE_DIR = DATA_DIR / "cache"
PREVIEW_DIR = DATA_DIR / "previews"


def _find_catalog() -> Path:
    override = os.environ.get("VOCALIS_CATALOG")
    if override:
        return Path(override)
    for candidate in (ENGINE_DIR / "catalog" / "voices.json", ENGINE_DIR.parent / "catalog" / "voices.json"):
        if candidate.exists():
            return candidate
    return ENGINE_DIR.parent / "catalog" / "voices.json"


CATALOG_FILE = _find_catalog()


def prepare_runtime():
    """Create data folders, isolate Applio's config and expose the vendor package."""
    for d in (DATA_DIR, VOICES_DIR, CACHE_DIR, PREVIEW_DIR):
        d.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("APPLIO_CONFIG_DIR", str(DATA_DIR / "applio"))
    os.environ.setdefault("APPLIO_LOGS_DIR", str(VOICES_DIR))
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.chdir(DATA_DIR)
    if str(VENDOR_DIR) not in sys.path:
        sys.path.insert(0, str(VENDOR_DIR))
