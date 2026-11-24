#!/usr/bin/env node
/**
 * Remove WordPress plumbing and HTTrack scrape artifacts that serve no
 * purpose in a static mirror.
 *
 *   node tools/cleanup.js --dry-run
 *   node tools/cleanup.js
 *
 * Everything removed is recoverable from the baseline commit 3ba0739.
 *
 * Orphaned theme CSS/JS is recomputed here rather than read from a list: a
 * file is only deleted if NOTHING still references it, so if the HTML is ever
 * restored to its unbundled state this script stops removing them.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const SKIP = new Set(['.git', 'node_modules', '_originals', 'tools', 'worker', 'assets']);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p);
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

const htmlFiles = () => walk(ROOT).filter((f) => /\.html?$/i.test(f));

/* ---------- 1. strip the <link> tags that point at WP plumbing ---------- */
// Each entry: [human name, test(tag) -> boolean]
const TAG_RULES = [
  ['rel=shortlink',      (t) => /rel=["']shortlink["']/i.test(t)],
  ['rel=pingback',       (t) => /rel=["']pingback["']/i.test(t)],
  ['rel=EditURI',        (t) => /rel=["']EditURI["']/i.test(t)],
  ['rel=api.w.org',      (t) => /rel=["']https:\/\/api\.w\.org\/["']/i.test(t)],
  ['oembed json',        (t) => /type=["']application\/json\+oembed["']/i.test(t)],
  ['oembed xml',         (t) => /type=["']text\/xml\+oembed["']/i.test(t)],
  ['wp-json alternate',  (t) => /type=["']application\/json["']/i.test(t) && /wp-json/i.test(t)],
];

let tagsStripped = 0, htmlTouched = 0;
const tagCounts = {};
for (const f of htmlFiles()) {
  const before = fs.readFileSync(f, 'utf8');
  // Never rewrite the RSS/XML feed documents saved with a .html name.
  if (/^\s*<\?xml/.test(before) || /<rss\b/i.test(before)) continue;

  let after = before.replace(/[ \t]*<link\b[^>]*>[ \t]*\r?\n?/gi, (tag) => {
    for (const [name, test] of TAG_RULES) {
      if (test(tag)) {
        tagsStripped++;
        tagCounts[name] = (tagCounts[name] || 0) + 1;
        return '';
      }
    }
    return tag;
  });
  if (after !== before) { htmlTouched++; if (!DRY) fs.writeFileSync(f, after); }
}

/* ---------- 2. collect files to delete ---------- */
const del = { 'WordPress plumbing': [], 'HTTrack artifacts': [], 'Orphaned theme CSS/JS': [], 'Dead VENOL branding': [] };

// -- WordPress plumbing
for (const d of ['wp-json', 'wp-admin']) {
  const p = path.join(ROOT, d);
  if (fs.existsSync(p)) walk(p).forEach((f) => del['WordPress plumbing'].push(f));
}
fs.readdirSync(ROOT).filter((f) => /^xmlrpc.*\.php$/i.test(f))
  .forEach((f) => del['WordPress plumbing'].push(path.join(ROOT, f)));

// -- HTTrack artifacts
fs.readdirSync(ROOT).filter((f) => /^index[0-9a-f]{4}\.html$/i.test(f))
  .forEach((f) => del['HTTrack artifacts'].push(path.join(ROOT, f)));
for (const f of ['en/home-3/hqdefault.html', 'en/home-3/mqdefault.html',
                 'en/home-3/sddefault.html', 'uber-uns/index - Copy.html']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) del['HTTrack artifacts'].push(p);
}

// -- Dead VENOL branding
for (const f of ['media/2024/07/cropped-favicon-180x180.gif',
                 'media/2024/07/cropped-favicon-192x192.gif',
                 'media/2024/07/cropped-favicon-270x270.gif',
                 'media/2024/07/cropped-favicon-32x32.gif',
                 'media/2024/07/favicon-300x300.gif',
                 'media/2024/08/venol-motor-oil-logo-GT-Flag-white12.png']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) del['Dead VENOL branding'].push(p);
}

/* -- Orphaned theme CSS/JS: recomputed, only if nothing references them -- */
{
  const pending = new Set([...del['WordPress plumbing'], ...del['HTTrack artifacts'],
                           ...del['Dead VENOL branding']].map((p) => path.resolve(p)));
  const texts = walk(ROOT).filter((f) => /\.(html?|css|js|mjs|json|xml)$/i.test(f) && !pending.has(path.resolve(f)));
  // include the bundles as reference sources
  const bundleDir = path.join(ROOT, 'assets', 'bundle');
  if (fs.existsSync(bundleDir)) walk.call(null, bundleDir, []).forEach;
  const referenced = new Set();
  const scan = (f) => {
    let s; try { s = fs.readFileSync(f, 'utf8'); } catch { return; }
    const dir = path.dirname(f);
    const cands = new Set();
    for (const m of s.matchAll(/["'(]\s*([^"'()\s>]+\.(?:css|js|mjs))(?:[?#][^"'()\s>]*)?\s*["')]/g)) cands.add(m[1]);
    for (const c of cands) {
      let r = c.trim();
      if (/^(https?:|data:)/i.test(r)) continue;
      try { r = decodeURIComponent(r); } catch {}
      referenced.add(path.resolve(r.startsWith('/') ? path.join(ROOT, r) : path.resolve(dir, r)));
    }
  };
  texts.forEach(scan);
  if (fs.existsSync(bundleDir)) fs.readdirSync(bundleDir).forEach((f) => scan(path.join(bundleDir, f)));

  // Only THEME/vendor asset trees are eligible. Without this guard a
  // root-level, intentionally-unreferenced file such as serve.js looks
  // "orphaned" and gets swept up.
  const ELIGIBLE = /^(media|theme|vendor)[\\/]/;
  for (const f of walk(ROOT)) {
    if (!/\.(css|js)$/i.test(f)) continue;
    if (pending.has(path.resolve(f))) continue;
    if (!ELIGIBLE.test(rel(f))) continue;
    if (!referenced.has(path.resolve(f))) del['Orphaned theme CSS/JS'].push(f);
  }
}

/* ---------- 3. report + execute ---------- */
console.log(`HTML <link> tags stripped: ${tagsStripped} across ${htmlTouched} files`);
for (const [k, v] of Object.entries(tagCounts)) console.log(`    ${String(v).padStart(4)}x  ${k}`);
console.log();
let grand = 0, grandN = 0;
for (const [group, files] of Object.entries(del)) {
  const bytes = files.reduce((t, f) => t + sizeOf(f), 0);
  grand += bytes; grandN += files.length;
  console.log(`${group}: ${files.length} files, ${(bytes / 1048576).toFixed(2)} MB`);
  files.slice(0, 3).forEach((f) => console.log(`    ${rel(f)}`));
  if (files.length > 3) console.log(`    ... +${files.length - 3} more`);
}
console.log(`\nTOTAL: ${grandN} files, ${(grand / 1048576).toFixed(2)} MB`);

if (DRY) { console.log('\n[dry-run] nothing deleted, no HTML written'); process.exit(0); }

for (const files of Object.values(del)) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch (e) { console.log(`  could not remove ${rel(f)}: ${e.code}`); }
    const w = f + '.webp';
    if (fs.existsSync(w)) { try { fs.unlinkSync(w); } catch {} }
  }
}
// drop directories left empty
for (let pass = 0; pass < 6; pass++) {
  for (const d of walk(ROOT).map((f) => path.dirname(f))) { /* noop, walk only lists files */ }
  const prune = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) prune(p);
    }
    try {
      if (dir !== ROOT && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {}
  };
  for (const e of fs.readdirSync(ROOT)) {
    if (SKIP.has(e)) continue;
    const p = path.join(ROOT, e);
    try { if (fs.statSync(p).isDirectory()) prune(p); } catch {}
  }
}
console.log('\ndone');
