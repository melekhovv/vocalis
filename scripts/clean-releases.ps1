[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$ReleaseDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $PSScriptRoot '..\app\release' }

function Assert-PhysicalPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse points are not allowed in release paths: $cursor"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-PhysicalTree([string]$Path, [string]$ExpectedRoot) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if ($resolved -ne $ExpectedRoot -and -not $resolved.StartsWith($ExpectedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unpacked path escaped expected folder' }
    Assert-PhysicalPath $resolved
    foreach ($entry in Get-ChildItem -LiteralPath $resolved -Force) {
        Assert-PhysicalPath $entry.FullName
        if ($entry.PSIsContainer) { Assert-PhysicalTree $entry.FullName $ExpectedRoot }
    }
}

$releaseRoot = [IO.Path]::GetFullPath($ReleaseDirectory).TrimEnd('\', '/')
Assert-PhysicalPath $releaseRoot
if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) { throw 'Release directory is missing; old releases are preserved' }
$previewRoot = Join-Path $releaseRoot 'preview'
Assert-PhysicalPath $previewRoot
$releaseDirectories = @($releaseRoot)
if (Test-Path -LiteralPath $previewRoot -PathType Container) { $releaseDirectories += $previewRoot }
$installerPattern = '^Vocalis-Setup-(\d+\.\d+\.\d+)(?:-[a-zA-Z0-9.-]+)?\.exe$'
$candidates = @($releaseDirectories | ForEach-Object { Get-ChildItem -LiteralPath $_ -Force } | Where-Object { $_.Name -match '^Vocalis-Setup-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.exe(?:\.blockmap)?$' })
if (-not $InstallerPath) {
    $installers = @($candidates | Where-Object { $_.Name -match $installerPattern } | Sort-Object LastWriteTimeUtc -Descending)
    if ($installers.Count -eq 0) { throw 'New installer is missing; old releases are preserved' }
    if ($installers.Count -gt 1 -and $installers[0].LastWriteTimeUtc -eq $installers[1].LastWriteTimeUtc) { throw 'Ambiguous latest installer; use -InstallerPath. Old releases are preserved' }
    $InstallerPath = $installers[0].FullName
}
$selected = [IO.Path]::GetFullPath($InstallerPath)
if ([IO.Path]::GetDirectoryName($selected) -notin $releaseDirectories) { throw 'Installer must be directly inside release or release/preview; releases are preserved' }
$selectedName = [IO.Path]::GetFileName($selected)
if ($selectedName -notmatch $installerPattern) { throw 'Unexpected installer filename; releases are preserved' }
$selectedVersion = [version]$Matches[1]
Assert-PhysicalPath $selected
if (-not (Test-Path -LiteralPath $selected -PathType Leaf)) { throw 'New installer is missing; old releases are preserved' }
if ((Get-Item -LiteralPath $selected).Length -lt 1MB) { throw 'New installer is incomplete; old releases are preserved' }
# Require a PE header, not merely an EXE extension or a short MZ stub.
$stream = [IO.File]::Open($selected, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $reader = New-Object IO.BinaryReader($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'New installer has no MZ header; old releases are preserved' }
    $stream.Position = 0x3C
    $offset = $reader.ReadInt32()
    if ($offset -lt 0x40 -or $offset -gt ($stream.Length - 4)) { throw 'New installer has an invalid PE offset; old releases are preserved' }
    $stream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x4550) { throw 'New installer has no PE header; old releases are preserved' }
} finally { $stream.Dispose() }

# electron-builder writes this manifest after producing the installer. Verify the
# full SHA-512 so a recent but truncated/partially written PE cannot replace a
# working release merely because it has the newest modification timestamp.
$manifestPath = Join-Path ([IO.Path]::GetDirectoryName($selected)) 'latest.yml'
Assert-PhysicalPath $manifestPath
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Installer manifest is missing; old releases are preserved' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw
$manifestNames = [regex]::Matches($manifest, '(?m)^path: *([^\r\n]+)\r?$')
$manifestHashes = [regex]::Matches($manifest, '(?m)^sha512: *([A-Za-z0-9+/=]+)\r?$')
if ($manifestNames.Count -ne 1 -or $manifestHashes.Count -ne 1 -or $manifestNames[0].Groups[1].Value.Trim().Trim('"', "'") -cne $selectedName) { throw 'Installer manifest does not identify selected installer; old releases are preserved' }
$hashStream = [IO.File]::OpenRead($selected)
$sha512 = [Security.Cryptography.SHA512]::Create()
try { $actualSha512 = [Convert]::ToBase64String($sha512.ComputeHash($hashStream)) }
finally { $hashStream.Dispose(); $sha512.Dispose() }
if ($actualSha512 -cne $manifestHashes[0].Groups[1].Value) { throw 'Installer manifest SHA-512 mismatch; old releases are preserved' }

# Preflight all candidates before deleting; only explicit installer + blockmap stay.
$remove = @()
$removeDirectories = @()
foreach ($file in $candidates) {
    Assert-PhysicalPath $file.FullName
    if ($file.PSIsContainer) { throw "Unexpected release directory: $($file.Name)" }
    if ($file.Name -match $installerPattern -and [version]$Matches[1] -gt $selectedVersion) {
        throw 'A newer installer already exists; releases are preserved'
    }
    if ($file.FullName -ne $selected -and $file.FullName -ne "$selected.blockmap") {
        $target = [IO.Path]::GetFullPath($file.FullName)
        if ([IO.Path]::GetDirectoryName($target) -notin $releaseDirectories) { throw 'Release path escaped the expected folder' }
        $remove += $target
    }
}
$selectedDirectory = [IO.Path]::GetDirectoryName($selected)
foreach ($directory in $releaseDirectories) {
    if ($directory -eq $selectedDirectory) { continue }
    foreach ($name in @('latest.yml', 'builder-debug.yml', 'builder-effective-config.yaml', 'SHA256SUMS.txt')) {
        $metadata = Join-Path $directory $name
        if ($directory -eq $releaseRoot -and $name -eq 'SHA256SUMS.txt') { continue }
        if (Test-Path -LiteralPath $metadata) {
            Assert-PhysicalPath $metadata
            if (-not (Test-Path -LiteralPath $metadata -PathType Leaf)) { throw "Unexpected metadata directory: $metadata" }
            $remove += $metadata
        }
    }
    $unpacked = Join-Path $directory 'win-unpacked'
    if (Test-Path -LiteralPath $unpacked) {
        Assert-PhysicalTree $unpacked $unpacked
        if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'Vocalis.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $unpacked 'resources\app.asar') -PathType Leaf)) {
            throw "Unrecognized win-unpacked contents; old releases are preserved: $unpacked"
        }
        $removeDirectories += $unpacked
    }
}
$checksumPath = Join-Path $releaseRoot 'SHA256SUMS.txt'
Assert-PhysicalPath $checksumPath
$checksumStream = [IO.File]::OpenRead($selected)
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha256.ComputeHash($checksumStream)).Replace('-', '').ToLowerInvariant() }
finally { $checksumStream.Dispose(); $sha256.Dispose() }
$checksumName = $selected.Substring($releaseRoot.Length + 1).Replace('\', '/')
$temporaryChecksum = Join-Path $releaseRoot ('.sha256-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    # Verify checksum write access before removing any previous installer.
    [IO.File]::WriteAllText($temporaryChecksum, "$hash  $checksumName`n", (New-Object Text.UTF8Encoding($false)))
    foreach ($target in $remove) {
        Assert-PhysicalPath $target
        Remove-Item -LiteralPath $target -Force
        Write-Host "Removed old release: $([IO.Path]::GetFileName($target))"
    }
    foreach ($target in $removeDirectories) {
        # Recursive deletion is limited to these preflighted, literal-known child
        # directories. Recheck the tree immediately before deletion.
        if ([IO.Path]::GetDirectoryName($target) -notin $releaseDirectories -or [IO.Path]::GetFileName($target) -ne 'win-unpacked') { throw 'Unexpected unpacked deletion target' }
        Assert-PhysicalTree $target $target
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    if (Test-Path -LiteralPath $checksumPath) { [IO.File]::Replace($temporaryChecksum, $checksumPath, [NullString]::Value) }
    else { [IO.File]::Move($temporaryChecksum, $checksumPath) }
    if ($selectedDirectory -eq $releaseRoot -and (Test-Path -LiteralPath $previewRoot -PathType Container)) {
        Assert-PhysicalPath $previewRoot
        if (@(Get-ChildItem -LiteralPath $previewRoot -Force).Count -eq 0) { Remove-Item -LiteralPath $previewRoot -Force }
    }
    Write-Host "Kept release: $selectedName"
} finally {
    if (Test-Path -LiteralPath $temporaryChecksum) { Remove-Item -LiteralPath $temporaryChecksum -Force }
}
