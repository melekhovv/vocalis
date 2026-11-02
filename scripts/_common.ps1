$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Engine = Join-Path $Root 'engine'
$App = Join-Path $Root 'app'
$EnginePython = Join-Path $Engine '.venv\Scripts\python.exe'

function Get-Uv {
    $local = Join-Path $App 'build\bin\uv.exe'
    if (Test-Path $local) { return $local }
    $toolCache = Join-Path $Root '.build-cache\uv'
    New-Item -ItemType Directory -Force $toolCache | Out-Null
    $archive = Join-Path $toolCache 'uv-x86_64-pc-windows-msvc.zip'
    $baseUrl = 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip'
    Invoke-WebRequest -Uri $baseUrl -OutFile $archive
    $checksum = ((Invoke-WebRequest -Uri ($baseUrl + '.sha256')).Content.Trim() -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $checksum.ToUpperInvariant()) { throw 'uv checksum mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $toolCache -Force
    New-Item -ItemType Directory -Force (Split-Path -Parent $local) | Out-Null
    Copy-Item -LiteralPath (Join-Path $toolCache 'uv.exe') -Destination $local
    return $local
}
