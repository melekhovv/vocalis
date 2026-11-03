# Runs the app in development mode (renderer hot reload; engine from engine\.venv).
. "$PSScriptRoot\_common.ps1"
if (-not (Test-Path $EnginePython)) { throw 'Engine Python environment is missing. Run scripts\setup-engine.ps1 first.' }
Push-Location $App
try { npx electron-vite dev } finally { Pop-Location }
