[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DestinationDirectory,
    [string]$SourceDirectory,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if (-not $SourceDirectory) { $SourceDirectory = Join-Path $PSScriptRoot '..' }

function Assert-NoReparse([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse point in export path: $cursor" }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

$sourceRoot = [IO.Path]::GetFullPath($SourceDirectory).TrimEnd('\', '/')
$requestedDestination = [IO.Path]::GetFullPath($DestinationDirectory).TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw 'Source directory is missing' }
if ($sourceRoot -eq $requestedDestination -or $requestedDestination.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or $sourceRoot.StartsWith($requestedDestination + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Export destination must be outside the source tree and must not contain it' }
if ([IO.Path]::GetDirectoryName($requestedDestination) -eq $null) { throw 'Cannot export to a filesystem root' }
Assert-NoReparse $sourceRoot
Assert-NoReparse $requestedDestination

# Explicitly select source subtrees. Never walk the project root, .git, local
# storage, runtime environments, research/acquisition folders, or build output.
$trees = @('app/src', 'app/tests', 'engine/vcengine', 'engine/vendor', 'engine/tests', 'engine/profiles', 'docs', 'catalog', '.github')
$singleFiles = @('LICENSE', '.gitignore', '.gitattributes', 'app/package.json', 'app/package-lock.json', 'app/components.json', 'app/.oxlintrc.json', 'app/electron-builder.yml', 'app/electron.vite.config.ts', 'app/tsconfig.json', 'app/build/icon.ico', 'app/build/icon.png', 'app/build/license.txt', 'app/build/THIRD_PARTY_NOTICES.txt', 'app/build/make_icon.py', 'engine/pyproject.toml', 'engine/uv.lock')
$allowedExtensions = @('.py', '.ts', '.tsx', '.js', '.cjs', '.mjs', '.css', '.html', '.svg', '.json', '.toml', '.lock', '.md', '.txt', '.yml', '.yaml', '.ps1', '.psm1', '.sh')
$forbiddenSegments = '^(?:\.git|node_modules|\.?venv|\.qa-venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache|cache|caches|out|output|release|dist|build|assets|models|model-downloads|recordings|audio|samples|secrets|credentials|preview-test-.*|qa-.*|research-.*|\.build-.*)$'
$forbiddenExtensions = @('.pth', '.pt', '.onnx', '.bin', '.index', '.ckpt', '.safetensors', '.wav', '.mp3', '.flac', '.ogg', '.m4a', '.mp4', '.zip', '.7z', '.exe', '.dll', '.sys', '.cat', '.pem', '.key', '.pfx', '.p12', '.log', '.tmp', '.pyc')
$paths = New-Object 'Collections.Generic.List[string]'
$script:excludedCount = 0

function Add-SourceFile([string]$Relative, [bool]$Explicit = $false) {
    $relativeName = $Relative.Replace('\', '/')
    $full = Join-Path $sourceRoot $relativeName
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return }
    Assert-NoReparse $full
    $name = [IO.Path]::GetFileName($full)
    $extension = [IO.Path]::GetExtension($full).ToLowerInvariant()
    if ($name -match '^\.env(?:\.|$)' -or $name -match '^(?:credentials|secrets?)(?:\.|$)' -or $extension -in $forbiddenExtensions) { $script:excludedCount++; return }
    if ($Explicit -or $extension -in $allowedExtensions -or $name -match '^LICENSE(?:[.-].*)?$') { $paths.Add($relativeName) }
    else { $script:excludedCount++ }
}

function Add-SourceTree([string]$Relative) {
    $full = Join-Path $sourceRoot $Relative
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { return }
    Assert-NoReparse $full
    foreach ($entry in Get-ChildItem -LiteralPath $full -Force) {
        if ($entry.PSIsContainer) {
            if ($entry.Name -match $forbiddenSegments) { $script:excludedCount++; continue }
            Add-SourceTree ($Relative + '/' + $entry.Name)
        } else { Add-SourceFile ($Relative + '/' + $entry.Name) }
    }
}

foreach ($relative in $singleFiles) { Add-SourceFile $relative $true }
foreach ($rootMarkdown in Get-ChildItem -LiteralPath $sourceRoot -File -Filter '*.md') { Add-SourceFile $rootMarkdown.Name }
foreach ($tree in $trees) { Add-SourceTree $tree }
# Historical model-acquisition Python scripts are intentionally private/ignored
# by this project's .gitignore. Only the maintained release checker is exported.
if (Test-Path -LiteralPath (Join-Path $sourceRoot 'scripts') -PathType Container) {
    foreach ($scriptFile in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'scripts') -File -Filter '*.ps1') { Add-SourceFile ('scripts/' + $scriptFile.Name) }
    Add-SourceFile 'scripts/check_release.py'
}

$required = @('README.md', 'LICENSE', 'MODEL_POLICY.md', 'THIRD_PARTY_LICENSES.md', 'app/package.json', 'app/package-lock.json', 'app/electron-builder.yml', 'app/electron.vite.config.ts', 'app/tsconfig.json', 'engine/pyproject.toml', 'engine/uv.lock', 'engine/vcengine/__init__.py', 'scripts/setup-app.ps1', 'scripts/setup-engine.ps1', 'scripts/build.ps1', 'scripts/_common.ps1', 'scripts/clean-releases.ps1', 'scripts/check_release.py', 'docs/ARCHITECTURE.md', 'docs/TESTING.md', 'catalog/voices.json', 'catalog/sources.json')
$selectedPaths = @($paths | Sort-Object -Unique)
foreach ($relative in $required) { if ($relative -notin $selectedPaths) { throw "Required source file is missing: $relative" } }

# Scan and snapshot bytes before creating any destination. Nothing is copied
# from a later, unvalidated file read, and no private content is printed.
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$snapshots = New-Object 'Collections.Generic.List[object]'
$totalBytes = 0L
$secretPattern = '(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)'
$personalPathPattern = '(?i)[a-z]:[/\\]+Users[/\\]+|/(?:Users|home)/[a-z0-9_.-]+/'
foreach ($relative in $selectedPaths) {
    $full = Join-Path $sourceRoot $relative
    if ((Get-Item -LiteralPath $full).Length -ge 10MB) { throw "Unexpected large source file: $relative" }
    $bytes = [IO.File]::ReadAllBytes($full)
    $totalBytes += $bytes.Length
    if ($totalBytes -gt 128MB) { throw 'Unexpected source size; review export allowlist' }
    if ($relative -notin @('app/build/icon.ico', 'app/build/icon.png')) {
        $content = $utf8.GetString($bytes)
        if ($content -match $secretPattern) { throw "Possible secret in source file: $relative" }
        if ($content -match $personalPathPattern) { throw "Personal absolute path in source file: $relative" }
        if ($content.IndexOf([char]0) -ge 0) { throw "Unexpected binary source file: $relative" }
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    $snapshots.Add([pscustomobject]@{ path = $relative; bytes = $bytes; size = $bytes.Length; sha256 = $digest })
}

$destination = $requestedDestination
$suffix = 1
while (Test-Path -LiteralPath $destination) {
    $destination = $requestedDestination + '-' + $suffix.ToString('000')
    $suffix++
}
Assert-NoReparse $destination
if ($DryRun) {
    [pscustomobject]@{ destination = $destination; files = $snapshots.Count; bytes = $totalBytes; excludedEntries = $script:excludedCount; dryRun = $true }
    return
}

New-Item -ItemType Directory -Path $destination -ErrorAction Stop | Out-Null
$incomplete = Join-Path $destination '.export-incomplete'
[IO.File]::WriteAllText($incomplete, 'Export in progress. Do not publish until SOURCE_MANIFEST.json and SHA256SUMS.txt are verified.', $utf8)
foreach ($file in $snapshots) {
    $target = Join-Path $destination $file.path
    if (-not [IO.Path]::GetFullPath($target).StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Export file escaped destination' }
    $parentDirectory = [IO.Path]::GetDirectoryName($target)
    if (-not (Test-Path -LiteralPath $parentDirectory)) { New-Item -ItemType Directory -Path $parentDirectory -Force | Out-Null }
    Assert-NoReparse $parentDirectory
    if (Test-Path -LiteralPath $target) { throw 'Refusing to overwrite an export file' }
    [IO.File]::WriteAllBytes($target, $file.bytes)
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Export hash mismatch: $($file.path)" }
}
$package = $utf8.GetString(($snapshots | Where-Object path -eq 'app/package.json').bytes) | ConvertFrom-Json
$manifest = [ordered]@{ format = 1; project = 'Vocalis'; version = $package.version; exportedAtUtc = [DateTime]::UtcNow.ToString('o'); files = @($snapshots | Select-Object path, size, sha256) }
$manifestPath = Join-Path $destination 'SOURCE_MANIFEST.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), $utf8)
$checksumLines = @($snapshots | ForEach-Object { "$($_.sha256)  $($_.path)" })
$checksumLines += (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() + '  SOURCE_MANIFEST.json'
[IO.File]::WriteAllText((Join-Path $destination 'SHA256SUMS.txt'), (($checksumLines -join "`n") + "`n"), $utf8)
# The only deletion is this script's own fixed marker in its newly created folder.
Remove-Item -LiteralPath $incomplete -Force
[pscustomobject]@{ destination = $destination; files = $snapshots.Count; bytes = $totalBytes; excludedEntries = $script:excludedCount; dryRun = $false }
