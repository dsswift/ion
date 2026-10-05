#!/bin/bash
# Ion — Finder entry point for the development install pipeline.
#
# This command builds Ion.app, waits for Ion's graceful quit, and installs the
# new build into /Applications without a password prompt.
set -euo pipefail

cd "$(dirname "$0")/.."
exec bash ./commands/install-bg.command
