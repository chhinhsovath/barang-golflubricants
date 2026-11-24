#!/usr/bin/env node
/**
 * Add loading="lazy" decoding="async" to <img> tags that lack it.
 *   node tools/lazy-images.js [--dry-run]
 *
 * Deliberately skipped, because lazy-loading them hurts:
 *  - the first EAGER_FIRST images in the document (likely above the fold / LCP)
 *  - slider & lightbox images, whose scripts read/swap src and can race with
 *    the lazy loader (LayerSlider, avia slideshow, magnific popup)
 *  - anything already carrying a loading= attribute
 * Idempotent.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const EAGER_FIRST = 2;
const SKIP = /\b(ls-l|ls-bg|layerslider|avia-slideshow|av-slideshow|avia_image_slider|ls-preload)\b/i;

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['.git', 'assets', 'tools', 'node_modules'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.html?$/i.test(e.name)) out.push(p);
  }
  return out;
}

let files = 0, added = 0, skippedSlider = 0, skippedEager = 0, already = 0;

for (const file of walk(ROOT)) {
  const html = fs.readFileSync(file, 'utf8');
  let seen = 0;
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    seen++;
    if (/\bloading\s*=/i.test(tag)) { already++; return tag; }
    if (SKIP.test(tag)) { skippedSlider++; return tag; }
    if (seen <= EAGER_FIRST) { skippedEager++; return tag; }
    added++;
    const extra = ' loading="lazy"' + (/\bdecoding\s*=/i.test(tag) ? '' : ' decoding="async"');
    // insert before the tag's closing bracket, preserving any self-closing slash
    return tag.replace(/\s*(\/?)>$/, extra + ' $1>');
  });
  if (out !== html) { files++; if (!DRY) fs.writeFileSync(file, out); }
}

console.log(`files ${DRY ? 'that would change' : 'changed'} : ${files}`);
console.log(`  loading="lazy" added        : ${added}`);
console.log(`  already had loading=        : ${already}`);
console.log(`  skipped (slider/lightbox)   : ${skippedSlider}`);
console.log(`  skipped (first ${EAGER_FIRST}, above fold): ${skippedEager}`);
if (DRY) console.log('\n[dry-run] nothing written');
