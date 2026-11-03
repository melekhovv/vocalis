"""Catalog network, rights and installation tests use synthetic files only."""
import copy
import hashlib
import io
import json
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _test_env
from vcengine import models as mod
from vcengine.catalog import CatalogService
from vcengine.downloads import open_download


def response(data=b'weights', status=200, headers=None):
    r = Mock()
    r.status_code = status
    r.headers = headers or {}
    r.iter_content.return_value = [data]
    r.__enter__ = Mock(return_value=r)
    r.__exit__ = Mock(return_value=False)
    return r


def voice(data=b'weights'):
    return {'id': 'fixture-approved', 'name': 'Synthetic fixture', 'category': 'other',
            'model': {'repo': 'fixtures/model', 'revision': 'a'*40, 'license': 'CC0-1.0',
                      'rights': {'datasetLicense': 'CC0-1.0', 'evidenceUrl': 'https://example.test/evidence', 'verifiedAt': '2026-11-03'},
                      'files': [{'kind': 'pth', 'path': 'model.pth', 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}]}}


class CatalogTests(unittest.TestCase):
    def test_checkpoint_architecture_and_index_compatibility(self):
        import torch
        import faiss
        import numpy as np
        from vcengine.paths import VENDOR_DIR
        if str(VENDOR_DIR) not in sys.path: sys.path.insert(0, str(VENDOR_DIR))
        from rvc.lib.algorithm.synthesizers import Synthesizer
        config = [5, 4, 8, 8, 16, 2, 2, 3, 0., '1', [3], [[1, 3, 5]], [10, 10, 2, 2], 16, [16, 16, 4, 4], 1, 4, 40000]
        with torch.random.fork_rng():
            torch.manual_seed(123)
            network = Synthesizer(*config, use_f0=True, text_enc_hidden_dim=768, vocoder='HiFi-GAN')
        del network.enc_q
        fixture = {'weight': network.state_dict(), 'config': config, 'version': 'v2', 'f0': 1}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'fixture.pth'
            torch.save(fixture, path)
            checkpoint = mod.inspect_checkpoint(path)
            self.assertEqual(checkpoint['version'], 'v2')
            legacy = copy.deepcopy(fixture)
            legacy['weight'] = {key.replace('.parametrizations.weight.original0', '.weight_g').replace('.parametrizations.weight.original1', '.weight_v'): value for key, value in legacy['weight'].items()}
            torch.save(legacy, path)
            self.assertEqual(mod.inspect_checkpoint(path)['version'], 'v2')
            mixed = copy.deepcopy(fixture)
            modern_key = next(k for k in mixed['weight'] if '.parametrizations.weight.original0' in k)
            mixed['weight'][modern_key.replace('.parametrizations.weight.original0', '.weight_g')] = mixed['weight'][modern_key].clone()
            torch.save(mixed, path)
            with self.assertRaisesRegex(mod.ModelError, 'weight_norm'):
                mod.inspect_checkpoint(path)
            for mutation in ('sr', 'vocoder', 'shape', 'nan'):
                candidate = copy.deepcopy(fixture)
                if mutation == 'sr': candidate['config'][-1] = 12345
                elif mutation == 'vocoder': candidate['vocoder'] = 'unknown-code'
                elif mutation == 'shape': candidate['weight']['enc_p.emb_phone.weight'] = torch.zeros(1, 1)
                else: candidate['weight']['enc_p.emb_phone.weight'][0, 0] = float('nan')
                torch.save(candidate, path)
                with self.assertRaises(mod.ModelError): mod.inspect_checkpoint(path)
            for dim, count in ((768, 1), (256, 1), (768, 0)):
                index = faiss.IndexFlatL2(dim)
                if count: index.add(np.zeros((count, dim), dtype='float32'))
                target = Path(folder) / 'model.index'
                faiss.write_index(index, str(target))
                if dim == 768 and count: mod.inspect_index(target, checkpoint)
                else:
                    with self.assertRaises(mod.ModelError): mod.inspect_index(target, checkpoint)

    def test_remote_license_or_rights_claim_cannot_enable_installation(self):
        manager = mod.ModelManager()
        service = CatalogService(manager)
        raw = {'id': 'someone/RVC-voice', 'sha': 'f'*40, 'cardData': {'license': 'cc0-1.0', 'vocalis_category': ['bad'], 'rights': {'approved': True}}}
        entry = service._remote_entry(raw)
        self.assertFalse(entry['canInstall'])
        self.assertFalse(entry['rights']['approved'])
        self.assertEqual(entry['category'], 'other')
        with patch.object(service, 'detail', return_value=entry), self.assertRaises(mod.ModelError):
            service.install('huggingface', raw['id'])
        self.assertFalse(manager.jobs)

    def test_remote_metadata_exact_curated_revision_can_resolve_to_approved(self):
        manager = mod.ModelManager()
        manager.catalog['voices'] = [voice()]
        service = CatalogService(manager)
        self.assertTrue(service._remote_entry({'id': 'fixtures/model', 'sha': 'a'*40, 'tags': ['rvc']}, merge_seed=True)['canInstall'])
        self.assertFalse(service._remote_entry({'id': 'fixtures/model', 'sha': 'b'*40, 'tags': ['rvc']})['canInstall'])

    def test_search_cache_and_offline_error_are_honest(self):
        with tempfile.TemporaryDirectory() as folder:
            manager = mod.ModelManager()
            service = CatalogService(manager, Path(folder))
            data = [{'id': 'tester/RVC-one', 'tags': ['rvc'], 'downloads': 5}]
            with patch.object(service, '_get_json', return_value=data) as network:
                first = service.search('RVC-one')
                second = service.search('RVC-one')
            self.assertEqual(len(first['items']), 1)
            self.assertEqual(first['providers'][-1]['state'], 'online')
            self.assertTrue(second['cached'])
            self.assertEqual(network.call_count, 1)
            for file in Path(folder).glob('*.json'):
                saved = json.loads(file.read_text())
                saved['checkedAt'] = time.time() - 1000
                file.write_text(json.dumps(saved))
            service.last_request = 0
            with patch.object(service, '_get_json', side_effect=mod.ModelError('Offline')):
                offline = service.search('RVC-one')
                service.last_request = 0
                absent = service.search('not-cached')
            self.assertEqual(offline['providers'][-1]['state'], 'cache')
            self.assertEqual(len(offline['items']), 1)
            self.assertEqual(absent['providers'][-1]['state'], 'error')
            self.assertFalse(absent['items'])

    def test_natural_search_to_detail_obeys_rate_cap_without_user_error(self):
        with tempfile.TemporaryDirectory() as folder:
            service = CatalogService(mod.ModelManager(), Path(folder))
            service.last_request = 100.0  # preceding search request
            with patch('vcengine.catalog.time.monotonic', side_effect=[100.25, 101.0]), patch('vcengine.catalog.time.sleep') as wait, patch.object(service, '_get_json', return_value={}) as network:
                _, state = service._cached('next-detail', 'https://huggingface.co/api/models/fixtures/RVC-model')
            wait.assert_called_once_with(.75)
            self.assertEqual(network.call_count, 1)
            self.assertEqual(state['state'], 'online')

    def test_policy_requires_pins_and_checksums_before_download(self):
        manager = mod.ModelManager()
        for change in ('revision', 'size', 'sha256'):
            candidate = voice()
            if change == 'revision': candidate['model']['revision'] = 'main'
            else: candidate['model']['files'][0].pop(change)
            with self.assertRaises(mod.ModelError):
                manager.validate_catalog_voice(candidate)
        candidate = voice()
        candidate['model']['license'] = 'Не указана'
        candidate['model']['rights'] = {'status': 'unverified'}
        manager.validate_catalog_voice(candidate)

    def test_redirects_allow_official_hf_cdn_and_reject_foreign_credentials_and_loops(self):
        session = Mock()
        redirected = response(status=302, headers={'Location': 'https://us.aws.cdn.hf.co/weights?signed=1'})
        binary = response()
        session.get.side_effect = [redirected, binary]
        self.assertIs(open_download(session, 'https://huggingface.co/a/b/resolve/rev/file.pth'), binary)
        self.assertFalse(session.get.call_args.kwargs['allow_redirects'])
        for target in ('https://127.0.0.1/private', 'https://example.com/x', 'https://user:secret@huggingface.co/a', 'http://huggingface.co/x'):
            session.get.side_effect = [response(status=302, headers={'Location': target})]
            with self.assertRaises(ValueError):
                open_download(session, 'https://huggingface.co/a/b')
        session.get.side_effect = None
        session.get.return_value = response(status=302, headers={'Location': '/again'})
        with self.assertRaises(ValueError):
            open_download(session, 'https://huggingface.co/a/b')

    def test_zip_traversal_duplicate_and_expansion_limit_rejected(self):
        for names in (['../evil.pth'], ['C:/evil.pth'], ['a.pth', 'A.pth']):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w') as z:
                for name in names: z.writestr(name, b'weights')
            with zipfile.ZipFile(buf) as z, self.assertRaises(mod.ModelError):
                mod.validate_zip(z)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr('bomb.pth', b'0' * 2_000_000)
        with zipfile.ZipFile(buf) as z, self.assertRaises(mod.ModelError):
            mod.validate_zip(z)

    def test_atomic_install_cancel_and_failed_validation_preserve_existing_files(self):
        for failure in ('invalid', 'cancel', 'success'):
            with tempfile.TemporaryDirectory() as folder:
                directory = Path(folder) / 'voices'
                directory.mkdir()
                existing = directory / 'custom-existing'
                existing.mkdir()
                (existing / 'keep.txt').write_text('keep')
                with patch.object(mod, 'VOICES_DIR', directory):
                    manager = mod.ModelManager()
                    job = mod.Job('fixture-approved')
                    candidate = voice()
                    def download(url, dest, *args):
                        dest.write_bytes(b'weights')
                        if failure == 'cancel': job.cancel.set()
                    with patch.object(manager, '_download', side_effect=download), patch.object(mod, 'inspect_checkpoint', side_effect=mod.ModelError('invalid') if failure == 'invalid' else None, return_value={'version': 'v2', 'sampleRate': 40000, 'f0': True, 'vocoder': 'HiFi-GAN'}):
                        if failure == 'success':
                            manager._run_voice(job, candidate)
                            installed = directory / candidate['id']
                            self.assertTrue((installed / 'manifest.json').is_file())
                            manager.catalog['voices'] = [candidate]
                            self.assertEqual(manager.list_voices()[-1]['status'], 'ready')
                            self.assertIn('recommendedParams', manager.list_voices()[-1])
                        else:
                            with self.assertRaises((mod.ModelError, mod._Cancelled)):
                                manager._run_voice(job, candidate)
                            self.assertFalse((directory / candidate['id']).exists())
                    self.assertEqual((existing / 'keep.txt').read_text(), 'keep')
                    self.assertFalse(list(directory.glob('.install-*')))

    def test_job_limit_and_duplicate_are_bounded(self):
        manager = mod.ModelManager()
        manager.jobs['one'] = mod.Job('one')
        manager.jobs['two'] = mod.Job('two')
        self.assertEqual(manager._start_job('one', lambda job: None)['stage'], 'queued')
        with self.assertRaises(mod.ModelError): manager._start_job('three', lambda job: None)


if __name__ == '__main__':
    unittest.main()
