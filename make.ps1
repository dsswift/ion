<#
.SYNOPSIS
  The Windows counterpart to the Makefile. `.\make.ps1 <target>`.

.DESCRIPTION
  Windows has no make, so this script carries the targets a Windows contributor
  actually needs. It is not a general make replacement -- it covers the build
  and install path, and defers everything else to the Makefile on a Mac.

  Targets:

    bootstrap   Set up a fresh machine. Delegates to .\bootstrap.ps1.
    engine      Build ion.exe and stage it into desktop\resources\engine.
    installer   engine + renderer build + NSIS installer. Leaves the .exe on
                disk and installs nothing.
    desktop     The whole path and the one command that matters: install any
                missing toolchain, build the engine, install dependencies,
                build the installer, close a running Ion, launch the installer.
                The equivalent of `make desktop` on macOS, including the fact
                that it sets up the environment itself -- no target has to be
                run before it.
    clean       Remove build output (dist, release, staged engine resources).
    uninstall   Remove every trace of Ion from this machine: per-machine and
                per-user installs, both uninstall registrations, the engine
                Scheduled Task, and the shortcuts. Requires an elevated
                prompt, and leaves %ProgramData%\Ion (enterprise policy)
                alone. Developer verb -- it is what gets past the installer's
                refusal to add a per-user copy beside a managed one.
    help        This list.

  Every run writes a transcript to make.log in the repository root, which
  .gitignore already covers via *.log. The Windows loop is usually driven from
  another machine, where a failure tends to arrive as silence -- a log that
  always exists is what makes the run readable afterwards.

.PARAMETER Target
  Which target to run. Defaults to help.

.PARAMETER Arch
  auto (default, follows the host), x64, or arm64. The engine binary and the
  installer are always built for the same one. A Windows VM on Apple silicon
  is ARM64; pass -Arch x64 to deliberately produce the emulated build.

.PARAMETER SkipSetup
  Skip the toolchain check. Saves a few seconds on a machine already known to
  be set up; a bare machine needs the check.

.PARAMETER LogPath
  Where the transcript is written. Defaults to make.log in the repository root.

.EXAMPLE
  .\make.ps1 bootstrap

.EXAMPLE
  .\make.ps1 desktop

.EXAMPLE
  .\make.ps1 installer -Arch x64
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('help', 'bootstrap', 'engine', 'installer', 'desktop', 'clean', 'uninstall')]
  [string] $Target = 'help',

  [ValidateSet('auto', 'x64', 'arm64')] [string] $Arch = 'auto',
  [switch] $SkipSetup,
  [string] $LogPath
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $LogPath) { $LogPath = Join-Path $Root 'make.log' }

. (Join-Path $Root 'scripts\windows\IonBuild.ps1')
. (Join-Path $Root 'scripts\windows\IonDesktop.ps1')

$resolved = Resolve-IonArch -Requested $Arch
$Arch   = $resolved.Arch
$GoArch = $resolved.GoArch

function Initialize-IonBuildEnvironment {
  Set-IonExecutionPolicy
  if ($SkipSetup) {
    Write-IonSkip 'toolchain check (-SkipSetup)'
    return
  }
  Initialize-IonEnvironment -Arch $Arch
}

function Show-IonHelp {
  Write-Host @"

Ion on Windows

  .\make.ps1 desktop           Everything: install whatever toolchain is
                               missing, build the engine and the installer,
                               close a running Ion, launch the installer.
                               Nothing needs to be run before it.

Partial targets, for when you do not want the whole path:

  .\make.ps1 engine            Build ion.exe into desktop\resources\engine
  .\make.ps1 installer         Build the installer, install nothing
  .\make.ps1 clean             Remove build output
  .\bootstrap.ps1              Machine setup on its own (also does the git
                               hooks, CLAUDE.md links and engine log level,
                               which building does not need)

  -Arch x64|arm64              Override the host architecture (default: auto)
  -SkipSetup                   Skip the toolchain check on a known-good machine
  -LogPath <file>              Where the transcript goes (default: make.log)

Host architecture: $env:PROCESSOR_ARCHITECTURE   Resolved target: $Arch

"@ -ForegroundColor Gray
}

if ($Target -eq 'help') { Show-IonHelp; exit 0 }

Start-IonLog -Path $LogPath -Title "make $Target"
Write-IonInfo "target architecture: $Arch (GOARCH=$GoArch)"

try {
  switch ($Target) {
    'bootstrap' {
      & (Join-Path $Root 'bootstrap.ps1')
      if ($LASTEXITCODE -ne 0) { throw "bootstrap.ps1 exited $LASTEXITCODE" }
    }

    'clean' {
      Invoke-IonClean -Root $Root
    }

    # Developer-only, and elevated on purpose: this is the one way past the
    # installer's refusal to put a per-user copy beside a managed one.
    'uninstall' {
      $n = Uninstall-IonEverywhere -Root $Root
      Write-IonOk "removed $n item(s)"
    }

    'engine' {
      Initialize-IonBuildEnvironment
      Build-IonEngine -Root $Root -GoArch $GoArch
    }

    'installer' {
      Initialize-IonBuildEnvironment
      Build-IonEngine -Root $Root -GoArch $GoArch
      Install-IonDesktopDependencies -Root $Root
      $exe = Build-IonInstaller -Root $Root -Arch $Arch
      Write-IonOk "installer: $exe"
      Write-IonInfo 'Install it with: .\make.ps1 desktop'
    }

    # The whole path, end to end: set up whatever is missing, build the engine
    # and the installer, close a running Ion, and launch it. Nothing has to be
    # run before this.
    'desktop' {
      Initialize-IonBuildEnvironment
      Build-IonEngine -Root $Root -GoArch $GoArch
      Install-IonDesktopDependencies -Root $Root
      $exe = Build-IonInstaller -Root $Root -Arch $Arch
      Write-IonOk "installer: $exe"

      Stop-IonRunning
      Start-IonInstaller -InstallerPath $exe
    }
  }
} catch {
  Write-IonError "make $Target failed: $($_.Exception.Message)"
  Stop-IonLog
  exit 1
}

Write-IonOk "make $Target complete"
Stop-IonLog
