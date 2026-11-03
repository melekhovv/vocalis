"""Voice model catalog, downloads, integrity checks and custom imports.

Security rules:
- catalog downloads only come from ALLOWED_HOSTS and are verified by SHA-256;
- from archives only the declared .pth/.index members are copied out, nothing
  is executed and no other member is written to disk;
- checkpoints are opened with ``torch.load(weights_only=True)``, which refuses
  arbitrary pickled objects, so a malicious .pth cannot run code.
"""

import hashlib
import json
import re
import shutil
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import requests

from .paths import CACHE_DIR, CATALOG_FILE, DATA_DIR, VOICES_DIR

from .downloads import ALLOWED_HOSTS, open_download
CHUNK = 1 << 20
CUSTOM_PREFIX = "custom-"


class ModelError(Exception):
    pass


def sha256_file(path: Path, progress=None) -> str:
    h = hashlib.sha256()
    done = 0
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
            done += len(chunk)
            if progress:
                progress(done)
    return h.hexdigest()


def inspect_checkpoint(path: Path) -> dict:
    """Safely open an RVC checkpoint and describe it. Raises ModelError if unusable."""
    import torch

    try:
        cpt = torch.load(str(path), map_location="cpu", weights_only=True)
    except Exception as e:  # weights_only rejects pickled code objects
        msg = str(e)
        if "Unsupported global" in msg or "Weights only load failed" in msg:
            detail = re.search(r"Unsupported global: GLOBAL ([\w.]+)", msg)
            raise ModelError(
                "Файл отклонён: он содержит исполняемые объекты Python"
                + (f" ({detail.group(1)})" if detail else "")
                + ", а не только веса нейросети. Такие файлы могут быть вредоносными и не загружаются."
            ) from e
        raise ModelError(f"Не удалось прочитать файл модели: {msg.splitlines()[0][:200]}") from e
    if not isinstance(cpt, dict) or "weight" not in cpt or "config" not in cpt:
        raise ModelError("Это не RVC-модель для инференса (нет полей weight/config). Возможно, это чекпойнт обучения G_*.pth.")
    config = cpt["config"]
    if not isinstance(config, (list, tuple)) or len(config) < 3:
        raise ModelError("Неизвестный формат config в чекпойнте")
    if "emb_g.weight" not in cpt["weight"]:
        raise ModelError("В чекпойнте нет speaker embedding (emb_g.weight)")
    version = cpt.get("version", "v1")
    if version not in ("v1", "v2"):
        raise ModelError(f"Неподдерживаемая версия RVC: {version}")
    sr = config[-1]
    if isinstance(sr, str):
        sr = int(sr.lower().replace("k", "000"))
    return {
        "version": version,
        "sampleRate": int(sr),
        "f0": bool(cpt.get("f0", 1)),
        "vocoder": cpt.get("vocoder", "HiFi-GAN"),
        "speakers": int(cpt["weight"]["emb_g.weight"].shape[0]),
    }


@dataclass
class Job:
    voice_id: str
    stage: str = "queued"
    done: int = 0
    total: int = 0
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def to_dict(self):
        return {
            "stage": self.stage,
            "done": self.done,
            "total": self.total,
            "progress": (self.done / self.total) if self.total else 0.0,
            "error": self.error,
        }


class ModelManager:
    def __init__(self, on_change=None):
        self.catalog = json.loads(Path(CATALOG_FILE).read_text(encoding="utf-8"))
        self._remove_retired_voices()
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.on_change = on_change or (lambda: None)
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "Vocalis/0.1"

    def _remove_retired_voices(self):
        """Remove only explicitly retired factory profiles on the next clean launch."""
        for vid in self.catalog.get("retiredVoiceIds", []):
            d = self._voice_dir(vid)
            if d.is_symlink() or d.resolve().parent != VOICES_DIR.resolve():
                continue
            try:
                if d.is_dir():
                    shutil.rmtree(d)
            except OSError:
                # A previous process can still hold a file. Retry on next launch.
                pass

    # ------------------------------------------------------------ catalog
    def _catalog_voice(self, voice_id):
        for v in self.catalog["voices"]:
            if v["id"] == voice_id:
                return v
        return None

    def _voice_dir(self, voice_id) -> Path:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", voice_id):
            raise ModelError("Некорректный идентификатор голоса")
        return VOICES_DIR / voice_id

    def _manifest(self, voice_id):
        p = self._voice_dir(voice_id) / "manifest.json"
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                return None
        return None

    def _write_manifest(self, voice_id, manifest):
        p = self._voice_dir(voice_id) / "manifest.json"
        p.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    def _download_size(self, v):
        m = v["model"]
        if "archive" in m:
            return m["archive"]["size"]
        return sum(f["size"] for f in m["files"])

    def voice_paths(self, voice_id):
        """Return (pth, index|None) for a ready voice or raise ModelError."""
        if voice_id in self.catalog.get("retiredVoiceIds", []):
            raise ModelError("Этот профиль удалён: библиотека содержит только русскую озвучку")
        man = self._manifest(voice_id)
        if man and man.get("status") == "corrupted":
            raise ModelError("Файлы модели повреждены (не совпадает SHA-256). Удалите и загрузите модель заново.")
        if man and man.get("status") == "incompatible":
            raise ModelError(f"Модель несовместима: {man.get('error', '')}")
        if not man or man.get("status") != "ready":
            raise ModelError("Модель не загружена")
        d = self._voice_dir(voice_id)
        pth = d / man["files"]["pth"]["name"]
        if not pth.exists():
            raise ModelError("Файл модели отсутствует — загрузите модель заново")
        idx = man["files"].get("index")
        index = d / idx["name"] if idx and (d / idx["name"]).exists() else None
        return str(pth), (str(index) if index else None)

    def list_voices(self):
        out = []
        for v in self.catalog["voices"]:
            out.append(self._describe(v, custom=False))
        if VOICES_DIR.exists():
            for d in sorted(VOICES_DIR.iterdir()):
                if d.is_dir() and d.name.startswith(CUSTOM_PREFIX):
                    man = self._manifest(d.name)
                    if man and "voice" in man:
                        out.append(self._describe(man["voice"], custom=True))
        return out

    def _describe(self, v, custom):
        man = self._manifest(v["id"])
        job = self.jobs.get(v["id"])
        if job and job.stage not in ("done", "error", "cancelled"):
            status = "downloading"
        elif man and man.get("status") == "ready":
            status = "ready"
        elif man and man.get("status") == "corrupted":
            status = "corrupted"
        else:
            status = "not_downloaded"
        info = dict(v)
        info["custom"] = custom
        info["status"] = status
        info["downloadSize"] = None if custom else self._download_size(v)
        info["diskSize"] = man.get("diskSize") if man else None
        info["checkpoint"] = man.get("checkpoint") if man else None
        info["compatible"] = (man or {}).get("compatible")
        info["job"] = job.to_dict() if job else None
        if job and job.stage == "error":
            info["lastError"] = job.error
        return info

    # ------------------------------------------------------------ base assets
    def base_assets_status(self):
        items = []
        for a in self.catalog["baseAssets"]:
            p = DATA_DIR / a["path"]
            items.append({"id": a["id"], "title": a["title"], "size": a["size"], "present": p.exists()})
        job = self.jobs.get("__base__")
        return {
            "ready": all(i["present"] for i in items),
            "items": items,
            "job": job.to_dict() if job else None,
        }

    def ensure_base_assets(self):
        return self._start_job("__base__", self._run_base)

    def _run_base(self, job: Job):
        missing = [a for a in self.catalog["baseAssets"] if not (DATA_DIR / a["path"]).exists()]
        job.total = sum(a["size"] for a in missing)
        for a in missing:
            job.stage = f"download:{a['id']}"
            dest = DATA_DIR / a["path"]
            self._download(a["url"], dest, a["size"], a.get("sha256"), job)

    # ------------------------------------------------------------ downloads
    def download(self, voice_id):
        v = self._catalog_voice(voice_id)
        if not v:
            raise ModelError("Голос не найден в каталоге")
        return self._start_job(voice_id, lambda job: self._run_voice(job, v))

    def cancel(self, voice_id):
        job = self.jobs.get(voice_id)
        if job:
            job.cancel.set()

    def _start_job(self, key, fn):
        with self.lock:
            job = self.jobs.get(key)
            if job and job.stage not in ("done", "error", "cancelled"):
                return job.to_dict()
            job = Job(key)
            self.jobs[key] = job

        def run():
            try:
                fn(job)
                job.stage = "done"
            except _Cancelled:
                job.stage = "cancelled"
            except Exception as e:
                job.stage = "error"
                job.error = str(e)
            finally:
                self.on_change()

        threading.Thread(target=run, daemon=True, name=f"job-{key}").start()
        self.on_change()
        return job.to_dict()

    def _hf_url(self, repo, revision, path):
        return f"https://huggingface.co/{repo}/resolve/{revision}/{path}"

    def _download(self, url, dest: Path, size, sha256, job: Job):
        host = urlparse(url).hostname or ""
        if host not in ALLOWED_HOSTS:
            raise ModelError(f"Источник {host} не входит в список доверенных")
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        base_done = job.done
        offset = part.stat().st_size if part.exists() else 0
        if size and offset > size:
            part.unlink()
            offset = 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        attempts = 8
        for attempt in range(attempts):
            try:
                # (connect, read) timeouts: a stalled CDN connection raises and is resumed.
                with open_download(self.session, url, headers) as r:
                    if r.status_code == 200 and offset:
                        offset = 0  # server ignored range
                    elif r.status_code not in (200, 206):
                        raise ModelError(f"HTTP {r.status_code} при загрузке {dest.name}")
                    with open(part, "ab" if offset else "wb") as f:
                        written = offset
                        job.done = base_done + written
                        for chunk in r.iter_content(CHUNK):
                            if job.cancel.is_set():
                                raise _Cancelled()
                            f.write(chunk)
                            written += len(chunk)
                            job.done = base_done + written
                break
            except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError) as e:
                if attempt == attempts - 1:
                    raise ModelError(f"Сетевая ошибка: сервер перестал отвечать ({type(e).__name__}). Повторите загрузку — она продолжится с места обрыва.") from e
                job.stage = f"retry:{dest.name}"
                time.sleep(min(2 * (attempt + 1), 10))
                offset = part.stat().st_size if part.exists() else 0
                headers = {"Range": f"bytes={offset}-"} if offset else {}
        if size and part.stat().st_size != size:
            raise ModelError(f"Размер {dest.name} не совпадает: {part.stat().st_size} вместо {size}")
        if sha256:
            job.stage = f"verify:{dest.name}"
            got = sha256_file(part)
            if got != sha256:
                part.unlink(missing_ok=True)
                raise ModelError(f"Контрольная сумма {dest.name} не совпадает — файл повреждён или подменён")
        part.replace(dest)

    def _run_voice(self, job: Job, v):
        m = v["model"]
        d = self._voice_dir(v["id"])
        d.mkdir(parents=True, exist_ok=True)
        job.total = self._download_size(v)
        files = {}
        if "archive" in m:
            a = m["archive"]
            zpath = CACHE_DIR / f"{v['id']}.zip"
            job.stage = "download"
            self._download(a.get("url") or self._hf_url(m["repo"], m["revision"], a["path"]), zpath, a["size"], a["sha256"], job)
            job.stage = "extract"
            with zipfile.ZipFile(zpath) as z:
                names = set(z.namelist())
                for kind, member in a["members"].items():
                    if member not in names:
                        raise ModelError(f"В архиве нет файла {member}")
                    out = d / ("model.pth" if kind == "pth" else "model.index")
                    with z.open(member) as src, open(out, "wb") as dst:
                        shutil.copyfileobj(src, dst, CHUNK)
            zpath.unlink(missing_ok=True)
            for kind in a["members"]:
                name = "model.pth" if kind == "pth" else "model.index"
                files[kind] = {"name": name, "sha256": sha256_file(d / name), "size": (d / name).stat().st_size}
        else:
            for f in m["files"]:
                job.stage = f"download:{f['kind']}"
                name = "model.pth" if f["kind"] == "pth" else "model.index"
                url = f.get("url") or self._hf_url(m["repo"], m["revision"], f["path"])
                member = f.get("member")
                dest = CACHE_DIR / f"{v['id']}-{f['kind']}.zip" if member else d / name
                self._download(url, dest, f["size"], f["sha256"], job)
                if member:
                    # Only the declared member is streamed into a fixed model filename.
                    # ZIP paths are never interpreted as filesystem destinations.
                    with zipfile.ZipFile(dest) as z:
                        if member not in z.namelist() or not member.lower().endswith("." + f["kind"]):
                            raise ModelError("В архиве нет указанного файла модели/индекса")
                        with z.open(member) as src, open(d / name, "wb") as dst:
                            shutil.copyfileobj(src, dst, CHUNK)
                    dest.unlink(missing_ok=True)
                target = d / name
                files[f["kind"]] = {"name": name, "sha256": sha256_file(target), "size": target.stat().st_size}
        job.stage = "validate"
        self._finalize(v["id"], files, voice=None)

    def _finalize(self, voice_id, files, voice):
        d = self._voice_dir(voice_id)
        manifest = {"status": "ready", "files": files, "installedAt": int(time.time())}
        if voice:
            manifest["voice"] = voice
        try:
            manifest["checkpoint"] = inspect_checkpoint(d / files["pth"]["name"])
            manifest["compatible"] = True
        except ModelError as e:
            manifest["status"] = "incompatible"
            manifest["compatible"] = False
            manifest["error"] = str(e)
            self._write_manifest(voice_id, manifest)
            raise
        manifest["diskSize"] = sum(f["size"] for f in files.values())
        self._write_manifest(voice_id, manifest)

    # ------------------------------------------------------------ management
    def delete(self, voice_id):
        self.cancel(voice_id)
        d = self._voice_dir(voice_id)
        if d.exists():
            shutil.rmtree(d)
        self.jobs.pop(voice_id, None)
        self.on_change()

    def verify(self, voice_id):
        man = self._manifest(voice_id)
        if not man:
            raise ModelError("Модель не загружена")
        d = self._voice_dir(voice_id)
        problems = []
        for kind, f in man["files"].items():
            p = d / f["name"]
            if not p.exists():
                problems.append(f"{f['name']}: отсутствует")
            elif sha256_file(p) != f["sha256"]:
                problems.append(f"{f['name']}: контрольная сумма не совпадает")
        man["status"] = "corrupted" if problems else "ready"
        man["verifiedAt"] = int(time.time())
        self._write_manifest(voice_id, man)
        self.on_change()
        return {"ok": not problems, "problems": problems}

    def import_custom(self, name, pth_path, index_path=None, category="other", description=""):
        pth_path = Path(pth_path)
        if pth_path.suffix.lower() != ".pth" or not pth_path.is_file():
            raise ModelError("Укажите файл модели .pth")
        if index_path:
            index_path = Path(index_path)
            if index_path.suffix.lower() != ".index" or not index_path.is_file():
                raise ModelError("Индекс должен быть файлом .index")
        info = inspect_checkpoint(pth_path)  # validate before copying anything
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "voice"
        voice_id = f"{CUSTOM_PREFIX}{slug}"
        n = 2
        while self._voice_dir(voice_id).exists():
            voice_id = f"{CUSTOM_PREFIX}{slug}-{n}"
            n += 1
        d = self._voice_dir(voice_id)
        d.mkdir(parents=True)
        try:
            files = {}
            shutil.copyfile(pth_path, d / "model.pth")
            files["pth"] = {"name": "model.pth", "sha256": sha256_file(d / "model.pth"), "size": (d / "model.pth").stat().st_size}
            if index_path:
                shutil.copyfile(index_path, d / "model.index")
                files["index"] = {"name": "model.index", "sha256": sha256_file(d / "model.index"), "size": (d / "model.index").stat().st_size}
            voice = {
                "id": voice_id,
                "name": name,
                "nameRu": name,
                "franchise": "Пользовательская модель",
                "category": category if category in ("cartoon", "anime", "film_tv", "game", "other") else "other",
                "description": description or f"Импортированная модель RVC {info['version']}, {info['sampleRate'] // 1000} кГц.",
                "language": None,
                "suggestedPitch": 0,
                "accent": "#a78bfa",
                "wikipedia": None,
                "model": {
                    "title": pth_path.name,
                    "format": f"RVC {info['version']} (.pth{' + .index' if index_path else ''})",
                    "repo": None,
                    "revision": None,
                    "upstream": str(pth_path),
                    "license": "Импорт пользователя",
                    "licenseNote": "Модель импортирована пользователем с диска. Источник и лицензия не проверялись приложением.",
                },
            }
            self._finalize(voice_id, files, voice)
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise
        self.on_change()
        return voice_id

    def storage_info(self):
        total = 0
        if VOICES_DIR.exists():
            for p in VOICES_DIR.rglob("*"):
                if p.is_file():
                    total += p.stat().st_size
        base = sum((DATA_DIR / a["path"]).stat().st_size for a in self.catalog["baseAssets"] if (DATA_DIR / a["path"]).exists())
        return {"dataDir": str(DATA_DIR), "voicesBytes": total, "baseBytes": base}


class _Cancelled(Exception):
    pass
