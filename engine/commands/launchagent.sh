#!/bin/bash
# LaunchAgent stop/start for commands/install.command. Sourced, not executed;
# kept apart so commands/launchagent.test.sh can drive it with a fake
# launchctl.
#
# Callers set PLIST_LABEL and ION_HOME. The waits are overridable for tests:
#   ION_LAUNCHD_STOP_TIMEOUT_S   how long the old service may take to leave
#   ION_ENGINE_SOCKET_TIMEOUT_S  how long the new engine may take to bind
#   ION_LAUNCHD_POLL_S           poll interval for both waits

# Default stop wait: the plist's ExitTimeOut (30 s, launchd's SIGKILL point)
# plus margin. The engine's own shutdown budget (timeouts.shutdownMs, 15 s by
# default) sits below ExitTimeOut, so a service still present past this is
# wedged rather than slow. A wait shorter than the shutdown budget lets
# bootstrap run against the departing service, which fails and leaves no
# engine loaded at all.
ION_LAUNCHD_STOP_TIMEOUT_S="${ION_LAUNCHD_STOP_TIMEOUT_S:-35}"
ION_ENGINE_SOCKET_TIMEOUT_S="${ION_ENGINE_SOCKET_TIMEOUT_S:-15}"
ION_LAUNCHD_POLL_S="${ION_LAUNCHD_POLL_S:-0.2}"

launchagent_target() {
    echo "gui/$(id -u)/$PLIST_LABEL"
}

# launchagent_polls TIMEOUT_S -> number of ION_LAUNCHD_POLL_S polls to cover it.
launchagent_polls() {
    awk -v t="$1" -v p="$ION_LAUNCHD_POLL_S" 'BEGIN { n = int(t / p); print (n < 1 ? 1 : n) }'
}

# stop_launch_agent: bootout the service and wait until launchd has removed it.
# Returns non-zero when it is still present after ION_LAUNCHD_STOP_TIMEOUT_S.
stop_launch_agent() {
    local target polls
    target="$(launchagent_target)"
    # On a fresh install (no agent ever loaded) bootout exits non-zero.
    launchctl bootout "$target" 2>/dev/null || true
    polls="$(launchagent_polls "$ION_LAUNCHD_STOP_TIMEOUT_S")"
    for _ in $(seq 1 "$polls"); do
        launchctl print "$target" >/dev/null 2>&1 || return 0
        sleep "$ION_LAUNCHD_POLL_S"
    done
    echo "  ERROR: $target still loaded after ${ION_LAUNCHD_STOP_TIMEOUT_S}s; the old engine did not exit" >&2
    return 1
}

# start_launch_agent PLIST: bootstrap the service, start it, and wait for the
# engine socket. Returns non-zero when any step fails.
start_launch_agent() {
    local plist="$1" target out polls
    target="$(launchagent_target)"
    if ! out="$(launchctl bootstrap "gui/$(id -u)" "$plist" 2>&1)"; then
        echo "  ERROR: launchctl bootstrap $plist failed: $out" >&2
        return 1
    fi
    # RunAtLoad alone is not enough: launchd can hold the load-time spawn as
    # "pended nondemand spawn = speculative" and never run it. kickstart
    # (without -k) starts the service now, and is a no-op when RunAtLoad
    # already did.
    if ! out="$(launchctl kickstart "$target" 2>&1)"; then
        echo "  ERROR: launchctl kickstart $target failed: $out" >&2
        return 1
    fi
    polls="$(launchagent_polls "$ION_ENGINE_SOCKET_TIMEOUT_S")"
    for _ in $(seq 1 "$polls"); do
        [ -S "$ION_HOME/engine.sock" ] && return 0
        sleep "$ION_LAUNCHD_POLL_S"
    done
    echo "  ERROR: engine socket $ION_HOME/engine.sock not bound after ${ION_ENGINE_SOCKET_TIMEOUT_S}s" >&2
    echo "         See $ION_HOME/engine-stdout.log, $ION_HOME/engine-stderr.log, and $ION_HOME/engine.jsonl" >&2
    return 1
}
