<#
.SYNOPSIS
  One-command setup for a fresh Windows clone. The counterpart to `make bootstrap`.

.DESCRIPTION
  Windows has no make, so this script is the entry point a Windows contributor
  runs instead. It is idempotent: every step checks for what it installs first,
  so re-running it after a partial failure costs only the steps still missing.

  It does everything `make bootstrap` does on macOS -- npm install (which
  activates the husky git hooks), the CLAUDE.md symlinks, the engine debug log
  level, and the graph build when graphify is present -- and additionally
  installs the toolchain, because a Windows machine does not arrive with one.

  Toolchain, all via winget, which ships with Windows 11 and resolves the host
  architecture itself:

    Git, Go, Node.js LTS, PowerShell 7, Python, Visual Studio Build Tools

  Python and Build Tools are not optional, and the reason is easy to get wrong.
  Both native dependencies ship prebuilt binaries for every Windows
  architecture, so `npm install` alone would never reach a compiler. But the
  desktop's postinstall runs `electron-builder install-app-deps`, which rebuilds
  native modules against Electron's ABI rather than Node's, and that path calls
  node-gyp regardless of what prebuilds exist. macOS never shows this because
  Xcode Command Line Tools are already there, and CI never shows it because the
  GitHub runner image ships both -- a bare VM is the only place the requirement
  is visible.

.PARAMETER SkipToolchain
  Assume Git, Go, Node, Python and a compiler are already installed and go
  straight to the repository steps.

.PARAMETER LogPath
  Where the transcript is written. Defaults to bootstrap.log in the repository
  root, which .gitignore already covers via *.log.

.EXAMPLE
  .\bootstrap.ps1

.EXAMPLE
  .\bootstrap.ps1 -SkipToolchain
#>
[CmdletBinding()]
param(
  [switch] $SkipToolchain,
  [string] $LogPath
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $LogPath) { $LogPath = Join-Path $Root 'bootstrap.log' }

. (Join-Path $Root 'scripts\windows\IonBuild.ps1')

Start-IonLog -Path $LogPath -Title 'bootstrap'
try {
  # npm is npm.ps1, so the default Restricted policy refuses every npm call the
  # rest of this script makes. The refusal is near-invisible when a caller has
  # redirected output, so widen it first and say so.
  Set-IonExecutionPolicy

  if ($SkipToolchain) {
    Write-IonSkip 'toolchain (-SkipToolchain)'
  } else {
    # The compiler is per-target, so setup must know which one this machine
    # will build for. A bare clone builds for the host.
    Initialize-IonEnvironment -Arch (Resolve-IonArch).Arch
  }

  Write-IonStep 'npm install (activates husky git hooks)'
  Invoke-IonNative 'npm' @('install', '--no-audit', '--no-fund') -WorkingDirectory $Root

  Write-IonStep 'CLAUDE.md symlinks'
  New-IonClaudeSymlinks -Root $Root

  Write-IonStep 'engine log level'
  Set-IonEngineLogLevel -Level 'debug'

  Write-IonStep 'knowledge graph'
  Build-IonGraph -Root $Root

  Write-IonOk 'bootstrap complete'
  Write-IonInfo "Next: .\make.ps1 desktop   (build and install Ion)"
} catch {
  Write-IonError "bootstrap failed: $($_.Exception.Message)"
  Stop-IonLog
  exit 1
}
Stop-IonLog
