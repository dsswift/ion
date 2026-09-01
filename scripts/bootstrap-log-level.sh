#!/usr/bin/env bash
# bootstrap-log-level.sh — put the developer's engine into DEBUG.
#
# Anyone running `make bootstrap` is developing Ion, and their global engine at
# ~/.ion is the dev build they are about to test against. DEBUG is the level
# that build needs: it is where the excruciating detail lives, and it is what
# both the developer and any agent working in this clone read out of
# ~/.ion/engine.jsonl. A consumer install stays on INFO, which is why this is a
# bootstrap step and not a shipped default.
#
# The engine resolves logLevel ONCE at daemon start, from the global config
# only — `LoadConfig("")` at cmd/ion/cmd_serve.go is the sole serve call site,
# and it passes no project directory. A project-level `.ion/engine.json` cannot
# raise the level, so this has to write the global file.
#
# Rules this script holds to:
#   - Preserve every other key. The file carries auth and provider config.
#   - Never print the file. It holds identity and credential material.
#   - Refuse rather than guess when the JSON does not parse.
#   - Atomic replace, so an interrupted run cannot truncate live config.
#   - Idempotent, and silent about work it did not need to do.
set -euo pipefail

CONFIG_DIR="${ION_HOME:-$HOME/.ion}"
CONFIG_FILE="$CONFIG_DIR/engine.json"

python3 - "$CONFIG_FILE" <<'PY'
import json
import os
import sys
import tempfile

path = sys.argv[1]
target = "debug"

if os.path.exists(path):
    try:
        with open(path) as handle:
            config = json.load(handle)
    except (json.JSONDecodeError, OSError) as err:
        # Refuse rather than overwrite. A malformed global config is the
        # operator's to fix; clobbering it would take their auth setup with it.
        print(f"⚠️  {path} could not be read ({err}).")
        print("   Set \"logLevel\": \"debug\" by hand once the file parses.")
        sys.exit(0)
    if not isinstance(config, dict):
        print(f"⚠️  {path} is not a JSON object; leaving it alone.")
        sys.exit(0)
else:
    config = {}

current = config.get("logLevel")
if current == target:
    sys.exit(0)  # Already correct. Say nothing.

config["logLevel"] = target

os.makedirs(os.path.dirname(path), exist_ok=True)
handle = tempfile.NamedTemporaryFile(
    mode="w", dir=os.path.dirname(path), delete=False, suffix=".tmp"
)
try:
    json.dump(config, handle, indent=2, sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
    handle.close()
    os.replace(handle.name, path)
except BaseException:
    os.unlink(handle.name)
    raise

was = current if current else "unset"
print(f"▶ engine logLevel: {was} → {target}")
print("   Restart the engine for this to take effect; the level is read once at")
print("   daemon start. Until then ~/.ion/engine.jsonl stays at the old level.")
PY
