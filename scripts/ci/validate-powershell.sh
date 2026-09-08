#!/usr/bin/env bash
# Gate for the Windows entry points: every .ps1 must parse, and the IonBuild
# helpers must behave.
#
# A PowerShell syntax error is only discovered when the script runs, which on
# Windows is usually on someone else's machine at the end of a long build. The
# parse check is cheap and catches it here instead.
#
# PowerShell is not a hard requirement for contributors: a machine without pwsh
# skips this and CI still runs it, the same posture the repo takes for graphify.
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v pwsh >/dev/null 2>&1; then
  echo "check-windows-scripts: pwsh not installed, skipping (CI runs this)"
  exit 0
fi

# macOS ships bash 3.2, which has no mapfile -- read the list portably.
scripts=()
while IFS= read -r line; do
  scripts+=("$line")
done < <(git ls-files '*.ps1')

if [ ${#scripts[@]} -eq 0 ]; then
  echo "check-windows-scripts: no .ps1 files tracked" >&2
  exit 1
fi

echo "check-windows-scripts: parsing ${#scripts[@]} script(s)"
for f in "${scripts[@]}"; do
  pwsh -NoProfile -Command "
    \$errors = \$null; \$tokens = \$null
    [System.Management.Automation.Language.Parser]::ParseFile(
      (Resolve-Path '$f').Path, [ref]\$tokens, [ref]\$errors) | Out-Null
    if (\$errors) { \$errors | ForEach-Object { Write-Error \$_.Message }; exit 1 }
  " || { echo "check-windows-scripts: $f failed to parse" >&2; exit 1; }
done

pwsh -NoProfile -File scripts/windows/IonBuild.test.ps1
pwsh -NoProfile -File packaging/windows/Remove-IonEngineTasks.test.ps1
pwsh -NoProfile -File scripts/ci/Write-IonArtifactManifest.test.ps1
pwsh -NoProfile -File scripts/ci/IonContentPrepTool.test.ps1
pwsh -NoProfile -File scripts/ci/make-intunewin.test.ps1
pwsh -NoProfile -File packaging/windows/intune/policy/New-IonPolicyPackage.test.ps1

echo "check-windows-scripts: OK"
