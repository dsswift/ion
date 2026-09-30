#!/usr/bin/env bash
# Runs the Windows release smoke test on the local Windows VM against this
# checkout: sync, then build the installer and smoke it there from a clean
# machine. The fast loop for a failure that CI only surfaces in a release run.
set -euo pipefail
cd "$(dirname "$0")/.."
VM_HOST="${ION_WIN_VM_HOST:-josh@10.211.55.3}"
VM_PATH="${ION_WIN_VM_PATH:-C:/dev/ion}"

bash scripts/sync-windows-vm.sh
rc=0
ssh "$VM_HOST" "pwsh -NoProfile -ExecutionPolicy Bypass -File '${VM_PATH}/scripts/windows/Invoke-VmSmoke.ps1'" || rc=$?
logs="build/windows-smoke-logs"
rm -rf "$logs" && mkdir -p "$logs"
scp -q "${VM_HOST}:${VM_PATH}/desktop/release/smoke-logs/*" "$logs/" || echo "smoke-windows-vm: no logs came back" >&2
echo "smoke-windows-vm: engine, desktop, and server logs in $logs"
exit "$rc"
