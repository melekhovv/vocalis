"""Independent integration checks for the owner's unified catalogue policy.

All source responses and downloads are synthetic; no user model store is read.
"""
import asyncio
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _test_env
import requests
from vcengine import models, server
from vcengine.catalog import CatalogService
from test_catalog_security import asgi_request


REPO = 'qa-fixtures/RVC-unverified'
REVISION = 'a' * 40


def source(license_name=None):
    return {
        'id': REPO, 'sha': REVISION, 'tags': ['rvc'],
        'cardData': {'license': license_name, 'language': ['ru'],
                     'rights': {'approved': True, 'verifiedAt': '2099-01-01', 'evidenceUrl': 'https://not-evidence.invalid'}},
        'siblings': [
            {'rfilename': 'voice-a.pth', 'size': 8, 'lfs': {'sha256': '1' * 64}},
            {'rfilename': 'voice-a.index', 'size': 16, 'lfs': {'sha256': '2' * 64}},
        ],
    }


def service(folder):
    manager = models.ModelManager()
    manager.catalog['voices'] = []
    return manager, CatalogService(manager, Path(folder))


class UnifiedCatalogSecurityTests(unittest.TestCase):
    def test_non_cc0_and_unknown_license_allow_pinned_files_without_fabricated_rights(self):
        for license_name in (None, 'apache-2.0', 'other'):
            with self.subTest(license=license_name), tempfile.TemporaryDirectory() as folder:
                manager, catalog = service(folder)
                raw = source(license_name)
                with patch.object(catalog, '_get_json', return_value=raw), patch.object(manager, 'install_voice', return_value={'stage': 'queued'}) as install:
                    entry = catalog.detail('huggingface', REPO)
                    self.assertTrue(entry['canInstall'])
                    self.assertFalse(entry['rights']['approved'])
                    self.assertIsNone(entry['rights'].get('verifiedAt'))
                    self.assertIsNone(entry['rights'].get('evidenceUrl'))
                    catalog.install('huggingface', REPO)
                installed = install.call_args.args[0]
                self.assertEqual(installed['model']['revision'], REVISION)
                self.assertEqual(installed['model']['rights']['status'], 'unverified')
                self.assertIsNone(installed['model']['rights'].get('verifiedAt'))
                self.assertIsNone(installed['model']['rights'].get('evidenceUrl'))
                self.assertNotEqual(installed['model']['license'], 'CC0-1.0')

    def test_http_install_uses_server_pins_and_ignores_forged_renderer_urls_and_approval(self):
        with tempfile.TemporaryDirectory() as folder:
            manager, catalog = service(folder)
            forged = {'provider': 'huggingface', 'id': REPO, 'selection': {'pth': 'voice-a.pth', 'index': None},
                      'url': 'http://127.0.0.1:5555/private.pth', 'revision': 'main',
                      'sha256': 'f' * 64, 'rights': {'approved': True}, 'canInstall': True}
            with patch.object(server, 'catalog_service', catalog), patch.object(catalog, '_get_json', return_value=source()), patch.object(manager, 'install_voice', return_value={'stage': 'queued'}) as install:
                result = asyncio.run(asgi_request('/catalog/install', 'POST', forged, {'X-Vocalis-Token': server.TOKEN, 'Content-Type': 'application/json'}))
            self.assertEqual(result[0]['status'], 200)
            resolved = install.call_args.args[0]['model']
            self.assertEqual(resolved['revision'], REVISION)
            self.assertEqual(resolved['files'], [{'path': 'voice-a.pth', 'kind': 'pth', 'size': 8, 'sha256': '1' * 64}])
            self.assertNotIn('127.0.0.1', json.dumps(resolved))
            self.assertEqual(resolved['rights']['status'], 'unverified')

    def test_selection_cannot_introduce_unknown_paths_urls_or_download_metadata(self):
        invalid = [
            {'pth': '../../outside.pth'}, {'pth': 'https://evil.invalid/model.pth'},
            {'pth': 'missing.pth'}, {'pth': 'voice-a.pth', 'index': 'missing.index'},
            {'pth': 'voice-a.pth', 'url': 'https://evil.invalid/model.pth'},
            {'pth': 'voice-a.pth', 'sha256': 'f' * 64},
            {'pth': 'voice-a.pth', 'archive': 'pack.zip'},
        ]
        with tempfile.TemporaryDirectory() as folder:
            manager, catalog = service(folder)
            with patch.object(catalog, '_get_json', return_value=source()), patch.object(manager, 'install_voice') as install:
                for selection in invalid:
                    with self.subTest(selection=selection), self.assertRaises(models.ModelError):
                        catalog.install('huggingface', REPO, selection)
                install.assert_not_called()

    def test_missing_immutable_revision_hash_size_and_private_sources_stay_blocked(self):
        invalid = []
        for mutate in (
            lambda raw: raw.update(sha='main'),
            lambda raw: raw['siblings'][0]['lfs'].update(sha256='not-a-hash'),
            lambda raw: raw['siblings'][0].update(size=True),
            lambda raw: raw['siblings'][0].update(rfilename='../model.pth'),
            lambda raw: raw.update(gated=True),
            lambda raw: raw.update(private=True),
        ):
            raw = source()
            mutate(raw)
            invalid.append(raw)
        for raw in invalid:
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as folder:
                manager, catalog = service(folder)
                with patch.object(catalog, '_get_json', return_value=raw), patch.object(manager, 'install_voice') as install:
                    with self.assertRaises(models.ModelError):
                        catalog.install('huggingface', REPO)
                    install.assert_not_called()

    def test_stale_offline_metadata_cannot_start_a_new_install(self):
        with tempfile.TemporaryDirectory() as folder:
            manager, catalog = service(folder)
            with patch.object(catalog, '_get_json', return_value=source()):
                self.assertTrue(catalog.detail('huggingface', REPO)['canInstall'])
            for path in Path(folder).glob('*.json'):
                cached = json.loads(path.read_text(encoding='utf-8'))
                cached['checkedAt'] = time.time() - 601
                path.write_text(json.dumps(cached), encoding='utf-8')
            catalog.last_request = 0
            with patch.object(catalog, '_get_json', side_effect=requests.Timeout('Offline')), patch.object(manager, 'install_voice') as install:
                entry = catalog.detail('huggingface', REPO)
                self.assertEqual(entry['sourceState']['state'], 'cache')
                self.assertTrue(entry['sourceState']['stale'])
                self.assertFalse(entry['canInstall'])
                with self.assertRaises(models.ModelError):
                    catalog.install('huggingface', REPO)
                install.assert_not_called()

    def test_two_models_from_one_repo_have_distinct_install_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            manager, catalog = service(folder)
            raw = source()
            raw['siblings'].append({'rfilename': 'voice-b.pth', 'size': 8, 'lfs': {'sha256': '3' * 64}})
            with patch.object(catalog, '_get_json', return_value=raw), patch.object(manager, 'install_voice', return_value={'stage': 'queued'}) as install:
                entry = catalog.detail('huggingface', REPO)
                self.assertTrue(entry['requiresSelection'])
                with self.assertRaises(models.ModelError):
                    catalog.install('huggingface', REPO)
                first = catalog.install('huggingface', REPO, {'pth': 'voice-a.pth', 'index': None})
                second = catalog.install('huggingface', REPO, {'pth': 'voice-b.pth', 'index': None})
            self.assertNotEqual(first['voiceId'], second['voiceId'])
            variants = [call.args[0] for call in install.call_args_list]
            self.assertNotEqual(variants[0]['model']['sourceFingerprint'], variants[1]['model']['sourceFingerprint'])
            self.assertEqual(variants[0]['model']['files'][0]['path'], 'voice-a.pth')
            self.assertEqual(variants[1]['model']['files'][0]['path'], 'voice-b.pth')

    def test_seed_match_does_not_silently_replace_a_selected_sibling_model(self):
        with tempfile.TemporaryDirectory() as folder:
            manager, catalog = service(folder)
            manager.catalog['voices'] = [{
                'id': 'qa-seed-a', 'name': 'Synthetic seed A',
                'model': {'repo': REPO, 'revision': REVISION, 'license': 'other',
                          'rights': {'status': 'unverified'},
                          'files': [{'kind': 'pth', 'path': 'voice-a.pth', 'size': 8, 'sha256': '1' * 64}]},
            }]
            raw = source()
            raw['siblings'].append({'rfilename': 'voice-b.pth', 'size': 8, 'lfs': {'sha256': '3' * 64}})
            with patch.object(catalog, '_get_json', return_value=raw), patch.object(manager, 'install_voice', return_value={'stage': 'queued'}) as install:
                catalog.install('huggingface', REPO, {'pth': 'voice-b.pth', 'index': None})
            actual = install.call_args.args[0]
            self.assertEqual(actual['model']['files'][0]['path'], 'voice-b.pth')
            self.assertNotEqual(actual['id'], 'qa-seed-a')


if __name__ == '__main__':
    unittest.main()
