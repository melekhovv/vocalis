# Релиз и чистые исходники

Версия каталога: **0.2.4**. Версия синхронизирована в `app/package.json`,
верхнем уровне и корневом пакете `app/package-lock.json`, `engine/pyproject.toml`,
CPU-профиле, обоих `uv.lock` и `engine/vcengine/__init__.py`. Остальные зависимости
и их хэши при смене версии не обновляются.

## Проверки перед сборкой

Из корня проекта выполните проверки из `docs/TESTING.md`, включая проверки
каталога, UI, жизненного цикла и экспорта. Версии Python-конфигураций:

```powershell
app/build/bin/uv.exe lock --check --project engine
app/build/bin/uv.exe lock --check --project engine/profiles/cpu
powershell -NoProfile -File scripts/test-clean-releases.ps1
powershell -NoProfile -File scripts/test-export-source.ps1
```

Аппаратную проверку микрофона, CUDA, задержки и виртуального кабеля проводите
отдельно. Автоматические тесты не подтверждают качество реального звучания.
Не устанавливайте драйвер и не публикуйте релиз в рамках проверки сборки.

## Windows-установщик

После завершения интеграции и QA:

```powershell
.\scripts\build.ps1
```

Результат: `app/release/Vocalis-Setup-0.2.4.exe`, соответствующие `.blockmap`,
`latest.yml`, `win-unpacked` и `SHA256SUMS.txt`. Штатная команда выполняет
TypeScript-проверку, frontend/Electron build, NSIS packaging и `postdist`.
`clean-releases.ps1` проверяет SHA-512 из `latest.yml` и оставляет выбранную
сборку; старые установщики и распакованные приложения очищаются по правилам,
описанным в README. Прямой запуск `electron-builder` обходит эту процедуру.

Если установка создана, но завершающее удаление старых артефактов запрещено
средой или файлы заняты, сохраните новую сборку и отдельно сообщите об ошибке
очистки. Не обходите запрет удаления другими shell/API и не утверждайте, что
установщик не создан, если он существует и проходит проверку манифеста.

В EXE входят исходники движка, закреплённые конфигурации зависимостей, код UI,
Electron, uv и лицензии. Python, PyTorch и базовые RVC-нейросети скачиваются
при первом использовании. Целевые голосовые модели, записи, runtime-окружения,
кэши и драйвер VB-CABLE в EXE не входят. Персональные данные остаются вне папки
установки. Проверка обновления не должна удалять локальную библиотеку.

### Цифровая подпись (Code Signing)

Конфигурация `app/electron-builder.yml` поддерживает подпись исполняемых файлов
и NSIS-установщика по алгоритму SHA-256 через стандартные переменные окружения:
`CSC_LINK` (путь к `.pfx` или base64) и `CSC_KEY_PASSWORD`. При их отсутствии
сборка остаётся неподписанной для локальной разработки.

Проверка подписи существующего установщика:

```powershell
powershell -NoProfile -File scripts/sign-release.ps1 -VerifyOnly
```

Подпись готового установщика локальным сертификатом или из хранилища Windows:

```powershell
# Из файла PFX
powershell -NoProfile -File scripts/sign-release.ps1 -CertificatePath 'C:\path\to\cert.pfx' -CertificatePassword 'pass'

# Из хранилища сертификатов Windows
powershell -NoProfile -File scripts/sign-release.ps1 -CertSubject 'My Code Signing Certificate'
```

### Непрерывная интеграция (CI/CD)

В репозитории настроен GitHub Actions workflow `.github/workflows/ci.yml`:
1. **Lint & Static Checks**: `npm run typecheck`, `npm run lint` (oxlint), `ruff check engine/vcengine`, `pyright`, проверка lockfiles, целостности релиза и скриптов очистки/экспорта.
2. **Automated Tests**: запуск тестов оболочки (lifecycle + cable) и 77 тестов движка в изолированном CPU-окружении.
3. **Package Windows Installer**: сборка NSIS-установщика, подпись при наличии секретов `CSC_LINK` / `CSC_KEY_PASSWORD` и публикация артефакта сборки.

## Чистая папка проекта

Экспорт не создаёт Git-репозиторий и ничего не отправляет в сеть. Используется
явный список исходных директорий, а не `git ls-files`: новые незакоммиченные
исходники и тесты также сохраняются.

Сначала проверка без создания папки:

```powershell
powershell -NoProfile -File scripts/export-source.ps1 -DestinationDirectory 'D:\Vocalis-Catalog-Source-20261103' -DryRun
```

После финальной документации и QA повторите команду без `-DryRun`. Если папка
уже существует, выбирается свободное имя с суффиксом `-001`, `-002` и далее;
существующие файлы не перезаписываются. Путь назначения должен находиться вне
исходного проекта. Экспорт отказывается работать через ссылки/junctions.

Состав: `app/src`, тесты приложения, конфигурации и lockfile, иконки и notices;
`engine/vcengine`, `vendor` с лицензией, тесты, профили и lockfiles; PowerShell
скрипты и `check_release.py`; `docs`, `catalog`, `.github` при наличии;
`AGENTS.md`, `.codex/agents`, корневые Markdown-документы, LICENSE и Git-ignore
правила. Старые локальные Python-скрипты приобретения моделей не экспортируются,
как предусмотрено `.gitignore`.

Исключаются `.git`, node_modules, окружения, выходные файлы сборки, кэши,
локальные модели, audio/assets, записи, скачанные архивы, исполняемые файлы,
секреты и env-файлы. Пакет содержит исходник генератора иконок и notices;
`app/build/bin/uv.exe` не экспортируется, его получает `setup-app.ps1`.

До записи выполняются проверка обязательных файлов и профилей, ограничения
размеров, поиск известных форматов секретов и абсолютных личных путей.
Содержимое файлов в сообщения об ошибках не выводится. Проверка шаблонами
не заменяет ручную проверку перед будущей публикацией.

Экспорт содержит `SOURCE_MANIFEST.json` с версией, относительными путями,
размерами и SHA-256 каждого файла. `SHA256SUMS.txt` включает исходники и сам
манифест. Проверка хэшей из папки экспорта:

```powershell
$manifest = Get-Content SOURCE_MANIFEST.json -Raw | ConvertFrom-Json
foreach ($entry in $manifest.files) {
    if ((Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
        throw "Изменён файл: $($entry.path)"
    }
}
```

Если экспорт прерван, остаётся `.export-incomplete`; такую папку нельзя считать
готовой. Скрипт не удаляет частичный экспорт автоматически. Завершённую папку
можно проверить `scripts/check_release.py` даже без `.git`, затем установить
зависимости и собрать по README. Публикация на GitHub требует отдельного
поручения владельца.
