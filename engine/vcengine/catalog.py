"""Unified public model catalogue with server-resolved, pinned installations.

License declarations are displayed, never promoted into verified consent.
Only technical availability and file safety govern the download operation.
"""
import hashlib
import json
import re
import threading
import time
from pathlib import Path
from urllib.parse import quote

import requests

from .models import ModelError
from .paths import CACHE_DIR

MAX_METADATA = 2 * 1024 * 1024
MAX_RESULTS = 30
CATEGORIES = {"game", "film_tv", "film", "series", "anime", "cartoon", "bloggers", "other"}
REPO = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\Z")


def _text(value, limit=1000):
    return value[:limit] if isinstance(value, str) else ""


class CatalogService:
    def __init__(self, models, cache_dir=None, session=None):
        self.models = models
        self.cache_dir = Path(cache_dir or CACHE_DIR / "catalog")
        self.session = session or requests.Session()
        self.session.trust_env = False
        self.session.headers["User-Agent"] = "Vocalis/voice-catalog"
        self.lock = threading.Lock()
        self.last_request = 0.0
        self.job_sources = {}

    def providers(self):
        return {"providers": [
            {"id": "approved", "name": "Подборка голосов", "available": True,
             "description": "Модели из публичных источников с закреплёнными файлами и сведениями об условиях использования."},
            {"id": "huggingface", "name": "Hugging Face", "available": True,
             "description": "Поиск публичных RVC-моделей. Доступные файлы проверяются перед установкой."},
        ]}

    def _get_json(self, url, params=None):
        # No user-controlled URL or redirects, no credentials, no remote code.
        started = time.monotonic()
        with self.session.get(url, params=params, timeout=(5, 12), stream=True, allow_redirects=False) as response:
            if response.status_code != 200:
                raise ModelError(f"Hugging Face: HTTP {response.status_code}. Повторите позже.")
            payload = bytearray()
            for chunk in response.iter_content(65536):
                if time.monotonic() - started > 20:
                    raise ModelError("Источник каталога отвечает слишком медленно")
                payload.extend(chunk)
                if len(payload) > MAX_METADATA:
                    raise ModelError("Ответ каталога превышает допустимый размер")
            return json.loads(payload)

    def _cached(self, key, url, params=None):
        path = self.cache_dir / (hashlib.sha256(key.encode()).hexdigest() + ".json")
        cached = None
        try:
            if path.stat().st_size <= MAX_METADATA:
                candidate = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(candidate, dict) and isinstance(candidate.get("checkedAt"), (int, float)) and isinstance(candidate.get("data"), (list, dict)):
                    cached = candidate
        except (OSError, ValueError, TypeError):
            pass
        now = time.time()
        if cached and now - cached["checkedAt"] < 600:
            return cached["data"], {"id": "huggingface", "state": "cache", "checkedAt": cached["checkedAt"], "stale": False, "message": "Локальный кеш метаданных"}
        try:
            # Serialise requests and bound frequency. An occupied provider
            # returns a retryable error; a sequential click waits in its worker.
            if not self.lock.acquire(blocking=False):
                raise ModelError("Запрос к источнику уже выполняется. Повторите позже.")
            try:
                delay = 1 - (time.monotonic() - self.last_request)
                if delay > 0:
                    # A natural search -> detail click waits at most a second
                    # in this worker; the HTTP/WebSocket loop stays responsive.
                    time.sleep(min(delay, 1))
                self.last_request = time.monotonic()
                data = self._get_json(url, params)
            finally:
                self.lock.release()
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            encoded = json.dumps({"checkedAt": now, "data": data}, ensure_ascii=False)
            if len(encoded.encode("utf-8")) <= MAX_METADATA:
                pending = path.with_suffix(".tmp")
                pending.write_text(encoded, encoding="utf-8")
                pending.replace(path)
                candidates = sorted((p for p in self.cache_dir.glob('*.json') if re.fullmatch(r'[a-f0-9]{64}\.json', p.name)), key=lambda p: p.stat().st_mtime)
                for old in candidates[:-100]:
                    old.unlink(missing_ok=True)
            return data, {"id": "huggingface", "state": "online", "checkedAt": now, "message": "Публичный API Hugging Face"}
        except (requests.RequestException, OSError, ValueError, ModelError) as exc:
            # Do not expose response bodies, credentials, or local storage paths.
            message = str(exc)[:200] if isinstance(exc, ModelError) else "Источник недоступен. Проверьте интернет и повторите поиск."
            return (cached["data"] if cached else []), {"id": "huggingface", "state": "cache" if cached else "error", "checkedAt": cached["checkedAt"] if cached else None, "stale": True, "message": message}

    def _installed(self, voice_id):
        return self.models._manifest(voice_id)

    def _entry(self, voice):
        model = voice["model"]
        man = self._installed(voice["id"])
        job = self.models.jobs.get(voice["id"])
        checkpoint = (man or {}).get("checkpoint") or {}
        return {
            "id": voice["id"], "provider": "approved", "voiceId": voice["id"],
            "name": voice.get("nameRu") or voice.get("name", voice["id"]),
            "description": voice.get("description", ""), "category": voice.get("category", "other"),
            "language": voice.get("language"), "author": model.get("author"),
            "sourceUrl": model.get("upstream") or ("https://huggingface.co/" + model.get("repo", "")),
            "license": model.get("license") or "Не указана", "rights": {**(model.get("rights") or {}), "approved": False, "reason": model.get("licenseNote") or "Условия указаны источником; приложение не подтверждает права на голос и записи."},
            "compatibility": "rvc-" + checkpoint["version"] if checkpoint.get("version") else "unverified",
            "size": self.models._download_size(voice), "downloads": None,
            "installed": bool(man and man.get("status") == "ready"), "job": job.to_dict() if job else None,
            "canInstall": True,
            "installReason": "Файлы закреплены ревизией и SHA-256; совместимость проверится после загрузки.",
            "languageConfidence": voice.get("languageConfidence", "declared" if voice.get("language") else "unknown"),
        }

    @staticmethod
    def _file_candidates(raw):
        files = raw.get('siblings') if isinstance(raw.get('siblings'), list) else []
        result = []
        for file in files[:1024]:
            if not isinstance(file, dict):
                continue
            path = file.get('rfilename')
            if not isinstance(path, str) or len(path) > 512 or '\\' in path or path.startswith('/') or '..' in path.split('/') or ':' in path:
                continue
            kind = 'pth' if path.lower().endswith('.pth') else 'index' if path.lower().endswith('.index') else 'archive' if path.lower().endswith('.zip') else None
            if not kind or path.split('/')[-1].startswith(('G_', 'D_')):
                continue
            lfs = file.get('lfs') if isinstance(file.get('lfs'), dict) else {}
            sha = lfs.get('sha256') or file.get('sha256')
            size = file.get('size', lfs.get('size'))
            if isinstance(sha, str) and re.fullmatch(r'[a-fA-F0-9]{64}', sha) and isinstance(size, int) and not isinstance(size, bool) and 0 < size <= 2 * 1024**3:
                result.append({'path': path, 'kind': kind, 'size': size, 'sha256': sha.lower()})
        return result

    @staticmethod
    def _fingerprint(repo, revision, selected):
        fingerprint = hashlib.sha256(json.dumps({'repo': repo, 'revision': revision, 'files': selected}, sort_keys=True).encode()).hexdigest()
        return fingerprint, 'hf-' + fingerprint[:40]

    def _remote_entry(self, raw, merge_seed=False):
        repo = raw.get("id") or raw.get("modelId")
        if not isinstance(repo, str) or not REPO.fullmatch(repo):
            return None
        card = raw.get("cardData") if isinstance(raw.get("cardData"), dict) else {}
        tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
        files = raw.get("siblings") if isinstance(raw.get("siblings"), list) else []
        is_rvc = any(isinstance(t, str) and "rvc" in t.lower() for t in tags) or "rvc" in repo.lower() or any(isinstance(f, dict) and str(f.get("rfilename", "")).lower().endswith((".pth", ".index")) for f in files)
        if not is_rvc:
            return None
        # Merge identical source/revision entries in the unified catalogue.
        for voice in self.models.catalog.get("voices", []) if merge_seed else []:
            if voice["model"].get("repo") == repo and raw.get("sha") == voice["model"].get("revision"):
                return self._entry(voice)
        language = card.get("language") or [tag[9:] for tag in tags if isinstance(tag, str) and tag.startswith('language:')]
        if isinstance(language, list):
            language = ", ".join(_text(x, 30) for x in language[:5])
        license_name = card.get("license") or next((t[8:] for t in tags if isinstance(t, str) and t.startswith("license:")), "Не указана")
        sizes = [f.get("size") for f in files if isinstance(f, dict) and str(f.get("rfilename", "")).lower().endswith((".pth", ".index", ".zip"))]
        size = sum(sizes) if sizes and all(isinstance(x, int) and x >= 0 for x in sizes) else None
        candidates = self._file_candidates(raw)
        revision = raw.get('sha')
        pinned = isinstance(revision, str) and bool(re.fullmatch(r'[a-fA-F0-9]{40}', revision))
        available = pinned and bool(candidates) and any(f['kind'] in ('pth', 'archive') for f in candidates) and not raw.get('gated') and not raw.get('private')
        primary = [f for f in candidates if f['kind'] == 'pth']
        indexes = [f for f in candidates if f['kind'] == 'index']
        archives = [f for f in candidates if f['kind'] == 'archive']
        requires_selection = len(primary) > 1 or (bool(primary) and len(indexes) > 1) or (not primary and len(archives) > 1)
        voice_id = "hf-" + hashlib.sha256(repo.encode()).hexdigest()[:40]
        if available and not requires_selection:
            _, voice_id = self._fingerprint(repo, revision, self._select_files(candidates, None))
        man = self._installed(voice_id)
        job = self.models.jobs.get(voice_id)
        return {"id": repo, "provider": "huggingface", "voiceId": voice_id,
                "name": _text(repo.split("/")[-1], 120), "description": _text(card.get("description"), 1000),
                "category": card.get("vocalis_category") if isinstance(card.get("vocalis_category"), str) and card["vocalis_category"] in CATEGORIES else "other",
                "language": _text(language, 100) or None, "author": _text(raw.get("author"), 120) or repo.split("/")[0],
                "sourceUrl": "https://huggingface.co/" + repo, "license": _text(license_name, 100) or "Не указана",
                "rights": {"approved": False, "reason": "Лицензия указана источником. Права на голос и исходные записи приложением не подтверждены."},
                "compatibility": "unverified", "size": size, "downloads": raw.get("downloads") if isinstance(raw.get("downloads"), int) else None,
                "installed": bool(man and man.get('status') == 'ready'), "job": job.to_dict() if job else None,
                "canInstall": bool(available), "installReason": "Требуется выбрать файлы модели." if available and requires_selection else "Файлы доступны; совместимость проверится после загрузки." if available else "Источник требует авторизацию." if raw.get('gated') or raw.get('private') else "Откройте сведения модели для проверки закреплённой ревизии, файлов и SHA-256.",
                "files": candidates, "revision": revision if pinned else None, "requiresSelection": requires_selection,
                "languageConfidence": 'declared' if language else 'unknown'}

    def search(self, q="", provider="all", category="all", sort="name"):
        if not isinstance(q, str) or len(q) > 120:
            raise ModelError("Поисковый запрос должен быть не длиннее 120 символов")
        if provider not in ("all", "approved", "huggingface") or category not in CATEGORIES | {"all"} or sort not in ("name", "downloads"):
            raise ModelError("Неизвестный источник, категория или сортировка")
        q = q.strip()
        items, states = [], []
        if provider in ("all", "approved"):
            items.extend(self._entry(v) for v in self.models.catalog.get("voices", []) if not q or q.casefold() in " ".join(str(v.get(k, "")) for k in ("name", "nameRu", "description", "franchise")).casefold())
            states.append({"id": "approved", "state": "cache", "checkedAt": None, "message": "Локальная подборка голосов"})
        if provider in ("all", "huggingface"):
            data, state = self._cached("search:" + q.casefold(), "https://huggingface.co/api/models", {"search": q or "RVC", "limit": MAX_RESULTS, "full": "true"})
            states.append(state)
            if isinstance(data, list):
                items.extend(entry for raw in data[:MAX_RESULTS] if isinstance(raw, dict) and (entry := self._remote_entry(raw, merge_seed=True)))
        # Same reviewed repository found by two providers is only shown once.
        deduped = {entry["voiceId"]: entry for entry in items}
        items = [entry for entry in deduped.values() if category == "all" or entry["category"] == category]
        items.sort(key=(lambda e: (-(e["downloads"] or 0), e["name"].casefold())) if sort == "downloads" else lambda e: e["name"].casefold())
        return {"items": items, "providers": states, "cached": any(s["state"] == "cache" and s["id"] == "huggingface" for s in states)}

    def detail(self, provider, model_id):
        if provider == "approved":
            voice = self.models._catalog_voice(model_id)
            if voice:
                return self._entry(voice)
        elif provider == "huggingface" and isinstance(model_id, str) and REPO.fullmatch(model_id):
            data, state = self._cached("detail-blobs:" + model_id, "https://huggingface.co/api/models/" + quote(model_id, safe="/"), {'blobs': 'true'})
            if isinstance(data, dict):
                entry = self._remote_entry(data)
                if entry:
                    entry["sourceState"] = state
                    if state.get('stale'):
                        entry['canInstall'] = False
                        entry['installReason'] = 'Источник недоступен; устаревшие метаданные нельзя использовать для новой установки. Повторите проверку.'
                    entry['installedVariants'] = [
                        {'voiceId': v['id'], 'name': v.get('nameRu', v.get('name', v['id'])), 'revision': v.get('model', {}).get('revision'),
                         'files': [f.get('path', '') for f in v.get('model', {}).get('files', [])]}
                        for v in self.models.list_voices()
                        if v.get('status') == 'ready' and v.get('model', {}).get('catalogProvider') == 'huggingface' and v.get('model', {}).get('catalogId') == model_id
                    ]
                    return entry
            raise ModelError(state["message"] if state["state"] == "error" else "RVC-модель не найдена в источнике")
        raise ModelError("Модель или провайдер не найдены")

    def install(self, provider, model_id, selection=None):
        # The renderer sends only known paths. URLs, sizes, revision, hashes and
        # licensing data always come from metadata resolved by the server.
        voice = self.models._catalog_voice(model_id) if provider == "approved" else None
        if provider == 'huggingface' and isinstance(model_id, str) and REPO.fullmatch(model_id):
            entry = self.detail(provider, model_id)
            if entry['provider'] == 'approved':
                voice = self.models._catalog_voice(entry['id'])
            else:
                if not entry['canInstall']:
                    raise ModelError(entry['installReason'])
                selected = self._select_files(entry['files'], selection)
                fingerprint, voice_id = self._fingerprint(model_id, entry['revision'], selected)
                model = {'repo': model_id, 'revision': entry['revision'], 'upstream': entry['sourceUrl'], 'title': entry['name'],
                         'format': 'RVC — проверка после загрузки', 'license': entry['license'], 'licenseNote': entry['rights']['reason'],
                         'rights': {'status': 'unverified'}, 'catalogProvider': provider, 'catalogId': model_id}
                if selected[0]['kind'] == 'archive':
                    model['archive'] = {k: v for k, v in selected[0].items() if k != 'kind'}
                else:
                    model['files'] = selected
                model['sourceFingerprint'] = fingerprint
                voice = {'id': voice_id, 'name': entry['name'], 'nameRu': entry['name'], 'description': entry['description'],
                         'category': entry['category'], 'language': entry['language'], 'languageConfidence': entry['languageConfidence'],
                         'franchise': 'Hugging Face', 'suggestedPitch': 0, 'accent': '#a78bfa', 'wikipedia': None, 'model': model}
        if not voice:
            raise ModelError("Модель или источник не найдены")
        self.models.validate_catalog_voice(voice)
        self.job_sources[voice['id']] = (provider, model_id)
        return {"voiceId": voice["id"], "job": self.models.install_voice(voice)}

    @staticmethod
    def _select_files(files, selection):
        selection = selection or {}
        if not isinstance(selection, dict) or set(selection) - {'pth', 'index', 'archive'} or any(value is not None and not isinstance(value, str) for value in selection.values()):
            raise ModelError('Некорректный выбор файлов модели')
        if selection.get('archive') and (selection.get('pth') or selection.get('index')):
            raise ModelError('Выберите архив либо отдельные веса с индексом')
        def get(kind, path=None, optional=False):
            matches = [f for f in files if f['kind'] == kind and (path is None or f['path'] == path)]
            if len(matches) == 1: return dict(matches[0])
            if not matches and optional and path is None: return None
            raise ModelError('Выберите один файл .pth и необязательный .index либо один ZIP из сведений модели')
        if selection.get('archive'):
            return [get('archive', selection['archive'])]
        if selection.get('pth') or any(f['kind'] == 'pth' for f in files):
            pth = get('pth', selection.get('pth'))
            index = None if 'index' in selection and selection['index'] is None else get('index', selection.get('index'), optional=True)
            return [pth] + ([index] if index else [])
        return [get('archive')]

    def jobs(self):
        return {"jobs": [{"voiceId": key, "provider": self.job_sources.get(key, ('approved', key))[0], "id": self.job_sources.get(key, ('approved', key))[1], **job.to_dict()} for key, job in list(self.models.jobs.items()) if key != "__base__"]}
