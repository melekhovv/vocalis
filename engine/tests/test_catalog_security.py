"""Independent catalog security checks with disposable data and synthetic payloads.

No model downloads, user stores, audio devices or inference are used here.
"""
import asyncio
import json
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _test_env
import numpy as np
from fastapi import HTTPException
from vcengine import models, server


async def asgi_request(path, method='GET', body=None, headers=None, websocket=False):
    """Exercise the actual app middleware without an extra HTTP client dependency."""
    route, _, query = path.partition('?')
    sent = []
    scope = {'type': 'websocket' if websocket else 'http', 'asgi': {'version': '3.0'},
             'http_version': '1.1', 'method': method, 'scheme': 'ws' if websocket else 'http',
             'path': route, 'raw_path': route.encode(), 'query_string': query.encode(),
             'root_path': '', 'server': ('127.0.0.1', 12345), 'client': ('127.0.0.1', 23456),
             'headers': [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
             'subprotocols': []}
    received = False
    async def receive():
        nonlocal received
        if not received:
            received = True
            return {'type': 'websocket.connect'} if websocket else {'type': 'http.request', 'body': json.dumps(body).encode() if body is not None else b'', 'more_body': False}
        await asyncio.Event().wait()
    async def send(message):
        sent.append(message)
    await asyncio.wait_for(server.app(scope, receive, send), timeout=5)
    return sent


class CatalogSecurityTests(unittest.TestCase):
    def test_new_http_routes_require_launch_token_before_processing(self):
        routes = [
            ('GET', '/catalog/providers', None),
            ('GET', '/catalog/search?provider=approved', None),
            ('GET', '/catalog/models/huggingface/fixtures/RVC-test', None),
            ('GET', '/catalog/jobs', None),
            ('POST', '/catalog/install', {'provider': 'approved', 'id': 'fixture'}),
            ('POST', '/catalog/jobs/fixture/cancel', {}),
        ]
        with patch.object(server.catalog_service, 'search', side_effect=AssertionError('Unauthorized request reached catalog')):
            for method, url, body in routes:
                for headers in ({}, {'X-Vocalis-Token': 'wrong-token'}):
                    with self.subTest(url=url, token=bool(headers)):
                        result = asyncio.run(asgi_request(url, method, body, headers))
                        self.assertEqual(result[0]['status'], 401)
            self.assertEqual(asyncio.run(asgi_request('/health'))[0]['status'], 200)
            self.assertEqual(asyncio.run(asgi_request('/catalog/providers', headers={'X-Vocalis-Token': server.TOKEN}))[0]['status'], 200)

    def test_websocket_rejects_missing_or_wrong_token(self):
        for path in ('/ws', '/ws?token=wrong-token'):
            with self.subTest(path=path):
                result = asyncio.run(asgi_request(path, websocket=True))
                self.assertEqual(result, [{'type': 'websocket.close', 'code': 4401, 'reason': ''}])

    def test_executable_pickle_is_rejected_without_running_payload(self):
        import torch
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / 'executed.txt'
            class Unsafe:
                def __reduce__(self):
                    return eval, (f"__import__('pathlib').Path({str(marker)!r}).write_text('executed')",)
            checkpoint = Path(folder) / 'unsafe.pth'
            torch.save({'weight': Unsafe(), 'config': []}, checkpoint)
            with self.assertRaises(models.ModelError):
                models.inspect_checkpoint(checkpoint)
            self.assertFalse(marker.exists(), 'Untrusted pickle payload was executed')

    def test_real_faiss_dimension_and_empty_index_are_rejected(self):
        import faiss
        with tempfile.TemporaryDirectory() as folder:
            index = faiss.IndexFlatL2(256)
            path = Path(folder) / 'fixture.index'
            faiss.write_index(index, str(path))
            with self.assertRaises(models.ModelError):
                models.inspect_index(path, {'version': 'v1'})
            index.add(np.zeros((1, 256), dtype=np.float32))
            faiss.write_index(index, str(path))
            with self.assertRaises(models.ModelError):
                models.inspect_index(path, {'version': 'v2'})
            models.inspect_index(path, {'version': 'v1'})

    def test_zip_import_ambiguity_is_rejected_before_checkpoint_load(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'ambiguous.zip'
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr('one.pth', b'fixture')
                package.writestr('two.pth', b'fixture')
            manager = models.ModelManager()
            with patch.object(models, 'inspect_checkpoint', side_effect=AssertionError('Ambiguous archive reached checkpoint loader')):
                with self.assertRaises(models.ModelError):
                    manager.import_custom('Ambiguous fixture', str(archive))

    def test_delete_is_blocked_during_preview_or_live_conversion(self):
        fake_engine = Mock(voice_id='fixture', state='running', control_lock=threading.RLock())
        with patch.object(server, '_inference_lock', threading.Lock()), patch.object(server, 'engine', fake_engine), patch.object(server.models, 'delete') as delete:
            with self.assertRaises(HTTPException) as live:
                server.delete('fixture')
            self.assertEqual(live.exception.status_code, 400)
            fake_engine.state = 'stopped'
            server._inference_lock.acquire()
            try:
                with self.assertRaises(HTTPException) as preview:
                    server.delete('fixture')
                self.assertEqual(preview.exception.status_code, 409)
            finally:
                server._inference_lock.release()
            delete.assert_not_called()

    def test_cancel_while_waiting_for_commit_never_publishes_model(self):
        entered, release = threading.Event(), threading.Event()
        class CommitGate:
            def __enter__(self):
                entered.set()
                if not release.wait(3):
                    raise RuntimeError('Test commit gate timed out')
            def __exit__(self, *_args):
                return False
        with tempfile.TemporaryDirectory() as folder, patch.object(models, 'VOICES_DIR', Path(folder)):
            manager = models.ModelManager()
            manager.lock = CommitGate()
            job = models.Job('fixture-cancel-gate')
            voice = {'id': job.voice_id, 'model': {'repo': 'fixtures/model', 'revision': 'a' * 40,
                     'files': [{'kind': 'pth', 'path': 'model.pth', 'size': 7, 'sha256': 'a' * 64}]}}
            errors = []
            def run():
                try:
                    manager._run_voice(job, voice)
                except BaseException as error:
                    errors.append(error)
            with patch.object(manager, '_download', side_effect=lambda _url, destination, *_args: destination.write_bytes(b'fixture')), patch.object(models, 'inspect_checkpoint', return_value={'version': 'v2', 'sampleRate': 40000, 'f0': True}):
                worker = threading.Thread(target=run)
                worker.start()
                try:
                    self.assertTrue(entered.wait(3), 'Install did not reach atomic commit')
                    self.assertEqual(job.stage, 'installing')
                    job.cancel.set()
                finally:
                    release.set()
                    worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], models._Cancelled)
            self.assertFalse((Path(folder) / job.voice_id).exists())
            self.assertFalse(list(Path(folder).glob('.install-*')))


if __name__ == '__main__':
    unittest.main()
