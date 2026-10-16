$ErrorActionPreference = 'Stop'
$adapter = Get-NetAdapter -Name WLAN -ErrorAction SilentlyContinue
if (!$adapter -or $adapter.Status -ne 'Up') { '{}' ; exit }
$address = Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress
if (!$address) { '{}' ; exit }

function Resolve-SchoolIPv4([string]$HostName) {
    $query = New-Object 'System.Collections.Generic.List[byte]'
    $query.AddRange([byte[]]@(0x5a,0x3c,0x01,0x00,0,1,0,0,0,0,0,0))
    foreach ($label in $HostName.Split('.')) {
        $query.Add([byte]$label.Length)
        $query.AddRange([Text.Encoding]::ASCII.GetBytes($label))
    }
    $query.AddRange([byte[]]@(0,0,1,0,1))
    foreach ($server in @('223.5.5.5','114.114.114.114')) {
        $udp = $null
        try {
            $udp = New-Object Net.Sockets.UdpClient([Net.Sockets.AddressFamily]::InterNetwork)
            # Windows IP_UNICAST_IF: resolve through WLAN rather than the VPN's fake DNS.
            $udp.Client.SetSocketOption([Net.Sockets.SocketOptionLevel]::IP,[Net.Sockets.SocketOptionName]31,[Net.IPAddress]::HostToNetworkOrder([int]$adapter.ifIndex))
            $udp.Client.ReceiveTimeout = 700
            $udp.Connect($server,53)
            [void]$udp.Send($query.ToArray(),$query.Count)
            $remote = New-Object Net.IPEndPoint([Net.IPAddress]::Any,0)
            $reply = $udp.Receive([ref]$remote)
            if ($reply.Length -lt 12 -or $reply[0] -ne 0x5a -or $reply[1] -ne 0x3c -or ($reply[3] -band 0x0f) -ne 0) { continue }
            $count = ($reply[6] -shl 8) -bor $reply[7]
            $pos = 12
            while ($pos -lt $reply.Length -and $reply[$pos] -ne 0) { $pos += [int]$reply[$pos]+1 }
            $pos += 5
            for ($i=0; $i -lt $count -and $pos+12 -le $reply.Length; $i++) {
                if (($reply[$pos] -band 0xc0) -eq 0xc0) { $pos += 2 }
                else { while ($pos -lt $reply.Length -and $reply[$pos] -ne 0) { $pos += [int]$reply[$pos]+1 }; $pos++ }
                if ($pos+10 -gt $reply.Length) { break }
                $type = ($reply[$pos] -shl 8) -bor $reply[$pos+1]
                $size = ($reply[$pos+8] -shl 8) -bor $reply[$pos+9]
                $pos += 10
                if ($pos+$size -gt $reply.Length) { break }
                if ($type -eq 1 -and $size -eq 4) {
                    $ip = New-Object Net.IPAddress(,[byte[]]$reply[$pos..($pos+3)])
                    if ($ip.ToString() -notmatch '^198\.(18|19)\.') { return $ip.ToString() }
                }
                $pos += $size
            }
        } catch {} finally { if ($udp) { $udp.Close() } }
    }
    return $null
}

$hosts = @{}
foreach ($hostName in @('tstc.scnu.edu.cn','sso.scnu.edu.cn')) {
    $ip = Resolve-SchoolIPv4 $hostName
    if ($ip) { $hosts[$hostName] = $ip }
}
@{ localAddress=$address; hosts=$hosts } | ConvertTo-Json -Compress
