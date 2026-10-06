#!/usr/bin/env bash
# Pins run-ion-prompt.sh: the engine reads the config from ION_DATA_DIR, a
# config with no model gets the CI default while one with a model keeps it,
# telemetry is merged only when asked for, the engine runs as the calling user
# so the script can clean up what it wrote, and a failed or empty run fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/run-ion-prompt.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# A fake docker records its arguments and the config it was given, then
# answers with $FAKE_ANSWER and exits $FAKE_EXIT.
cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" > "$TMP/docker-args"
for arg in "$@"; do
  case "$arg" in
    *:/data) cp "${arg%:/data}/.ion/engine.json" "$TMP/engine.json" ;;
  esac
done
cat > "$TMP/stdin"
printf '%s' "$FAKE_ANSWER"
exit "${FAKE_EXIT:-0}"
EOF
# A fake timeout drops its duration so the test runs where coreutils does not.
cat > "$TMP/bin/timeout" <<'EOF'
#!/usr/bin/env bash
shift
exec "$@"
EOF
chmod +x "$TMP/bin/docker" "$TMP/bin/timeout"
export PATH="$TMP/bin:$PATH" TMP

fail() { echo "FAIL: $*" >&2; exit 1; }
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

printf 'write the notes\n' > "$TMP/prompt"
unset ION_TELEMETRY_ENDPOINT ION_PROMPT_HOSTNAME ION_CI_DEFAULT_MODEL

# A config with no model gets the CI default; the engine reads it from ION_DATA_DIR.
export ION_ENGINE_CONFIG_B64="$(b64 '{"providers":{"anthropic":{}}}')" FAKE_ANSWER='- Faster startup' FAKE_EXIT=0
bash "$SCRIPT" img:1 "$TMP/prompt" "$TMP/out" > /dev/null
[ "$(cat "$TMP/out")" = '- Faster startup' ] || fail "answer not written"
[ "$(jq -r .defaultModel "$TMP/engine.json")" = 'claude-sonnet-5-5' ] || fail "no-model config did not get the default"
jq -e '.providers.anthropic' "$TMP/engine.json" > /dev/null || fail "secret config not kept"
grep -q -- '-e ION_DATA_DIR=/data/.ion' "$TMP/docker-args" || fail "ION_DATA_DIR not pointed at the config: $(cat "$TMP/docker-args")"
grep -q -- 'img:1 prompt - --output text --no-extensions --timeout 3m --max-budget 1.00' "$TMP/docker-args" || fail "prompt flags wrong: $(cat "$TMP/docker-args")"
[ "$(cat "$TMP/stdin")" = 'write the notes' ] || fail "prompt not on stdin"
grep -q -- "--user $(id -u):$(id -g)" "$TMP/docker-args" || fail "engine not run as the calling user: $(cat "$TMP/docker-args")"
grep -q -- '--hostname' "$TMP/docker-args" && fail "hostname passed when not asked for"
jq -e '.logging' "$TMP/engine.json" > /dev/null && fail "telemetry merged when not asked for"

# A config that names a model keeps it.
export ION_ENGINE_CONFIG_B64="$(b64 '{"defaultModel":"chosen-model"}')"
bash "$SCRIPT" img:1 "$TMP/prompt" "$TMP/out" > /dev/null
[ "$(jq -r .defaultModel "$TMP/engine.json")" = 'chosen-model' ] || fail "secret model overridden"

# Telemetry and hostname, when asked for.
export ION_TELEMETRY_ENDPOINT='https://collector.example.org' ION_PROMPT_HOSTNAME='ci-host'
bash "$SCRIPT" img:1 "$TMP/prompt" "$TMP/out" > /dev/null
[ "$(jq -r .logging.egressOtel.endpoint "$TMP/engine.json")" = 'https://collector.example.org' ] || fail "telemetry endpoint not set"
grep -q -- '-e ION_TELEMETRY_SHIP_CLIENT_SECRET' "$TMP/docker-args" || fail "telemetry secret not passed"
grep -q -- '--hostname ci-host' "$TMP/docker-args" || fail "hostname not passed"
unset ION_TELEMETRY_ENDPOINT ION_PROMPT_HOSTNAME

# An engine failure fails the script with its status.
export FAKE_EXIT=3 FAKE_ANSWER=''
status=0
bash "$SCRIPT" img:1 "$TMP/prompt" "$TMP/out" > /dev/null 2>&1 || status=$?
[ "$status" -eq 3 ] || fail "engine failure exit = $status, want 3"

# An empty answer from an engine that exited 0 is a failure too.
export FAKE_EXIT=0 FAKE_ANSWER=$'  \n'
status=0
bash "$SCRIPT" img:1 "$TMP/prompt" "$TMP/out" > /dev/null 2>&1 || status=$?
[ "$status" -eq 1 ] || fail "empty answer exit = $status, want 1"

# A secret that is not a JSON object is refused before docker runs.
rm -f "$TMP/docker-args"
export ION_ENGINE_CONFIG_B64="$(b64 'not json')" FAKE_ANSWER='x'
bash "$SCRIPT" img:1 "$TMP/prompt" "$TMP/out" > /dev/null 2>&1 && fail "bad secret accepted"
[ ! -e "$TMP/docker-args" ] || fail "docker ran with a bad secret"

echo "run-ion-prompt.test.sh: ok"
