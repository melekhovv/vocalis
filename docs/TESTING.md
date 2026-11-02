# Проверки

Из корня проекта после установки зависимостей:

```powershell
.\scripts\check-release.ps1
cd app
npm run typecheck
npm run build
node --test tests/main-lifecycle.cjs
cd ..\engine
.venv\Scripts\python.exe -B -m unittest discover -s tests -p "test_*.py" -v
```

`app/tests/ui-regression.cjs` дополнительно требует Playwright. Можно задать пути через `PLAYWRIGHT_MODULE` и `BROWSER_EXECUTABLE`. Тест использует фиктивные модели и не открывает микрофон. Снимки из `app/tests/out/` исключены из Git.

Тесты движка используют временное хранилище и синтетический сигнал, созданный в памяти. Реальные голоса или аудиодатасеты для тестов не поставляются. Проверяются лицензирование каталога, импорт, preview собственного WAV, параметры, отмена/перезапуск, работа мониторинга, совместимость моделей и загрузки. Реальное звучание гарнитуры, Discord и сквозная задержка требуют отдельного аппаратного теста.
