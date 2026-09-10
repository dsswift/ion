<#
  IonBuild.ps1 -- shared helpers for bootstrap.ps1 and make.ps1.

  Dot-sourced by both entry points rather than published as a module, so a
  fresh clone needs no install step before it can build.

  Everything here writes through Write-Ion*, which tees to the console and to a
  transcript file. That is deliberate: the Windows loop is usually driven from
  another machine over SSH, where a failure has a habit of arriving as silence.
  A log file that always exists is what makes a run readable afterwards.
#>

$script:IonLogPath = $null

# ── Logging ──────────────────────────────────────────────────────────────────

function Start-IonLog {
  param([Parameter(Mandatory)][string] $Path, [string] $Title = 'run')

  # Invoke-IonNative decodes a child's own stdout/stderr as UTF-8 explicitly,
  # independent of the console -- that is the actual fix for npm/vite/
  # electron-builder's checkmarks and box-drawing characters coming back as
  # mojibake ("OK" as "ГЁô"). What is left for the console itself: once this
  # process has decoded that text into real Unicode strings, Write-Host still
  # has to re-encode them to send to the terminal, and the terminal has to
  # render them -- both of those go through the console's own codepage, which
  # defaults to the legacy 437/1252 on Windows and can't display characters
  # like "✓" at all. `chcp 65001` plus `[Console]::OutputEncoding` switches
  # that display path to UTF-8 so the already-correct text actually shows up
  # instead of being replaced with "?".
  #
  # Windows-only: `chcp` doesn't exist on macOS/Linux, where this file also
  # runs (IonBuild.test.ps1, exercised locally and in CI via
  # `make check-windows-scripts`). And on a non-interactive host -- CI runners
  # with redirected stdout -- setting OutputEncoding with no real console
  # attached can throw, so this stays best-effort.
  if ($env:OS -eq 'Windows_NT') {
    try {
      $null = chcp 65001 2>&1
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    } catch {
      Write-Host "console encoding: could not switch to UTF-8 ($($_.Exception.Message))" -ForegroundColor DarkGray
    }
  }

  $script:IonLogPath = $Path
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $header = @(
    '',
    ('=' * 72),
    "ion $Title  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "  host   $env:COMPUTERNAME  $env:PROCESSOR_ARCHITECTURE",
    "  user   $env:USERNAME",
    "  shell  PowerShell $($PSVersionTable.PSVersion)",
    ('=' * 72)
  )
  Set-Content -Path $Path -Value $header -Encoding utf8
  Write-Host ($header -join "`n") -ForegroundColor DarkGray
}

<#
  Strip ANSI escape sequences from text captured from a child process.

  npm, vite and electron-builder emit SGR colour codes and cursor movement
  whenever they believe a terminal is attached, and they believe it here: the
  child inherits no console but writes colour anyway (vite and electron-builder
  both honour FORCE_COLOR/CI heuristics that guess wrong for a redirected
  pipe). Windows PowerShell 5.1 hosts have no virtual-terminal processing
  enabled by default -- VirtualTerminalLevel is unset on a stock machine -- so
  those bytes are not interpreted, they are printed, and the operator sees
  "<ESC>[32m" wrapped around every line. Written to make.log they are worse:
  the log is read later by an editor or `Select-String`, neither of which
  renders them either.

  Removing them at the boundary keeps one representation of the text -- what
  it says -- rather than one for a terminal that may or may not decode it.
  Colour in this script comes from Write-Host -ForegroundColor, which the host
  applies itself and which survives redirection to the log as plain text.
#>
function Remove-IonAnsi {
  param([string] $Text)
  if (-not $Text) { return $Text }
  # CSI (ESC [ ... final-byte) covers colour and cursor movement; OSC
  # (ESC ] ... BEL or ESC \) covers the title/hyperlink sequences npm uses.
  $csi = "$([char]27)\[[0-9;?]*[ -/]*[@-~]"
  $osc = "$([char]27)\][^$([char]7)$([char]27)]*($([char]7)|$([char]27)\\)"
  return ($Text -replace $csi, '' -replace $osc, '')
}

<#
  Truncate a single captured line to something a human can read.

  electron-builder's "duplicate dependency references" line is one JSON array
  of every transitively duplicated package: 6,894 characters on this
  repository, one line, no newlines. It tells the operator nothing actionable
  and it buries the lines around it in both the console and the log.

  The full text is not recoverable afterwards, which is the deliberate
  trade -- this is a build transcript for a human, and the tools that produced
  the line can be re-run directly when the detail is genuinely wanted. The
  marker says a truncation happened so the transcript never silently lies
  about what the child printed.
#>
function Limit-IonLineLength {
  param([string] $Text, [int] $Maximum = 500)
  if (-not $Text -or $Text.Length -le $Maximum) { return $Text }
  return $Text.Substring(0, $Maximum) + "... [+$($Text.Length - $Maximum) chars]"
}

function Write-IonLine {
  param([string] $Text, [string] $Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
  if ($script:IonLogPath) {
    Add-Content -Path $script:IonLogPath -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $Text) -Encoding utf8
  }
}

<#
  Write one line of a child process's output. Everything captured from a child
  goes through here rather than Write-IonLine directly, so the escape-stripping
  and length cap apply uniformly to stdout and stderr, and so this script's own
  messages -- which are never escaped and never absurdly long -- stay untouched.
#>
function Write-IonChildLine {
  param([string] $Text)
  Write-IonLine ("    " + (Limit-IonLineLength (Remove-IonAnsi $Text))) 'DarkGray'
}

function Write-IonStep  { param([string] $m) Write-IonLine "`n=== $m ===" 'Cyan' }
function Write-IonSkip  { param([string] $m) Write-IonLine "--- skipped: $m" 'DarkGray' }
function Write-IonInfo  { param([string] $m) Write-IonLine "    $m" 'Gray' }
function Write-IonOk    { param([string] $m) Write-IonLine "OK  $m" 'Green' }
function Write-IonWarn  { param([string] $m) Write-IonLine "WARN  $m" 'Yellow' }
function Write-IonError { param([string] $m) Write-IonLine "ERROR  $m" 'Red' }

function Stop-IonLog {
  if ($script:IonLogPath) { Write-Host "`nlog: $script:IonLogPath" -ForegroundColor DarkGray }
}

# ── Process execution ────────────────────────────────────────────────────────

<#
  Turn an argument array into a single Win32 command-line string, using the
  same backslash/quote escaping rule CommandLineToArgvW (and every C-runtime
  argv parser, including Go's and Node's) uses to split it back apart. Needed
  because ProcessStartInfo takes one command-line string, not an argv array,
  on both .NET Framework (Windows PowerShell 5.1) and .NET (pwsh 7).
#>
function ConvertTo-IonArgumentString {
  param([string[]] $Arguments)
  $parts = foreach ($arg in $Arguments) {
    if ($arg -eq '') {
      '""'
    } elseif ($arg -notmatch '[\s"]') {
      $arg
    } else {
      $sb = New-Object System.Text.StringBuilder
      [void]$sb.Append('"')
      $backslashes = 0
      foreach ($ch in $arg.ToCharArray()) {
        if ($ch -eq '\') {
          $backslashes++
        } elseif ($ch -eq '"') {
          [void]$sb.Append('\', ($backslashes * 2 + 1))
          [void]$sb.Append('"')
          $backslashes = 0
        } else {
          if ($backslashes -gt 0) { [void]$sb.Append('\', $backslashes); $backslashes = 0 }
          [void]$sb.Append($ch)
        }
      }
      if ($backslashes -gt 0) { [void]$sb.Append('\', ($backslashes * 2)) }
      [void]$sb.Append('"')
      $sb.ToString()
    }
  }
  return ($parts -join ' ')
}

<#
  Resolve a bare command name (npm, go, node, ...) the same way PowerShell's
  own `&` operator would -- via PATH -- but as an ApplicationInfo we can hand
  to ProcessStartInfo directly. -CommandType Application excludes PowerShell
  functions/aliases/cmdlets of the same name.
#>
function Resolve-IonNativeCommand {
  param([Parameter(Mandatory)][string] $Command)
  $found = Get-Command -Name $Command -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $found) { throw "'$Command' was not found on PATH" }
  return $found.Source
}

<#
  Run an external command, tee its output to the log, and throw on a non-zero
  exit.

  Driven through System.Diagnostics.Process with an explicit UTF-8
  StandardOutputEncoding/StandardErrorEncoding, rather than PowerShell's own
  `& cmd 2>&1 | ForEach-Object` capture. npm, vite and electron-builder write
  UTF-8 checkmarks and box-drawing characters to stdout; PowerShell's capture
  of a native command's output is decoded using the console's own codepage
  (chcp), which on a stock Windows console is the legacy OEM codepage
  (437/1252) regardless of what `[Console]::OutputEncoding` is set to after
  the fact -- that is what turned "OK" into "ГЁô" even with the console
  switched to UTF-8 in Start-IonLog. Reading the child's pipe with an explicit
  StreamReader encoding sidesteps the console entirely: the bytes are decoded
  correctly no matter what codepage the terminal happens to be in.

  A .cmd/.bat command (npm, npx on Windows are batch shims) cannot be started
  directly by CreateProcess -- it is not a PE executable, so it needs cmd.exe
  as the interpreter, exactly like PowerShell's own `&` does under the hood.
#>
function Invoke-IonNative {
  param(
    [Parameter(Mandatory)][string] $Command,
    [string[]] $Arguments = @(),
    [string] $WorkingDirectory,
    [switch] $AllowFailure,
    # Return the child's last non-empty stdout line instead of its exit code.
    # For the handful of children whose output IS the answer (the desktop
    # version resolver), so they still stream to the transcript and still fail
    # loudly on a non-zero exit rather than being run through a bare `&`.
    [switch] $CaptureLastLine
  )

  Write-IonInfo "> $Command $($Arguments -join ' ')"

  $resolved = Resolve-IonNativeCommand -Command $Command
  $argString = ConvertTo-IonArgumentString -Arguments $Arguments
  $ext = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $utf8NoBom
  $psi.StandardErrorEncoding = $utf8NoBom
  $psi.CreateNoWindow = $true
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }

  if ($ext -in @('.cmd', '.bat')) {
    $psi.FileName = $env:ComSpec
    $psi.Arguments = '/d /c ""' + $resolved + '" ' + $argString + '"'
  } else {
    $psi.FileName = $resolved
    $psi.Arguments = $argString
  }

  $proc = [System.Diagnostics.Process]::Start($psi)

  # Drain stdout on this thread (so it still streams live, which is what
  # progress output is for) and stderr concurrently on a background
  # runspace. Reading one stream to completion while the other's OS pipe
  # buffer fills up with nobody draining it deadlocks the child -- that is
  # why both are never read with ReadToEnd() sequentially on one thread.
  $stderrRunspace = [powershell]::Create()
  [void]$stderrRunspace.AddScript({ param($stream) $stream.ReadToEnd() }).AddArgument($proc.StandardError)
  $stderrHandle = $stderrRunspace.BeginInvoke()

  $lastLine = $null
  try {
    while ($true) {
      $line = $proc.StandardOutput.ReadLine()
      if ($null -eq $line) { break }
      if ($line.Trim()) { $lastLine = $line.Trim() }
      Write-IonChildLine $line
    }
    $proc.WaitForExit()

    $stderrText = $stderrRunspace.EndInvoke($stderrHandle)
    if ($stderrText) {
      ($stderrText -split "`r?`n") | Where-Object { $_ -ne '' } | ForEach-Object { Write-IonChildLine $_ }
    }

    $code = $proc.ExitCode
    if ($code -ne 0 -and -not $AllowFailure) {
      throw "$Command exited $code"
    }
    if ($CaptureLastLine) { return $lastLine }
    return $code
  } finally {
    $stderrRunspace.Dispose()
    $proc.Dispose()
  }
}

function Test-IonCommand {
  param([Parameter(Mandatory)][string] $Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ── Target architecture ──────────────────────────────────────────────────────

<#
  Resolve the architecture the engine binary and the installer are both built
  for. A hardcoded x64 on an ARM64 host produces an installer the machine can
  only run under emulation, carrying an amd64 ion.exe inside it -- wrong in two
  ways while still reporting a clean build. Resolving once, here, is what keeps
  the binary and its installer from disagreeing.

  Returns a hashtable: Arch is electron-builder's spelling, GoArch is Go's.
#>
function Resolve-IonArch {
  param(
    [ValidateSet('auto', 'x64', 'arm64')] [string] $Requested = 'auto',
    [string] $HostArchitecture = $env:PROCESSOR_ARCHITECTURE
  )
  $arch = $Requested
  if ($arch -eq 'auto') {
    $arch = if ($HostArchitecture -eq 'ARM64') { 'arm64' } else { 'x64' }
  }
  return @{
    Arch   = $arch
    GoArch = if ($arch -eq 'arm64') { 'arm64' } else { 'amd64' }
  }
}

# ── Environment ──────────────────────────────────────────────────────────────

<#
  npm ships as npm.ps1, so under the default Restricted policy every npm call
  is refused. Widen the current user only; the machine scope is not ours to
  decide.
#>
# ── Desktop version ──────────────────────────────────────────────────────────

<#
  Parse the desktop version out of an installer filename.

  Pure, so the agreement check below is testable without a build. The version
  is everything between "Ion-Setup-" and the trailing "-<arch>.exe", which
  keeps a prerelease version ("1.98.0-dev.abc123.dirty") intact.
#>
function Get-IonVersionFromInstallerName {
  param([Parameter(Mandatory)][AllowEmptyString()][string] $Name)
  $m = [regex]::Match($Name, '^Ion-Setup-(?<v>.+)-(?<a>x64|arm64)\.exe$')
  if (-not $m.Success) { return $null }
  return $m.Groups['v'].Value
}

<#
  The version this build stamps into every artifact.

  There is exactly one answer, and desktop/scripts/desktop-version.js is where
  it comes from: the released version in release-please-manifest.json, bumped
  to the next minor and suffixed with the commit and dirty state. CI already
  resolves through it, and the local Windows build did not -- it let
  electron-builder read desktop/package.json, which carries whatever version
  release-please last committed there and is normally many releases behind.
  The result was an installer, an NSIS DisplayVersion, an Intune detection
  stamp and a provenance manifest that all agreed with each other on a number
  that was wrong. Editing package.json locally would "fix" that by making the
  working tree lie instead, so the resolver is called and its answer is passed
  to both build steps.

  Three sources, in order:

    1. ION_DESKTOP_VERSION, when the caller has already resolved it.
    2. The sync stamp, whenever one is present and complete. The machine that
       HAS the history resolves the version at sync time
       (scripts/sync-windows-vm.sh) and records it, so the stamp is the
       authoritative answer for the tree it describes.
    3. The resolver, when there is no stamp. The normal developer checkout,
       where git history is the only source there is.

  The stamp is consulted BEFORE git, not after, and that order is the whole
  point. The Windows VM builds from a tar of tracked files, but the directory
  it extracts into has accumulated .git metadata from historic partial copies.
  That metadata describes a tree nobody synced: git reported a different, dirty
  commit, desktop-version.js answered from it, and the build stamped a version
  the source did not match while a correct stamp sat unread beside it. Git
  answering first is what made that possible, so git no longer answers first.

  A stamp that is present but unreadable, unparseable or missing a required
  field is a hard failure rather than a fallback. It exists only because a sync
  wrote it, so a broken one means the sync is broken, and falling through to
  git would resurrect exactly the false provenance above. ION_DESKTOP_VERSION
  remains the override for anyone who needs one.

  Anything else is a hard failure. A build with a guessed version produces
  artifacts nobody can trace, which is the failure this whole path exists to
  remove.
#>
function Resolve-IonDesktopVersion {
  param(
    [Parameter(Mandatory)][string] $Root,
    [string] $StampPath
  )
  if ($env:ION_DESKTOP_VERSION) {
    Write-IonInfo "desktop version from ION_DESKTOP_VERSION: $($env:ION_DESKTOP_VERSION)"
    return [string] $env:ION_DESKTOP_VERSION
  }

  if (-not $StampPath) { $StampPath = Join-Path $Root '.ion-sync-stamp.json' }

  if (Test-Path -LiteralPath $StampPath) {
    $stamp = $null
    try {
      $stamp = Get-Content -LiteralPath $StampPath -Raw | ConvertFrom-Json
    } catch {
      throw "$StampPath is not readable JSON: $($_.Exception.Message). Re-run ``make sync-windows-vm``, or set ION_DESKTOP_VERSION."
    }

    # Every field the stamp promises is required, because a partial stamp is
    # indistinguishable from a sync that failed halfway and its version cannot
    # be tied back to a commit.
    foreach ($field in @('desktopVersion', 'commit', 'syncedAtUtc')) {
      if (-not $stamp.$field) {
        throw "$StampPath carries no $field. A partial sync stamp cannot describe the tree it sits in. Re-run ``make sync-windows-vm``, or set ION_DESKTOP_VERSION."
      }
    }

    Write-IonInfo "desktop version from the sync stamp: $($stamp.desktopVersion) (commit $($stamp.commit), dirty=$($stamp.dirty), synced $($stamp.syncedAtUtc))"
    # Named explicitly, because a synced tree that also has git metadata is the
    # exact shape that produced a wrong version before, and the log is where
    # anyone re-diagnosing it will look.
    #
    # Invoke-IonNative -AllowFailure, not a raw `&` call: git writes "fatal:
    # not a git repository" to stderr when $Root has no .git, and under
    # $ErrorActionPreference = 'Stop' on Windows PowerShell 5.1 that stderr
    # write is itself a terminating error even with a `*> $null` redirect --
    # the same trap Invoke-IonNative and the scheduled-task check above exist
    # to avoid.
    if (Test-IonCommand 'git') {
      $gitDirCode = Invoke-IonNative 'git' @('-C', $Root, 'rev-parse', '--git-dir') -AllowFailure
      if ($gitDirCode -eq 0) {
        Write-IonInfo 'this tree also has git metadata; the sync stamp is authoritative and git was not consulted'
      }
    }
    return [string] $stamp.desktopVersion
  }

  $hasGit = $false
  if (Test-IonCommand 'git') {
    $hasGit = ((Invoke-IonNative 'git' @('-C', $Root, 'rev-parse', '--git-dir') -AllowFailure) -eq 0)
  }

  if ($hasGit) {
    $version = (Invoke-IonNative 'node' @('scripts/desktop-version.js') `
      -WorkingDirectory (Join-Path $Root 'desktop') -CaptureLastLine)
    if ($version) {
      Write-IonInfo "desktop version from desktop/scripts/desktop-version.js: $version"
      return [string] $version
    }
    throw 'desktop/scripts/desktop-version.js produced no version.'
  }

  throw ("Cannot resolve the desktop version: this tree has no git history and there is no sync stamp at $StampPath. " +
         'Re-run `make sync-windows-vm` from the machine that holds the repository, or set ION_DESKTOP_VERSION.')
}

<#
  Assert that every version-bearing surface of a finished build agrees with
  the version the build resolved.

  Four surfaces carry a version and they are produced by four different
  mechanisms, so "they all came from one variable" is an intention rather than
  a fact until it is read back off the artifacts:

    - the installer FILENAME, which electron-builder composes from the
      effective package version;
    - the installer's Win32 VERSIONINFO resource, which is what Windows shows
      in the file's properties and what an operator reads when a support case
      arrives with a screenshot;
    - latest.yml, the update feed electron-builder writes beside it;
    - the NSIS DisplayVersion, which is the effective package version and is
      therefore proved by the two above rather than readable before install.

  Anything that disagrees fails the build. An installer whose name says one
  version and whose properties say another is worse than one that is simply
  old, because the disagreement is what makes it untraceable.
#>
function Assert-IonInstallerVersion {
  param(
    [Parameter(Mandatory)][string] $InstallerPath,
    [Parameter(Mandatory)][string] $Arch,
    [Parameter(Mandatory)][string] $Version,
    [Parameter(Mandatory)][string] $ReleaseDir
  )
  Write-IonStep 'version agreement'

  $nameVersion = Get-IonVersionFromInstallerName -Name (Split-Path $InstallerPath -Leaf)
  if ($nameVersion -ne $Version) {
    throw "installer filename says version '$nameVersion' but this build resolved '$Version'"
  }
  Write-IonInfo "filename: $nameVersion"

  # The numeric core only. A prerelease suffix ("-dev.abc123.dirty") has no
  # representation in a Win32 VERSIONINFO quad, so electron-builder drops it --
  # comparing the whole string would fail every local build for a difference
  # that is a property of the resource format rather than a disagreement.
  $core = ($Version -split '[-+]')[0]
  $productVersion = $null
  try {
    $productVersion = (Get-Item -LiteralPath $InstallerPath).VersionInfo.ProductVersion
  } catch {
    Write-IonWarn "could not read the installer's VERSIONINFO: $($_.Exception.Message)"
  }
  if ($productVersion) {
    if (-not ($productVersion.StartsWith($core, [System.StringComparison]::Ordinal))) {
      throw "the installer's VERSIONINFO says '$productVersion' but this build resolved '$Version'"
    }
    Write-IonInfo "VERSIONINFO: $productVersion"
  } else {
    # Reported, not silently skipped: on a non-Windows host there is no
    # VERSIONINFO to read, and pretending it agreed would be a lie.
    Write-IonInfo 'VERSIONINFO: unreadable on this host, not checked'
  }

  $feed = Join-Path $ReleaseDir 'latest.yml'
  if (Test-Path -LiteralPath $feed) {
    $feedVersion = ([regex]::Match((Get-Content -LiteralPath $feed -Raw), '(?m)^version:\s*(?<v>\S+)')).Groups['v'].Value
    if ($feedVersion -ne $Version) {
      throw "latest.yml says version '$feedVersion' but this build resolved '$Version'"
    }
    Write-IonInfo "latest.yml: $feedVersion"
  } else {
    Write-IonInfo 'latest.yml: not produced by this target'
  }

  Write-IonOk "every version surface agrees on $Version ($Arch)"
}

<#
  Assert the provenance manifest records the version and architecture this
  build actually produced.

  The manifest is the artifact anybody holding the installer six weeks later
  reads to identify it. A manifest that names a different version than the
  installer beside it is worse than no manifest, because it is believed.
#>
function Assert-IonManifestVersion {
  param(
    [Parameter(Mandatory)][string] $ManifestPath,
    [Parameter(Mandatory)][string] $Version,
    [Parameter(Mandatory)][string] $Arch
  )
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if ($manifest.version -ne $Version) {
    throw "the artifact manifest says version '$($manifest.version)' but this build resolved '$Version'"
  }
  if ($manifest.arch -ne $Arch) {
    throw "the artifact manifest says arch '$($manifest.arch)' but this build produced '$Arch'"
  }
  Write-IonInfo "manifest: version $($manifest.version), arch $($manifest.arch), buildType $($manifest.buildType), reproducible $($manifest.reproducible)"
}

function Set-IonExecutionPolicy {
  $current = Get-ExecutionPolicy -Scope CurrentUser
  if ($current -in @('Restricted', 'Undefined')) {
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
    Write-IonInfo 'execution policy (CurrentUser): RemoteSigned'
  } else {
    Write-IonInfo "execution policy (CurrentUser): $current"
  }
}

<#
  winget updates the machine PATH, but this process keeps the one it started
  with, so a tool installed a moment ago is invisible until the PATH is
  re-read. Without this, a single bootstrap run installs Node and then fails to
  find npm.
#>
function Update-IonPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = ($machine, $user | Where-Object { $_ }) -join ';'
}

function Install-IonWingetPackage {
  param([Parameter(Mandatory)][string] $Id, [Parameter(Mandatory)][string] $Probe, [string[]] $Extra = @())
  if (Test-IonCommand $Probe) {
    Write-IonSkip "$Id (already installed)"
    return
  }
  Write-IonInfo "installing $Id"
  $args = @('install', '--id', $Id, '--exact', '--silent',
            '--accept-source-agreements', '--accept-package-agreements') + $Extra
  Invoke-IonNative 'winget' $args -AllowFailure | Out-Null
  Update-IonPath
  if (-not (Test-IonCommand $Probe)) {
    Write-IonWarn "$Id installed but '$Probe' is still not on PATH; a new shell may be required"
  }
}

function Install-IonToolchain {
  param([Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string] $Arch)
  if (-not (Test-IonCommand 'winget')) {
    throw 'winget not found. Install "App Installer" from the Microsoft Store, then re-run.'
  }

  Install-IonWingetPackage -Id 'Git.Git'             -Probe 'git'
  Install-IonWingetPackage -Id 'GoLang.Go'           -Probe 'go'
  Install-IonWingetPackage -Id 'OpenJS.NodeJS.LTS'   -Probe 'node'
  Install-IonWingetPackage -Id 'Microsoft.PowerShell' -Probe 'pwsh'

  # node-gyp rejects the Microsoft Store python.exe stub, which resolves on
  # PATH but is not an interpreter -- so probe for a real one rather than for
  # the name.
  if (Test-IonRealPython) {
    Write-IonSkip 'Python (already installed)'
  } else {
    Install-IonWingetPackage -Id 'Python.Python.3.12' -Probe 'nonexistent-force-install' -Extra @('--scope', 'machine')
  }

  Install-IonBuildTools -Arch $Arch
  Install-IonEsbuild
}

<#
  A real interpreter answers --version; the WindowsApps stub opens the Store
  and returns nothing useful.
#>
function Test-IonRealPython {
  foreach ($name in @('python', 'python3')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    if ($cmd.Source -like '*\WindowsApps\*') { continue }
    try {
      $v = & $cmd.Source --version 2>&1
      if ($v -match 'Python \d') { return $true }
    } catch {
      Write-IonWarn "python probe failed for $($cmd.Source): $($_.Exception.Message)"
    }
  }
  return $false
}

<#
  Every Visual Studio component node-gyp needs to build this project's native
  dependencies for a given architecture.

  Two of them, and both have to be named:

    VC.Tools.<arch>              The compiler targeting that architecture. The
                                 VCTools workload's recommended set installs
                                 the x64 and x86 targets only, so ARM64 is
                                 absent on an ARM64 machine unless asked for.
    VC.Runtimes.<arch>.Spectre   Spectre-mitigated runtime libraries. node-pty
                                 sets the Spectre mitigation property, so
                                 without these MSBuild stops at MSB8040.

  This toolchain is genuinely required and cannot be avoided by preferring the
  shipped prebuilds. node-pty's prebuilt binaries are Node-ABI specific (plain
  pty.node, fetched by its own prebuild script), so Electron, which has a
  different ABI, must build its own.
#>
function Get-IonVCComponents {
  param([Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string] $Arch)
  if ($Arch -eq 'arm64') {
    return @(
      'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
      'Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre'
    )
  }
  return @(
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre'
  )
}

<#
  The 7-Zip branch filter electron-builder must use when it compresses the app
  payload into the NSIS archive.

  electron-builder unpacks that archive at install time with the bundled
  nsis7z plugin, whose decoder is built on the LZMA SDK 19.00 filter set:
  BCJ, BCJ2, ARM, ARMT, IA64, PPC, SPARC, DELTA. Current 7-Zip additionally
  applies an ARM64 filter to ARM64 executables, and the plugin cannot decode
  those entries. It drops them, returns nothing, and electron-builder's
  extract macro never inspects a result -- so an ARM64 install lands its data
  files, silently omits every executable including Ion.exe, and still exits 0.

  Pinning BCJ keeps every entry inside the set the plugin can decode. It is
  set for both architectures rather than only ARM64: an x64 payload would
  otherwise get BCJ2, and one filter for both means the arch that is built
  less often cannot quietly diverge from the one that is.
#>
function Get-IonSevenZipFilter { return 'BCJ' }

<#
  electron-builder's install-app-deps rebuilds native modules against
  Electron's ABI via node-gyp, which needs a C++ toolchain even though every
  dependency ships a prebuilt binary for this architecture.
#>
function Install-IonBuildTools {
  param([Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string] $Arch)

  $components = Get-IonVCComponents -Arch $Arch
  $missing = @($components | Where-Object { -not (Test-IonVSComponent -Component $_) })
  if ($missing.Count -eq 0) {
    Write-IonSkip "Visual Studio Build Tools ($($components -join ', '))"
    return
  }

  # Two different operations, and using the wrong one is a silent no-op.
  # `winget install` on an already-installed package does not apply --override;
  # it reports "Found an existing package already installed" and changes
  # nothing, so a machine with Build Tools but without these components stays
  # exactly as broken. Adding to an existing install is the Visual Studio
  # Installer's `modify` verb.
  $installPath = Get-IonVisualStudioPath
  if ($installPath) {
    Write-IonInfo "adding to $installPath : $($missing -join ', ')"
    $vsInstaller = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vs_installer.exe'
    if (-not (Test-Path $vsInstaller)) {
      throw "Visual Studio Installer not found at $vsInstaller; add $($missing -join ', ') with the Visual Studio Installer, then re-run."
    }
    # No --wait: both setup.exe and vs_installer.exe on this Build Tools build
    # reject it with "Option 'wait' is unknown" and exit 87 without doing
    # anything. Start-Process -Wait gives the same guarantee without depending
    # on an installer flag whose spelling varies by version.
    $argList = @('modify', '--installPath', "`"$installPath`"")
    foreach ($c in $missing) { $argList += @('--add', $c) }
    $argList += @('--quiet', '--norestart')
    $proc = Start-Process -FilePath $vsInstaller -Wait -PassThru -ArgumentList $argList
    Write-IonInfo "Visual Studio Installer exited $($proc.ExitCode)"
  } else {
    Write-IonInfo "installing Visual Studio Build Tools (large download): $($components -join ', ')"
    $adds = ($components | ForEach-Object { "--add $_" }) -join ' '
    $override = "--quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools $adds --includeRecommended"
    Invoke-IonNative 'winget' @('install', '--id', 'Microsoft.VisualStudio.2022.BuildTools', '--exact', '--silent',
                                '--accept-source-agreements', '--accept-package-agreements',
                                '--override', $override) -AllowFailure | Out-Null
  }

  $stillMissing = @($components | Where-Object { -not (Test-IonVSComponent -Component $_) })
  if ($stillMissing.Count -gt 0) {
    throw "Visual Studio Build Tools is still missing: $($stillMissing -join ', '). Add them with the Visual Studio Installer (Individual components), then re-run."
  }
  Write-IonInfo "Visual Studio components present: $($components -join ', ')"
}

<#
  The install path of any Build Tools / Visual Studio instance, or $null when
  none is installed. Deliberately not filtered by component: the caller needs
  to know an instance exists precisely so it can add a component to it.
#>
function Get-IonVisualStudioPath {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { return $null }
  $path = & $vswhere -products '*' -property installationPath 2>$null | Select-Object -First 1
  if ($path) { return $path.Trim() }
  return $null
}

<#
  Ask vswhere for one specific component rather than for "some Build Tools
  install". A check that answers yes when a needed component is absent is worse
  than no check: it lets a build skip setup and then fail deep inside node-gyp,
  where the cause is unrecognisable.
#>
function Test-IonVSComponent {
  param([Parameter(Mandatory)][string] $Component)
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { return $false }
  $found = & $vswhere -products '*' -requires $Component -property installationPath 2>$null
  return [bool]$found
}

function Test-IonVisualStudioBuildTools {
  param([Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string] $Arch)
  foreach ($c in (Get-IonVCComponents -Arch $Arch)) {
    if (-not (Test-IonVSComponent -Component $c)) { return $false }
  }
  return $true
}

<#
  The engine looks for esbuild on PATH and in %APPDATA%\npm when it transpiles
  a TypeScript extension, so a global install is part of a working environment
  rather than a convenience.
#>
function Install-IonEsbuild {
  if (Test-IonCommand 'esbuild') {
    Write-IonSkip 'esbuild (already installed)'
    return
  }
  Invoke-IonNative 'npm' @('install', '--global', 'esbuild') -AllowFailure | Out-Null
  Update-IonPath
}

<#
  Make sure the machine can build before trying to, installing only what is
  missing.

  On macOS `make desktop` runs the environment setup itself, so nobody has to
  remember a prerequisite target. This is that same contract: a Windows
  contributor with a bare machine runs one command and gets an installer, and
  a machine that is already set up pays a few Get-Command calls to find out.
#>
function Initialize-IonEnvironment {
  param([Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string] $Arch)
  $missing = @()
  foreach ($tool in @('git', 'go', 'node', 'npm')) {
    if (-not (Test-IonCommand $tool)) { $missing += $tool }
  }
  # node-gyp needs both, because electron-builder rebuilds native modules
  # against Electron's ABI rather than using the shipped prebuilds.
  if (-not (Test-IonRealPython))            { $missing += 'python' }
  foreach ($c in (Get-IonVCComponents -Arch $Arch)) {
    if (-not (Test-IonVSComponent -Component $c)) { $missing += $c }
  }

  if ($missing.Count -eq 0) {
    Write-IonSkip 'toolchain (already complete)'
    return
  }

  Write-IonStep "installing missing toolchain: $($missing -join ', ')"
  Write-IonInfo 'Visual Studio Build Tools is a large download on a bare machine.'
  Install-IonToolchain -Arch $Arch
}

# ── Repository steps (the `make bootstrap` equivalents) ──────────────────────

<#
  CLAUDE.md is a local-only pointer at the sibling AGENTS.md. Windows can only
  create a symbolic link with Developer Mode on or from an elevated shell, so
  fall back to a copy -- which is why this writes a warning rather than
  pretending the link exists.
#>
function New-IonClaudeSymlinks {
  param([Parameter(Mandatory)][string] $Root)
  $agents = Get-ChildItem -Path $Root -Filter 'AGENTS.md' -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|graphify-out)\\' }
  $linked = 0; $copied = 0
  foreach ($a in $agents) {
    $target = Join-Path $a.DirectoryName 'CLAUDE.md'
    if (Test-Path $target) { continue }
    try {
      New-Item -ItemType SymbolicLink -Path $target -Value $a.Name -ErrorAction Stop | Out-Null
      $linked++
    } catch {
      Copy-Item $a.FullName $target
      $copied++
    }
  }
  Write-IonInfo "CLAUDE.md: $linked linked, $copied copied, $($agents.Count) AGENTS.md found"
  if ($copied -gt 0) {
    Write-IonWarn 'Copies drift from their AGENTS.md. Enable Developer Mode (Settings > System > For developers) and delete the copies to get real links.'
  }
}

<#
  Whoever runs this is developing Ion, so their engine is a dev build and DEBUG
  is the level it needs. Preserve every other key, and refuse rather than guess
  when the file does not parse -- overwriting an operator's engine config to
  fix a log level would be a poor trade.
#>
function Set-IonEngineLogLevel {
  param([string] $Level = 'debug')
  $path = Join-Path $env:USERPROFILE '.ion\engine.json'
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $config = [ordered]@{}
  if (Test-Path $path) {
    try {
      $raw = Get-Content $path -Raw
      if ($raw.Trim()) {
        $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
        foreach ($p in $parsed.PSObject.Properties) { $config[$p.Name] = $p.Value }
      }
    } catch {
      Write-IonWarn "$path does not parse as JSON; leaving it untouched. ($($_.Exception.Message))"
      return
    }
  }
  if ($config['logLevel'] -eq $Level) {
    Write-IonSkip "engine logLevel (already $Level)"
    return
  }
  $config['logLevel'] = $Level
  ($config | ConvertTo-Json -Depth 20) | Set-Content -Path $path -Encoding utf8
  Write-IonInfo "engine logLevel: $Level  ($path)"
  Write-IonInfo 'Takes effect at the next engine restart.'
}

<#
  The graph is a gitignored local build cache that no build, test or CI job
  reads, so a missing graphify is never an error here.
#>
function Build-IonGraph {
  param([Parameter(Mandatory)][string] $Root)
  if (-not (Test-IonCommand 'graphify')) {
    Write-IonSkip 'knowledge graph (graphify not installed -- optional)'
    return
  }
  if (Test-Path (Join-Path $Root 'graphify-out\graph.json')) {
    Write-IonSkip 'knowledge graph (already built)'
    return
  }
  Invoke-IonNative 'graphify' @('.', '--code-only') -WorkingDirectory $Root -AllowFailure | Out-Null
  Invoke-IonNative 'graphify' @('cluster-only', '.', '--no-viz', '--no-label') -WorkingDirectory $Root -AllowFailure | Out-Null
}
