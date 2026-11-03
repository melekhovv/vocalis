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
import stat
import tempfile
import math
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import requests

from .paths import CACHE_DIR, CATALOG_FILE, DATA_DIR, VOICES_DIR  # noqa: F401

from .downloads import ALLOWED_HOSTS, open_download
CHUNK = 1 << 20
CUSTOM_PREFIX = "custom-"
MAX_FILE_SIZE = 2 * 1024**3
MAX_EXPANDED_SIZE = 3 * 1024**3
MAX_ARCHIVE_ENTRIES = 1024


def validate_zip(z):
    """Validate the complete central directory before copying any member."""
    entries = z.infolist()
    if len(entries) > MAX_ARCHIVE_ENTRIES:
        raise ModelError("В архиве слишком много файлов")
    total = 0
    names = set()
    for entry in entries:
        name = entry.filename.replace('\\', '/')
        parts = name.split('/')
        if (name.startswith('/') or re.match(r'^[A-Za-z]:', name) or '..' in parts
                or '\x00' in name or name.casefold() in names
                or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1):
            raise ModelError("Архив содержит небезопасные пути, ссылки или дубликаты")
        names.add(name.casefold())
        total += entry.file_size
        if entry.file_size > MAX_FILE_SIZE or total > MAX_EXPANDED_SIZE or (entry.file_size > 1024**2 and entry.file_size > max(entry.compress_size, 1) * 200):
            raise ModelError("Архив превышает допустимый размер или коэффициент сжатия")


def copy_zip_member(z, member, destination, job):
    if not isinstance(member, str) or member not in z.namelist() or not member.lower().endswith(destination.suffix.lower()):
        raise ModelError("В архиве нет указанного файла модели/индекса")
    entry = z.getinfo(member)
    if entry.is_dir():
        raise ModelError("Вместо файла модели в архиве указана папка")
    written = 0
    with z.open(member) as source, open(destination, 'wb') as target:
        while chunk := source.read(CHUNK):
            if job.cancel.is_set():
                raise _Cancelled()
            written += len(chunk)
            if written > MAX_FILE_SIZE or written > entry.file_size:
                raise ModelError("Распакованный файл превышает допустимый размер")
            target.write(chunk)
    if written != entry.file_size:
        raise ModelError("Размер распакованного файла не совпадает")


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

    if not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE_SIZE:
        raise ModelError("Файл модели пуст или превышает допустимый размер")
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
    if not isinstance(config, (list, tuple)) or len(config) != 18:
        raise ModelError("Неизвестный формат config в чекпойнте")
    if not isinstance(cpt["weight"], dict) or "emb_g.weight" not in cpt["weight"]:
        raise ModelError("В чекпойнте нет speaker embedding (emb_g.weight)")
    version = cpt.get("version", "v1")
    if version not in ("v1", "v2"):
        raise ModelError(f"Неподдерживаемая версия RVC: {version}")
    sr = config[-1]
    try:
        if not isinstance(sr, int) or isinstance(sr, bool) or sr not in (32000, 40000, 48000):
            raise ValueError()
        embedding = cpt["weight"]["emb_g.weight"]
        if not isinstance(embedding, torch.Tensor) or embedding.ndim != 2 or not 1 <= embedding.shape[0] <= 65536 or embedding.shape[1] != config[-2]:
            raise ValueError()
    except (TypeError, ValueError, AttributeError):
        raise ModelError("Некорректная частота дискретизации или speaker embedding")
    f0, vocoder = cpt.get("f0", 1), cpt.get("vocoder", "HiFi-GAN")
    if not isinstance(f0, (int, bool)) or f0 not in (0, 1) or vocoder not in ("HiFi-GAN", "MRF HiFi-GAN", "RefineGAN") or (not f0 and vocoder != "HiFi-GAN"):
        raise ModelError("Неподдерживаемый вокодер или флаг F0")
    # Bound architecture metadata before constructing even a metadata-only
    # network. Loading untrusted pickles is never enabled as a fallback.
    limits = {0: 4097, 1: 65536, 2: 512, 3: 512, 4: 4096, 5: 16, 6: 24, 7: 31, 13: 1024, 15: 65536, 16: 512}
    if any(not isinstance(config[i], int) or isinstance(config[i], bool) or not 0 < config[i] <= cap for i, cap in limits.items()):
        raise ModelError("Размеры архитектуры модели выходят за поддерживаемые пределы")
    if config[3] % config[5] or not isinstance(config[8], (int, float)) or not 0 <= config[8] < 1 or config[9] not in ('1', '2'):
        raise ModelError("Некорректная архитектура модели")
    for index in (10, 12, 14):
        if not isinstance(config[index], (list, tuple)) or not 1 <= len(config[index]) <= 8 or any(not isinstance(x, int) or isinstance(x, bool) or not 1 <= x <= 64 for x in config[index]):
            raise ModelError("Некорректные параметры слоёв модели")
    if len(config[12]) != len(config[14]) or math.prod(config[12]) != sr // 100 or not isinstance(config[11], (list, tuple)) or len(config[11]) != len(config[10]):
        raise ModelError("Архитектура не соответствует частоте модели")
    if any(not isinstance(layer, (list, tuple)) or not 1 <= len(layer) <= 8 or any(not isinstance(x, int) or isinstance(x, bool) or not 1 <= x <= 64 for x in layer) for layer in config[11]):
        raise ModelError("Некорректные параметры residual-слоёв")
    weights = cpt['weight']
    if len(weights) > 4096 or any(not isinstance(k, str) or not isinstance(v, torch.Tensor) or v.layout != torch.strided for k, v in weights.items()) or sum(v.numel() for v in weights.values()) > 300_000_000:
        raise ModelError("Неподдерживаемый набор тензоров модели")
    for key in weights:
        legacy = key.replace('.parametrizations.weight.original0', '.weight_g').replace('.parametrizations.weight.original1', '.weight_v')
        if legacy != key and legacy in weights:
            raise ModelError("Неоднозначные веса: одновременно указаны старые и новые параметры weight_norm")
    try:
        from .paths import VENDOR_DIR
        import sys
        if str(VENDOR_DIR) not in sys.path:
            sys.path.insert(0, str(VENDOR_DIR))
        from rvc.lib.algorithm.synthesizers import Synthesizer
        architecture = list(config)
        architecture[-3] = embedding.shape[0]
        with torch.device('meta'):
            network = Synthesizer(*architecture, use_f0=bool(f0), text_enc_hidden_dim=256 if version == 'v1' else 768, vocoder=vocoder)
        del network.enc_q
        expected = network.state_dict()
        # Torch's weight_norm load hook supports older RVC exports named
        # weight_g/weight_v. Compare those equivalent tensors without changing
        # the checkpoint or weakening the required architecture shape checks.
        def checkpoint_tensor(key):
            if key in weights:
                return weights[key]
            legacy = key.replace('.parametrizations.weight.original0', '.weight_g').replace('.parametrizations.weight.original1', '.weight_v')
            return weights.get(legacy)
        if any(checkpoint_tensor(key) is None or checkpoint_tensor(key).shape != tensor.shape for key, tensor in expected.items()):
            raise ModelError("Тензоры весов не соответствуют архитектуре RVC")
        del network, expected
        for tensor in weights.values():
            flattened = tensor.reshape(-1)
            for start in range(0, flattened.numel(), 1_000_000):
                if not torch.isfinite(flattened[start:start + 1_000_000]).all():
                    raise ModelError("Веса содержат NaN или бесконечность")
    except ModelError:
        raise
    except Exception as exc:
        raise ModelError("Не удалось подтвердить совместимость архитектуры RVC") from exc
    return {
        "version": version,
        "sampleRate": int(sr),
        "f0": bool(f0),
        "vocoder": vocoder,
        "speakers": int(cpt["weight"]["emb_g.weight"].shape[0]),
    }


def inspect_index(path: Path, checkpoint: dict):
    """Verify FAISS structure/dimension; semantic weight/index pairing is not inferred."""
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE_SIZE:
        raise ModelError("Файл индекса пуст или превышает допустимый размер")
    try:
        import faiss
        index = faiss.read_index(str(path))
        expected = 256 if checkpoint.get("version") == "v1" else 768
        if index.d != expected or index.ntotal < 1:
            raise ModelError(f"Индекс должен содержать данные размерности {expected} для {checkpoint.get('version')}")
    except ModelError:
        raise
    except Exception as exc:
        raise ModelError("Не удалось прочитать FAISS-индекс") from exc


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
        self._validate_catalog()
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.on_change = on_change or (lambda: None)
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.headers["User-Agent"] = "Vocalis/0.1"

    def _validate_catalog(self):
        """Require reproducible files; licensing information is not certification."""
        for voice in self.catalog.get("voices", []):
            self.validate_catalog_voice(voice)

    def validate_catalog_voice(self, voice):
        model = voice.get("model", {})
        # Declared licensing is informational, not a technical download gate.
        # Unknown terms never become a rights approval or an inferred license.
        self._voice_dir(voice.get("id", ""))
        if not re.fullmatch(r"[a-fA-F0-9]{40}", str(model.get("revision", ""))):
            raise ModelError("Ревизия модели должна быть закреплена полным commit SHA")
        assets = [model["archive"]] if isinstance(model.get("archive"), dict) else model.get("files", [])
        if not assets or len(assets) > 2:
            raise ModelError("Каталог должен указывать один архив или веса и необязательный индекс")
        kinds = set()
        for asset in assets:
            if not isinstance(asset, dict) or not isinstance(asset.get("size"), int) or isinstance(asset.get("size"), bool) or not 0 < asset["size"] <= MAX_FILE_SIZE or not re.fullmatch(r"[a-fA-F0-9]{64}", str(asset.get("sha256", ""))):
                raise ModelError("Для файла модели обязательны допустимый размер и SHA-256")
            if "archive" not in model:
                kind = asset.get("kind")
                if kind not in ("pth", "index") or kind in kinds:
                    raise ModelError("Неоднозначный набор файлов модели")
                kinds.add(kind)
        if "archive" not in model and "pth" not in kinds:
            raise ModelError("В наборе файлов нет весов .pth")
        members = model.get("archive", {}).get("members")
        if members is not None and (not isinstance(members, dict) or "pth" not in members or set(members) - {"pth", "index"}):
            raise ModelError("Неоднозначный набор файлов в архиве")

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
                manifest = json.loads(p.read_text(encoding="utf-8"))
                if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), dict) or "pth" not in manifest["files"]:
                    return None
                for entry in manifest["files"].values():
                    if not isinstance(entry, dict) or entry.get("name") not in ("model.pth", "model.index"):
                        return None
                return manifest
            except (json.JSONDecodeError, OSError, UnicodeError):
                return None
        return None

    def _write_manifest(self, voice_id, manifest):
        p = self._voice_dir(voice_id) / "manifest.json"
        with self.lock:
            pending = p.with_suffix(".tmp")
            pending.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            pending.replace(p)

    def _download_size(self, v):
        m = v["model"]
        if "archive" in m:
            return m["archive"]["size"]
        return sum(f["size"] for f in m["files"])

    def voice_paths(self, voice_id):
        """Return (pth, index|None) for a ready voice or raise ModelError."""
        if not isinstance(voice_id, str) or (not voice_id.startswith(CUSTOM_PREFIX) and not self._catalog_voice(voice_id) and not self._local_voice(voice_id)):
            raise ModelError("Голос отсутствует в библиотеке")
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
        if idx and not (d / idx["name"]).is_file():
            raise ModelError("Файл индекса отсутствует — загрузите модель заново")
        index = d / idx["name"] if idx and (d / idx["name"]).exists() else None
        return str(pth), (str(index) if index else None)

    def _local_voice(self, voice_id):
        """Describe an installed model independently of the downloadable catalog."""
        man = self._manifest(voice_id)
        if not man or not (self._voice_dir(voice_id) / "model.pth").is_file():
            return None
        if isinstance(man.get("voice"), dict):
            return {**man["voice"], "id": voice_id}
        names = {
            "pudge-ru": "Пудж", "invoker-ru": "Инвокер", "treant-ru": "Трент",
            "witch-doctor-ru": "Вич Доктор", "spongebob-ru": "Губка Боб",
            "shrek-ru": "Шрек", "shrek-alt-ru": "Шрек (альтернативный)",
            "sonic-ru": "Соник", "burunov-ru": "Сергей Бурунов",
            "deadpool-ru": "Дэдпул", "geralt-kuznetsov-ru": "Геральт",
            "optimus-prime-ru": "Оптимус Прайм",
        }
        # These profiles were part of the original local catalog. Keep them
        # when recovering installed voices: a zero pitch for every model
        # changes both its register and its resemblance to the target voice.
        pitches = {
            "pudge-ru": -3, "invoker-ru": 0, "treant-ru": -4,
            "witch-doctor-ru": -2, "spongebob-ru": 5,
            "shrek-ru": -2, "shrek-alt-ru": -2, "sonic-ru": 2,
            "burunov-ru": -2, "deadpool-ru": 0,
            "geralt-kuznetsov-ru": -3, "optimus-prime-ru": -4,
        }
        name = names.get(voice_id, voice_id.replace("-", " "))
        voice = {
            "id": voice_id, "name": name, "nameRu": name,
            "franchise": "Локальная модель", "category": "other",
            "description": "Ранее установленная модель RVC.", "language": None,
            "suggestedPitch": pitches.get(voice_id, 0), "accent": "#a78bfa", "wikipedia": None,
            "model": {"title": name, "format": "RVC (.pth)", "repo": None,
                      "revision": None, "upstream": None, "license": "Не проверена",
                      "licenseNote": "Локальная модель пользователя. Права на распространение не проверялись."},
        }
        if voice_id in pitches:
            voice["legacyProfile"] = True
            voice["recommendedParams"] = {
                "index_rate": 0.75 if "index" in man["files"] else 0.0,
                "protect": 0.33,
                "f0_method": "rmvpe",
            }
        return voice

    def list_voices(self):
        out = []
        for v in self.catalog["voices"]:
            out.append(self._describe(v, custom=False))
        if VOICES_DIR.exists():
            for d in sorted(VOICES_DIR.iterdir()):
                if d.is_dir() and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", d.name) and not self._catalog_voice(d.name):
                    voice = self._local_voice(d.name)
                    if voice:
                        out.append(self._describe(voice, custom=True))
        return out

    def _describe(self, v, custom):
        man = self._manifest(v["id"])
        job = self.jobs.get(v["id"])
        if job and job.stage not in ("done", "error", "cancelled"):
            status = "downloading"
        elif man and man.get("status") == "ready":
            try:
                self.voice_paths(v["id"])
                status = "ready"
            except ModelError:
                status = "corrupted"
        elif man and man.get("status") in ("corrupted", "incompatible"):
            status = "corrupted"
        else:
            status = "not_downloaded"
        info = dict(v)
        if man and isinstance(man.get("voice"), dict):
            for key in ("recommendedParams", "qualityPreset"):
                if key in man["voice"]:
                    info[key] = man["voice"][key]
        info["custom"] = custom
        info["status"] = status
        info["downloadSize"] = None if custom else self._download_size(v)
        info["diskSize"] = man.get("diskSize") if man else None
        info["checkpoint"] = man.get("checkpoint") if man else None
        info["compatible"] = (man or {}).get("compatible")
        info["job"] = job.to_dict() if job else None
        if job and job.stage == "error":
            info["lastError"] = job.error
        elif man and man.get("error"):
            info["lastError"] = man["error"]
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
        return self.install_voice(v)

    def install_voice(self, v):
        voice_id = v['id']
        self.validate_catalog_voice(v)
        man = self._manifest(voice_id)
        if man and man.get("status") == "ready":
            self.voice_paths(voice_id)
            incoming = v.get('model', {}).get('sourceFingerprint')
            previous = man.get('voice', {}).get('model', {}).get('sourceFingerprint')
            if incoming and incoming != previous:
                raise ModelError("Уже установлен другой файл или ревизия этого репозитория. Сначала удалите предыдущий вариант в библиотеке")
            return {"stage": "done", "done": 0, "total": 0, "progress": 1, "error": None}
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
            if sum(j.stage not in ("done", "error", "cancelled") for j in self.jobs.values()) >= 2:
                raise ModelError("Уже выполняются две загрузки. Дождитесь завершения или отмените одну из них")
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
        from urllib.parse import quote
        if not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
            raise ModelError("Некорректный источник модели")
        if not isinstance(path, str) or path.startswith(('/', '\\')) or '..' in path.replace('\\', '/').split('/'):
            raise ModelError("Некорректный путь файла модели")
        return f"https://huggingface.co/{repo}/resolve/{quote(revision, safe='')}/{quote(path, safe='/')}"

    def _download(self, url, dest: Path, size, sha256, job: Job):
        if job.cancel.is_set():
            raise _Cancelled()
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
                            written += len(chunk)
                            if written > (size or MAX_FILE_SIZE):
                                raise ModelError("Загрузка превысила заявленный размер файла")
                            f.write(chunk)
                            job.done = base_done + written
                break
            except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError) as e:
                if attempt == attempts - 1:
                    raise ModelError(f"Сетевая ошибка: сервер перестал отвечать ({type(e).__name__}). Повторите загрузку — она продолжится с места обрыва.") from e
                job.stage = f"retry:{dest.name}"
                if job.cancel.wait(min(2 * (attempt + 1), 10)):
                    raise _Cancelled()
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
        if job.cancel.is_set():
            raise _Cancelled()
        part.replace(dest)

    def _run_voice(self, job: Job, v):
        m = v["model"]
        d = self._voice_dir(v["id"])
        if d.exists():
            raise ModelError("Папка модели уже существует. Проверьте установленную модель или удалите её явно перед повторной установкой")
        VOICES_DIR.mkdir(parents=True, exist_ok=True)
        # Same-volume staging guarantees the validated manifest and weights
        # become visible together. Failed/cancelled jobs never enter library.
        with tempfile.TemporaryDirectory(prefix=".install-", dir=VOICES_DIR) as temporary:
            staged = Path(temporary) / "voice"
            staged.mkdir()
            job.total = self._download_size(v)
            files = {}
            if "archive" in m:
                a = m["archive"]
                zpath = Path(temporary) / "source.zip"
                job.stage = "downloading"
                self._download(a.get("url") or self._hf_url(m["repo"], m["revision"], a["path"]), zpath, a["size"], a["sha256"], job)
                job.stage = "extracting"
                with zipfile.ZipFile(zpath) as z:
                    validate_zip(z)
                    members = a.get("members")
                    if members is None:
                        # A single unambiguous inference checkpoint and optional
                        # index can be discovered without filesystem operations.
                        members = {}
                        for kind in ("pth", "index"):
                            candidates = [n for n in z.namelist() if n.lower().endswith('.' + kind) and not Path(n).name.startswith(('G_', 'D_'))]
                            if len(candidates) > 1 or (kind == "pth" and not candidates):
                                raise ModelError("Неоднозначный архив: невозможно выбрать единственную модель/индекс")
                            if candidates:
                                members[kind] = candidates[0]
                    for kind, member in members.items():
                        if kind not in ("pth", "index"):
                            raise ModelError("Неподдерживаемый файл в манифесте модели")
                        target = staged / ("model.pth" if kind == "pth" else "model.index")
                        copy_zip_member(z, member, target, job)
            else:
                for f in m["files"]:
                    job.stage = "downloading"
                    name = "model.pth" if f["kind"] == "pth" else "model.index"
                    url = f.get("url") or self._hf_url(m["repo"], m["revision"], f["path"])
                    member = f.get("member")
                    dest = Path(temporary) / (f['kind'] + '.zip') if member else staged / name
                    self._download(url, dest, f["size"], f["sha256"], job)
                    if member:
                        job.stage = "extracting"
                        with zipfile.ZipFile(dest) as z:
                            validate_zip(z)
                            copy_zip_member(z, member, staged / name, job)
            for target in staged.iterdir():
                kind = "pth" if target.suffix == ".pth" else "index"
                files[kind] = {"name": target.name, "sha256": sha256_file(target), "size": target.stat().st_size}
            job.stage = "validating"
            if job.cancel.is_set():
                raise _Cancelled()
            self._finalize(v["id"], files, voice=v, directory=staged)
            if job.cancel.is_set():
                raise _Cancelled()
            job.stage = "installing"
            with self.lock:
                if job.cancel.is_set():
                    raise _Cancelled()
                if d.exists():
                    raise ModelError("Модель уже установлена другой операцией")
                staged.replace(d)

    def _finalize(self, voice_id, files, voice, directory=None):
        d = directory or self._voice_dir(voice_id)
        manifest = {"status": "ready", "files": files, "installedAt": int(time.time())}
        if voice:
            manifest["voice"] = voice
        try:
            manifest["checkpoint"] = inspect_checkpoint(d / files["pth"]["name"])
            if "index" in files:
                inspect_index(d / files["index"]["name"], manifest["checkpoint"])
            manifest["compatible"] = True
        except ModelError as e:
            manifest["status"] = "incompatible"
            manifest["compatible"] = False
            manifest["error"] = str(e)
            if directory is None:
                self._write_manifest(voice_id, manifest)
            raise
        manifest["diskSize"] = sum(f["size"] for f in files.values())
        if voice:
            from .quality import model_quality_defaults
            manifest["voice"] = {**voice, "recommendedParams": voice.get("recommendedParams") or model_quality_defaults(manifest["checkpoint"], "index" in files), "qualityPreset": "Balanced"}
        if directory is None:
            self._write_manifest(voice_id, manifest)
        else:
            (d / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

    # ------------------------------------------------------------ management
    def delete(self, voice_id):
        with self.lock:
            job = self.jobs.get(voice_id)
            if job and job.stage not in ("done", "error", "cancelled"):
                raise ModelError("Сначала отмените загрузку и дождитесь её завершения")
            d = self._voice_dir(voice_id)
            if d.exists():
                shutil.rmtree(d)
            self.jobs.pop(voice_id, None)
        self.on_change()

    def verify(self, voice_id):
        job = self.jobs.get(voice_id)
        if job and job.stage not in ("done", "error", "cancelled"):
            raise ModelError("Дождитесь завершения загрузки перед проверкой")
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
        if not problems:
            try:
                man["checkpoint"] = inspect_checkpoint(d / man["files"]["pth"]["name"])
                if "index" in man["files"]:
                    inspect_index(d / man["files"]["index"]["name"], man["checkpoint"])
                man["compatible"] = True
                man.pop("error", None)
            except ModelError as e:
                problems.append(str(e))
                man["compatible"] = False
                man["error"] = str(e)
        man["status"] = "corrupted" if problems else "ready"
        man["verifiedAt"] = int(time.time())
        self._write_manifest(voice_id, man)
        self.on_change()
        return {"ok": not problems, "problems": problems}

    def import_custom(self, name, pth_path, index_path=None, category="other", description=""):
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
            raise ModelError("Укажите название модели длиной от 1 до 120 символов")
        name = name.strip()
        pth_path = Path(pth_path)
        if pth_path.suffix.lower() == ".zip" and pth_path.is_file():
            if index_path:
                raise ModelError("Для ZIP-импорта не выбирайте отдельный индекс")
            if pth_path.stat().st_size > MAX_FILE_SIZE:
                raise ModelError("Архив превышает допустимый размер")
            with tempfile.TemporaryDirectory(prefix="vocalis-import-") as folder, zipfile.ZipFile(pth_path) as z:
                validate_zip(z)
                selected = {}
                for kind in ("pth", "index"):
                    candidates = [n for n in z.namelist() if n.lower().endswith('.' + kind) and not Path(n).name.startswith(('G_', 'D_'))]
                    if len(candidates) > 1 or (kind == "pth" and not candidates):
                        raise ModelError("Неоднозначный ZIP: нужна одна модель и не более одного индекса")
                    if candidates:
                        selected[kind] = Path(folder) / ('model.' + kind)
                        copy_zip_member(z, candidates[0], selected[kind], Job('import'))
                return self.import_custom(name, str(selected['pth']), str(selected['index']) if 'index' in selected else None, category, description)
        if pth_path.suffix.lower() != ".pth" or not pth_path.is_file():
            raise ModelError("Укажите файл модели .pth")
        if index_path:
            index_path = Path(index_path)
            if index_path.suffix.lower() != ".index" or not index_path.is_file():
                raise ModelError("Индекс должен быть файлом .index")
        info = inspect_checkpoint(pth_path)  # validate before copying anything
        if index_path:
            inspect_index(index_path, info)
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
                "category": category if category in ("cartoon", "anime", "film_tv", "film", "series", "game", "bloggers", "other") else "other",
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
