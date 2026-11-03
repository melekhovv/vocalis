[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$CertificatePath,
    [string]$CertificatePassword,
    [string]$CertSubject,
    [string]$TimestampServer = 'http://timestamp.digicert.com',
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

if (-not $InstallerPath) {
    $latest = Get-ChildItem -Path (Join-Path $App 'release\Vocalis-Setup-*.exe') -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $latest) {
        throw 'No built installer found in app/release/. Build one first using scripts/build.ps1 or specify -InstallerPath.'
    }
    $InstallerPath = $latest.FullName
}

$fullPath = [IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Installer not found at path: $fullPath"
}

if ($VerifyOnly) {
    Write-Host "Verifying signature for $fullPath..." -ForegroundColor Cyan
    $sig = Get-AuthenticodeSignature -LiteralPath $fullPath
    [PSCustomObject]@{
        Path       = $fullPath
        Status     = $sig.Status
        SignerCert = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null }
        Timestamp  = if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { $null }
    } | Format-List
    if ($sig.Status -eq 'Valid') {
        Write-Host "PASS: Signature is valid." -ForegroundColor Green
        exit 0
    } else {
        $statusMsg = if ($sig.StatusMessage) { $sig.StatusMessage } else { "$($sig.Status)" }
        Write-Host "Signature status: $statusMsg" -ForegroundColor Yellow
        exit 1
    }
}

# Code signing workflow
$cert = $null
if ($CertificatePath) {
    if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
        throw "Certificate file not found: $CertificatePath"
    }
    $securePass = if ($CertificatePassword) {
        ConvertTo-SecureString $CertificatePassword -AsPlainText -Force
    } else {
        $null
    }
    $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $CertificatePath,
        $securePass,
        [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
    )
} elseif ($CertSubject) {
    $cert = Get-ChildItem -Path 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\My' -Recurse |
        Where-Object { $_.Subject -like "*$CertSubject*" -and $_.HasPrivateKey } |
        Select-Object -First 1
    if (-not $cert) {
        throw "No certificate found matching subject: $CertSubject with private key."
    }
} else {
    throw 'Specify either -VerifyOnly, -CertificatePath (with optional -CertificatePassword), or -CertSubject.'
}

Write-Host "Signing $fullPath with certificate: $($cert.Subject)..." -ForegroundColor Cyan
$result = Set-AuthenticodeSignature -FilePath $fullPath -Certificate $cert -TimestampServer $TimestampServer -HashAlgorithm SHA256

if ($result.Status -ne 'Valid') {
    $err = if ($result.StatusMessage) { $result.StatusMessage } else { "$($result.Status)" }
    throw "Signing failed with status: $err"
}

Write-Host "SUCCESS: Signed $fullPath (SHA-256 with timestamp from $TimestampServer)" -ForegroundColor Green
