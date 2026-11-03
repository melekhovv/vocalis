# Installs the desktop shell dependencies (Electron needs its postinstall to fetch the binary).
. "$PSScriptRoot\_common.ps1"
Push-Location $App
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Could not install app dependencies' }
    if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) {
        node node_modules\electron\install.js
        if ($LASTEXITCODE -ne 0) { throw 'Could not download the Electron runtime' }
    }
    if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) { throw 'Electron runtime is missing after installation' }
    $uv = Get-Uv
    New-Item -ItemType Directory -Force build\bin | Out-Null
    if ([IO.Path]::GetFullPath($uv) -ne [IO.Path]::GetFullPath((Join-Path $App 'build\bin\uv.exe'))) { Copy-Item $uv build\bin\uv.exe -Force }
} finally { Pop-Location }
