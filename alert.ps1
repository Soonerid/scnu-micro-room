param([Parameter(Mandatory=$true)][string]$DataDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\SCNU-MicroRoom-Community-StrongAlert', [ref]$created)
if (-not $created) { $mutex.Dispose(); exit }
$noticeFile = Join-Path $DataDirectory 'notification.json'
$ackFile = Join-Path $DataDirectory 'notification-ack.json'
$healthFile = Join-Path $DataDirectory 'notification-health.json'
$script:shownId = ''; $script:acknowledged = $false; $script:previewId = ''
[xml]$markup = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'alert.xaml'))
$window = [Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($markup))
$window.Icon = Join-Path $PSScriptRoot 'micro-room.ico'
$window.FindName('brandIcon').Source = $window.Icon
$heading = $window.FindName('heading'); $reservations = $window.FindName('reservations')
$extra = $window.FindName('extra'); $footnote = $window.FindName('footnote')
$area = [Windows.SystemParameters]::WorkArea
$window.Left = [Math]::Max($area.Left, $area.Right - $window.Width - 12)
$window.Top = [Math]::Max($area.Top, $area.Bottom - 370)
$writeAck = {
  if ($script:shownId) { [IO.File]::WriteAllText($ackFile, (@{id=$script:shownId;time=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json), [Text.UTF8Encoding]::new($false)) }
  $script:acknowledged = $true
}
$acknowledge = { & $writeAck; $window.Close() }
$window.FindName('close').Add_Click($acknowledge)
$window.FindName('ack').Add_Click($acknowledge)
$window.FindName('open').Add_Click({ Start-Process 'https://tstc.scnu.edu.cn/#/appointment-record' })
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [timespan]::FromSeconds(1)
$refresh = {
  try {
    $data = [IO.File]::ReadAllText($noticeFile) | ConvertFrom-Json; $n = $data.active
    if (-not $n -or $n.acknowledgedAt) { $script:acknowledged = $true; $window.Close(); return }
    if ($n.id -ne $script:shownId) {
      $script:shownId = $n.id
      $heading.Text = if ($n.test) { '提醒效果预览' } elseif ($n.uncertain) { '部分时段已确认' } elseif ($n.title -match '等待平台审核') { '预约正在等待审核' } else { '教室预约已确认' }
      $items = @($n.records | Group-Object { "$($_.date)|$($_.room)|$($_.building)" } | ForEach-Object {
        $group = @($_.Group | Sort-Object start); $first = $group[0]
        $day = '示例'; $monthWeek = '无实际预约'
        if ($first.date -match '^\d{4}-\d{2}-\d{2}$') {
          $date = [datetime]::ParseExact($first.date,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
          $day = $date.Day.ToString('00'); $week = @('日','一','二','三','四','五','六')[[int]$date.DayOfWeek]
          $monthWeek = "$($date.Month)月 · 周$week"
        }
        [pscustomobject]@{Day=$day;MonthWeek=$monthWeek;Room=$first.room;Building=$first.building;
          Times=(($group | ForEach-Object { "$($_.start)—$($_.end)" }) -join "`n");
          Summary=if($n.test){'演示数据 · 未提交预约'}else{"$($group.Count)个时段 · $(($group.reviewText | Select-Object -Unique) -join ' / ')"}}
      })
      $reservations.ItemsSource = $items
      $extra.Visibility = if ($n.uncertain) { 'Visible' } else { 'Collapsed' }
      $extra.Text = '还有提交结果待核对，请在官网确认。'
      $footnote.Text = if ($n.test) { '效果预览 · 没有占用教室' } else { '静音提醒 · 确认收到不等于完成签到' }
      $window.UpdateLayout()
      $window.Top = [Math]::Max($area.Top, $area.Bottom - $window.ActualHeight - 12)
    }
    [IO.File]::WriteAllText($healthFile, (@{id=$script:shownId;visible=$window.IsVisible;activated=$window.IsActive;left=$window.Left;top=$window.Top;width=$window.ActualWidth;height=$window.ActualHeight;workRight=$area.Right;workBottom=$area.Bottom;quiet=$true;time=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    if ($n.test -and $window.Opacity -gt 0.99 -and $script:previewId -ne $n.id) {
      $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new([int][Math]::Ceiling($window.ActualWidth),[int][Math]::Ceiling($window.ActualHeight),96,96,[Windows.Media.PixelFormats]::Pbgra32)
      $bitmap.Render($window.Content)
      $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new(); $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
      $stream = [IO.File]::Create((Join-Path $PSScriptRoot '提醒预览.png')); try { $encoder.Save($stream) } finally { $stream.Dispose() }
      $script:previewId = $n.id
    }
  } catch { }
}
$timer.Add_Tick($refresh)
$window.Add_Loaded({
  & $refresh
  $fade = [Windows.Media.Animation.DoubleAnimation]::new(0,1,[Windows.Duration]::new([timespan]::FromMilliseconds(180)))
  $window.BeginAnimation([Windows.UIElement]::OpacityProperty,$fade)
  $timer.Start()
})
$window.Add_Closing({ if (-not $script:acknowledged -and $script:shownId) { & $writeAck } })
$application = New-Object Windows.Application; $application.ShutdownMode = 'OnMainWindowClose'
try { $application.Run($window) | Out-Null } finally { $timer.Stop(); $mutex.ReleaseMutex(); $mutex.Dispose() }
