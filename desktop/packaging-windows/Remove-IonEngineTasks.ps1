<#
.SYNOPSIS
  Detects and removes the per-user Ion Engine scheduled tasks on this machine.

.DESCRIPTION
  Ion registers one scheduled task per interactive account, named
  "Ion Engine (<SID>)". Releases before that registered a single shared task
  named "Ion Engine". Both point at an executable inside the installed
  application, so both must go when Ion is uninstalled -- a task left behind
  points at a binary that no longer exists and fires at every sign-in.

  A scheduled task lives in C:\Windows\System32\Tasks, not in the account's
  profile, so an administrator can enumerate and remove every user's task
  regardless of whether that user is signed in and regardless of whether an
  FSLogix profile container is mounted. That is what makes an uninstall on a
  multi-session host complete rather than "complete for whoever ran it".

  IDENTIFICATION IS TWO GATES, NOT ONE.

  This script runs elevated and deletes machine-global objects belonging to
  accounts other than the one running it. A name match alone is not evidence
  of ownership: a task name is a string anybody can choose, and a wrong
  deletion here removes somebody else's sign-in automation with no undo. So a
  task is deleted only when BOTH hold:

    1. Its name is exactly the legacy "Ion Engine", or matches
       ^Ion Engine \(S-1-[0-9-]+\)$ -- a real SID suffix, not a prefix.
    2. Its registered Exec action proves it launches Ion: the command is
       ion-engine-host.exe or ion.exe, resolved inside an accepted installed
       Ion root, with `serve --supervised` semantics.

  Anything that fails gate 2 -- an unreadable action, a malformed task, an
  action pointing somewhere else -- is skipped and logged. It is never
  deleted, and it is never counted as a verified Ion task, so a detection run
  cannot report "clean" on the strength of a task it could not read.

  NOTHING in a user profile is touched. %USERPROFILE%\.ion holds
  conversations, credentials and settings; ~/orion and ~/.orion hold operator
  data; none of it is this script's business, and an uninstall that removed
  any of it would destroy work. The rendered task XML at
  %USERPROFILE%\.ion\ion-engine-task.xml is left behind on purpose for the
  same reason: it is inert once the task is gone, and reaching into another
  account's profile to delete an inert file is not worth the risk of touching
  the wrong thing. %ProgramData%\Ion (administrator-authored policy) is
  likewise untouched.

  Two roles, one implementation:
    - The uninstaller invokes it to clean up.
    - An administrator runs it directly to find or clear orphans, which is the
      remediation path when an uninstall ran without sufficient rights.

.PARAMETER Detect
  Report what is present and exit without removing anything. Exits 0 when no
  verified Ion task remains and 1 when at least one does, so it can be used
  directly as an Intune detection or remediation-detection script.

.PARAMETER WhatIf
  List the tasks that would be removed, remove nothing, and exit 0.

.PARAMETER LogPath
  Append a line per action here. Defaults to Ion-Setup.log in the current
  account's TEMP, which is the same file the NSIS installer writes -- so an
  install and its later uninstall read as one story. An unwritable log never
  fails the run.

.PARAMETER InstallRoot
  An additional directory to accept as an installed Ion root. The NSIS
  uninstaller passes $INSTDIR here, because by the time this script runs the
  install directory and its uninstall registration are both already gone --
  so on a device that installed somewhere other than the two conventional
  paths, the caller is the only remaining source of the truth. Ignored when
  empty, which is the standalone administrator case.

.OUTPUTS
  One line per task considered, and a final summary line. Exit codes:
    0  nothing left to remove (or -WhatIf)
    1  at least one verified Ion task remains: either -Detect found some, or a
       removal failed
#>
[CmdletBinding()]
param(
  [switch] $Detect,
  [switch] $WhatIf,
  [string] $LogPath,
  [string] $InstallRoot
)

$ErrorActionPreference = 'Stop'

# The shared name every Ion registered before the task became per-user, and
# the prefix of the per-user names that replaced it. Both are pinned in
# desktop/src/main/engine-supervisor-schtasks.ts (LEGACY_TASK_NAME,
# taskNameForSid) and asserted against these values by
# Remove-IonEngineTasks.test.ps1 -- a rename on either side fails that test
# rather than silently orphaning every task on every host.
$LegacyTaskName = 'Ion Engine'
$PerUserPrefix = 'Ion Engine ('

# The exact per-user name shape. Anchored, and the suffix must be a real SID:
# "S-1-" followed by digit groups. A prefix match would accept
# "Ion Engine (whatever)" -- a name anybody can register, on a script that
# runs elevated and deletes what it matches.
$PerUserNamePattern = '^Ion Engine \(S-1-[0-9]+(-[0-9]+)*\)$'

# The two executables an Ion task is allowed to launch. ion-engine-host.exe is
# the GUI-subsystem launcher the current desktop registers; ion.exe is the
# direct-exec fallback resolveTaskAction() falls back to when the launcher is
# missing (desktop/src/main/engine-supervisor-schtasks.ts).
$EngineHostLeaf = 'ion-engine-host.exe'
$EngineLeaf = 'ion.exe'

# The uninstall registration the NSIS installer writes. InstallLocation under
# it is the authoritative answer to "where is Ion installed on THIS machine",
# which is what makes a non-default install directory acceptable without
# widening the check to "anywhere".
$UninstallKeyGuid = '7b1e4b3a-5d2c-4c7e-9f0a-2e6d8c1b4a53'

# GetTempPath rather than $env:TEMP: it is always defined, on every platform,
# which is what lets the test dot-source this file on the Linux CI runner. On
# Windows it resolves to the same directory the NSIS installer logs to, so an
# install and its later uninstall land in one file.
if (-not $LogPath) { $LogPath = Join-Path ([System.IO.Path]::GetTempPath()) 'Ion-Setup.log' }

function Write-IonLog([string] $Message) {
  Write-Output $Message
  try {
    Add-Content -LiteralPath $LogPath -Value "tasks: $Message" -ErrorAction Stop
  } catch {
    # An unwritable log must never fail an uninstall. Reported once on the
    # console so the loss of the record is visible rather than silent.
    Write-Warning "could not append to $LogPath ($($_.Exception.Message))"
  }
}

<#
.SYNOPSIS
  Reports whether a task name is one Ion itself would have registered.
.DESCRIPTION
  Gate 1 of two. Pure, so it is the unit the tests exercise. The per-user form
  is matched against an anchored SID pattern rather than a prefix: a prefix
  match accepts "Ion Engine (anything)", and this script deletes what it
  matches, elevated, across every account on the host.
#>
function Test-IonTaskName {
  param([Parameter(Mandatory = $true)] [AllowEmptyString()] [string] $Name)
  $leaf = ($Name -split '\\')[-1]
  if ($leaf -eq $LegacyTaskName) { return $true }
  return [bool] ([regex]::IsMatch($leaf, $PerUserNamePattern))
}

<#
.SYNOPSIS
  Normalises a filesystem path for prefix comparison.
.DESCRIPTION
  Expands %VAR% forms (a task's Command may carry one), collapses forward
  slashes, and trims a trailing separator. Comparison is done on the result,
  case-insensitively, because Windows paths are.
#>
function ConvertTo-IonComparablePath {
  param([Parameter(Mandatory = $true)] [AllowEmptyString()] [string] $Path)
  if (-not $Path) { return '' }
  $p = [System.Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
  $p = $p -replace '/', '\'
  while ($p.EndsWith('\')) { $p = $p.Substring(0, $p.Length - 1) }
  return $p
}

<#
.SYNOPSIS
  Reports whether a file path sits inside one of the accepted install roots.
.DESCRIPTION
  A segment-boundary prefix test, not a substring test: "C:\Program Files\Ionosphere\ion.exe"
  must not match the root "C:\Program Files\Ion".
#>
function Test-IonPathUnderRoot {
  param(
    [Parameter(Mandatory = $true)] [AllowEmptyString()] [string] $Path,
    [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [string[]] $Roots
  )
  $candidate = ConvertTo-IonComparablePath $Path
  if (-not $candidate) { return $false }
  foreach ($root in $Roots) {
    $r = ConvertTo-IonComparablePath $root
    if (-not $r) { continue }
    if ($candidate.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

<#
.SYNOPSIS
  The install roots a verified Ion task's action may launch from.
.DESCRIPTION
  The two conventional per-machine directories, plus whatever the installer
  actually recorded on this machine. The recorded location is read rather than
  assumed because an ARM64 device upgraded in place still lives under
  Program Files (x86), and because a relocated install is legitimate -- but
  "wherever the task happens to point" is not, which is why the set is finite.

  Roots are injectable so the tests can exercise the matching without a
  Windows registry.
#>
function Get-IonAcceptedRoot {
  param([string[]] $Extra = @())
  $roots = @()
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432)) {
    if ($base) { $roots += (Join-Path $base 'Ion') }
  }
  foreach ($hive in @('HKLM:', 'HKCU:')) {
    $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$UninstallKeyGuid"
    try {
      $entry = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    } catch {
      # A hive this account cannot read is not an accepted root and is not an
      # error: the conventional roots still apply.
      Write-Verbose "could not read $key ($($_.Exception.Message))"
      continue
    }
    if ($entry -and $entry.InstallLocation) { $roots += [string] $entry.InstallLocation }
  }
  $roots += $Extra
  return @(
    $roots |
      ForEach-Object { ConvertTo-IonComparablePath $_ } |
      Where-Object { $_ } |
      Select-Object -Unique
  )
}

<#
.SYNOPSIS
  Reports whether a registered Exec action proves the task launches Ion.
.DESCRIPTION
  Gate 2 of two, and the whole reason this script is safe to run elevated.
  Pure: it takes the command and arguments a task declares and answers yes or
  no, so every branch is exercised by the tests without a Task Scheduler.

  Accepts exactly the two shapes resolveTaskAction() produces:

    ion-engine-host.exe   "<root>\...\ion.exe" serve --supervised
    ion.exe               serve --supervised

  Both require the executable to resolve inside an accepted root, and the host
  form additionally requires the ion.exe it launches to resolve inside one --
  otherwise a host launcher in the right place could be pointed at any binary
  at all.
#>
function Test-IonTaskAction {
  param(
    [Parameter(Mandatory = $true)] [AllowEmptyString()] [AllowNull()] [string] $Command,
    [AllowEmptyString()] [AllowNull()] [string] $Arguments,
    [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [string[]] $Roots
  )
  $cmd = ConvertTo-IonComparablePath $Command
  if (-not $cmd) { return $false }
  if (-not (Test-IonPathUnderRoot -Path $cmd -Roots $Roots)) { return $false }

  $leaf = ($cmd -split '\\')[-1]
  $argText = if ($null -eq $Arguments) { '' } else { $Arguments }

  # `serve --supervised` in that order, as whole tokens. A substring test
  # would accept "--supervised-by-somebody-else".
  $servesSupervised = [regex]::IsMatch($argText, '(^|\s)serve(\s+[^\s]+)*\s+--supervised(\s|$)')
  if (-not $servesSupervised) { return $false }

  if ($leaf -eq $EngineLeaf) {
    # Direct exec: the arguments carry no engine path, only the verb.
    return $true
  }
  if ($leaf -ne $EngineHostLeaf) { return $false }

  # Host launcher: the first argument is the quoted engine path, and it has to
  # be an ion.exe inside an accepted root too.
  $first = [regex]::Match($argText, '^\s*"(?<p>[^"]+)"')
  if (-not $first.Success) {
    $first = [regex]::Match($argText, '^\s*(?<p>[^\s]+)')
    if (-not $first.Success) { return $false }
  }
  $enginePath = ConvertTo-IonComparablePath $first.Groups['p'].Value
  if (($enginePath -split '\\')[-1] -ne $EngineLeaf) { return $false }
  return (Test-IonPathUnderRoot -Path $enginePath -Roots $Roots)
}

<#
.SYNOPSIS
  The Exec action of one registered task, or $null when it cannot be read.
.DESCRIPTION
  Deliberately returns $null rather than throwing or guessing. An action this
  script cannot read is an action it cannot verify, and an unverifiable task
  is skipped -- which is the safe answer for a delete that has no undo.

  Only a single Exec action counts. A task with several actions, or with a
  ComHandler/SendEmail/ShowMessage action, is not a shape Ion ever registers.
#>
function Get-IonTaskAction {
  param([Parameter(Mandatory = $true)] [string] $TaskPath)
  try {
    $leaf = ($TaskPath -split '\\')[-1]
    $folder = $TaskPath.Substring(0, $TaskPath.Length - $leaf.Length)
    if (-not $folder) { $folder = '\' }
    $task = Get-ScheduledTask -TaskName $leaf -TaskPath $folder -ErrorAction Stop
  } catch {
    return $null
  }
  if (-not $task) { return $null }
  $actions = @($task.Actions)
  if ($actions.Count -ne 1) { return $null }
  $action = $actions[0]
  # Duck-typed rather than type-checked: the CIM class name differs between
  # Windows builds, and "does it carry an Execute path" is the property that
  # actually matters.
  $execute = $null
  try { $execute = $action.Execute } catch { $execute = $null }
  if (-not $execute) { return $null }
  $arguments = ''
  try { if ($action.Arguments) { $arguments = [string] $action.Arguments } } catch { $arguments = '' }
  return [pscustomobject]@{ Command = [string] $execute; Arguments = $arguments }
}

<#
.SYNOPSIS
  Every task on this machine whose NAME is one Ion registers, as full paths.
.DESCRIPTION
  Gate 1 only. The caller applies gate 2 -- the action check -- so that a
  name-matching task with an unverifiable action is reported and skipped
  rather than silently dropped from the enumeration.

  Get-ScheduledTask is used when available (Windows 8 and later) because it
  returns structured objects; schtasks.exe CSV is the fallback for a host
  where the ScheduledTasks module is absent.
#>
function Get-IonTaskPath {
  if (Get-Command -Name Get-ScheduledTask -ErrorAction SilentlyContinue) {
    return @(
      Get-ScheduledTask -ErrorAction SilentlyContinue |
        Where-Object { Test-IonTaskName $_.TaskName } |
        ForEach-Object { ($_.TaskPath.TrimEnd('\') + '\' + $_.TaskName) }
    )
  }
  $csv = & schtasks.exe /Query /FO CSV /NH 2>$null
  if ($LASTEXITCODE -ne 0) { return @() }
  return @(
    $csv | ForEach-Object { ($_ -split '","')[0].TrimStart('"') } |
      Where-Object { Test-IonTaskName $_ }
  )
}

<#
.SYNOPSIS
  Splits name-matching tasks into verified Ion tasks and skipped ones.
.DESCRIPTION
  Returns a hashtable with Verified (full paths, safe to delete) and Skipped
  (path plus the reason it could not be verified). Every skipped task is
  reported by the caller: silence about a task that looks like Ion's and
  cannot be proved to be would be the worst of both answers.
#>
function Get-IonTaskCandidate {
  param(
    [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [string[]] $Paths,
    [string[]] $ExtraRoots = @()
  )
  $roots = @(Get-IonAcceptedRoot -Extra $ExtraRoots)
  $verified = @()
  $skipped = @()
  foreach ($path in $Paths) {
    $action = Get-IonTaskAction -TaskPath $path
    if ($null -eq $action) {
      $skipped += [pscustomobject]@{ Path = $path; Reason = 'its registered action could not be read' }
      continue
    }
    if (Test-IonTaskAction -Command $action.Command -Arguments $action.Arguments -Roots $roots) {
      $verified += $path
    } else {
      $skipped += [pscustomobject]@{
        Path   = $path
        Reason = "its action does not launch Ion from an installed Ion directory (command: $($action.Command))"
      }
    }
  }
  return @{ Verified = @($verified); Skipped = @($skipped) }
}

# Dot-sourcing loads the functions and the constants without running the
# sweep. That is how Remove-IonEngineTasks.test.ps1 exercises the pure
# functions on a Linux runner, where there are no scheduled tasks to
# enumerate.
if ($MyInvocation.InvocationName -eq '.') { return }

$named = @(Get-IonTaskPath)

if ($named.Count -eq 0) {
  Write-IonLog 'no Ion Engine scheduled task is registered on this machine'
  exit 0
}

$extraRoots = @()
if ($InstallRoot) { $extraRoots += $InstallRoot }
$split = Get-IonTaskCandidate -Paths $named -ExtraRoots $extraRoots
$found = @($split.Verified)

foreach ($s in $split.Skipped) {
  Write-IonLog "SKIPPED $($s.Path): $($s.Reason). Not removed, and not counted as an Ion task."
}
foreach ($path in $found) { Write-IonLog "found $path" }

if ($found.Count -eq 0) {
  Write-IonLog "no verified Ion Engine task remains ($($split.Skipped.Count) name match(es) skipped)"
  exit 0
}

if ($Detect) {
  Write-IonLog "detect: $($found.Count) Ion Engine task(s) remain"
  exit 1
}

if ($WhatIf) {
  Write-IonLog "-WhatIf: $($found.Count) task(s) would be removed, none were"
  exit 0
}

$failed = 0
foreach ($path in $found) {
  # End before Delete. Deleting a task whose instance is running leaves the
  # engine process alive with nothing supervising it, and on a multi-session
  # host that orphan holds the user's loopback port until they sign out.
  & schtasks.exe /End /TN $path 2>$null | Out-Null
  & schtasks.exe /Delete /TN $path /F 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-IonLog "removed $path"
  } else {
    $failed++
    # The usual cause is running without the rights to touch another account's
    # task. Named rather than swallowed: this is exactly the case an
    # administrator re-runs the script to finish.
    Write-IonLog "FAILED to remove $path (schtasks exit $LASTEXITCODE) -- re-run this script as an administrator"
  }
}

$remainingNamed = @(Get-IonTaskPath)
$remaining = @((Get-IonTaskCandidate -Paths $remainingNamed -ExtraRoots $extraRoots).Verified)
Write-IonLog "summary: found $($found.Count), skipped $($split.Skipped.Count), failed $failed, remaining $($remaining.Count)"
if ($remaining.Count -gt 0) { exit 1 }
exit 0
