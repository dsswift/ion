# Returns a Windows test machine to "Ion was never installed", so the next
# smoke run exercises a true first launch. The smoke test's own uninstall
# deliberately keeps user data and machine policy; this removes those too.
# For a test VM only: it deletes %USERPROFILE%\.ion unless -KeepUserData
# moves it aside instead.
[CmdletBinding()]
param(
  [switch] $KeepUserData
)
$ErrorActionPreference = 'Stop'

$AppGuid = '7b1e4b3a-5d2c-4c7e-9f0a-2e6d8c1b4a53'
$UninstallKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$AppGuid"
$InstallDir = Join-Path $env:ProgramFiles 'Ion'
$ProgramDataIon = Join-Path $env:ProgramData 'Ion'
$PolicyKey = 'HKLM:\SOFTWARE\Policies\IonEngine'
$IonHome = Join-Path $env:USERPROFILE '.ion'
$RemoveTasks = Join-Path $PSScriptRoot '..\..\desktop\packaging-windows\Remove-IonEngineTasks.ps1'

function Say([string] $message) { Write-Host "reset: $message" }

$procs = @(Get-Process -Name 'Ion', 'ion', 'ion-engine-host' -ErrorAction SilentlyContinue)
$procs | Stop-Process -Force
Say "stopped $($procs.Count) Ion process(es)"

$quiet = (Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction SilentlyContinue).QuietUninstallString
if ($quiet) {
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $quiet -Wait -PassThru
  $goneBy = (Get-Date).AddSeconds(60)
  while ((Test-Path -LiteralPath $InstallDir) -and (Get-Date) -lt $goneBy) { Start-Sleep -Seconds 2 }
  Say "uninstalled (exit $($p.ExitCode)); install folder present: $(Test-Path -LiteralPath $InstallDir)"
} else {
  Say 'no installed Ion found'
}
if (Test-Path -LiteralPath $InstallDir) { throw "$InstallDir is still present after uninstall" }

& $RemoveTasks -InstallRoot $InstallDir | Out-Host
# That tool deletes only tasks it can prove launch an installed Ion. A dev
# build registers this account's task against %USERPROFILE%\.ion\bin, so
# remove this account's own task by its exact name.
$ownTask = "Ion Engine ($(([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value))"
if (Get-ScheduledTask -TaskName $ownTask -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $ownTask -Confirm:$false
  Say "removed this account's task: $ownTask"
}
& $RemoveTasks -Detect | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'an Ion Engine scheduled task survived' }

if (Test-Path -LiteralPath $PolicyKey) { Remove-Item -LiteralPath $PolicyKey -Recurse -Force; Say "removed $PolicyKey" }
if (Test-Path -LiteralPath $ProgramDataIon) { Remove-Item -LiteralPath $ProgramDataIon -Recurse -Force; Say "removed $ProgramDataIon" }

if (Test-Path -LiteralPath $IonHome) {
  if ($KeepUserData) {
    $aside = "$IonHome.kept-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Move-Item -LiteralPath $IonHome -Destination $aside
    Say "moved $IonHome to $aside"
  } else {
    Remove-Item -LiteralPath $IonHome -Recurse -Force
    Say "removed $IonHome"
  }
}
Say 'clean'
