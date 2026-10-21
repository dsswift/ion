#!/usr/bin/env bash
# Pins commands/launchagent.sh against a fake launchctl, including the two
# failures it exists for: an old engine whose teardown outlasts a short stop
# wait, and a RunAtLoad spawn launchd holds as speculative and never runs.

set -euo pipefail

HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/launchagent.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# The fake keeps its state in files under $FAKE:
#   loaded        the service is in the namespace (print succeeds)
#   linger        print calls left before a booted-out service disappears
#   calls         every subcommand, one per line
# FAKE_BOOTSTRAP_FAIL=1 makes bootstrap fail; FAKE_NO_BIND=1 makes kickstart
# start an engine that never binds its socket. bootstrap never binds: only
# kickstart does, modelling the held RunAtLoad spawn.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/launchctl" <<'FAKE_EOF'
#!/usr/bin/env bash
echo "$1" >> "$FAKE/calls"
case "$1" in
  bootout) [ -f "$FAKE/loaded" ] || exit 3 ;;
  print)
    [ -f "$FAKE/loaded" ] || exit 113
    if [ -f "$FAKE/linger" ]; then
      n="$(cat "$FAKE/linger")"
      if [ "$n" -le 0 ]; then rm -f "$FAKE/loaded" "$FAKE/linger"; exit 113; fi
      echo $((n - 1)) > "$FAKE/linger"
    fi
    ;;
  bootstrap)
    [ -n "${FAKE_BOOTSTRAP_FAIL:-}" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    [ -f "$FAKE/loaded" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    touch "$FAKE/loaded"
    ;;
  kickstart)
    [ -f "$FAKE/loaded" ] || exit 113
    [ -n "${FAKE_NO_BIND:-}" ] || python3 -c 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$ION_HOME/engine.sock"
    ;;
esac
FAKE_EOF
chmod +x "$TMP/bin/launchctl"

# reset LINGER: a loaded service that survives LINGER prints after bootout
# (or "none" for nothing loaded).
reset() {
  export FAKE="$TMP/fake" ION_HOME="$TMP/ion"
  rm -rf "$FAKE" "$ION_HOME"
  mkdir -p "$FAKE" "$ION_HOME"
  unset FAKE_BOOTSTRAP_FAIL FAKE_NO_BIND
  if [ "$1" != none ]; then touch "$FAKE/loaded"; echo "$1" > "$FAKE/linger"; fi
}

run() {
  PATH="$TMP/bin:$PATH" PLIST_LABEL=com.ion.engine \
    ION_LAUNCHD_POLL_S=0.01 ION_LAUNCHD_STOP_TIMEOUT_S="${STOP_S:-2}" ION_ENGINE_SOCKET_TIMEOUT_S=0.5 \
    bash -c 'source "$1"; shift; "$@"' _ "$HELPER" "$@"
}

# 1. A teardown that outlasts the old 50-poll wait still stops cleanly, and the
#    restart that follows binds the socket through kickstart.
reset 120
run stop_launch_agent 2>/dev/null || fail "a slow teardown was reported as wedged"
[ ! -f "$FAKE/loaded" ] || fail "stop returned while the service was still loaded"
run start_launch_agent "$TMP/com.ion.engine.plist" || fail "restart after a slow teardown failed"
[ -S "$ION_HOME/engine.sock" ] || fail "engine socket not bound after start"
grep -qx kickstart "$FAKE/calls" || fail "start never kickstarted the service"

# 2. A fresh install (nothing loaded) stops and starts.
reset none
run stop_launch_agent || fail "stop with nothing loaded failed"
run start_launch_agent "$TMP/com.ion.engine.plist" || fail "start on a fresh install failed"

# 3. A service that never leaves fails the stop instead of racing bootstrap.
reset 1000000
if STOP_S=0.2 run stop_launch_agent 2>"$TMP/err"; then fail "a wedged service was reported stopped"; fi
grep -q "still loaded" "$TMP/err" || fail "wedged stop gave no error: $(cat "$TMP/err")"

# 4. A failed bootstrap fails the start.
reset none
export FAKE_BOOTSTRAP_FAIL=1
if run start_launch_agent "$TMP/com.ion.engine.plist" 2>"$TMP/err"; then fail "a failed bootstrap was reported started"; fi
grep -q "bootstrap .* failed" "$TMP/err" || fail "failed bootstrap gave no error: $(cat "$TMP/err")"

# 5. An engine that never binds its socket fails the start.
reset none
export FAKE_NO_BIND=1
if run start_launch_agent "$TMP/com.ion.engine.plist" 2>"$TMP/err"; then fail "an unbound engine was reported started"; fi
grep -q "not bound" "$TMP/err" || fail "unbound socket gave no error: $(cat "$TMP/err")"

echo "launchagent: 5 cases passed"
