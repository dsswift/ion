#!/usr/bin/env bash
# post-to-discord.sh — Post a summary file to a Discord webhook.
#
# Handles three posting strategies based on content length:
#   1. Short  (≤ 1,900 chars): plain content message (no embed).
#   2. Medium (≤ 4,000 chars): single embed with full description.
#   3. Long   (> 4,000 chars): multiple embed messages, split at paragraph
#      boundaries, with 1-second delays between POSTs for rate-limit safety.
#
# Usage:
#   post-to-discord.sh <summary-file> <webhook-url> <embed-title>
#
# Dependencies: bash ≥ 4, curl, jq (all available on ubuntu-latest runners).

set -euo pipefail

readonly CONTENT_LIMIT=1900
readonly EMBED_CHUNK_LIMIT=4000
readonly EMBED_COLOR=5814783
readonly RATE_LIMIT_SLEEP=1

# ── Argument validation ──────────────────────────────────────────────

if [ $# -ne 3 ]; then
  echo "Usage: $0 <summary-file> <webhook-url> <embed-title>" >&2
  exit 1
fi

SUMMARY_FILE="$1"
WEBHOOK_URL="$2"
EMBED_TITLE="$3"

if [ ! -f "$SUMMARY_FILE" ]; then
  echo "Error: summary file not found: $SUMMARY_FILE" >&2
  exit 1
fi

if [ -z "$WEBHOOK_URL" ]; then
  echo "Error: webhook URL is empty" >&2
  exit 1
fi

# ── Read summary ─────────────────────────────────────────────────────

SUMMARY=$(cat "$SUMMARY_FILE")
CHAR_COUNT=${#SUMMARY}

echo "Summary: ${CHAR_COUNT} chars from ${SUMMARY_FILE}"

if [ "$CHAR_COUNT" -eq 0 ]; then
  echo "Warning: summary is empty — skipping Discord post"
  exit 0
fi

# ── HTTP POST helper ─────────────────────────────────────────────────
# Posts a JSON payload to the webhook. Handles 429 (rate-limited) with
# a single retry using the retry_after value from Discord's response.

post_payload() {
  local payload_file="$1"
  local label="$2"
  local response_file
  response_file=$(mktemp)

  local http_code
  http_code=$(curl -sS -o "$response_file" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    -d @"$payload_file" "$WEBHOOK_URL")

  echo "${label}: HTTP ${http_code}"

  if [ "$http_code" -eq 429 ]; then
    local retry_after
    retry_after=$(jq -r '.retry_after // 2' "$response_file")
    echo "${label}: rate-limited, retrying after ${retry_after}s"
    sleep "$retry_after"

    http_code=$(curl -sS -o "$response_file" -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' \
      -d @"$payload_file" "$WEBHOOK_URL")

    echo "${label}: retry HTTP ${http_code}"
  fi

  if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    echo "Discord webhook failed: HTTP ${http_code}" >&2
    cat "$response_file" >&2
    rm -f "$response_file"
    exit 1
  fi

  rm -f "$response_file"
}

# ── Strategy 1: short message (plain content) ───────────────────────

if [ "$CHAR_COUNT" -le "$CONTENT_LIMIT" ]; then
  echo "Strategy: plain content (${CHAR_COUNT} chars)"
  payload_file=$(mktemp)
  jq -Rs '{content: .}' "$SUMMARY_FILE" > "$payload_file"
  post_payload "$payload_file" "content"
  rm -f "$payload_file"
  exit 0
fi

# ── Strategy 2: medium message (single embed) ───────────────────────

if [ "$CHAR_COUNT" -le "$EMBED_CHUNK_LIMIT" ]; then
  echo "Strategy: single embed (${CHAR_COUNT} chars)"
  payload_file=$(mktemp)
  jq -Rsn --arg title "$EMBED_TITLE" --argjson color "$EMBED_COLOR" \
    '{embeds: [{title: $title, description: input, color: $color}]}' \
    "$SUMMARY_FILE" > "$payload_file"
  post_payload "$payload_file" "embed"
  rm -f "$payload_file"
  exit 0
fi

# ── Strategy 3: long message (chunked embeds) ───────────────────────

echo "Strategy: chunked embeds (${CHAR_COUNT} chars, limit ${EMBED_CHUNK_LIMIT}/chunk)"

# Split the summary into chunks at paragraph boundaries (\n\n).
# If a single paragraph exceeds the limit, hard-split at the limit.
chunks=()
remaining="$SUMMARY"

while [ ${#remaining} -gt 0 ]; do
  if [ ${#remaining} -le "$EMBED_CHUNK_LIMIT" ]; then
    chunks+=("$remaining")
    break
  fi

  # Take up to EMBED_CHUNK_LIMIT chars, then find the last paragraph
  # break (\n\n) within that window.
  window="${remaining:0:$EMBED_CHUNK_LIMIT}"

  # Find the last \n\n in the window using awk.
  split_pos=$(printf '%s' "$window" | awk '
    BEGIN { pos = 0; offset = 0 }
    {
      # awk splits on \n, so each record boundary is a newline.
      # A paragraph break (\n\n) shows as: an empty record followed
      # by the next non-empty record. When we see a non-empty line
      # whose predecessor was empty, offset is the paragraph start.
      if (NR > 1 && length($0) > 0 && prev_len == 0) {
        pos = offset
      }
      prev_len = length($0)
      offset += length($0) + 1  # +1 for the \n
    }
    END { print pos }
  ')

  if [ "$split_pos" -gt 0 ]; then
    chunks+=("${remaining:0:$split_pos}")
    remaining="${remaining:$split_pos}"
  else
    # No paragraph break found — hard-split at the limit.
    chunks+=("${window}")
    remaining="${remaining:$EMBED_CHUNK_LIMIT}"
  fi
done

total=${#chunks[@]}
echo "Chunk count: ${total}"

for i in "${!chunks[@]}"; do
  chunk="${chunks[$i]}"
  chunk_num=$((i + 1))
  chunk_chars=${#chunk}

  echo "Chunk ${chunk_num}/${total}: ${chunk_chars} chars"

  payload_file=$(mktemp)

  if [ "$i" -eq 0 ]; then
    # First chunk gets the title, no footer.
    printf '%s' "$chunk" | jq -Rsn --arg title "$EMBED_TITLE" --argjson color "$EMBED_COLOR" \
      '{embeds: [{title: $title, description: input, color: $color}]}' \
      > "$payload_file"
  else
    # Subsequent chunks get a part footer, no title.
    footer_text="(part ${chunk_num} of ${total})"
    printf '%s' "$chunk" | jq -Rsn --argjson color "$EMBED_COLOR" --arg footer "$footer_text" \
      '{embeds: [{description: input, color: $color, footer: {text: $footer}}]}' \
      > "$payload_file"
  fi

  post_payload "$payload_file" "chunk ${chunk_num}/${total}"
  rm -f "$payload_file"

  # Rate-limit safety: sleep between POSTs (skip after the last one).
  if [ "$chunk_num" -lt "$total" ]; then
    sleep "$RATE_LIMIT_SLEEP"
  fi
done

echo "All ${total} chunks delivered successfully"
