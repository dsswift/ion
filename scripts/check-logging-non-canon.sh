#!/usr/bin/env bash
# The NON-CANON check of scripts/check-logging.sh, sourced from it (and from
# its test): reports each non-canonical field key through the caller's
# `report` function. Wire payloads that legitimately carry those keys (a Go
# struct's JSON tag, a Swift raw-string JSON fixture) are not logger calls.

check_non_canon() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  local key_pat='"(runID|sessionID|convID|durationMs|elapsedMs|elapsed_ms|errMsg|errorMsg|errStr)"'
  local file linenum rest
  while IFS=: read -r file linenum rest; do
    # Skip Go struct JSON tag lines — they are wire-protocol contract fields,
    # not logger field keys. Tag lines contain `json:" before the matched key.
    case "$rest" in
      *'`json:"'*) continue ;;
      # A Swift raw-string JSON literal is a wire payload fixture, not a
      # logger call; its keys are the wire's, not the log schema's.
      *'#"{'*) continue ;;
    esac
    report "NON-CANON" "$file" "$linenum" "$rest"
  done < <(grep -EHn "$key_pat" "${files[@]}" 2>/dev/null || true)
}
