$ErrorActionPreference = 'Stop'
$cleanupScript = Join-Path $PSScriptRoot 'clean-releases.ps1'
$testParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $testParent ('vocalis-clean-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$passed = 0

function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function New-Case([string]$Name) {
    $directory = Join-Path $testRoot $Name
    New-Item -ItemType Directory -Path $directory | Out-Null
    return $directory
}
function New-FakeInstaller([string]$Path, [int]$Size = 1MB) {
    $bytes = New-Object byte[] $Size
    if ($Size -ge 128) {
        $bytes[0] = 0x4D; $bytes[1] = 0x5A; $bytes[0x3C] = 0x40
        $bytes[0x40] = 0x50; $bytes[0x41] = 0x45
    }
    [IO.File]::WriteAllBytes($Path, $bytes)
}
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'Expected cleanup to reject unsafe/incomplete input'
}
function Write-Manifest([string]$Installer) {
    $stream = [IO.File]::OpenRead($Installer)
    $hash = [Security.Cryptography.SHA512]::Create()
    try { $digest = [Convert]::ToBase64String($hash.ComputeHash($stream)) }
    finally { $stream.Dispose(); $hash.Dispose() }
    Set-Content -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($Installer)) 'latest.yml') -Value ("path: " + [IO.Path]::GetFileName($Installer) + "`nsha512: $digest")
}

try {
    $case = New-Case 'preview'
    $selected = Join-Path $case 'Vocalis-Setup-1.2.3-cable-preview.exe'
    $old = Join-Path $case 'Vocalis-Setup-1.2.3.exe'
    New-FakeInstaller $selected
    New-FakeInstaller $old
    Set-Content -LiteralPath "$old.blockmap" -Value 'old'
    Set-Content -LiteralPath "$selected.blockmap" -Value 'keep'
    Set-Content -LiteralPath (Join-Path $case 'unrelated.txt') -Value 'keep'
    Set-Content -LiteralPath (Join-Path $case 'SHA256SUMS.txt') -Value 'stale'
    New-Item -ItemType Directory -Path (Join-Path $case 'win-unpacked') | Out-Null
    Write-Manifest $selected
    & $cleanupScript -InstallerPath $selected -ReleaseDirectory $case
    Assert-True (Test-Path -LiteralPath $selected) 'Selected installer disappeared'
    Assert-True (Test-Path -LiteralPath "$selected.blockmap") 'Selected blockmap disappeared'
    Assert-True (-not (Test-Path -LiteralPath $old)) 'Old same-version installer remained'
    Assert-True (-not (Test-Path -LiteralPath "$old.blockmap")) 'Old blockmap remained'
    Assert-True (Test-Path -LiteralPath (Join-Path $case 'unrelated.txt')) 'Unrelated file changed'
    Assert-True (Test-Path -LiteralPath (Join-Path $case 'win-unpacked')) 'Unpacked directory changed'
    $expected = (Get-FileHash -LiteralPath $selected).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($selected)
    Assert-True ((Get-Content -LiteralPath (Join-Path $case 'SHA256SUMS.txt') -Raw).Trim() -eq $expected) 'Checksum list is not synchronized'
    $passed++

    foreach ($invalid in @('missing', 'truncated', 'bad-header', 'newer-present', 'outside', 'missing-manifest', 'wrong-hash')) {
        $case = New-Case $invalid
        $old = Join-Path $case 'Vocalis-Setup-1.0.0.exe'
        $selected = Join-Path $case 'Vocalis-Setup-1.2.3.exe'
        New-FakeInstaller $old
        if ($invalid -eq 'truncated') { New-FakeInstaller $selected 128 }
        elseif ($invalid -eq 'bad-header') { [IO.File]::WriteAllBytes($selected, (New-Object byte[] 1MB)) }
        elseif ($invalid -ne 'missing') { New-FakeInstaller $selected }
        if ($invalid -eq 'newer-present') { New-FakeInstaller (Join-Path $case 'Vocalis-Setup-9.0.0-preview.exe') }
        if ($invalid -eq 'outside') { $selected = Join-Path $testRoot 'Vocalis-Setup-1.2.3.exe'; New-FakeInstaller $selected }
        if (Test-Path -LiteralPath $selected) {
            if ($invalid -ne 'missing-manifest') { Write-Manifest $selected }
            if ($invalid -eq 'wrong-hash') { Set-Content -LiteralPath (Join-Path $case 'latest.yml') -Value "path: Vocalis-Setup-1.2.3.exe`nsha512: AAAA" }
        }
        Assert-Rejected { & $cleanupScript -InstallerPath $selected -ReleaseDirectory $case }
        Assert-True (Test-Path -LiteralPath $old) "Old installer removed in rejected $invalid case"
        $passed++
    }

    $case = New-Case 'default-newest-preview'
    $preview = Join-Path $case 'preview'
    New-Item -ItemType Directory -Path $preview | Out-Null
    $selected = Join-Path $preview 'Vocalis-Setup-1.2.3-preview.exe'
    New-FakeInstaller $selected
    New-FakeInstaller (Join-Path $case 'Vocalis-Setup-0.0.1-preview.exe')
    (Get-Item -LiteralPath $selected).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(1)
    $oldUnpacked = Join-Path $case 'win-unpacked'
    New-Item -ItemType Directory -Path (Join-Path $oldUnpacked 'resources') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $oldUnpacked 'Vocalis.exe') -Value 'old'
    Set-Content -LiteralPath (Join-Path $oldUnpacked 'resources\app.asar') -Value 'old'
    Set-Content -LiteralPath (Join-Path $case 'latest.yml') -Value 'stale'
    Write-Manifest $selected
    & $cleanupScript -ReleaseDirectory $case
    Assert-True (Test-Path -LiteralPath $selected) 'Default did not preserve newest preview installer'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $case 'Vocalis-Setup-0.0.1-preview.exe'))) 'Default did not remove old preview'
    Assert-True (-not (Test-Path -LiteralPath $oldUnpacked)) 'Old unpacked app remained'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $case 'latest.yml'))) 'Old metadata remained'
    Assert-True ((Get-Content -LiteralPath (Join-Path $case 'SHA256SUMS.txt') -Raw) -match 'preview/Vocalis-Setup-1.2.3-preview.exe') 'Preview checksum did not use relative path'
    $passed++

    $case = New-Case 'root-replaces-preview'
    $preview = Join-Path $case 'preview'
    New-Item -ItemType Directory -Path (Join-Path $preview 'win-unpacked\resources') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $preview 'win-unpacked\Vocalis.exe') -Value 'old'
    Set-Content -LiteralPath (Join-Path $preview 'win-unpacked\resources\app.asar') -Value 'old'
    $selected = Join-Path $case 'Vocalis-Setup-1.2.3.exe'
    New-FakeInstaller $selected
    New-FakeInstaller (Join-Path $preview 'Vocalis-Setup-1.2.3-preview.exe')
    foreach ($name in @('latest.yml', 'builder-debug.yml', 'SHA256SUMS.txt')) { Set-Content -LiteralPath (Join-Path $preview $name) -Value 'stale' }
    Write-Manifest $selected
    & $cleanupScript -ReleaseDirectory $case -InstallerPath $selected
    Assert-True (-not (Test-Path -LiteralPath $preview)) 'Empty obsolete preview directory remained'
    Assert-True (Test-Path -LiteralPath $selected) 'Root replacement disappeared'
    $passed++

    $case = New-Case 'unknown-unpacked'
    $preview = Join-Path $case 'preview'
    New-Item -ItemType Directory -Path (Join-Path $preview 'win-unpacked') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $preview 'win-unpacked\unrelated.txt') -Value 'keep'
    $selected = Join-Path $case 'Vocalis-Setup-1.2.3.exe'
    $old = Join-Path $preview 'Vocalis-Setup-1.0.0.exe'
    New-FakeInstaller $selected
    New-FakeInstaller $old
    Write-Manifest $selected
    Assert-Rejected { & $cleanupScript -ReleaseDirectory $case -InstallerPath $selected }
    Assert-True (Test-Path -LiteralPath $old) 'Preflight failure removed an old installer'
    Assert-True (Test-Path -LiteralPath (Join-Path $preview 'win-unpacked\unrelated.txt')) 'Unknown unpacked directory changed'
    $passed++

    $case = New-Case 'reparse'
    $selected = Join-Path $case 'Vocalis-Setup-1.2.3.exe'
    New-FakeInstaller $selected
    $junction = Join-Path $testRoot 'release-junction'
    New-Item -ItemType Junction -Path $junction -Target $case | Out-Null
    try {
        Assert-Rejected { & $cleanupScript -ReleaseDirectory $junction -InstallerPath (Join-Path $junction 'Vocalis-Setup-1.2.3.exe') }
        Assert-True (Test-Path -LiteralPath $selected) 'Junction target changed'
    } finally {
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($junction)) -ne $testRoot) { throw 'Unsafe test junction path' }
        [IO.Directory]::Delete($junction)
    }
    $passed++
    Write-Host "PASS: $passed cleanup scenarios; production release directory was not touched."
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if ([IO.Path]::GetDirectoryName($resolvedTestRoot) -ne $testParent -or [IO.Path]::GetFileName($resolvedTestRoot) -notmatch '^vocalis-clean-test-[a-f0-9]{32}$') { throw 'Unsafe temporary test path' }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
