#!/usr/bin/env bash
# download-release-assets.sh — download every asset of one release into a
# directory, ready to be checksummed. The checksum jobs go through here.
#
# Usage:
#   download-release-assets.sh <repo> <tag> <dir>
#
# Environment:
#   RELEASE_DOWNLOAD_ATTEMPTS  tries before giving up (default 5)
#   RELEASE_DOWNLOAD_BACKOFF   seconds before the first retry, doubled after
#                              each one (default 5)
#
# The release API answers an occasional HTTP 500 on an asset, so a failed
# download is retried. A checksums.txt from an earlier run is dropped, so a
# rerun does not hash the old checksums into the new ones.

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <repo> <tag> <dir>" >&2
  exit 2
fi

REPO="$1"
TAG="$2"
DIR="$3"
ATTEMPTS="${RELEASE_DOWNLOAD_ATTEMPTS:-5}"
delay="${RELEASE_DOWNLOAD_BACKOFF:-5}"

attempt=1
until gh release download "$TAG" -R "$REPO" -D "$DIR" --clobber; do
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "download-release-assets: $TAG failed after $attempt attempts" >&2
    exit 1
  fi
  echo "download-release-assets: $TAG attempt $attempt failed; retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
done

rm -f "$DIR/checksums.txt"
echo "download-release-assets: $TAG downloaded on attempt $attempt"
