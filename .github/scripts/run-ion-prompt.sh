#!/usr/bin/env bash
# run-ion-prompt.sh — run one prompt through the Ion engine image and write
# the answer to a file. Every CI job that asks Ion to write something goes
# through here, so the engine setup is right in one place.
#
# Usage:
#   run-ion-prompt.sh <engine-image> <prompt-file> <output-file>
#
# Environment:
#   ION_ENGINE_CONFIG_B64            required; base64 engine.json (repo secret)
#   ION_CI_DEFAULT_MODEL             the model used when that config names none
#                                    (default claude-sonnet-5-5)
#   ION_PROMPT_MAX_BUDGET            USD cap for the run (default 1.00)
#   ION_PROMPT_HOSTNAME              container hostname (optional)
#   ION_TELEMETRY_ENDPOINT           when set, ship the run's logs and spans:
#                                    .github/ion/ci-logging.json is merged over
#                                    the config and the endpoint filled in
#   ION_TELEMETRY_SHIP_CLIENT_SECRET passed to the container with telemetry
#
# Exits nonzero when the engine fails or the answer is empty, so a caller
# never mistakes a failed run for a blank answer.

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <engine-image> <prompt-file> <output-file>" >&2
  exit 2
fi

IMAGE="$1"
PROMPT_FILE="$2"
OUTPUT_FILE="$3"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_LOGGING="$SCRIPT_DIR/../ion/ci-logging.json"

: "${ION_ENGINE_CONFIG_B64:?ION_ENGINE_CONFIG_B64 is not set}"
DEFAULT_MODEL="${ION_CI_DEFAULT_MODEL:-claude-sonnet-5-5}"
MAX_BUDGET="${ION_PROMPT_MAX_BUDGET:-1.00}"

if [ ! -s "$PROMPT_FILE" ]; then
  echo "run-ion-prompt: prompt file is missing or empty: $PROMPT_FILE" >&2
  exit 2
fi

DATA_DIR="$(mktemp -d)"
trap 'rm -rf "$DATA_DIR"' EXIT
mkdir -p "$DATA_DIR/.ion"
CONFIG="$DATA_DIR/.ion/engine.json"

printf '%s' "$ION_ENGINE_CONFIG_B64" | base64 -d > "$DATA_DIR/secret.json"
if ! jq -e 'type == "object"' "$DATA_DIR/secret.json" > /dev/null; then
  echo "run-ion-prompt: ION_ENGINE_CONFIG_B64 is not a JSON object" >&2
  exit 1
fi

# The engine ships with no default model; a config that names none fails
# every prompt with "no model configured". The secret's own choice wins.
if jq -e '(.defaultModel // "") != ""' "$DATA_DIR/secret.json" > /dev/null; then
  echo "run-ion-prompt: model from the engine config"
else
  echo "run-ion-prompt: engine config names no model; using $DEFAULT_MODEL"
fi
jq --arg model "$DEFAULT_MODEL" '{defaultModel: $model} * .' "$DATA_DIR/secret.json" > "$CONFIG"

DOCKER_ENV=(-e ION_DATA_DIR=/data/.ion)
if [ -n "${ION_TELEMETRY_ENDPOINT:-}" ]; then
  jq -s --arg endpoint "$ION_TELEMETRY_ENDPOINT" \
    '.[0] * .[1] | .logging.egressOtel.endpoint = $endpoint' \
    "$CONFIG" "$CI_LOGGING" > "$CONFIG.tmp"
  mv "$CONFIG.tmp" "$CONFIG"
  DOCKER_ENV+=(-e ION_TELEMETRY_SHIP_CLIENT_SECRET)
  echo "run-ion-prompt: shipping telemetry"
fi
rm -f "$DATA_DIR/secret.json"
chmod 600 "$CONFIG"

HOSTNAME_ARGS=()
if [ -n "${ION_PROMPT_HOSTNAME:-}" ]; then
  HOSTNAME_ARGS=(--hostname "$ION_PROMPT_HOSTNAME")
fi

echo "run-ion-prompt: prompt is $(wc -c < "$PROMPT_FILE") bytes; running $IMAGE"
status=0
# The image runs as root by default. Its conversation files would then be
# root-owned in $DATA_DIR, and the cleanup trap could not remove them.
timeout 4m docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  ${HOSTNAME_ARGS[@]+"${HOSTNAME_ARGS[@]}"} \
  "${DOCKER_ENV[@]}" \
  -v "$DATA_DIR:/data" \
  "$IMAGE" \
  prompt - \
  --output text \
  --no-extensions \
  --timeout 3m \
  --max-budget "$MAX_BUDGET" \
  < "$PROMPT_FILE" \
  > "$OUTPUT_FILE" || status=$?

if [ "$status" -ne 0 ]; then
  echo "run-ion-prompt: the engine run failed (exit $status)" >&2
  exit "$status"
fi
if ! grep -q '[^[:space:]]' "$OUTPUT_FILE"; then
  echo "run-ion-prompt: the engine returned an empty answer" >&2
  exit 1
fi
echo "run-ion-prompt: answer is $(wc -c < "$OUTPUT_FILE") bytes"
