Option Explicit
Dim base, fso, sh, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & base & "\launch.ps1"" -Open"
sh.Run cmd, 0, False
