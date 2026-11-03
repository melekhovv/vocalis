"""Public model downloads, including Google Drive's public confirmation form."""
from html.parser import HTMLParser
from urllib.parse import urlparse, urljoin

ALLOWED_HOSTS = {'huggingface.co', 'drive.google.com', 'drive.usercontent.google.com'}
DRIVE_HOSTS = {'drive.google.com', 'drive.usercontent.google.com'}
HF_DOWNLOAD_HOSTS = {'huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.hf.co',
                     'cdn-lfs-eu-1.hf.co', 'cas-bridge.xethub.hf.co'}


def _safe_url(url, initial=False):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    trusted = host in ALLOWED_HOSTS if initial else host in ALLOWED_HOSTS | HF_DOWNLOAD_HOSTS or host.endswith('.cdn.hf.co')
    if not trusted or parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Недоверенный источник или перенаправление модели')
    return host


def _request(session, url, headers=None, params=None):
    for _ in range(6):
        _safe_url(url)
        response = session.get(url, params=params, headers=headers or {}, stream=True, timeout=(15, 30), allow_redirects=False)
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        location = response.headers.get('Location')
        response.close()
        if not isinstance(location, str) or not location:
            raise ValueError('Пустое перенаправление модели')
        url = urljoin(url, location)
        _safe_url(url)
        params = None
    raise ValueError('Слишком много перенаправлений модели')

class _DownloadForm(HTMLParser):
    def __init__(self):
        super().__init__()
        self.action = None
        self.fields = {}
        self.active = False
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'form':
            self.active = attrs.get('id') == 'download-form'
            if self.active:
                self.action = attrs.get('action')
        elif tag == 'input' and self.active and attrs.get('type') == 'hidden' and attrs.get('name'):
            self.fields[attrs['name']] = attrs.get('value', '')
    def handle_endtag(self, tag):
        if tag == 'form':
            self.active = False

def open_download(session, url, headers=None):
    host = _safe_url(url, initial=True)
    response = _request(session, url, headers=headers)
    if host in DRIVE_HOSTS and response.status_code == 200 and 'text/html' in response.headers.get('Content-Type', ''):
        form = _DownloadForm()
        form.feed(response.text)
        response.close()
        action = urlparse(form.action or '')
        if action.scheme != 'https' or action.hostname != 'drive.usercontent.google.com' or action.path != '/download' or not form.fields.get('id'):
            raise ValueError('Публичная загрузка Google Drive недоступна. Возможно, автор ограничил доступ.')
        response = _request(session, form.action, params=form.fields, headers=headers)
        if 'text/html' in response.headers.get('Content-Type', ''):
            response.close()
            raise ValueError('Google Drive не выдал файл: проверьте доступ или лимит скачивания')
    return response
