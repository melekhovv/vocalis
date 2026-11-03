"""Public Drive confirmations, checksum enforcement and declared ZIP member extraction."""
import sys,tempfile,unittest,zipfile,hashlib
from pathlib import Path
from unittest.mock import Mock,patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import _test_env
from vcengine.downloads import open_download
from vcengine import models as mod

def response(content_type='application/octet-stream',text=''):
    r=Mock();r.status_code=200;r.headers={'Content-Type':content_type};r.text=text
    r.__enter__=Mock(return_value=r);r.__exit__=Mock(return_value=False)
    return r

class DownloadTests(unittest.TestCase):
    def test_public_drive_confirmation_keeps_range_and_uses_only_download_host(self):
        form=response('text/html','<form id="download-form" action="https://drive.usercontent.google.com/download"><input type="hidden" name="id" value="public-id"><input type="hidden" name="confirm" value="t"></form>')
        binary=response();session=Mock();session.get.side_effect=[form,binary]
        self.assertIs(open_download(session,'https://drive.google.com/uc?id=public-id',{'Range':'bytes=10-'}),binary)
        self.assertEqual(session.get.call_args.kwargs['params']['id'],'public-id')
        self.assertEqual(session.get.call_args.kwargs['headers']['Range'],'bytes=10-')
        form.close.assert_called_once()

    def test_login_page_and_foreign_form_are_not_followed(self):
        for html in ['<form action="https://accounts.google.com/login"></form>', '<form id="download-form" action="https://example.com/download"><input type="hidden" name="id" value="x"></form>']:
            session=Mock();session.get.return_value=response('text/html',html)
            with self.assertRaises(ValueError):open_download(session,'https://drive.google.com/uc?id=x')
            self.assertEqual(session.get.call_count,1)

    def test_unknown_host_and_http_are_rejected_before_network(self):
        session=Mock()
        for url in ['https://example.com/model.pth','http://drive.google.com/file']:
            with self.assertRaises(ValueError):open_download(session,url)
        session.get.assert_not_called()

    def test_huggingface_download_does_not_use_drive_confirmation(self):
        session=Mock();r=response();session.get.return_value=r
        self.assertIs(open_download(session,'https://huggingface.co/repo/model.pth'),r)
        self.assertEqual(session.get.call_count,1)

    def test_mixed_direct_weights_and_zipped_index_extract_only_declared_member(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            base=Path(tmp);voices=base/'voices';cache=base/'cache';voices.mkdir();cache.mkdir()
            archive=base/'source.zip'
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('nested/voice.index',b'index-data')
                z.writestr('../unselected.py',b'must not be extracted')
            with patch.object(mod,'VOICES_DIR',voices),patch.object(mod,'CACHE_DIR',cache):
                manager=mod.ModelManager()
                def download(url,dest,*_):dest.write_bytes(b'weights' if url.endswith('weights') else archive.read_bytes())
                manager._download=Mock(side_effect=download);manager._finalize=Mock()
                files=[{'kind':'pth','url':'https://drive.google.com/weights','path':'weight.pth','size':7,'sha256':'fixture'}, {'kind':'index','url':'https://drive.google.com/archive','path':'index.zip','size':archive.stat().st_size,'sha256':'fixture','member':'nested/voice.index'}]
                manager._run_voice(mod.Job('test-russian'),{'id':'test-russian','model':{'files':files}})
                manifest_files=manager._finalize.call_args.args[1]
                self.assertEqual(manifest_files['index']['sha256'],hashlib.sha256(b'index-data').hexdigest())
                self.assertEqual(manifest_files['index']['size'],10)
                self.assertEqual((voices/'test-russian/model.pth').read_bytes(),b'weights')
                self.assertEqual((voices/'test-russian/model.index').read_bytes(),b'index-data')
                self.assertFalse((base/'unselected.py').exists())
                self.assertFalse(list(cache.iterdir()))

    def test_corrupted_download_is_not_published(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            base=Path(tmp)
            with patch.object(mod,'VOICES_DIR',base/'voices'):
                manager=mod.ModelManager()
            r=response();r.iter_content.return_value=[b'bad']
            with patch.object(mod,'open_download',return_value=r):
                with self.assertRaises(mod.ModelError):manager._download('https://drive.google.com/uc?id=x',base/'model.pth',3,'0'*64,mod.Job('test'))
            self.assertFalse((base/'model.pth').exists())
            self.assertFalse((base/'model.pth.part').exists())

if __name__=='__main__':unittest.main()
