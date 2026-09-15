<#
  Behaviour tests for Remove-IonEngineTasks.ps1.

  Runs anywhere PowerShell does, including the Linux CI runner: the script is
  dot-sourced, which loads its functions and its name constants without
  enumerating anything. Invoked by `make check-windows-scripts`.

  The subject under test is a script that runs elevated and deletes
  machine-global objects belonging to other accounts. Every case below is
  either "this must be deleted" or "this must NOT be deleted", and the second
  kind is the reason the file exists.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Remove-IonEngineTasks.ps1')

$script:failures = 0
function Assert-Equal {
  param($Expected, $Actual, [string] $Because)
  if ($Expected -ne $Actual) {
    Write-Host "FAIL  $Because`n      expected '$Expected', got '$Actual'" -ForegroundColor Red
    $script:failures++
  } else {
    Write-Host "ok    $Because" -ForegroundColor Green
  }
}

# -- Gate 1: Test-IonTaskName -------------------------------------------------
# What uninstall may consider, and just as importantly what it may not. A false
# positive here puts a stranger's scheduled task in front of gate 2.

Assert-Equal $true (Test-IonTaskName 'Ion Engine (S-1-5-21-99-1001)') `
  'a per-user task is Ion'
Assert-Equal $true (Test-IonTaskName '\Ion Engine (S-1-5-21-99-1001)') `
  'a per-user task is Ion when Get-ScheduledTask reports it with a leading path'
Assert-Equal $true (Test-IonTaskName 'Ion Engine (S-1-5-18)') `
  'a short well-known SID is still a valid suffix'
Assert-Equal $true (Test-IonTaskName 'Ion Engine') `
  'the legacy shared task is still removed'
Assert-Equal $true (Test-IonTaskName '\Ion Engine') `
  'the legacy shared task is removed when reported with a leading path'

# Malformed SID suffixes. Each of these is a name a third party could register.
Assert-Equal $false (Test-IonTaskName 'Ion Engine (not-a-sid)') `
  'a parenthesised suffix that is not a SID is not matched'
Assert-Equal $false (Test-IonTaskName 'Ion Engine (S-1-)') `
  'a SID prefix with no digit groups is not matched'
Assert-Equal $false (Test-IonTaskName 'Ion Engine (S-1-5-21-99-1001) evil') `
  'a valid SID followed by more text is not matched'
Assert-Equal $false (Test-IonTaskName 'Ion Engine (S-1-5-21--99)') `
  'a SID with an empty digit group is not matched'
Assert-Equal $false (Test-IonTaskName 'Ion Engine (S-2-5-21-99)') `
  'an authority other than S-1 is not matched'

# Prefix lookalikes. The previous implementation matched on "Ion Engine ("
# alone and would have accepted the first of these.
Assert-Equal $false (Test-IonTaskName 'Ion Engine (something else)') `
  'a prefix lookalike is not matched'
Assert-Equal $false (Test-IonTaskName 'Ion Engine Updater') `
  'a differently-named task is not matched'
Assert-Equal $false (Test-IonTaskName 'Ionosphere') `
  'a task whose name merely starts with Ion is not matched'
Assert-Equal $false (Test-IonTaskName 'OneDrive Reporting Task') `
  'an unrelated task is left alone'
Assert-Equal $false (Test-IonTaskName '') `
  'an empty name matches nothing'
Assert-Equal $false (Test-IonTaskName '\Microsoft\Windows\Ion Engine Something') `
  'a task in another folder whose name only resembles Ion is left alone'

# -- Path containment ---------------------------------------------------------

$roots = @('C:\Program Files\Ion', 'C:\Program Files (x86)\Ion')

Assert-Equal $true (Test-IonPathUnderRoot -Path 'C:\Program Files\Ion\resources\engine\ion.exe' -Roots $roots) `
  'a path inside an accepted root is under it'
Assert-Equal $true (Test-IonPathUnderRoot -Path 'c:\program files\ion\Ion.exe' -Roots $roots) `
  'containment is case-insensitive, as Windows paths are'
Assert-Equal $false (Test-IonPathUnderRoot -Path 'C:\Program Files\Ionosphere\ion.exe' -Roots $roots) `
  'a sibling directory sharing a name prefix is not under the root'
Assert-Equal $false (Test-IonPathUnderRoot -Path 'C:\Users\Public\ion.exe' -Roots $roots) `
  'a path outside every root is not under one'
Assert-Equal $false (Test-IonPathUnderRoot -Path '' -Roots $roots) `
  'an empty path is under nothing'
Assert-Equal $false (Test-IonPathUnderRoot -Path 'C:\Program Files\Ion\ion.exe' -Roots @()) `
  'with no accepted roots nothing is under one'

# -- Gate 2: Test-IonTaskAction -----------------------------------------------
# The gate that makes an elevated delete safe. A task passes only when its
# action proves it launches Ion from an installed Ion directory.

$hostExe = 'C:\Program Files\Ion\resources\engine\ion-engine-host.exe'
$engineExe = 'C:\Program Files\Ion\resources\engine\ion.exe'

Assert-Equal $true (Test-IonTaskAction -Command $hostExe -Arguments "`"$engineExe`" serve --supervised" -Roots $roots) `
  'a valid per-user action (host launcher + quoted engine + serve --supervised) verifies'
Assert-Equal $true (Test-IonTaskAction -Command $engineExe -Arguments 'serve --supervised' -Roots $roots) `
  'a valid legacy action (direct ion.exe exec) verifies'
Assert-Equal $true (Test-IonTaskAction -Command 'C:\Program Files (x86)\Ion\resources\engine\ion.exe' -Arguments 'serve --supervised' -Roots $roots) `
  'the legacy x86 install root is accepted'

Assert-Equal $false (Test-IonTaskAction -Command 'C:\Users\Public\Tools\ion-engine-host.exe' -Arguments "`"$engineExe`" serve --supervised" -Roots $roots) `
  'a foreign action outside every install root does not verify'
Assert-Equal $false (Test-IonTaskAction -Command $hostExe -Arguments '"C:\Users\Public\evil.exe" serve --supervised' -Roots $roots) `
  'a host launcher pointed at a binary outside the install root does not verify'
Assert-Equal $false (Test-IonTaskAction -Command $hostExe -Arguments '"C:\Program Files\Ion\resources\engine\evil.exe" serve --supervised' -Roots $roots) `
  'a host launcher pointed at something that is not ion.exe does not verify'
Assert-Equal $false (Test-IonTaskAction -Command 'C:\Program Files\Ion\notepad.exe' -Arguments 'serve --supervised' -Roots $roots) `
  'an unexpected executable inside the install root does not verify'
Assert-Equal $false (Test-IonTaskAction -Command $engineExe -Arguments 'serve' -Roots $roots) `
  'ion.exe without --supervised does not verify'
Assert-Equal $false (Test-IonTaskAction -Command $engineExe -Arguments '--supervised serve' -Roots $roots) `
  'the verb and the flag out of order do not verify'
Assert-Equal $false (Test-IonTaskAction -Command $engineExe -Arguments 'serve --supervised-elsewhere' -Roots $roots) `
  'a flag that merely starts with --supervised does not verify'
Assert-Equal $false (Test-IonTaskAction -Command $engineExe -Arguments '' -Roots $roots) `
  'an empty argument string does not verify'
Assert-Equal $false (Test-IonTaskAction -Command '' -Arguments 'serve --supervised' -Roots $roots) `
  'an empty command does not verify'
Assert-Equal $false (Test-IonTaskAction -Command $null -Arguments 'serve --supervised' -Roots $roots) `
  'a null command (an unreadable action) does not verify'

# -- Unreadable and foreign actions are skipped, never deleted ----------------
# Get-IonTaskAction returns $null for anything it cannot read, and
# Get-IonTaskCandidate must put that in Skipped rather than Verified. Proved
# here by overriding the reader, which is the only seam a Linux runner has.

function Get-IonTaskAction { param([string] $TaskPath) return $null }
$split = Get-IonTaskCandidate -Paths @('\Ion Engine (S-1-5-21-99-1001)')
Assert-Equal 0 $split.Verified.Count 'a task whose action cannot be read is not verified'
Assert-Equal 1 $split.Skipped.Count 'a task whose action cannot be read is reported as skipped'
Assert-Equal $true ($split.Skipped[0].Reason -like '*could not be read*') `
  'the skip reason names the unreadable action'

function Get-IonTaskAction {
  param([string] $TaskPath)
  return [pscustomobject]@{ Command = 'C:\Windows\System32\cmd.exe'; Arguments = '/c whoami' }
}
$split = Get-IonTaskCandidate -Paths @('\Ion Engine')
Assert-Equal 0 $split.Verified.Count 'a name-matching task with a foreign action is not verified'
Assert-Equal 1 $split.Skipped.Count 'a name-matching task with a foreign action is reported as skipped'

# -- Agreement with the desktop -----------------------------------------------
# The desktop chooses the names and the action; this script has to recognise
# both. They are in different languages in different directories, so nothing
# but a test keeps them in step -- and a divergence orphans a task on every
# host in the fleet, silently, pointing at a binary that no longer exists.

$supervisor = Join-Path $PSScriptRoot '..\..\desktop\src\main\engine-supervisor-schtasks.ts'
if (-not (Test-Path -LiteralPath $supervisor)) {
  Write-Host "FAIL  cannot find the desktop supervisor at $supervisor" -ForegroundColor Red
  $script:failures++
} else {
  $ts = Get-Content -LiteralPath $supervisor -Raw

  $legacy = [regex]::Match($ts, "export const LEGACY_TASK_NAME = '(?<v>[^']+)'")
  Assert-Equal $true $legacy.Success 'the desktop still exports LEGACY_TASK_NAME'
  Assert-Equal $LegacyTaskName $legacy.Groups['v'].Value `
    'the legacy task name matches the desktop'

  # taskNameForSid composes `${LEGACY_TASK_NAME} (${sid})`, so the name this
  # script matches is the legacy name plus a parenthesised SID. Pinning the
  # template rather than a literal means a change to either half fails here.
  $template = [regex]::Match($ts, 'return `(?<v>[^`]+)`')
  Assert-Equal $true $template.Success 'the desktop still composes the task name from a template'
  Assert-Equal '${LEGACY_TASK_NAME} (${sid})' $template.Groups['v'].Value `
    'the desktop composes the name this script matches'
  Assert-Equal "$LegacyTaskName (" $PerUserPrefix `
    'the documented per-user prefix is the legacy name plus the opening parenthesis'

  # The action shape gate 2 accepts is resolveTaskAction()'s output. If the
  # desktop starts registering a different verb, every task in the fleet
  # becomes unverifiable and uninstall silently stops removing anything -- so
  # the two are pinned together.
  Assert-Equal $true ($ts -match 'serve --supervised') `
    'the desktop still registers the action verb this script verifies'
}

$binaryInstall = Join-Path $PSScriptRoot '..\..\desktop\src\main\engine-binary-install.ts'
if (-not (Test-Path -LiteralPath $binaryInstall)) {
  Write-Host "FAIL  cannot find engine-binary-install.ts at $binaryInstall" -ForegroundColor Red
  $script:failures++
} else {
  $install = Get-Content -LiteralPath $binaryInstall -Raw
  $hostName = [regex]::Match($install, "export const ENGINE_HOST_NAME = '(?<v>[^']+)'")
  Assert-Equal $true $hostName.Success 'the desktop still exports ENGINE_HOST_NAME'
  Assert-Equal $EngineHostLeaf $hostName.Groups['v'].Value `
    'the host launcher this script accepts is the one the desktop registers'
}

# -- Agreement with the uninstaller -------------------------------------------
# The NSIS uninstall macro invokes this script by name from a fixed path. A
# rename of either would leave uninstall silently doing nothing.

$nsh = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installer.nsh') -Raw
Assert-Equal $true ($nsh -match 'Remove-IonEngineTasks\.ps1') `
  'the uninstaller still invokes this script'

# The uninstall registration GUID this script reads InstallLocation from is the
# product GUID electron-builder writes the uninstall key under. A divergence
# would silently drop a relocated install out of the accepted roots and leave
# its task behind.
$pkg = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\desktop\package.json') -Raw
Assert-Equal $true ($pkg -match [regex]::Escape($UninstallKeyGuid)) `
  'the uninstall-key GUID matches the product GUID in desktop/package.json'

if ($script:failures -gt 0) {
  Write-Host "`n$($script:failures) failure(s)" -ForegroundColor Red
  exit 1
}
Write-Host "`nRemove-IonEngineTasks.test.ps1: OK" -ForegroundColor Green
exit 0
