#!/bin/bash
# Detached launcher for install-app.command.
# Runs the installer in a background process that survives the parent
# being killed (critical for self-development inside CODA).

cd "$(dirname "$0")/.."

LOG="/tmp/coda-install.log"
nohup bash commands/install-app.command > "$LOG" 2>&1 &
disown

echo "Install dispatched successfully."
