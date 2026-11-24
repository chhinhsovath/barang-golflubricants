#!/usr/bin/env bash
# Generate a .webp sibling for every jpg/png in the mirror.
#   <file>.jpg  ->  <file>.jpg.webp
# The suffix (rather than replacing the extension) keeps foo.jpg and foo.png
# from colliding, and lets serve.js map a request 1:1 onto its webp variant.
# Idempotent: skips any webp newer than its source.
set -uo pipefail
cd "$(dirname "$0")/.."
QUALITY="${QUALITY:-82}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu)}"

find . \( -path ./.git -o -path ./assets -o -path ./tools \) -prune -o \
     -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print0 \
| xargs -0 -P "$JOBS" -I{} bash -c '
    src="$1"; out="${src}.webp"
    if [ -f "$out" ] && [ "$out" -nt "$src" ]; then exit 0; fi
    cwebp -quiet -q '"$QUALITY"' -m 4 -metadata none "$src" -o "$out" 2>/dev/null || rm -f "$out"
  ' _ {}
