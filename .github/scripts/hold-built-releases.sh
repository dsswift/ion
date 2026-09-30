#!/usr/bin/env bash
# hold-built-releases.sh — After release-damnit has cut this push's releases,
# turn every release that has a build job back into a draft, and publish the
# ones that have nothing to build.
#
# A draft is invisible to the desktop update feed, to /releases/latest, and to
# `ion studio update`. build.yml's per-component publish job flips it public
# once every asset is attached. So a half-built release can never be seen.
#
# Usage:
#   RELEASE_REPORT='<release-damnit json>' hold-built-releases.sh
#
# BUILT_COMPONENTS names the components build.yml has a publish job for. A
# component not listed here is published immediately, marked non-latest: the
# engine release is the one the README install command resolves through
# /releases/latest, and its publish job is what marks it latest.

set -euo pipefail

BUILT_COMPONENTS="${BUILT_COMPONENTS:-engine server desktop relay}"

is_built() {
  local c
  for c in $BUILT_COMPONENTS; do
    [ "$c" = "$1" ] && return 0
  done
  return 1
}

while IFS=$'\t' read -r component tag; do
  [ -z "$tag" ] && continue
  if is_built "$component"; then
    gh release edit "$tag" --draft=true
    echo "held as draft: $tag ($component; published by build.yml)"
  else
    gh release edit "$tag" --draft=false --latest=false
    echo "published: $tag ($component; no build job)"
  fi
done < <(echo "$RELEASE_REPORT" | jq -r '.releases[] | "\(.component)\t\(.tag_name)"')
