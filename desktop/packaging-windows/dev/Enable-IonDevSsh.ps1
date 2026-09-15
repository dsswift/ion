<#
.SYNOPSIS
  Enable OpenSSH Server on a Windows dev VM and authorize one public key.

.DESCRIPTION
  Run this ONCE, in an ELEVATED PowerShell, on the Windows VM. It is the only
  step that cannot be driven remotely, because it is what creates the remote
  channel. Everything after it can run over SSH.

  Windows OpenSSH ignores %USERPROFILE%\.ssh\authorized_keys for accounts in
  the Administrators group and reads C:\ProgramData\ssh\administrators_
  authorized_keys instead -- which must be owned by Administrators/SYSTEM with
  inheritance removed, or sshd silently refuses the key. Both files are written
  so the account works whether or not it is an administrator.

.PARAMETER PublicKey
  The authorized public key, in authorized_keys format.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $PublicKey
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  [Console]::Error.WriteLine('Enable-IonDevSsh: run this in an elevated PowerShell (Run as Administrator).')
  exit 1
}

Write-Host '=== installing OpenSSH Server ===' -ForegroundColor Cyan
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
# Windows sometimes stages the component and defers registering the sshd service
# until the next boot. Add-WindowsCapability reports that as RestartNeeded, and
# every Set-Service / Start-Service call before that reboot fails with "service
# was not found" -- so carry the flag rather than discarding the result.
$restartNeeded = $false
if ($cap.State -ne 'Installed') {
  $result = Add-WindowsCapability -Online -Name $cap.Name
  $restartNeeded = [bool]$result.RestartNeeded
}
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { $restartNeeded = $true }

# The OpenSSH Server component ships its own rule under this exact name, so a
# rule created before the install is replaced by the package's -- which is
# scoped to the Private profile. A Parallels host-only adapter classifies as
# Public, so the package rule alone drops every connection. Create the rule when
# it is absent, then widen whichever rule now holds the name to every profile.
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Any
$fw = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'
Write-Host "firewall: $($fw.DisplayName) enabled=$($fw.Enabled) profile=$($fw.Profile)"

Write-Host '=== authorizing key ===' -ForegroundColor Cyan

# Per-user file, for a standard account.
$userSsh = Join-Path $env:USERPROFILE '.ssh'
New-Item -ItemType Directory -Path $userSsh -Force | Out-Null
$userKeys = Join-Path $userSsh 'authorized_keys'
if (-not (Test-Path $userKeys) -or -not (Select-String -Path $userKeys -SimpleMatch $PublicKey -Quiet)) {
  Add-Content -Path $userKeys -Value $PublicKey -Encoding ascii
}

# Administrators file, which is the one sshd actually reads for an admin.
$adminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
New-Item -ItemType Directory -Path (Split-Path $adminKeys -Parent) -Force | Out-Null
if (-not (Test-Path $adminKeys) -or -not (Select-String -Path $adminKeys -SimpleMatch $PublicKey -Quiet)) {
  Add-Content -Path $adminKeys -Value $PublicKey -Encoding ascii
}
# sshd refuses the file unless only Administrators and SYSTEM can write it.
icacls $adminKeys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null

# The loop scripts are PowerShell 7 when it is present; fall back to Windows
# PowerShell so a fresh VM still gets a usable remote shell.
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $shell) { $shell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" }
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
  -Value $shell -PropertyType String -Force | Out-Null
Write-Host "default ssh shell: $shell"

# Everything above survives a reboot, so a deferred component install costs one
# restart and a re-run, never a redo of the key and firewall work.
if ($restartNeeded) {
  Write-Host ''
  Write-Host 'OpenSSH Server needs a restart before the sshd service exists.' -ForegroundColor Yellow
  Write-Host 'The key, the firewall rule and the shell are already in place.' -ForegroundColor Yellow
  Write-Host 'Reboot, then run this script again to start sshd.' -ForegroundColor Yellow
  exit 2
}

Set-Service -Name sshd -StartupType Automatic
Restart-Service sshd
Write-Host "sshd: $((Get-Service sshd).Status)"

Write-Host ''
Write-Host 'Reach this VM from the Mac at:' -ForegroundColor Green
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { Write-Host "  ssh $env:USERNAME@$($_.IPAddress)" }
