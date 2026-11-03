# Typechecks and builds the Windows installer: app\release\Vocalis-Setup-<version>.exe
. "$PSScriptRoot\_common.ps1"
$buildTemp = Join-Path $Root '.build-tmp'
New-Item -ItemType Directory -Path $buildTemp -Force | Out-Null
$env:TEMP = $buildTemp
$env:TMP = $buildTemp
$env:npm_config_cache = Join-Path $Root '.build-cache\npm'
$env:ELECTRON_CACHE = Join-Path $Root '.build-cache\electron'
$env:ELECTRON_BUILDER_CACHE = Join-Path $Root '.build-cache\electron-builder'
Push-Location $App
try {
    if (-not (Test-Path 'build\bin\uv.exe')) { Copy-Item (Get-Uv) build\bin\uv.exe -Force }
    npx tsc --noEmit -p tsconfig.json
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript compilation failed' }
    npm run dist
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build installer' }
    Get-ChildItem release\*.exe | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
} finally { Pop-Location }
