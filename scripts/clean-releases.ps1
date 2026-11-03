$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'app\release'))
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'app\package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected version format' }
$currentInstaller = Join-Path $releaseRoot "Vocalis-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $currentInstaller -PathType Leaf)) { throw 'New installer is missing; old releases are preserved' }
if ((Get-Item -LiteralPath $currentInstaller).Length -lt 1MB) { throw 'New installer is incomplete; old releases are preserved' }
# --publish never does not refresh electron-builder's update metadata. Keep all
# local release metadata tied to the installer that actually finished building.
$installer = Get-Item -LiteralPath $currentInstaller
$sha512Algorithm = [Security.Cryptography.SHA512]::Create()
$installerStream = [IO.File]::OpenRead($currentInstaller)
try {
    $sha512 = [Convert]::ToBase64String($sha512Algorithm.ComputeHash($installerStream))
} finally {
    $installerStream.Dispose()
    $sha512Algorithm.Dispose()
}
$latest = @(
    "version: $version", 'files:', "  - url: $($installer.Name)",
    "    sha512: $sha512", "    size: $($installer.Length)",
    "path: $($installer.Name)", "sha512: $sha512",
    "releaseDate: $($installer.LastWriteTimeUtc.ToString('o'))"
)
Set-Content -LiteralPath (Join-Path $releaseRoot 'latest.yml') -Value $latest -Encoding ascii
$checksums = foreach ($name in @($installer.Name, ($installer.Name + '.blockmap'))) {
    $artifact = Join-Path $releaseRoot $name
    if (Test-Path -LiteralPath $artifact -PathType Leaf) {
        '{0} *{1}' -f (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant(), $name
    }
}
Set-Content -LiteralPath (Join-Path $releaseRoot 'SHA256SUMS.txt') -Value $checksums -Encoding ascii
foreach ($file in Get-ChildItem -LiteralPath $releaseRoot -File) {
    if ($file.Name -match '^Vocalis-Setup-(\d+\.\d+\.\d+)\.exe(?:\.blockmap)?$' -and $Matches[1] -ne $version) {
        $resolved = [IO.Path]::GetFullPath($file.FullName)
        if ([IO.Path]::GetDirectoryName($resolved) -ne $releaseRoot) { throw 'Release path escaped the expected folder' }
        Remove-Item -LiteralPath $resolved -Force
        Write-Host "Removed old release: $($file.Name)"
    }
}
