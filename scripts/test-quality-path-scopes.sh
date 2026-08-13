#!/usr/bin/env bash
# Regression coverage for `.github/quality-paths.yml` ownership. Keep CI scope
# narrow for pull requests without letting a source path lose its required gate.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

FILTERS=.github/quality-paths.yml
WORKFLOW=.github/workflows/quality.yml

python3 - "$FILTERS" "$WORKFLOW" <<'PY'
import fnmatch
import sys
from pathlib import Path

path = Path(sys.argv[1])
workflow = Path(sys.argv[2]).read_text(encoding="utf-8")
filters = {}
current = None
for line in path.read_text(encoding="utf-8").splitlines():
    if not line or line.lstrip().startswith("#"):
        continue
    if not line.startswith(" ") and line.endswith(":"):
        current = line[:-1]
        filters[current] = []
    elif line.startswith("  - ") and current:
        filters[current].append(line[4:].strip("'\""))

cases = {
    "docs-only": ("docs/design/theme-packs.md", set()),
    "workflow-only": (".github/workflows/quality.yml", {"workflows"}),
    "engine": ("engine/internal/session/manager.go", {"engine", "logging"}),
    "relay": ("relay/main.go", {"relay", "logging"}),
    "sdk": ("sdk/go/context.go", {"sdk", "logging"}),
    "engine-sdk": ("engine/extensions/sdk/ion-sdk/types.ts", {"engine", "sdk", "logging"}),
    "desktop-source": ("desktop/src/main/remote/protocol.ts", {"desktop", "logging"}),
    "desktop-dependency": ("desktop/package-lock.json", {"desktop", "desktop_deps", "logging"}),
    "ios": ("ios/IonRemote/Models/RemoteTabState.swift", {"ios", "logging"}),
    "ios-docs": ("ios/AGENTS.md", {"logging"}),
    "ios-version": ("ios/VERSION", {"logging"}),
    "dashboard": ("docs/observability/dashboards/src/quality.ts", {"dashboards"}),
}

for name, (changed, want) in cases.items():
    got = {scope for scope, globs in filters.items() if any(fnmatch.fnmatch(changed, glob) for glob in globs)}
    if got != want:
        raise SystemExit(f"{name}: {changed}: got {sorted(got)}, want {sorted(want)}")

job_scopes = {
    "actionlint": "workflows",
    "status-writers": "desktop",
    "atv-parity": "desktop",
    "check-logging": "logging",
    "check-swiftlint": "ios",
    "dashboards": "dashboards",
    "engine-crossbuild": "engine",
    "engine-test-platform": "engine",
    "engine-test": "engine",
    "sdk-test": "sdk",
    "relay-test": "relay",
    "desktop-test": "desktop",
    "desktop-lint": "desktop",
    "desktop-audit": "desktop_deps",
    "docker-build": "engine",
    "ios-build": "ios",
}
for job, scope in job_scopes.items():
    needle = f"needs.changes.outputs.{scope} == 'true'"
    if needle not in workflow:
        raise SystemExit(f"{job}: missing path-scope condition for {scope}")

for scope in ("engine", "relay", "sdk"):
    needle = f"needs.changes.outputs.{scope} == 'true'"
    if workflow.count(needle) < 3:
        raise SystemExit(f"{scope}: composite lint/vulnerability steps are not fully scoped")

if "needs: [changes, engine-test-platform]" not in workflow or "if: always()" not in workflow:
    raise SystemExit("engine-test: missing stable aggregate required-check job")

print(f"quality path scopes: {len(cases)} cases and {len(job_scopes)} job guards passed")
PY
