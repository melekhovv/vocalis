# Measures per-block inference time for downloaded voices. Extra args go to tests.bench
# (e.g. .\scripts\bench.ps1 custom-your-voice --clip your-recording.wav --preset balanced --cpu).
. "$PSScriptRoot\_common.ps1"
Push-Location $Engine
try { & $EnginePython -m tests.bench @args } finally { Pop-Location }
