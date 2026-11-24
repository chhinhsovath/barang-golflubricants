#!/usr/bin/env bash
# Re-encode the oversized promo videos to fit Cloudflare's 25 MiB asset limit.
#
#   ./tools/shrink-video.sh
#
# Two-pass H.264 at a bitrate computed per clip from its own duration, so each
# lands just under the cap instead of using one guessed bitrate for all three.
# Originals are kept in _originals/videos/ (they are gitignored, so that copy
# is the only backup). Re-running restores from there first, so the script is
# idempotent and never re-compresses an already-compressed file.
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET_MIB="${TARGET_MIB:-23}"       # leave headroom under the 25 MiB limit
AUDIO_KBPS="${AUDIO_KBPS:-96}"

shrink() {
  local rel="$1" backup="$2"
  [ -f "$backup" ] || { echo "  no backup for $rel - skipping"; return 1; }

  # always start from the pristine original
  cp -p "$backup" "$rel"

  local dur size_before
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$rel")
  size_before=$(stat -f%z "$rel")

  # total_bits = TARGET_MiB * 8; video gets what's left after audio
  local vkbps
  vkbps=$(python3 -c "
d=float('$dur'); total=$TARGET_MIB*1024*1024*8/d/1000
print(max(200, int(total - $AUDIO_KBPS)))")

  local log="/tmp/ffpass-$$"
  ffmpeg -v error -y -i "$rel" -c:v libx264 -b:v "${vkbps}k" -pass 1 -passlogfile "$log" \
         -preset slow -an -f null /dev/null 2>/dev/null
  ffmpeg -v error -y -i "$rel" -c:v libx264 -b:v "${vkbps}k" -pass 2 -passlogfile "$log" \
         -preset slow -c:a aac -b:a "${AUDIO_KBPS}k" -movflags +faststart \
         "${rel}.tmp.mp4" 2>/dev/null
  rm -f "$log"-*.log "$log"-*.log.mbtree

  if [ -s "${rel}.tmp.mp4" ]; then
    mv "${rel}.tmp.mp4" "$rel"
    local after; after=$(stat -f%z "$rel")
    printf "  %-44s %6.1f -> %5.1f MiB  @%skbps\n" \
      "$(basename "$rel")" "$(echo "$size_before/1048576"|bc -l)" \
      "$(echo "$after/1048576"|bc -l)" "$vkbps"
  else
    rm -f "${rel}.tmp.mp4"
    echo "  FAILED: $rel (original restored)"
  fi
}

shrink "media/2026/10/Venol Motor Oil Production 720.mp4" \
       "_originals/videos/2026_10_Venol Motor Oil Production 720.mp4"
shrink "media/2024/09/Venol Motor Oil Production 720.mp4" \
       "_originals/videos/2024_09_Venol Motor Oil Production 720.mp4"
shrink "media/2024/09/Nexium Motor Oil Production 720.mp4" \
       "_originals/videos/2024_09_Nexium Motor Oil Production 720.mp4"
