param([switch]$Open)
$ErrorActionPreference = 'Stop'
$appData = Join-Path $env:LOCALAPPDATA 'SCNU-MicroRoom-Community'
$nodeCandidates = @((Join-Path $appData 'runtime\node.exe'))
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
$nodeExe = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $nodeExe) { throw 'Please run Install-and-Open.cmd first.' }
$uri = 'http://127.0.0.1:8912/'
$running = $false
try {
    $status = Invoke-RestMethod -Uri ($uri + 'api/status') -TimeoutSec 2
    if ($status.app -ne 'scnu-micro-room-community') { throw 'Port 8912 belongs to another application.' }
    $running = $true
} catch { if ($_.Exception.Message -like 'Port 8912*') { throw } }
if (-not $running) {
    Start-Process -FilePath $nodeExe -ArgumentList @('"' + (Join-Path $PSScriptRoot 'server.js') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}
if ($Open) {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $status = Invoke-RestMethod -Uri ($uri + 'api/status') -TimeoutSec 1
            if ($status.app -eq 'scnu-micro-room-community') { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ready) { throw 'The assistant could not start. Please run Install-and-Open.cmd again.' }
    Start-Process $uri
}
