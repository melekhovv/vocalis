# Changelog

## 1.1.0

- Исправлены мигание аватаров и выбор голосов в разделах «Недавние» и «Избранное».
- Панели настроек занимают доступную ширину; длинные пути импорта сокращаются многоточием.
- Добавлена категория «Медийные люди» в библиотеке и импорте моделей.

- Исправлены отмена запуска аудио, освобождение устройств, восстановление настроек и переподключение интерфейса.
- Устранены конфликты установки и запуска движка, зависание выхода и ошибки переключения голосов.
- Исправлены проверки установки и поставка уведомлений о лицензиях.
- README упрощён и дополнен настоящими скриншотами. Подробности: docs/AUDIT-1.1.md.

## 1.0.0

- Исправлены девять замечаний по установке, уведомлениям, прогреву CPU и недавним голосам.
- Сохранены обработка и модели стабильной 0.1.5.
- Атомарная валидация параметров, защита от повторных процессов и цикла перезапусков.
- Установщик и отдельный архив 12 моделей с SHA-256; 28 тестов движка и проверки Electron.

## 0.1.5 — восстановление локальной версии, 2026-11-04

- Возвращены исходные интерфейс, короткие речевые примеры, профили и потоковая обработка 0.1.5.
- Сохранены исправление шкалы F0 и необязательный режим «Чёткая речь» из 0.1.5.
- Более поздние изменения 0.2.x отменены в локальной ветке; резервная копия 0.2.4 сохранена отдельно.
- Исходный EXE не найден: выпуск пересобран по истории изменений и сохранившимся файлам. UI-бандлы совпадают с записанными хешами исходной сборки 0.1.5.
- Упаковка выполняется с --publish never; публикация в сеть не производится.

## 0.2.4 — unified downloadable catalog, 2026-11-03

- Replace the mandatory CC0-only gate with the owner's unified third-party-source policy; retain licence and provenance information without claiming verified rights.
- Add pinned Russian-oriented Maizenberg, Nyamura, GLAD VALAKAS and Ivona Maxim entries, without bundling weights or recordings.
- Resolve downloadable Hugging Face files on the server, support explicit selection within multi-model repositories and independent installed variants.
- Retain download integrity, archive, checkpoint and index validation; support older RVC weight-normalization tensor names.
- Keep one catalog with Russian-first ordering and inspect/download actions for remote search results.

## 0.2.3 — local catalog preview, 2026-11-03

- Add public Hugging Face metadata search, policy-gated model details and a separate local library view.
- Add bounded metadata caching, persistent favorites and explicit provider/offline states.
- Stage model installation atomically; validate pinned sizes/hashes, redirects, ZIP contents, RVC tensor architecture and FAISS indexes.
- Support local ZIP import, cancellation/retry and race-safe model deletion.
- Apply model-aware starting profiles, retain personal tuning and expose three supported quality modes.
- Add independent authorization, malicious-file and UI regressions, source export tooling and release documentation.
- No target voice with verified CC0 source recordings was found in the inspected set; approved download content remains empty. No GitHub publication.

## 0.1.9 — local recovery, 2026-11-02

- Restore the pre-publication realtime audio implementation and UI from recorded source changes.
- Restore the earlier bundled speech previews.
- Retain local installed-model discovery because the complete original download catalog was not preserved.
- This is a rebuilt private recovery, not the original byte-identical installer. No GitHub publication.

## 0.2.2 — 2026-11-02

- Restore the original pitch and RVC profiles for previously installed local voices.
- Repair the saved legacy selection on upgrade while preserving other preferences.
- Stop carrying another model's retrieval/pitch settings into unprofiled imports.
- Preserve rolling speech history across quiet syllables without replaying old audio.
- Report partial output-buffer underruns and rebuild the jitter buffer after a gap.

## 0.2.1 — 2026-11-02

- Detect previously installed local voice models independently of the public download catalog.
- Models remain local and are not bundled in the installer.

## 0.2.0 — 2026-11-02

- First public source release and Windows installer.
- Removed factory character/celebrity voice catalog and bundled audio examples from distribution.
- Added CC0-only approval checks for future factory voice entries.
- User-owned WAV input for previewing imported RVC models.
- Source/build cleanup, license notices and release checks.
- Includes realtime headphone monitoring, long-path truncation in import, responsive settings and safe engine cancellation/restart fixes.
