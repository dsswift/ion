<#
.SYNOPSIS
  Intune-shaped end-to-end smoke test for the Windows Ion build.

.DESCRIPTION
  Runs on a native x64 windows-latest runner, whose user is an administrator,
  and proves the whole managed-install path for every release:

    silent per-machine install -> detection rule -> first launch ->
    scheduled-task supervisor -> engine on TCP loopback -> registry policy
    read -> desktop policy enforcement -> quit leaves the engine up ->
    silent uninstall

  It deliberately does not attempt a chat turn or a terminal pane. Those need
  a backend and a real desktop session; they are on the manual sign-off list.

  Every step prints what it checked. A failure prints the observed value and
  exits non-zero at the first failed assertion, because a later step's result
  is not meaningful once an earlier one is wrong.

.PARAMETER InstallerPath
  The Ion-Setup-<version>-x64.exe to install.

.PARAMETER DetectScriptPath
  The version-stamped Detect-Ion.ps1 produced by make-intunewin.ps1.

.PARAMETER SmokeModel
  The model ID written as enterprise policy and expected back over the wire.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $InstallerPath,
  [Parameter(Mandatory = $true)] [string] $DetectScriptPath,
  [string] $SmokeModel = 'smoke-test-model'
)

$ErrorActionPreference = 'Stop'

$PolicyKey = 'HKLM:\SOFTWARE\Policies\IonEngine'
$AppGuid = '7b1e4b3a-5d2c-4c7e-9f0a-2e6d8c1b4a53'
$UninstallKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$AppGuid"
$InstallDir = Join-Path $env:ProgramFiles 'Ion'
$AppExe = Join-Path $InstallDir 'Ion.exe'
# The engine's loopback port and the supervisor's task name are both derived
# from the signed-in user's SID, so two users on one machine collide on
# neither. The smoke test derives them the same way rather than assuming fixed
# values -- see engine/cmd/ion/port.go and
# desktop/src/main/engine-supervisor-schtasks.ts.
$CurrentSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$TaskName = "Ion Engine ($CurrentSid)"
$IonTaskPrefix = 'Ion Engine ('
$ProgramDataIon = Join-Path $env:ProgramData 'Ion'
$RemoveTasksScript = Join-Path $ProgramDataIon 'Remove-IonEngineTasks.ps1'

function Get-IonEnginePort {
  $sid = $CurrentSid
  $bytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sid))
  # Big-endian uint32 of the first four bytes, matching both implementations.
  $n = ([uint32]$bytes[0] -shl 24) -bor ([uint32]$bytes[1] -shl 16) -bor ([uint32]$bytes[2] -shl 8) -bor [uint32]$bytes[3]
  return 51000 + [int]($n % 4000)
}
$EnginePort = Get-IonEnginePort
$IonHome = Join-Path $env:USERPROFILE '.ion'

$step = 0
function Step([string] $message) {
  $script:step++
  Write-Host "smoke [$script:step] $message"
}
function Assert([bool] $condition, [string] $message) {
  if (-not $condition) {
    [Console]::Error.WriteLine("smoke FAIL: $message")
    exit 1
  }
  Write-Host "  ok: $message"
}

# schtasks /Query reflects Task Scheduler's own state machine, not the
# engine's. The socket wait above proves the engine process is alive, but
# schtasks can still report the task's last-known state as "Ready" for a
# short window after the run it tracks has already started -- polling
# closes that window instead of asserting on a single, unretried read.
function Wait-TaskStatus([string] $pattern, [int] $timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  $state = $null
  while ($true) {
    $state = (schtasks /Query /TN $TaskName /FO LIST /V 2>&1 | Select-String -Pattern '^\s*Status:' | Select-Object -First 1)
    if ("$state" -match $pattern) { return $state }
    if ((Get-Date) -ge $deadline) { return $state }
    Start-Sleep -Seconds 1
  }
}

# --- 1. Enterprise policy, written before the app ever runs -----------------
Step 'writing enterprise policy to HKLM'
$configJson = "{`"allowedModels`":[`"$SmokeModel`"],`"customFields`":{`"ion-desktop`":{`"disableAutoUpdate`":true}}}"
New-Item -Path $PolicyKey -Force | Out-Null
New-ItemProperty -LiteralPath $PolicyKey -Name 'ConfigJson' -PropertyType MultiString -Value @($configJson) -Force | Out-Null
Assert (Test-Path -LiteralPath $PolicyKey) "policy key exists at $PolicyKey"

# --- 2. Silent per-machine install ------------------------------------------
Step 'installing silently with /S /allusers'
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$proc = Start-Process -FilePath $installer -ArgumentList '/S', '/allusers' -Wait -PassThru
Assert ($proc.ExitCode -eq 0) "installer exit code is 0 (got $($proc.ExitCode))"
Assert (Test-Path -LiteralPath $AppExe) "Ion.exe installed at $AppExe"

# --- 3. Intune detection rule -----------------------------------------------
Step 'running the Intune detection script'
$detectOutput = & pwsh -NoProfile -File $DetectScriptPath 2>&1
$detectExit = $LASTEXITCODE
Assert ($detectExit -eq 0) "detection script exit code is 0 (got $detectExit)"
Assert (-not [string]::IsNullOrWhiteSpace(($detectOutput -join ''))) "detection script wrote output: $($detectOutput -join ' ')"

Step 'checking the enterprise policy directory is not writable by standard users'
Assert (Test-Path -LiteralPath $ProgramDataIon) "$ProgramDataIon exists"
$acl = & icacls $ProgramDataIon
# BUILTIN\Users must appear with read-and-execute and must NOT carry (F), (M)
# or (W). A standard user who can write here can author the machine policy
# their own engine reads, which is the control the managed pilot rests on.
$usersAce = ($acl | Select-String -Pattern 'BUILTIN\\Users:' | Select-Object -First 1)
Assert ($null -ne $usersAce) "the ACL names BUILTIN\Users (got: $($acl -join ' | '))"
Assert ("$usersAce" -notmatch '\((F|M|W)\)') "BUILTIN\Users has no write right (got: $usersAce)"

Step 'checking the administrator cleanup tool was installed'
Assert (Test-Path -LiteralPath $RemoveTasksScript) "$RemoveTasksScript present"

# --- 4. First launch registers the supervisor -------------------------------
Step 'launching Ion for the first time'
Start-Process -FilePath $AppExe | Out-Null

Step "waiting for the engine on 127.0.0.1:$EnginePort"
$deadline = (Get-Date).AddSeconds(60)
$listening = $false
while ((Get-Date) -lt $deadline) {
  $probe = Test-NetConnection -ComputerName '127.0.0.1' -Port $EnginePort -InformationLevel Quiet -WarningAction SilentlyContinue
  if ($probe) { $listening = $true; break }
  Start-Sleep -Seconds 2
}
Assert $listening "engine is listening on 127.0.0.1:$EnginePort within 60s"

Step 'checking the scheduled-task supervisor'
schtasks /Query /TN $TaskName /FO LIST /V 2>&1 | Out-Null
Assert ($LASTEXITCODE -eq 0) "schtasks found the `"$TaskName`" task"
$taskState = Wait-TaskStatus 'Running' 30
Assert ("$taskState" -match 'Running') "task status is Running (got: $taskState)"

Step 'running ion.exe health'
$engineExe = Join-Path $InstallDir 'resources\engine\ion.exe'
Assert (Test-Path -LiteralPath $engineExe) "bundled engine at $engineExe"
& $engineExe health | Write-Host
Assert ($LASTEXITCODE -eq 0) "ion.exe health exit code is 0 (got $LASTEXITCODE)"

# --- 5. The engine console must stay hidden ---------------------------------
Step 'checking the engine owns no visible window'
$visible = Get-Process -Name 'ion' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 }
Assert ($null -eq $visible) 'no ion.exe process owns a visible window'

# --- 6. The engine actually read the registry policy ------------------------
Step 'reading enterprise policy back over the NDJSON socket'
$client = [System.Net.Sockets.TcpClient]::new()
$client.Connect('127.0.0.1', $EnginePort)
$stream = $client.GetStream()
$writer = [System.IO.StreamWriter]::new($stream)
$writer.AutoFlush = $true
$reader = [System.IO.StreamReader]::new($stream)
$writer.WriteLine('{"cmd":"get_enterprise_policy","requestId":"smoke-1"}')

$policyLine = $null
$readDeadline = (Get-Date).AddSeconds(20)
$client.ReceiveTimeout = 5000
while ((Get-Date) -lt $readDeadline) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line -notmatch '"requestId"\s*:\s*"smoke-1"') { continue }
  $policyLine = $line
  break
}
$reader.Dispose(); $writer.Dispose(); $client.Dispose()

Assert ($null -ne $policyLine) 'engine answered get_enterprise_policy'
$response = $policyLine | ConvertFrom-Json
Assert ($response.ok -eq $true) "response ok is true (error: $($response.error))"
Assert ($null -ne $response.data.policy) 'response carries data.policy'
Assert ($response.data.policy.allowedModels -contains $SmokeModel) "allowedModels contains '$SmokeModel' (got: $($response.data.policy.allowedModels -join ','))"

# --- 7. Both logs prove the policy was applied on each side -----------------
Step 'checking the engine and desktop logs'
$engineLog = Join-Path $IonHome 'engine.jsonl'
Assert (Test-Path -LiteralPath $engineLog) "engine log at $engineLog"
Assert ((Select-String -Path $engineLog -Pattern 'loaded enterprise config from windows registry' -Quiet) -eq $true) 'engine logged the registry policy read'

$desktopLog = Join-Path $IonHome 'desktop.jsonl'
Assert (Test-Path -LiteralPath $desktopLog) "desktop log at $desktopLog"
Assert ((Select-String -Path $desktopLog -Pattern 'auto-update disabled by enterprise policy' -Quiet) -eq $true) 'desktop logged the auto-update kill switch'

# --- 8. Quitting the desktop must not stop the engine -----------------------
Step 'quitting the desktop'
Get-Process -Name 'Ion' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5
$stateAfterQuit = Wait-TaskStatus 'Running' 30
Assert ("$stateAfterQuit" -match 'Running') "task still Running after the desktop quits (got: $stateAfterQuit)"

# --- 9. Silent uninstall ----------------------------------------------------
Step 'uninstalling with QuietUninstallString'
$quiet = (Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction SilentlyContinue).QuietUninstallString
Assert (-not [string]::IsNullOrWhiteSpace($quiet)) "uninstall key carries QuietUninstallString: $quiet"
$uninstProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $quiet -Wait -PassThru
Assert ($uninstProc.ExitCode -eq 0) "uninstaller exit code is 0 (got $($uninstProc.ExitCode))"

# The NSIS uninstaller returns before it has finished removing the directory.
$goneBy = (Get-Date).AddSeconds(30)
while ((Test-Path -LiteralPath $InstallDir) -and (Get-Date) -lt $goneBy) { Start-Sleep -Seconds 2 }
Assert (-not (Test-Path -LiteralPath $InstallDir)) "$InstallDir removed"

# --- 10. Uninstall left nothing pointing at the removed binary --------------
# The regression this pins: uninstall used to remove the application and leave
# every user's scheduled task registered, firing at each sign-in against an
# executable that no longer exists. On a multi-session host that is one orphan
# per account, and nothing surfaced it.
Step 'checking no Ion Engine scheduled task survived the uninstall'
$survivors = @(
  Get-ScheduledTask -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -eq 'Ion Engine' -or $_.TaskName.StartsWith($IonTaskPrefix, [System.StringComparison]::Ordinal) } |
    ForEach-Object { $_.TaskName }
)
Assert ($survivors.Count -eq 0) "no Ion Engine task remains (found: $($survivors -join ', '))"

Step 'checking the cleanup tool agrees nothing is left'
& pwsh -NoProfile -File $RemoveTasksScript -Detect | Write-Host
Assert ($LASTEXITCODE -eq 0) "Remove-IonEngineTasks.ps1 -Detect reports a clean machine (exit $LASTEXITCODE)"

# Uninstall must never take user data with it. %USERPROFILE%\.ion holds
# conversations, credentials and settings, and the policy directory is
# administrator-owned configuration rather than application state.
Step 'checking uninstall preserved user data and machine policy'
Assert (Test-Path -LiteralPath $IonHome) "$IonHome survived the uninstall"
Assert (Test-Path -LiteralPath $ProgramDataIon) "$ProgramDataIon survived the uninstall"

Write-Host ''
Write-Host "windows-smoke: all $script:step steps passed"
exit 0
