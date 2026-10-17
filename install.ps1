$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$appData = Join-Path $env:LOCALAPPDATA 'SCNU-MicroRoom-Community'
$runtime = Join-Path $appData 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$nodeExe = Join-Path $runtime 'node.exe'
function Test-NodeRuntime($file) {
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    try { $major = & $file -p 'parseInt(process.versions.node)' 2>$null; return ($LASTEXITCODE -eq 0 -and [int]$major -ge 22) } catch { return $false }
}
if (-not (Test-NodeRuntime $nodeExe)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand -and (Test-NodeRuntime $nodeCommand.Source)) {
        Copy-Item -LiteralPath $nodeCommand.Source -Destination $nodeExe
    } else {
        Write-Host '首次准备运行环境，请稍候（仅从 Node.js 官方下载）…'
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $baseUrl = 'https://nodejs.org/dist/latest-v24.x/'
        $checksums = (Invoke-WebRequest -Uri ($baseUrl + 'SHASUMS256.txt') -UseBasicParsing).Content
        $entry = [regex]::Match($checksums, '(?m)^([a-f0-9]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-' + $arch + '\.zip)\s*$')
        if (-not $entry.Success) { throw '无法确认官方下载信息。请从 nodejs.org 安装 Node.js LTS 后重试。' }
        $archive = Join-Path $runtime 'node-download.zip'
        Invoke-WebRequest -Uri ($baseUrl + $entry.Groups[2].Value) -OutFile $archive -UseBasicParsing
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Groups[1].Value) { throw '运行环境校验失败，已停止安装。请重新打开助手。' }
        $unpacked = Join-Path $runtime 'unpacked'
        Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force
        $officialNode = Join-Path (Join-Path $unpacked ([IO.Path]::GetFileNameWithoutExtension($entry.Groups[2].Value))) 'node.exe'
        Copy-Item -LiteralPath $officialNode -Destination $nodeExe
        Copy-Item -LiteralPath (Join-Path (Split-Path $officialNode) 'LICENSE') -Destination (Join-Path $runtime 'NODE-LICENSE.txt')
    }
}
if (-not (Test-NodeRuntime $nodeExe)) { throw '运行环境无法启动，请从 nodejs.org 安装 Node.js LTS 后重试。' }
$base = $PSScriptRoot
$sh = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) '微格预约助手（共享版）.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    $existing = $sh.CreateShortcut($shortcutPath)
    if ($existing.TargetPath -ne (Join-Path $env:WINDIR 'System32\wscript.exe') -or $existing.Arguments -notmatch '\\Open-Dashboard\.vbs"$') { throw '桌面已有同名快捷方式，请先将它改名，再重新打开助手。' }
}
$shortcut = $sh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $base 'Open-Dashboard.vbs') + '"'
$shortcut.WorkingDirectory = $base
$shortcut.IconLocation = (Join-Path $base 'micro-room.ico') + ',0'
$shortcut.Save()
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('"' + (Join-Path $base 'Start-Background.vbs') + '"') -WorkingDirectory $base
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $currentUser), (New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5)))
try {
    Register-ScheduledTask -TaskName 'SCNU-MicroRoom-Community-Watchdog' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
    $wakeSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'SCNU-MicroRoom-Community-BeforeRelease' -Action $action -Trigger (New-ScheduledTaskTrigger -Daily -At '19:58') -Settings $wakeSettings -Principal $principal -Force | Out-Null
} catch { Write-Warning '未能设置自动启动；每天登录电脑后，请打开桌面上的预约助手。' }
& (Join-Path $base 'launch.ps1') -Open
Write-Host '已打开：请填写本人学校账号，选择实际需要的时段，再启用预约。'
