#!/usr/bin/env bash
# Replace the site logo and every favicon from a single source image.
#
#   ./tools/set-logo.sh path/to/new-logo.png
#
# Does all of this:
#   1. keeps your source in _originals/branding/
#   2. header logo  -> media/2024/08/golf-lubricants-logo.png  (height 160 = 2x
#      the 80px header slot; width scales with your image's aspect ratio)
#   3. favicons     -> media/2024/07/golf-favicon-{32,180,192,270,300}.png
#      (centre-cropped square, which stays legible at 16px tab size --
#       padding to square makes the wordmark too small to read)
#   4. updates the width/height attributes on the <img> in every page so the
#      intrinsic aspect ratio is right and the header doesn't shift on load
#   5. regenerates the .webp siblings the Worker serves
#
# Afterwards:  npx wrangler deploy
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"

SRC="${1:-}"
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "usage: ./tools/set-logo.sh <image>   (png, jpg, svg-rasterised, etc.)"
  exit 1
fi

LOGO="media/2024/08/golf-lubricants-logo.png"
FAVDIR="media/2024/07"
LOGO_H=160

W=$(sips -g pixelWidth  "$SRC" 2>/dev/null | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$SRC" 2>/dev/null | awk '/pixelHeight/{print $2}')
if [ -z "${W:-}" ] || [ -z "${H:-}" ]; then
  echo "could not read image dimensions from $SRC"; exit 1
fi
echo "source: $SRC  (${W}x${H})"

# 1. keep the original (skip if we already hold an identical copy, so repeated
#    runs don't litter _originals/branding with duplicates)
mkdir -p _originals/branding
KEEP="_originals/branding/logo-source-${W}x${H}.${SRC##*.}"
if [ "$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")" != "$(pwd)/$KEEP" ]; then
  if ! find _originals/branding -type f -exec cmp -s "$SRC" {} \; -quit 2>/dev/null; then
    cp -p "$SRC" "$KEEP"
    echo "  source kept : $KEEP"
  else
    echo "  source already in _originals/branding"
  fi
fi

# 2. header logo: fix the height, let the width follow the aspect ratio
sips -s format png --resampleHeight "$LOGO_H" "$SRC" --out "$LOGO" >/dev/null 2>&1
NEW_W=$(sips -g pixelWidth  "$LOGO" | awk '/pixelWidth/{print $2}')
NEW_H=$(sips -g pixelHeight "$LOGO" | awk '/pixelHeight/{print $2}')
printf "  header logo : %s  (%sx%s)\n" "$LOGO" "$NEW_W" "$NEW_H"

# 3. favicons: centre-crop to a square, then scale
SQ=$(( W < H ? W : H ))
TMP="$(mktemp -t logosq).png"
sips -s format png -c "$SQ" "$SQ" "$SRC" --out "$TMP" >/dev/null 2>&1
for S in 32 180 192 270 300; do
  sips -Z "$S" "$TMP" --out "$FAVDIR/golf-favicon-${S}x${S}.png" >/dev/null 2>&1
  printf "  favicon %-4s: %s B\n" "${S}x${S}" "$(stat -f%z "$FAVDIR/golf-favicon-${S}x${S}.png")"
done
rm -f "$TMP"

# 4. keep the HTML's intrinsic size in step with the new aspect ratio
node -e '
const fs=require("fs"),path=require("path");
const [w,h]=process.argv.slice(1);
function walk(d,out=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  if([".git","_originals","node_modules","tools","worker"].includes(e.name))continue;
  const p=path.join(d,e.name);
  if(e.isDirectory())walk(p,out);else if(/\.html?$/i.test(e.name))out.push(p)}return out}
let n=0;
for(const f of walk(".")){
  let s;try{s=fs.readFileSync(f,"utf8")}catch{continue}
  if(!s.includes("golf-lubricants-logo"))continue;
  const b=s;
  s=s.replace(/<img[^>]*golf-lubricants-logo[^>]*>/gi,t=>
    t.replace(/\bwidth="\d+"/,`width="${w}"`).replace(/\bheight="\d+"/,`height="${h}"`));
  if(s!==b){fs.writeFileSync(f,s);n++}
}
console.log(`  updated width/height on ${n} pages -> ${w}x${h}`);
' "$NEW_W" "$NEW_H"

# 5. webp siblings (stale ones are replaced because they are older than the source)
rm -f "$LOGO.webp" "$FAVDIR"/golf-favicon-*.webp
./tools/make-webp.sh >/dev/null 2>&1
echo "  webp regenerated"

echo
echo "Preview locally:  node serve.js   ->  http://localhost:8080"
echo "Publish:          CLOUDFLARE_ACCOUNT_ID=0917cab6a3763a18518040978bf8835f npx wrangler deploy"
