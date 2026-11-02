"""Public model downloads, including Google Drive's public confirmation form."""
from html.parser import HTMLParser
from urllib.parse import urlparse

ALLOWED_HOSTS = {'huggingface.co', 'drive.google.com', 'drive.usercontent.google.com'}
DRIVE_HOSTS = {'drive.google.com', 'drive.usercontent.google.com'}

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
    host = urlparse(url).hostname
    if host not in ALLOWED_HOSTS or urlparse(url).scheme != 'https':
        raise ValueError('Недоверенный источник модели')
    response = session.get(url, headers=headers or {}, stream=True, timeout=(15, 30))
    if host in DRIVE_HOSTS and response.status_code == 200 and 'text/html' in response.headers.get('Content-Type', ''):
        form = _DownloadForm()
        form.feed(response.text)
        response.close()
        action = urlparse(form.action or '')
        if action.scheme != 'https' or action.hostname != 'drive.usercontent.google.com' or action.path != '/download' or not form.fields.get('id'):
            raise ValueError('Публичная загрузка Google Drive недоступна. Возможно, автор ограничил доступ.')
        response = session.get(form.action, params=form.fields, headers=headers or {}, stream=True, timeout=(15, 30))
        if 'text/html' in response.headers.get('Content-Type', ''):
            response.close()
            raise ValueError('Google Drive не выдал файл: проверьте доступ или лимит скачивания')
    return response
