<#
.SYNOPSIS
  One-shot setup of a Windows dev VM for building Ion Desktop.

.DESCRIPTION
  Installs the toolchain, clones the repository, and leaves the VM able to run
  Update-IonDev.ps1 for every subsequent iteration. Safe to re-run: every step
  checks for what it installs first.

  It installs Git, obtains the clone, and then hands off to the repository's
  own bootstrap.ps1 for the toolchain and make.ps1 for the build -- the same
  two scripts a Windows contributor runs on a physical machine.

  OpenSSH Server is installed and started so the Mac can drive the loop
  remotely. Skip it with -NoSsh if you would rather work only in the VM.

.PARAMETER Source
  Where to clone from. Any of:
    A custom Parallels share:        \\Mac\ion
    A shared Mac volume:             \\Mac\Macintosh HD\path\to\ion
    A bundle file on the shared Mac: \\Mac\Home\ion-win.bundle
    A GitHub URL:                    https://github.com/dsswift/ion.git

.PARAMETER Branch
  Branch to check out. Pass the branch of the worktree you are testing; a
  worktree branch is an ordinary ref in the base repository, so naming it is
  all that is needed. Defaults to main.

.PARAMETER Dest
  Where to clone to. Must be a native VM path, never a shared folder --
  node_modules on a shared folder is punishingly slow and breaks file watching.

.PARAMETER NoSsh
  Skip installing and enabling OpenSSH Server.

.EXAMPLE
  .\Bootstrap-IonDevVM.ps1 -Source '\\Mac\ion' -Branch wt/example
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Source,
  [string] $Branch = 'main',
  [string] $Dest = 'C:\dev\ion',
  [switch] $NoSsh
)

$ErrorActionPreference = 'Stop'

# npm on Windows is npm.ps1, so the default Restricted execution policy blocks
# every npm invocation -- including the ones this script and Update-IonDev.ps1
# make. The failure is quiet in a detached run: the process exits immediately,
# writes nothing, and leaves no node_modules behind. Widen it for this user once
# rather than prefixing every call, and leave the machine scope alone.
if ((Get-ExecutionPolicy -Scope CurrentUser) -in @('Restricted', 'Undefined')) {
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
  Write-Host 'execution policy (CurrentUser): RemoteSigned'
}

function Step([string] $m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Have([string] $exe) { $null -ne (Get-Command $exe -ErrorAction SilentlyContinue) }

if (-not (Have 'winget')) {
  [Console]::Error.WriteLine('winget not found. Install "App Installer" from the Microsoft Store, then re-run.')
  exit 1
}

# --- Prerequisite: git only ---------------------------------------------------
# The full toolchain belongs to bootstrap.ps1, which lives inside the repository
# and is the same script a Windows contributor runs on a physical machine.
# Keeping a second list here is how the two drift. Git is the exception: it is
# needed to obtain the clone that carries bootstrap.ps1 in the first place.
if (-not (Have 'git')) {
  Step 'installing Git.Git'
  winget install --id Git.Git --exact --silent --accept-source-agreements --accept-package-agreements
  # winget updates the machine PATH; this process still has the old one.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}
if (-not (Have 'git')) {
  [Console]::Error.WriteLine('git is still not on PATH after install. Open a new terminal and re-run.')
  exit 1
}

# --- Remote access -----------------------------------------------------------
if (-not $NoSsh) {
  Step 'enabling OpenSSH Server'
  $ssh = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
  if ($ssh.State -ne 'Installed') { Add-WindowsCapability -Online -Name $ssh.Name | Out-Null }
  Set-Service -Name sshd -StartupType Automatic
  Start-Service sshd
  if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  # pwsh as the default shell: the loop scripts are PowerShell 7.
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
    -Value (Get-Command pwsh).Source -PropertyType String -Force | Out-Null
  Write-Host "sshd is running. Reach this VM at:" -ForegroundColor Green
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { Write-Host "  ssh $env:USERNAME@$($_.IPAddress)" }
}

# --- Clone -------------------------------------------------------------------
if (Test-Path -LiteralPath (Join-Path $Dest '.git')) {
  Step "repository already present at $Dest"
} else {
  Step "cloning $Source -> $Dest"
  New-Item -ItemType Directory -Path (Split-Path -Parent $Dest) -Force | Out-Null
  # core.autocrlf=false: the repo has shell scripts and Go files whose line
  # endings must survive the round trip back to macOS.
  # Git refuses to read a repository it does not believe the current user owns,
  # and a Parallels share never reports a matching owner -- the clone dies with
  # "detected dubious ownership" before it reads an object. The source is the
  # operator's own repository on the host, so declare it safe. Both spellings
  # are registered because Git reports the path with the /.git suffix.
  if ($Source -like '\\*') {
    foreach ($safe in @($Source, ($Source -replace '\\$','') + '/.git')) {
      git config --global --add safe.directory $safe 2>&1 | Out-Null
    }
    Write-Host "declared safe.directory for $Source"
  }

  git clone --config core.autocrlf=false --branch $Branch -- "$Source" $Dest
}

Set-Location $Dest
git config core.autocrlf false
git config --local --add safe.directory $Dest

Step 'setting up the environment (bootstrap.ps1)'
& (Join-Path $Dest 'bootstrap.ps1')
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('bootstrap.ps1 failed; see bootstrap.log'); exit 1 }

Step 'building for the first time'
& (Join-Path $Dest 'make.ps1') installer
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('make.ps1 installer failed; see make.log'); exit 1 }

Write-Host ''
Write-Host "Logs: $Dest\bootstrap.log and $Dest\make.log" -ForegroundColor Green
Write-Host "Loop: .\packaging\windows\dev\Update-IonDev.ps1 [-Install]" -ForegroundColor Green
