param([ValidateSet('read','write')] [string]$Mode)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')
if ($Mode -eq 'write') {
    $plain = [Console]::In.ReadToEnd()
    $encrypted = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Write([Convert]::ToBase64String($encrypted))
} else {
    $encrypted = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Write([Text.Encoding]::UTF8.GetString($plain))
}
