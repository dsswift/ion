package fleet

import "github.com/dsswift/ion/engine/internal/studiostatus"

// PowerShell for Windows hosts. Each script runs after psPrelude, so any
// error ends it with its message on stderr.

// windowsUninstallKey is the desktop's uninstall key under HKLM or HKCU.
const windowsUninstallKey = studiostatus.WindowsUninstallKey

// psFindDesktop defines Find-IonDesktop: the desktop's install folder from
// its uninstall key (InstallLocation, else DisplayIcon's folder), else the
// installer's default folders; $null when Ion.exe is in none of them.
const psFindDesktop = `function Find-IonDesktop {
  foreach ($hive in 'HKLM:', 'HKCU:') {
    $e = Get-ItemProperty -LiteralPath (Join-Path $hive '` + windowsUninstallKey + `') -ErrorAction SilentlyContinue
    if (-not $e) { continue }
    $dir = $e.InstallLocation
    if (-not $dir -and $e.DisplayIcon) { $dir = Split-Path -Parent (($e.DisplayIcon -replace ',\d+$', '').Trim('"')) }
    if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'Ion.exe'))) { return $dir }
  }
  foreach ($dir in (Join-Path $env:ProgramFiles 'Ion'), (Join-Path $env:LOCALAPPDATA 'Programs\Ion')) {
    if (Test-Path -LiteralPath (Join-Path $dir 'Ion.exe')) { return $dir }
  }
  return $null
}
`

// psFindIon sets $ion to the host's ion.exe: the Studio Server bundle's, then
// the desktop's bundled engine, then ~\.ion\bin\ion.exe.
const psFindIon = psFindDesktop + `$ion = $null
$candidates = @(Join-Path $env:USERPROFILE '.ion\studio-server\current\bin\ion.exe')
$desktop = Find-IonDesktop
if ($desktop) { $candidates += Join-Path $desktop 'resources\engine\ion.exe' }
$candidates += Join-Path $env:USERPROFILE '.ion\bin\ion.exe'
foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { $ion = $c; break } }
if (-not $ion) { [Console]::Error.WriteLine('no ion binary on this host'); exit 3 }
`

// psDesktopExe sets $exe to the desktop's Ion.exe and defines Get-Ion, its
// running processes.
const psDesktopExe = psFindDesktop + `$desktop = Find-IonDesktop
if (-not $desktop) { [Console]::Error.WriteLine('the Ion desktop is not installed on this host'); exit 3 }
$exe = Join-Path $desktop 'Ion.exe'
function Get-Ion { Get-Process -Name Ion -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } }
`

// psStartInUserSession defines Start-InUserSession: it runs a program in the
// signed-in user's desktop session through a one-shot interactive scheduled
// task. An ssh session is not that session, and a GUI started from it is
// never shown. A task with the default settings never starts on a laptop
// running on battery: it stays Queued and the program never runs, so the
// task allows batteries and the function fails when the task is still
// Queued after 15 seconds.
const psStartInUserSession = `function Start-InUserSession([string]$program, [string]$arguments) {
  $name = 'Ion Fleet ' + [guid]::NewGuid()
  if ($arguments) { $action = New-ScheduledTaskAction -Execute $program -Argument $arguments }
  else { $action = New-ScheduledTaskAction -Execute $program }
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  try {
    Start-ScheduledTask -TaskName $name
    $deadline = (Get-Date).AddSeconds(15)
    while (((Get-ScheduledTask -TaskName $name).State -eq 'Queued') -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 250 }
    if ((Get-ScheduledTask -TaskName $name).State -eq 'Queued') {
      throw "Windows did not start $program in the signed-in user's session: its task is still queued"
    }
    Start-Sleep -Seconds 2
  }
  finally { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
}
`

// psAwaitDesktop fails when Ion is not running 30 seconds after a launch.
const psAwaitDesktop = `$deadline = (Get-Date).AddSeconds(30)
while ((-not (Get-Ion)) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 500 }
if (-not (Get-Ion)) { [Console]::Error.WriteLine('Ion did not start within 30 seconds of its launch'); exit 9 }
`

// psStartDesktop starts Ion in the user's session and waits for it.
const psStartDesktop = psDesktopExe + psStartInUserSession + `Start-InUserSession $exe ''
` + psAwaitDesktop

// psQuitDesktop quits a running Ion: the desktop's forced quit (a second
// launch with --ion-force-quit stops its sessions and engine, no dialog),
// then a forced stop for one still running after a minute, as a desktop
// older than the forced quit is.
const psQuitDesktop = `if (Get-Ion) {
  Start-InUserSession $exe '--ion-force-quit'
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Ion) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 1 }
  if (Get-Ion) { Get-Ion | Stop-Process -Force; Start-Sleep -Seconds 2 }
}
`

// psRestartDesktop quits Ion the way a deploy does and starts it again in
// the user's session.
const psRestartDesktop = psDesktopExe + psStartInUserSession + psQuitDesktop + `Start-InUserSession $exe ''
` + psAwaitDesktop

// psDesktopRunning prints yes or no.
const psDesktopRunning = psDesktopExe + `if (Get-Ion) { 'yes' } else { 'no' }
`
