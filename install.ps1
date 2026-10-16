$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$appData = Join-Path $env:LOCALAPPDATA 'SCNU-MicroRoom-Community'
$runtime = Join-Path $appData 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$nodeExe = Join-Path $runtime 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand -and [int]((& $nodeCommand.Source -p 'process.versions.node.split(".")[0]') | Select-Object -First 1) -ge 22) {
        Copy-Item -LiteralPath $nodeCommand.Source -Destination $nodeExe
    } else {
        Write-Host 'Downloading the official Node.js LTS runtime. This may take a few minutes...'
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $baseUrl = 'https://nodejs.org/dist/latest-v24.x/'
        $checksums = (Invoke-WebRequest -Uri ($baseUrl + 'SHASUMS256.txt') -UseBasicParsing).Content
        $entry = [regex]::Match($checksums, '(?m)^([a-f0-9]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-' + $arch + '\.zip)\s*$')
        if (-not $entry.Success) { throw 'Cannot verify the official runtime download. Please install Node.js LTS from nodejs.org and retry.' }
        $archive = Join-Path $runtime 'node-download.zip'
        Invoke-WebRequest -Uri ($baseUrl + $entry.Groups[2].Value) -OutFile $archive -UseBasicParsing
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Groups[1].Value) { throw 'Runtime checksum mismatch. Installation stopped.' }
        $unpacked = Join-Path $runtime 'unpacked'
        Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force
        $officialNode = Join-Path (Join-Path $unpacked ([IO.Path]::GetFileNameWithoutExtension($entry.Groups[2].Value))) 'node.exe'
        Copy-Item -LiteralPath $officialNode -Destination $nodeExe
        Copy-Item -LiteralPath (Join-Path (Split-Path $officialNode) 'LICENSE') -Destination (Join-Path $runtime 'NODE-LICENSE.txt')
    }
}
$base = $PSScriptRoot
$sh = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) '微格预约助手（共享版）.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    $existing = $sh.CreateShortcut($shortcutPath)
    if ($existing.Arguments -ne ('"' + (Join-Path $base 'Open-Dashboard.vbs') + '"')) { throw 'A shortcut with this name already exists. Keep the app in its original folder.' }
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
} catch { Write-Warning 'Automatic startup could not be registered. Open the desktop shortcut after logging in each day.' }
& (Join-Path $base 'launch.ps1') -Open
Write-Host 'Ready. Enter your OWN school account in the browser. Automatic booking is off until you enable it.'
