<#
  IonDesktop.ps1 -- the build and install steps behind `.\make.ps1`.

  Split from IonBuild.ps1 so the environment setup a fresh machine needs stays
  separate from the build path a developer runs every day.
#>

<#
  Stage everything the Windows installer packages out of desktop\resources\engine.

  That whole directory is gitignored, so none of it arrives with a pull and all
  of it is produced here. electron-builder's win.extraResources reads ion.exe
  and ion-engine-task.xml from it, and extraResources reads the extensions tree.
#>
function Build-IonEngine {
  param(
    [Parameter(Mandatory)][string] $Root,
    [Parameter(Mandatory)][string] $GoArch
  )
  Write-IonStep "building ion.exe (windows/$GoArch)"

  $engineDir = Join-Path $Root 'desktop\resources\engine'
  $engineOut = Join-Path $engineDir 'ion.exe'
  New-Item -ItemType Directory -Path $engineDir -Force | Out-Null

  $version = 'dev'
  try {
    $described = & git -C $Root describe --tags --always --dirty 2>$null
    if ($LASTEXITCODE -eq 0 -and $described) { $version = "dev-$($described.Trim())" }
  } catch {
    Write-IonWarn "git describe failed, stamping version=dev: $($_.Exception.Message)"
  }

  # CGO off: the only cgo in the engine is the darwin Local Network probe.
  $env:CGO_ENABLED = '0'; $env:GOOS = 'windows'; $env:GOARCH = $GoArch
  Invoke-IonNative 'go' @('build', '-ldflags', "-s -w -X main.version=$version", '-o', $engineOut, './cmd/ion') `
    -WorkingDirectory (Join-Path $Root 'engine') | Out-Null
  Write-IonInfo "ion.exe stamped $version"

  # The engine host launcher. -H windowsgui links it for the GUI subsystem so
  # Windows allocates it no console; it starts the engine with
  # CREATE_NO_WINDOW so the engine gets no window either. Without it the
  # Scheduled Task opens a terminal the user can see and close.
  Write-IonStep "building ion-engine-host.exe (windows/$GoArch)"
  $hostOut = Join-Path $engineDir 'ion-engine-host.exe'
  Invoke-IonNative 'go' @('build', '-ldflags', "-s -w -H windowsgui", '-o', $hostOut, './cmd/ion-engine-host') `
    -WorkingDirectory (Join-Path $Root 'engine') | Out-Null
  Write-IonInfo 'ion-engine-host.exe'

  Write-IonStep 'staging engine resources'
  Copy-Item (Join-Path $Root 'packaging\windows\ion-engine-task.xml') `
            (Join-Path $engineDir 'ion-engine-task.xml') -Force
  Write-IonInfo 'ion-engine-task.xml'

  # The SDKs ship inside the installer so an extension can resolve them without
  # a network fetch. Replace rather than merge, so a removed SDK file does not
  # survive in the staged copy and get packaged forever.
  $extDir = Join-Path $engineDir 'extensions'
  New-Item -ItemType Directory -Path $extDir -Force | Out-Null
  foreach ($pair in @(
    @{ From = (Join-Path $Root 'engine\extensions\sdk'); To = (Join-Path $extDir 'sdk') },
    @{ From = (Join-Path $Root 'sdk\go');                To = (Join-Path $extDir 'sdk-go') }
  )) {
    if (-not (Test-Path $pair.From)) {
      Write-IonWarn "SDK source missing, not staged: $($pair.From)"
      continue
    }
    if (Test-Path $pair.To) { Remove-Item $pair.To -Recurse -Force }
    Copy-Item $pair.From $pair.To -Recurse
    Write-IonInfo "staged $(Split-Path $pair.To -Leaf)"
  }
}

<#
  Install desktop dependencies when they are absent or the lockfile has moved.
  npm ci is the only install used: npm install would rewrite the lockfile, and
  a Windows machine quietly rewriting a lockfile the Mac owns is how a branch
  grows a diff nobody meant to make.
#>
function Install-IonDesktopDependencies {
  param([Parameter(Mandatory)][string] $Root)

  $desktop = Join-Path $Root 'desktop'
  $modules = Join-Path $desktop 'node_modules'
  $lock    = Join-Path $desktop 'package-lock.json'
  $stamp   = Join-Path $modules '.ion-lock-hash'

  $lockHash = (Get-FileHash $lock -Algorithm SHA256).Hash
  if ((Test-Path $modules) -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $lockHash)) {
    Write-IonSkip 'npm ci (package-lock.json unchanged)'
    return
  }

  Write-IonStep 'npm ci (desktop)'
  try {
    Invoke-IonNative 'npm' @('ci', '--no-audit', '--no-fund') -WorkingDirectory $desktop | Out-Null
  } catch {
    Write-IonError 'npm ci failed.'
    Write-IonInfo 'If the error names node-gyp, Python or Visual Studio: electron-builder rebuilds native'
    Write-IonInfo 'modules against Electron ABI, which needs a C++ toolchain even though every dependency'
    Write-IonInfo 'ships a prebuilt binary. Run .\bootstrap.ps1 to install Python and VS Build Tools.'
    throw
  }
  Set-Content -Path $stamp -Value $lockHash -Encoding ascii
}

<#
  Build the renderer and the NSIS installer, then return the path to the
  artifact. The arch is passed explicitly rather than left to electron-builder's
  default so the installer can never disagree with the engine binary staged
  beside it -- and the version is resolved once, here, for exactly the same
  reason.

  Before that, the local build had no version of its own. electron-vite was
  given nothing, so it computed one; electron-builder was given nothing, so it
  read desktop/package.json, which carries whatever release-please last
  committed there. On this branch that was 1.82.0 against a manifest saying
  1.97.0, so a locally built installer was named, stamped and registered as a
  release fifteen minors old -- consistently, which is what made it invisible.

  So: resolve, then hand the same string to both steps, then check that every
  surface carrying a version agrees with it before returning.
#>
function Build-IonInstaller {
  param(
    [Parameter(Mandatory)][string] $Root,
    [Parameter(Mandatory)][string] $Arch
  )
  $desktop = Join-Path $Root 'desktop'

  Write-IonStep 'resolving the desktop version'
  $version = Resolve-IonDesktopVersion -Root $Root
  Write-IonOk "desktop version: $version"

  # Discard the exit codes. A PowerShell function returns everything that is
  # not consumed, so an uncaptured Invoke-IonNative result joins the path in
  # the return value and the caller receives @(0, 0, '<path>') -- which then
  # reaches Start-Process as a mangled string and cannot be found.
  #
  # ION_DESKTOP_VERSION is what electron.vite.config.ts reads for
  # __ION_DESKTOP_VERSION__; it is set for the rest of this process so the
  # renderer define and the installer metadata cannot come from two different
  # resolutions. Set rather than saved-and-restored, the same way Build-IonEngine
  # sets GOOS/GOARCH: make.ps1 builds once and exits, and a later step reading
  # the version this build used is right rather than surprising.
  $env:ION_DESKTOP_VERSION = $version

  Write-IonStep 'electron-vite build'
  Invoke-IonNative 'npx' @('electron-vite', 'build', '--mode', 'production') -WorkingDirectory $desktop | Out-Null

  # postinstall applies this patch, but postinstall only runs when npm ci does,
  # and npm ci is skipped whenever package-lock.json is unchanged. Re-applying
  # it here is idempotent and makes the build independent of when dependencies
  # were last installed. Without it an ARM64 per-machine install silently lands
  # in Program Files (x86) -- see desktop/scripts/patch-nsis-arm64.js.
  Write-IonStep 'patching nsis arm64 install directory'
  Invoke-IonNative 'node' @('scripts/patch-nsis-arm64.js') -WorkingDirectory $desktop | Out-Null

  # The filter has to be in the environment for the electron-builder call
  # itself, because it is read where the app payload is compressed rather than
  # passed as an option. See Get-IonSevenZipFilter for what goes wrong without
  # it: an installer that omits every executable and still reports success.
  # -c.extraMetadata.version overrides the version electron-builder would
  # otherwise read from package.json, without editing package.json. That one
  # value feeds the installer filename, the NSIS ${VERSION} the install log
  # prints, the DisplayVersion written to the uninstall key, and latest.yml --
  # so overriding it here is what makes every downstream surface agree.
  Write-IonStep "electron-builder --win --$Arch (version $version)"
  $previousFilter = $env:ELECTRON_BUILDER_7Z_FILTER
  $env:ELECTRON_BUILDER_7Z_FILTER = Get-IonSevenZipFilter
  try {
    Invoke-IonNative 'npx' @(
      'electron-builder', '--win', "--$Arch", '--publish', 'never',
      "-c.extraMetadata.version=$version"
    ) -WorkingDirectory $desktop | Out-Null
  } finally {
    $env:ELECTRON_BUILDER_7Z_FILTER = $previousFilter
  }

  $release = Join-Path $desktop 'release'
  # Named exactly, not globbed. A glob picks the newest matching file, which on
  # a machine that has built before is happily a stale installer from the
  # previous version -- and the whole point of this function is that the
  # version it resolved is the version it shipped.
  $expectedName = "Ion-Setup-$version-$Arch.exe"
  $exe = Get-Item (Join-Path $release $expectedName) -ErrorAction SilentlyContinue
  if (-not $exe) {
    $seen = @(Get-ChildItem $release -Filter "Ion-Setup-*-$Arch.exe" -ErrorAction SilentlyContinue |
      ForEach-Object { $_.Name })
    throw ("electron-builder reported success but $expectedName does not exist in $release. " +
           "Present: $(if ($seen) { $seen -join ', ' } else { '(none)' })")
  }

  Assert-IonInstallerVersion -InstallerPath $exe.FullName -Arch $Arch -Version $version -ReleaseDir $release

  # Provenance, written next to the artifact.
  #
  # A local build is the one most likely to be handed to somebody for a pilot
  # and the one least likely to be reproducible, because it is normally made
  # from a working tree that has edits in it. The manifest records the commit,
  # the dirty state, the version, the architecture, the byte size and the
  # SHA-256, and refuses to call a dirty build reproducible -- so an installer
  # that arrives by hand can still be identified six weeks later.
  #
  # A manifest failure FAILS the build.
  #
  # It used to warn. That was defensible when provenance was a nicety, and it
  # is not defensible for this pilot: a local build is the one most likely to
  # be handed to somebody and the one least likely to be reproducible, and an
  # installer with no manifest is an installer nobody can tie to a commit, a
  # hash, or a signature. Shipping 130 MB that cannot be identified is worse
  # than shipping nothing, so the artifact is discarded with the failure.
  #
  # Invoke-IonNative rather than a bare `&`: a bare call runs the child and
  # discards its exit code, so a manifest script that exited 1 without throwing
  # a PowerShell error was reported as a success. Invoke-IonNative checks the
  # code and throws.
  $manifest = Join-Path $release ("Ion-Artifacts-$version-$Arch.json")
  Write-IonStep 'artifact manifest'
  Invoke-IonNative 'pwsh' @(
    '-NoProfile', '-File', (Join-Path $Root 'scripts/ci/Write-IonArtifactManifest.ps1'),
    '-Path', $exe.FullName, '-OutputPath', $manifest,
    '-Version', $version, '-Arch', $Arch, '-RepoRoot', $Root,
    # A local build is a test build even when the tree it came from is
    # spotless. Cleanliness makes a commit resolvable; it does not make the
    # bytes reproducible, because nothing here pins the toolchain, the signing
    # identity or the environment the way the release runner does. Only CI
    # passes 'release', and only after its signing gate has decided.
    '-BuildType', 'test-build'
  ) -WorkingDirectory $Root | Out-Null
  if (-not (Test-Path -LiteralPath $manifest)) {
    throw "Write-IonArtifactManifest.ps1 exited 0 but wrote no manifest at $manifest"
  }
  Assert-IonManifestVersion -ManifestPath $manifest -Version $version -Arch $Arch
  Write-IonOk "manifest: $manifest"

  return [string]$exe.FullName
}

<#
  Close a running Ion before the installer replaces its files.

  Ask the window to close first so the desktop can shut down the way it
  normally does, and only escalate when it does not. The engine is a per-user
  Scheduled Task, so stopping the task is what actually stops it -- killing
  ion.exe alone would leave the task free to start it again mid-install.
#>
function Stop-IonRunning {
  Write-IonStep 'closing a running Ion'

  # The task is named after the account -- "Ion Engine (<SID>)" -- because a
  # task name is machine-global and two users on one host would otherwise share
  # one registration. The legacy shared name is still matched so a machine
  # mid-upgrade is stopped too. See
  # desktop/src/main/engine-supervisor-schtasks.ts.
  $sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
  $task = Get-ScheduledTask -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -eq "Ion Engine ($sid)" -or $_.TaskName -eq 'Ion Engine' } |
    Select-Object -First 1
  if ($task) {
    if ($task.State -eq 'Running') {
      Stop-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue
      Write-IonInfo "stopped Scheduled Task ""$($task.TaskName)"""
    } else {
      Write-IonInfo "Scheduled Task ""$($task.TaskName)"" state: $($task.State)"
    }
  } else {
    Write-IonInfo 'no "Ion Engine" Scheduled Task registered'
  }

  $desktopProcs = @(Get-Process -Name 'Ion' -ErrorAction SilentlyContinue)
  if ($desktopProcs.Count -eq 0) {
    Write-IonInfo 'Ion desktop is not running'
  } else {
    foreach ($p in $desktopProcs) {
      if (-not $p.CloseMainWindow()) {
        Write-IonInfo "pid $($p.Id) has no main window to close"
      }
    }
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and (Get-Process -Name 'Ion' -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 500
    }
    $left = @(Get-Process -Name 'Ion' -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
      Write-IonWarn "Ion did not close within 20s; terminating $($left.Count) process(es)"
      $left | Stop-Process -Force
    } else {
      Write-IonInfo 'Ion desktop closed'
    }
  }

  $engineProcs = @(Get-Process -Name 'ion' -ErrorAction SilentlyContinue)
  if ($engineProcs.Count -gt 0) {
    Write-IonInfo "terminating $($engineProcs.Count) ion.exe process(es)"
    $engineProcs | Stop-Process -Force
  }
}

<#
  Launch the installer and wait for it. The NSIS build is the assisted
  installer (oneClick is false), so this deliberately shows its UI rather than
  passing /S -- an unattended install belongs to Intune, not to a developer
  who wants to see what the installer does.
#>
function Start-IonInstaller {
  param([Parameter(Mandatory)][string] $InstallerPath)
  Write-IonStep 'launching the installer'
  Write-IonInfo $InstallerPath
  $p = Start-Process -FilePath $InstallerPath -PassThru -Wait
  if ($p.ExitCode -ne 0) {
    throw "installer exited $($p.ExitCode)"
  }
  Write-IonInfo 'installer finished'
}

function Invoke-IonClean {
  param([Parameter(Mandatory)][string] $Root)
  Write-IonStep 'clean'
  foreach ($path in @(
    (Join-Path $Root 'desktop\dist'),
    (Join-Path $Root 'desktop\release'),
    (Join-Path $Root 'desktop\resources\engine')
  )) {
    if (Test-Path $path) {
      Remove-Item $path -Recurse -Force
      Write-IonInfo "removed $path"
    } else {
      Write-IonSkip "$path (absent)"
    }
  }
}

<#
  Remove every trace of Ion from this machine: the per-machine install, the
  per-user install, both uninstall registrations, the engine Scheduled Task,
  and the shortcuts.

  This is a developer verb, not a user-facing one. It requires elevation on
  purpose. A per-user install is refused while a per-machine install exists
  (see packaging/windows/installer.nsh), so this is the only way past that
  refusal -- and gating it behind administrator rights is what stops someone on
  a managed device from cloning the repo and stepping around their fleet's
  managed copy, while leaving a developer with local admin free to reset their
  own dev loop.

  %ProgramData%\Ion is left alone. It holds administrator-authored enterprise
  policy, not application state, and the uninstaller does not remove it either.
#>
function Uninstall-IonEverywhere {
  param([Parameter(Mandatory)][string] $Root)

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'uninstall requires an elevated PowerShell. Run it from an administrator prompt.'
  }

  $guid = '7b1e4b3a-5d2c-4c7e-9f0a-2e6d8c1b4a53'
  $removed = 0

  Write-IonStep 'stopping a running Ion'
  Stop-IonRunning

  # Run each registered uninstaller first so it can undo its own work, then
  # sweep whatever it left. QuietUninstallString is what the installer wrote,
  # so it is read rather than reconstructed.
  Write-IonStep 'running registered uninstallers'
  foreach ($hive in @('HKLM:', 'HKCU:')) {
    $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
    $entry = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    if (-not $entry) { Write-IonInfo "no registration in $hive"; continue }
    $cmd = $entry.QuietUninstallString
    if (-not $cmd) { Write-IonWarn "registration in $hive has no QuietUninstallString"; continue }
    Write-IonInfo "$hive $cmd"
    $exe = [regex]::Match($cmd, '^"([^"]+)"').Groups[1].Value
    $args = $cmd.Substring($cmd.IndexOf('"', 1) + 1).Trim()
    if (Test-Path $exe) {
      $p = Start-Process $exe -ArgumentList $args -PassThru -Wait
      Write-IonInfo "uninstaller exit $($p.ExitCode)"
      $removed++
    } else {
      Write-IonWarn "uninstaller missing at $exe, sweeping instead"
    }
  }

  # The scheduled-task cmdlets are used rather than schtasks.exe here: a
  # /Query for a task that does not exist writes to stderr, and under
  # $ErrorActionPreference = 'Stop' that stderr line is itself a terminating
  # error -- so the absence of a task would fail the uninstall that is trying
  # to confirm it. Same trap Invoke-IonNative exists to avoid.
  Write-IonStep 'removing the engine Scheduled Task'
  if (Get-ScheduledTask -TaskName 'Ion Engine' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'Ion Engine' -Confirm:$false -ErrorAction SilentlyContinue
    if (Get-ScheduledTask -TaskName 'Ion Engine' -ErrorAction SilentlyContinue) {
      Write-IonWarn 'could not remove the "Ion Engine" task'
    } else {
      Write-IonInfo 'deleted "Ion Engine"'
      $removed++
    }
  } else {
    Write-IonInfo 'no "Ion Engine" task registered'
  }

  Write-IonStep 'sweeping install directories'
  foreach ($dir in @(
    (Join-Path $env:ProgramFiles 'Ion'),
    (Join-Path ${env:ProgramFiles(x86)} 'Ion'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Ion')
  )) {
    if (Test-Path $dir) {
      Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path $dir) { Write-IonWarn "could not remove $dir" } else { Write-IonInfo "removed $dir"; $removed++ }
    }
  }

  Write-IonStep 'sweeping registration and shortcuts'
  foreach ($key in @(
    "HKLM:\SOFTWARE\$guid", "HKCU:\SOFTWARE\$guid",
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$guid",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
  )) {
    if (Test-Path $key) { Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue; Write-IonInfo "removed $key"; $removed++ }
  }
  foreach ($lnk in @(
    (Join-Path $env:USERPROFILE 'Desktop\Ion.lnk'),
    'C:\Users\Public\Desktop\Ion.lnk',
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Ion.lnk'),
    'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Ion.lnk'
  )) {
    if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue; Write-IonInfo "removed $lnk"; $removed++ }
  }

  # The rendered task definition is regenerated on the next launch; leaving a
  # stale one behind would be compared against and reported as unchanged.
  $taskXml = Join-Path $env:USERPROFILE '.ion\ion-engine-task.xml'
  if (Test-Path $taskXml) { Remove-Item $taskXml -Force; Write-IonInfo "removed $taskXml" }

  Write-IonInfo "%ProgramData%\Ion left in place (administrator-authored policy, not app state)"
  return $removed
}
