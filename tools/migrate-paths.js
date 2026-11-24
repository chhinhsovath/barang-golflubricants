#!/usr/bin/env node
/**
 * One-time migration: drop the WordPress directory names.
 *
 *   node tools/migrate-paths.js --dry-run
 *   node tools/migrate-paths.js
 *
 *   media/        -> media/
 *   theme/  -> theme/
 *   vendor/mediaelement/ -> vendor/mediaelement/
 *
 * No WordPress code is involved -- there are no .php files left. These are
 * just folders holding the site's media and fonts.
 *
 * References are relative and climb to the root ("../../wp-content/..."), so
 * the leading ../ sequence is unchanged and only the suffix is rewritten.
 *
 * The CSS/JS bundles embed these paths, so their content changes; their file
 * names are content hashes, so they are re-hashed and the HTML updated to
 * match, keeping the cache-busting contract honest.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
process.chdir(ROOT);

// longest/most specific first
const MAP = [
  ['theme/',    'theme/'],
  ['media/',          'media/'],
  ['vendor/mediaelement/', 'vendor/mediaelement/'],
];

const SKIP = new Set(['.git', 'node_modules', '_originals']);
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/* ---------- 1. move the directories ---------- */
const moves = [];
for (const [from, to] of MAP) {
  const src = path.join(ROOT, from.replace(/\/$/, ''));
  const dst = path.join(ROOT, to.replace(/\/$/, ''));
  if (fs.existsSync(src)) moves.push([src, dst, from, to]);
}
console.log('Directory moves:');
for (const [src, dst, from, to] of moves) {
  const n = walk(src).length;
  console.log(`  ${from.padEnd(30)} -> ${to.padEnd(22)} (${n} files)`);
}

if (!DRY) {
  for (const [src, dst] of moves) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      execFileSync('git', ['mv', path.relative(ROOT, src), path.relative(ROOT, dst)], { stdio: 'pipe' });
    } catch {
      fs.renameSync(src, dst);   // untracked files (e.g. .webp) move plainly
    }
  }
  // sweep anything git mv left behind, then drop the empty shells
  for (const [src, dst] of moves) {
    if (fs.existsSync(src)) {
      for (const f of walk(src)) {
        const rest = path.relative(src, f);
        const target = path.join(dst, rest);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(f, target);
      }
    }
  }
  const prune = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      if (fs.statSync(p).isDirectory()) prune(p);
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
  };
  prune(path.join(ROOT, 'wp-content'));
  prune(path.join(ROOT, 'wp-includes'));
}

/* ---------- 2. rewrite references ---------- */
const TEXT = /\.(html?|css|js|mjs|json|xml|md|jsonc|sh)$/i;
let filesTouched = 0, refsRewritten = 0;
const targets = DRY
  ? walk(ROOT).filter((f) => TEXT.test(f))
  : walk(ROOT).filter((f) => TEXT.test(f));

for (const f of targets) {
  let s;
  try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const before = s;
  for (const [from, to] of MAP) {
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    s = s.replace(re, () => { refsRewritten++; return to; });
  }
  // any leftover bare wp-content/ or wp-includes/ (e.g. a directory listing)
  if (s !== before) { filesTouched++; if (!DRY) fs.writeFileSync(f, s); }
}
console.log(`\nReferences rewritten: ${refsRewritten} across ${filesTouched} files`);

if (DRY) { console.log('\n[dry-run] nothing moved or written'); process.exit(0); }

/* ---------- 3. re-hash the bundles (their content changed) ---------- */
const bundleDir = path.join(ROOT, 'assets', 'bundle');
const renames = new Map();
if (fs.existsSync(bundleDir)) {
  for (const name of fs.readdirSync(bundleDir)) {
    const m = /^(site|screen|js)-?\.?([0-9a-f]{10})\.(css|js)$/.exec(name)
           || /^(site|screen)\.([0-9a-f]{10})\.(css)$/.exec(name)
           || /^(js)-([0-9a-f]{10})\.(js)$/.exec(name);
    if (!m) continue;
    const full = path.join(bundleDir, name);
    const body = fs.readFileSync(full);
    const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 10);
    if (hash === m[2]) continue;
    const next = m[1] === 'js' ? `js-${hash}.js` : `${m[1]}.${hash}.${m[3]}`;
    fs.renameSync(full, path.join(bundleDir, next));
    renames.set(name, next);
  }
}
if (renames.size) {
  let n = 0;
  for (const f of walk(ROOT).filter((x) => /\.html?$/i.test(x))) {
    let s = fs.readFileSync(f, 'utf8');
    const before = s;
    for (const [oldN, newN] of renames) s = s.split(oldN).join(newN);
    if (s !== before) { fs.writeFileSync(f, s); n++; }
  }
  console.log(`\nBundles re-hashed (content changed): ${renames.size}, HTML updated in ${n} files`);
  for (const [a, b] of renames) console.log(`  ${a} -> ${b}`);
}
console.log('\ndone');
