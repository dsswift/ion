# Runs the release smoke test on this Windows machine against the synced tree,
# the same script CI runs, from a clean slate and back to one. Invoked over
# SSH by scripts/smoke-windows-vm.sh; a CI release run takes 12 minutes and
# publishes, this takes one installer build and publishes nothing.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo

& (Join-Path $PSScriptRoot 'Reset-IonTestState.ps1')

& .\make.ps1 installer
if ($LASTEXITCODE -ne 0) { throw "make.ps1 installer failed (exit $LASTEXITCODE)" }
$installer = Get-ChildItem 'desktop\release\Ion-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'no installer under desktop\release' }
Write-Host "vm-smoke: installer $($installer.Name)"

& pwsh -NoProfile -File scripts\ci\make-intunewin.ps1 -InstallerPath $installer.FullName -OutputDir desktop\release\intune -SkipPackaging
if ($LASTEXITCODE -ne 0) { throw "stamping the detection script failed (exit $LASTEXITCODE)" }

& pwsh -NoProfile -File scripts\ci\windows-smoke.ps1 -InstallerPath $installer.FullName -DetectScriptPath desktop\release\intune\Detect-Ion.ps1
$smokeExit = $LASTEXITCODE

# The reset deletes %USERPROFILE%\.ion, and with it the only record of why a
# run failed. Keep the logs first.
$logDir = Join-Path $repo 'desktop\release\smoke-logs'
Remove-Item -LiteralPath $logDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
foreach ($name in 'engine.jsonl', 'desktop.jsonl', 'server.jsonl') {
  $src = Join-Path $env:USERPROFILE ".ion\$name"
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $logDir }
}
Write-Host "vm-smoke: logs kept in $logDir"

& (Join-Path $PSScriptRoot 'Reset-IonTestState.ps1')
Write-Host "vm-smoke: smoke exit $smokeExit"
exit $smokeExit
