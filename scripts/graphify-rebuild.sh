#!/usr/bin/env bash
# Incrementally refresh the graphify knowledge graph after history arrives from
# somewhere other than a local commit.
#
# Why Ion ships this at all: graphify's `hook install` writes `post-commit` and
# `post-checkout`, which between them cover "I committed" and "I switched
# branches". They do NOT cover the two ways other people's work lands:
#
#   - `git pull` — a fast-forward moves the branch pointer without a checkout,
#     so post-checkout's `$3 == 1` branch-switch test is false and it exits.
#     Git's hook for this is post-merge, which graphify does not install.
#   - `git rebase` — post-commit and post-checkout both deliberately bail while
#     a rebase is in progress (`rebase-merge` / `rebase-apply` present), because
#     replaying N commits would otherwise fire N racing rebuilds. That
#     suppression is correct, but it has no counterpart: git's post-rebase
#     notification is post-rewrite, which graphify also does not install.
#
# The net effect without this script is silent and bad: pull main, switch to a
# feature branch, rebase onto main — and the graph is missing everything that
# just landed, with no later event that picks it up. An agent then queries
# pre-merge structure and acts on it.
#
# Invoked by .husky/post-merge and .husky/post-rewrite. Runs the rebuild
# detached so `git pull` / `git rebase` return immediately.

set -uo pipefail

# Opt-out, matching the graphify-generated hooks.
[ "${GRAPHIFY_SKIP_HOOK:-0}" = "1" ] && exit 0

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$REPO_ROOT" || exit 0

# Nothing to refresh if this clone has no graph — `make bootstrap` builds the
# first one. Refreshing a nonexistent graph would trigger a full extraction at
# an unexpected moment.
[ -d graphify-out ] || exit 0
[ -f graphify-out/graph.json ] || exit 0

# Linked worktrees share core.hooksPath with the primary checkout but never
# rebuild its provisioned graph link. An unreadable identity is safe to skip:
# hooks are convenience automation and must not mutate an uncertain target.
_GUARD=$(bash scripts/graphify-worktree-guard.sh) || exit 0
if [ "${_GUARD%% *}" = "worktree" ]; then
    exit 0
fi

# Resolve an interpreter that can import graphify. Same probe order as the
# generated hooks so both agree on which install they use: a $HOME-relative uv
# pin, then the path the CLI records, then the launcher on PATH, then a plain
# python3/python. $HOME rather than a literal ~ because the shell does not
# expand tilde inside quotes.
PROBE="import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('graphify') else 1)"
PYTHON=""

PINNED="$HOME/.local/share/uv/tools/graphifyy/bin/python"
if [ -x "$PINNED" ] && "$PINNED" -c "$PROBE" 2>/dev/null; then
    PYTHON="$PINNED"
fi

if [ -z "$PYTHON" ] && [ -f graphify-out/.graphify_python ]; then
    FROM_FILE="$(tr -d '[:space:]' < graphify-out/.graphify_python)"
    case "$FROM_FILE" in
        *[!a-zA-Z0-9/_.@:\\-]*) FROM_FILE="" ;;  # path-character allowlist
    esac
    if [ -n "$FROM_FILE" ] && [ -x "$FROM_FILE" ] && "$FROM_FILE" -c "$PROBE" 2>/dev/null; then
        PYTHON="$FROM_FILE"
    fi
fi

# Third probe: resolve via the graphify launcher on PATH. Covers pipx, venv,
# and Windows pip layouts where neither the uv pin nor .graphify_python exists
# but the launcher is discoverable — without this, a pull/rebase silently skips
# on exactly the installs post-commit rebuilds fine, which is the staleness
# this script exists to prevent.
if [ -z "$PYTHON" ]; then
    GRAPHIFY_BIN=$(command -v graphify 2>/dev/null)
    if [ -n "$GRAPHIFY_BIN" ]; then
        # Windows pip layout: Scripts/graphify(.exe) sits beside ..\python.exe
        # (or .\python.exe inside a venv's Scripts dir). command -v may return
        # the launcher WITHOUT the .exe suffix, so this cannot key on it.
        _BINDIR=$(dirname "$GRAPHIFY_BIN")
        if [ -x "$_BINDIR/../python.exe" ] && "$_BINDIR/../python.exe" -c "$PROBE" 2>/dev/null; then
            PYTHON="$_BINDIR/../python.exe"
        elif [ -x "$_BINDIR/python.exe" ] && "$_BINDIR/python.exe" -c "$PROBE" 2>/dev/null; then
            PYTHON="$_BINDIR/python.exe"
        fi
    fi

    # Fourth probe: parse the POSIX launcher's shebang. head -c + tr strip NUL
    # bytes first — when the launcher is a Windows binary reached without its
    # .exe suffix, a raw `head -1` reads binary into the command substitution
    # and the shell warns about ignored null bytes on every pull.
    if [ -z "$PYTHON" ] && [ -n "$GRAPHIFY_BIN" ]; then
        case "$GRAPHIFY_BIN" in
            *.exe) _SHEBANG="" ;;
            *)     _SHEBANG=$(head -c 256 "$GRAPHIFY_BIN" 2>/dev/null | tr -d '\000' | head -n 1 | sed 's/^#![[:space:]]*//') ;;
        esac
        case "$_SHEBANG" in
            */env\ *) _FROM_SHEBANG="${_SHEBANG#*/env }" ;;
            *)        _FROM_SHEBANG="$_SHEBANG" ;;
        esac
        case "$_FROM_SHEBANG" in
            *[!a-zA-Z0-9/_.@:\\-]*) _FROM_SHEBANG="" ;;  # path-character allowlist
        esac
        if [ -n "$_FROM_SHEBANG" ] && "$_FROM_SHEBANG" -c "$PROBE" 2>/dev/null; then
            PYTHON="$_FROM_SHEBANG"
        fi
    fi
fi

if [ -z "$PYTHON" ]; then
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "$PROBE" 2>/dev/null; then
            PYTHON="$candidate"
            break
        fi
    done
fi

# A missing graphify install is never fatal — the graph is an optional
# developer convenience and a pull or rebase must never fail over it.
if [ -z "$PYTHON" ]; then
    echo "[graphify] not installed — skipping graph refresh (run 'make bootstrap' after installing)" >&2
    exit 0
fi

LOG="${HOME}/.cache/graphify-rebuild.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

REASON="${1:-refresh}"
echo "[graphify] refreshing graph after ${REASON} (detached; log: $LOG)"

# Detach so the triggering git command returns immediately.
#
# `-m graphify update .` re-extracts only new and changed files against the
# existing graph, so this is incremental rather than a full rebuild. It is also
# the subcommand that takes graphify's per-repo flock: the generated hooks
# rebuild through graphify.watch._rebuild_code, which locks, and `update`
# routes through that same code. The raw `. --update --code-only` extract path
# does NOT lock, so a post-merge refresh racing a post-commit rebuild could
# lose an update outright — atomic writes prevent a torn file, not a lost
# write. `update` is code-only by definition ("no LLM needed") and rejects
# --code-only as an unknown option, so passing it here would abort the refresh.
"$PYTHON" - "$LOG" <<'PYEOF' &
import os, subprocess, sys
log_path = sys.argv[1]
try:
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    out = open(log_path, "a", buffering=1, encoding="utf-8", errors="replace")
except OSError:
    out = subprocess.DEVNULL
kw = dict(stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
          cwd=os.getcwd(), close_fds=True)
cmd = [sys.executable, "-m", "graphify", "update", "."]
if os.name == "nt":
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    try:
        subprocess.Popen(cmd, creationflags=flags | 0x01000000, **kw)
    except OSError:
        subprocess.Popen(cmd, creationflags=flags, **kw)
else:
    subprocess.Popen(cmd, start_new_session=True, **kw)
PYEOF

exit 0
