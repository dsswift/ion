#!/bin/bash
# Ion — Finder entry point for the shared development package pipeline.
#
# This command builds a local .pkg, waits for Ion's graceful quit, and opens
# macOS Installer. It never copies /Applications/Ion.app directly.
set -euo pipefail

cd "$(dirname "$0")/.."
exec bash ./commands/install-bg.command
