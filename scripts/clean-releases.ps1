$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'app\release'))
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'app\package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected version format' }
$currentInstaller = Join-Path $releaseRoot "Vocalis-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $currentInstaller -PathType Leaf)) { throw 'New installer is missing; old releases are preserved' }
if ((Get-Item -LiteralPath $currentInstaller).Length -lt 1MB) { throw 'New installer is incomplete; old releases are preserved' }
foreach ($file in Get-ChildItem -LiteralPath $releaseRoot -File) {
    if ($file.Name -match '^Vocalis-Setup-(\d+\.\d+\.\d+)\.exe(?:\.blockmap)?$' -and $Matches[1] -ne $version) {
        $resolved = [IO.Path]::GetFullPath($file.FullName)
        if ([IO.Path]::GetDirectoryName($resolved) -ne $releaseRoot) { throw 'Release path escaped the expected folder' }
        Remove-Item -LiteralPath $resolved -Force
        Write-Host "Removed old release: $($file.Name)"
    }
}
