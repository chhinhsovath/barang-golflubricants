#!/usr/bin/env bash
# Shrink the oversized catalogue PDFs under Cloudflare's 25 MiB asset limit.
#
#   ./tools/shrink-pdf.sh
#
# These are Corel-produced brochures whose pages are CMYK JPEG-2000 images
# (618 of them in the VENOL folder). Ghostscript alone CANNOT read that
# combination -- it emits a file with a broken xref that renders zero pages.
# So this runs two stages:
#   1. pdftocairo -pdf   : poppler reads the JPX/CMYK fine and rewrites clean
#                          PDF operators (output is larger -- that's expected,
#                          the streams come out decompressed).
#   2. ghostscript       : re-encodes those clean streams as JPEG.
# Text stays selectable; only the images are re-encoded.
#
# Originals are kept in _originals/pdfs/ and are also tracked in git.
# Re-running restores from the backup first, so this is idempotent.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"

LIMIT=$((25 * 1024 * 1024))
JPEGQ="${JPEGQ:-80}"

for req in pdftocairo gs pdfinfo; do
  command -v "$req" >/dev/null || { echo "missing: $req (brew install poppler ghostscript)"; exit 1; }
done

shrink() {
  local rel="$1" backup="_originals/pdfs/$(basename "$1")"
  [ -f "$backup" ] || { echo "  no backup for $rel - skipping"; return 1; }
  cp -p "$backup" "$rel"

  local before; before=$(stat -f%z "$rel")
  local clean="${rel}.clean.pdf" out="${rel}.out.pdf"

  pdftocairo -pdf "$rel" "$clean" 2>/dev/null
  [ -s "$clean" ] || { echo "  stage 1 failed: $rel"; rm -f "$clean"; return 1; }

  gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.6 \
     -dDownsampleColorImages=true -dColorImageResolution=144 \
     -dDownsampleGrayImages=true  -dGrayImageResolution=144 \
     -dDownsampleMonoImages=true  -dMonoImageResolution=300 \
     -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode \
     -dAutoFilterGrayImages=false  -dGrayImageFilter=/DCTEncode \
     -dJPEGQ="$JPEGQ" -dDetectDuplicateImages=true \
     -dNOPAUSE -dBATCH -dQUIET -sOutputFile="$out" "$clean" 2>/dev/null
  rm -f "$clean"

  # Validate before replacing: page count must match and it must parse cleanly.
  local want got errs
  want=$(pdfinfo "$backup" 2>/dev/null | awk '/^Pages/{print $2}')
  got=$(pdfinfo "$out"    2>/dev/null | awk '/^Pages/{print $2}')
  errs=$(pdfinfo "$out" 2>&1 | grep -ci 'Syntax Error\|Internal Error')
  local after; after=$(stat -f%z "$out" 2>/dev/null || echo 0)

  if [ -s "$out" ] && [ "$want" = "$got" ] && [ "$errs" -eq 0 ] && [ "$after" -lt "$LIMIT" ]; then
    mv "$out" "$rel"
    printf "  %-34s %6.1f -> %5.1f MiB  (%s pages, text intact)\n" \
      "$(basename "$rel")" "$(echo "$before/1048576"|bc -l)" "$(echo "$after/1048576"|bc -l)" "$got"
  else
    rm -f "$out"; cp -p "$backup" "$rel"
    echo "  REJECTED $(basename "$rel"): pages $got/$want, errors $errs, $((after/1048576)) MiB - original kept"
    return 1
  fi
}

shrink "wp-content/uploads/2025/10/Folder_VENOL_EN.pdf"
shrink "wp-content/uploads/2025/10/Folder_NEXIUM_EN_2025.pdf"
