#!/usr/bin/env bash
# check-studio-parity — broadcast parity gate (mechanism 3 of the overlay↔Studio
# parity contract; see docs/architecture/adr on the Studio shell mirror store).
#
# The overlay and the Studio shell are two clients of one event stream. Event
# pushes to the overlay renderer must route through broadcast() (which owns
# the Studio fan-out gate) so both clients see them by default. A direct
# `webContents.send` to the overlay is allowed only from files on the
# owner-only allowlist below, each with a reason — going overlay-only is an
# explicit, documented decision, never an accident.
set -euo pipefail
cd "$(dirname "$0")/.."

# Files allowed to send directly to a window (owner-only or window-plumbing):
#   broadcast.ts             — the router itself (owns the Studio gate)
#   studio-window-manager.ts — Studio window plumbing (pushes TO the studio window / button indicator)
#   window-manager.ts        — window lifecycle plumbing (show/hide/settings signals)
#   updater.ts               — update UX is overlay chrome
#   ipc/studio.ts            — Studio forwarding router (owner exec-action relay)
#   ipc/conversation-backup.ts — overlay dialog plumbing
#   ipc/models.ts            — reply plumbing to the requesting window
#   ipc/remote-control.ts    — overlay-only remote-control UX
#   remote/handlers/display.ts — overlay display control from iOS
#   git/subscriptions.ts     — per-sender git subscription replies
ALLOWLIST='broadcast\.ts|studio-window-manager\.ts|window-manager\.ts|updater\.ts|ipc/studio\.ts|ipc/conversation-backup\.ts|ipc/models\.ts|ipc/remote-control\.ts|remote/handlers/display\.ts|git/subscriptions\.ts'

violations=$(grep -rn "webContents\.send(" desktop/src/main --include='*.ts' \
  | grep -v '__tests__' \
  | grep -vE "desktop/src/main/($ALLOWLIST)" || true)

if [ -n "$violations" ]; then
  echo "check-studio-parity: direct webContents.send outside the owner-only allowlist."
  echo "Route event pushes through broadcast() so the Studio mirror receives them,"
  echo "or add the file to the allowlist in scripts/check-studio-parity.sh with a reason."
  echo
  echo "$violations"
  exit 1
fi
echo "check-studio-parity: OK"
