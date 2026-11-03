# Документация Vocalis

- [Аудит 1.1 и границы проверки](AUDIT-1.1.md)
- [Аудит 1.0](AUDIT-1.0.md)
- [Восстановление 0.1.5](RESTORE-0.1.5.md)

## Разработка

Подготовка: `powershell -NoProfile -File scripts/setup-app.ps1` и `powershell -NoProfile -File scripts/setup-engine.ps1` из корня проекта.

Запуск: `powershell -NoProfile -File scripts/dev.ps1`.

Проверки: `npm --prefix app run typecheck`, `node app/tests/startup.cjs`, `node app/tests/settings.cjs`, `engine/.venv/Scripts/python.exe -m unittest discover -s engine/tests -p "test_*.py"`.

Сборка Windows x64: `powershell -NoProfile -File scripts/build.ps1`. Установщик сохраняется в `app/release`; старые установщики удаляются только после успешной сборки нового. Публикация релиза — отдельное действие.
