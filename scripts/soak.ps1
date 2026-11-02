# Long-running live pipeline test. Starts its own engine instance on port 47811.
param([Parameter(Mandatory=$true)][string]$Voice, [double]$Minutes = 10, [string]$Preset = 'balanced')
. "$PSScriptRoot\_common.ps1"
$env:VOCALIS_TOKEN = 'soak-' + [guid]::NewGuid().ToString('N')
$server = Start-Process -FilePath $EnginePython -ArgumentList '-u','-m','vcengine.server','--port','47811' -WorkingDirectory $Engine -PassThru -WindowStyle Hidden
try {
    Start-Sleep -Seconds 15
    Push-Location $Engine
    & $EnginePython -m tests.soak --port 47811 --token $env:VOCALIS_TOKEN --minutes $Minutes --voice $Voice --preset $Preset
} finally {
    Pop-Location
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
