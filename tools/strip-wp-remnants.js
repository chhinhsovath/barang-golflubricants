#!/usr/bin/env node
/**
 * Remove the last WordPress runtime remnants embedded in the HTML.
 *
 *   node tools/strip-wp-remnants.js [--dry-run]
 *
 * Removed:
 *  - the emoji polyfill: <script id="wp-emoji-settings">, the auto-generated
 *    <script type="module"> that reads it, and <style id="wp-emoji-styles...">.
 *    It is dead weight on a static mirror AND it fetches emoji images from
 *    s.w.org (wordpress.org's CDN), so dropping it also removes a phone-home.
 *  - dead exclusion patterns in the <script type="speculationrules"> block
 *    (/wp-*.php, /wp-admin/*, /wp-content/*, ...). Those paths no longer
 *    exist; the block itself is a genuine prefetch optimisation and is kept.
 *
 * DELIBERATELY KEPT (functional CSS that merely carries a wp- id):
 *    wp-custom-css          - the site's OWN custom styling
 *    wp-block-library-...   - block editor styles still referenced by content
 *    wp-img-auto-sizes-...  - lazy-image sizing rules
 * Renaming those ids would risk breaking selectors for no real benefit.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const SKIP = new Set(['.git', 'node_modules', '_originals', 'tools', 'worker']);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.html?$/i.test(e.name)) out.push(p);
  }
  return out;
}

const DEAD_PREFIXES = ['/wp-*.php', '/wp-admin/*', '/wp-content/*',
                       '/wp-content/plugins/*', '/wp-content/themes/enfold-child/*'];

let emojiSettings = 0, emojiModule = 0, emojiStyle = 0, specCleaned = 0, filesTouched = 0;

for (const f of walk(ROOT)) {
  let h;
  try { h = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (/^\s*<\?xml/.test(h) || /<rss\b/i.test(h)) continue;   // feed documents
  const before = h;

  // 1. emoji settings JSON
  h = h.replace(/[ \t]*<script\b[^>]*id=["']wp-emoji-settings["'][^>]*>[\s\S]*?<\/script>[ \t]*\r?\n?/gi,
                () => { emojiSettings++; return ''; });

  // 2. the auto-generated module that consumes it (matched by content, so we
  //    never touch an unrelated <script type="module">)
  h = h.replace(/[ \t]*<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>[ \t]*\r?\n?/gi,
                (m, body) => {
                  if (/wp-emoji-settings|wpemoji|wp-emoji-release/i.test(body)) { emojiModule++; return ''; }
                  return m;
                });

  // 3. emoji inline styles
  h = h.replace(/[ \t]*<style\b[^>]*id=["']wp-emoji-styles-inline-css["'][^>]*>[\s\S]*?<\/style>[ \t]*\r?\n?/gi,
                () => { emojiStyle++; return ''; });

  // 4. dead exclusions inside speculationrules
  h = h.replace(/<script\b[^>]*type=["']speculationrules["'][^>]*>([\s\S]*?)<\/script>/gi, (m, body) => {
    let b = body;
    for (const p of DEAD_PREFIXES) {
      const lit = JSON.stringify(p);
      // drop the entry plus a neighbouring comma, whichever side it sits on
      const re = new RegExp(',\\s*' + lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|' +
                            lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*,', 'g');
      if (re.test(b)) { b = b.replace(re, ''); specCleaned++; }
    }
    return m.replace(body, b);
  });

  if (h !== before) { filesTouched++; if (!DRY) fs.writeFileSync(f, h); }
}

/* 5. the one file still named wp-* */
const OLD = path.join(ROOT, 'vendor/mediaelement/wp-mediaelement.min8478.js');
const NEW = path.join(ROOT, 'vendor/mediaelement/mediaelement-player.min8478.js');
let renamed = false;
if (fs.existsSync(OLD)) {
  if (!DRY) fs.renameSync(OLD, NEW);
  renamed = true;
  let n = 0;
  for (const f of walk(ROOT)) {
    let h; try { h = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!h.includes('wp-mediaelement.min8478.js')) continue;
    if (!DRY) fs.writeFileSync(f, h.split('wp-mediaelement.min8478.js').join('mediaelement-player.min8478.js'));
    n++;
  }
  console.log(`renamed wp-mediaelement.min8478.js -> mediaelement-player.min8478.js (${n} refs)`);
}

console.log(`emoji settings blocks removed : ${emojiSettings}`);
console.log(`emoji module scripts removed  : ${emojiModule}`);
console.log(`emoji inline styles removed   : ${emojiStyle}`);
console.log(`speculationrules entries fixed: ${specCleaned}`);
console.log(`HTML files touched            : ${filesTouched}`);
if (DRY) console.log('\n[dry-run] nothing written');
