$ErrorActionPreference = 'Stop'
$exportScript = Join-Path $PSScriptRoot 'export-source.ps1'
$testParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $testParent ('vocalis-export-test-' + [guid]::NewGuid().ToString('N'))
$fixture = Join-Path $testRoot 'source'
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$passed = 0
function Write-Fixture([string]$Relative, [string]$Text = 'source') {
    $path = Join-Path $fixture $Relative
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($path)) -Force | Out-Null
    [IO.File]::WriteAllText($path, $Text, $utf8)
}
function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'Expected export to reject unsafe source/destination'
}
try {
    $required = @('AGENTS.md', 'README.md', 'LICENSE', 'MODEL_POLICY.md', 'THIRD_PARTY_LICENSES.md', 'app/package.json', 'app/package-lock.json', 'app/electron-builder.yml', 'app/electron.vite.config.ts', 'app/tsconfig.json', 'engine/pyproject.toml', 'engine/uv.lock', 'engine/vcengine/__init__.py', 'scripts/setup-app.ps1', 'scripts/setup-engine.ps1', 'scripts/build.ps1', 'scripts/_common.ps1', 'scripts/clean-releases.ps1', 'scripts/check_release.py', 'docs/ARCHITECTURE.md', 'docs/TESTING.md', 'docs/TEAM.md', 'catalog/voices.json', 'catalog/sources.json')
    foreach ($profile in @('audio_engineer', 'app_developer', 'ux_designer', 'release_engineer', 'voice_specialist', 'qa_engineer')) { $required += ".codex/agents/$profile.toml" }
    foreach ($relative in $required) { Write-Fixture $relative }
    Write-Fixture 'app/package.json' '{"version":"0.2.3"}'
    Write-Fixture 'app/src/new-untracked.ts' 'export const value = 1'
    Write-Fixture 'engine/tests/test_new.py' '# New untracked test'
    Write-Fixture 'app/build/icon.png' 'icon-fixture'
    foreach ($excluded in @('.git/config', '.env', 'app/node_modules/private.js', 'app/out/generated.js', 'app/release/old.exe', 'app/build/bin/uv.exe', 'app/tests/out/result.json', 'app/src/recording.wav', 'app/src/private.key', 'engine/.venv/private.py', 'engine/assets/voice.wav', 'engine/vcengine/__pycache__/private.pyc', 'engine/tests/out/voice.json', 'scripts/acquire-private-models.py')) { Write-Fixture $excluded 'private fixture' }

    $destination = Join-Path $testRoot 'export'
    $result = & $exportScript -SourceDirectory $fixture -DestinationDirectory $destination -DryRun
    Assert-True $result.dryRun 'Dry run did not report itself'
    Assert-True (-not (Test-Path -LiteralPath $destination)) 'Dry run created destination'
    $passed++

    $result = & $exportScript -SourceDirectory $fixture -DestinationDirectory $destination
    Assert-True (Test-Path -LiteralPath (Join-Path $destination 'app/src/new-untracked.ts')) 'Untracked source was omitted'
    Assert-True (Test-Path -LiteralPath (Join-Path $destination '.codex/agents/qa_engineer.toml')) 'Agent configuration omitted'
    foreach ($excluded in @('.git', '.env', 'app/node_modules', 'app/out', 'app/release', 'app/build/bin', 'app/tests/out', 'app/src/recording.wav', 'app/src/private.key', 'engine/.venv', 'engine/assets', 'engine/vcengine/__pycache__', 'engine/tests/out', 'scripts/acquire-private-models.py', '.export-incomplete')) {
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $destination $excluded))) "Excluded content exported: $excluded"
    }
    $manifest = Get-Content -LiteralPath (Join-Path $destination 'SOURCE_MANIFEST.json') -Raw | ConvertFrom-Json
    Assert-True ($manifest.version -eq '0.2.3') 'Manifest project version mismatch'
    Assert-True ($manifest.files.Count -eq $result.files) 'Manifest count mismatch'
    foreach ($entry in $manifest.files) {
        Assert-True ((Get-FileHash -LiteralPath (Join-Path $destination $entry.path)).Hash.ToLowerInvariant() -eq $entry.sha256) "Manifest hash mismatch: $($entry.path)"
    }
    Assert-True ((Get-Content -LiteralPath (Join-Path $destination 'SHA256SUMS.txt')).Count -eq ($result.files + 1)) 'SHA256 list should include manifest and all source files'
    $passed++

    [IO.File]::WriteAllText((Join-Path $destination 'sentinel.txt'), 'preserve', $utf8)
    $collision = & $exportScript -SourceDirectory $fixture -DestinationDirectory $destination
    Assert-True ($collision.destination -eq ($destination + '-001')) 'Existing destination did not get a unique suffix'
    Assert-True ((Get-Content -LiteralPath (Join-Path $destination 'sentinel.txt') -Raw) -eq 'preserve') 'Existing export was changed'
    $passed++

    $rejectedDestination = Join-Path $testRoot 'rejected'
    Write-Fixture 'app/src/unsafe.ts' ('const token = "' + 'ghp_' + ('a' * 40) + '"')
    Assert-Rejected { & $exportScript -SourceDirectory $fixture -DestinationDirectory $rejectedDestination }
    Assert-True (-not (Test-Path -LiteralPath $rejectedDestination)) 'Secret scan should reject before creating destination'
    Write-Fixture 'app/src/unsafe.ts' ('const path = "C:' + '\Users\private-owner\file.txt"')
    Assert-Rejected { & $exportScript -SourceDirectory $fixture -DestinationDirectory $rejectedDestination }
    Assert-True (-not (Test-Path -LiteralPath $rejectedDestination)) 'Personal path scan should reject before destination creation'
    Write-Fixture 'app/src/unsafe.ts' 'const publicPath = "relative/file.txt"'
    $passed++

    Assert-Rejected { & $exportScript -SourceDirectory $fixture -DestinationDirectory (Join-Path $fixture 'export') }
    Assert-Rejected { & $exportScript -SourceDirectory $fixture -DestinationDirectory $testRoot }
    $passed++

    $junction = Join-Path $fixture 'app/src/linked'
    New-Item -ItemType Junction -Path $junction -Target (Join-Path $fixture 'engine/tests') | Out-Null
    try { Assert-Rejected { & $exportScript -SourceDirectory $fixture -DestinationDirectory $rejectedDestination } }
    finally {
        if (-not [IO.Path]::GetFullPath($junction).StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test junction path' }
        [IO.Directory]::Delete($junction)
    }
    $passed++
    Write-Host "PASS: $passed source export scenarios; production source export was not created."
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    if ([IO.Path]::GetDirectoryName($resolved) -ne $testParent -or [IO.Path]::GetFileName($resolved) -notmatch '^vocalis-export-test-[a-f0-9]{32}$') { throw 'Unsafe export fixture cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
