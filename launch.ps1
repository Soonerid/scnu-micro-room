param([switch]$Open)
$ErrorActionPreference = 'Stop'
$appData = Join-Path $env:LOCALAPPDATA 'SCNU-MicroRoom-Community'
$nodeCandidates = @((Join-Path $appData 'runtime\node.exe'))
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
$nodeExe = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $nodeExe) { throw '请双击“打开预约助手.cmd”准备运行环境。' }
$uri = 'http://127.0.0.1:8912/'
$running = $false
$responded = $false
$status = $null
try {
    $status = Invoke-RestMethod -Uri ($uri + 'api/status') -TimeoutSec 2
    $responded = $true
} catch { if ($_.Exception.Response) { throw '8912端口已被其他程序占用，请关闭占用程序后重试。' } }
if ($responded) {
    if ($status.app -ne 'scnu-micro-room-community') { throw '8912端口已被其他程序占用，请关闭占用程序后重试。' }
    $running = $true
}
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
    if (-not $ready) { throw '助手未能启动，请重新双击“打开预约助手.cmd”。如仍失败，请检查8912端口是否被占用。' }
    Start-Process $uri
}
