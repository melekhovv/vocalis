$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"
$python = if (Test-Path -LiteralPath $EnginePython) { $EnginePython } else { 'python' }
& $python -B (Join-Path $PSScriptRoot 'check_release.py')
if ($LASTEXITCODE -ne 0) { throw 'Release checks failed' }
