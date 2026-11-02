$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"
& $EnginePython -B (Join-Path $PSScriptRoot 'check_release.py')
if ($LASTEXITCODE -ne 0) { throw 'Release checks failed' }
