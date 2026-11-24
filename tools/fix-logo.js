#!/usr/bin/env node
/**
 * Make the GOLF Lubricants logo the single, consistent header logo.
 *   node tools/fix-logo.js [--dry-run]
 *
 * The captured mirror was mid-rebrand:
 *   - the header's inline <svg> is the OLD VENOL mark, on all 143 pages
 *   - a GOLF <img class="alternate"> exists on only the 5 language homepages,
 *     and Enfold shows it solely while the header is transparent
 *     (.logo img.alternate {opacity:0} / .av_header_transparency ... {opacity:1})
 *   so most pages showed VENOL, and the homepages flipped VENOL<->GOLF on scroll.
 *
 * This replaces the inline SVG with the GOLF logo and drops the now-redundant
 * alternate, so one mark shows in every header state. Also repoints the
 * favicons and rewrites the logo's alt/title/aria-label.
 *
 * Idempotent: a page already carrying the GOLF logo is left alone.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const LOGO = 'wp-content/uploads/2024/08/golf-lubricants-logo.png';
const FAV_LG = 'wp-content/uploads/2024/07/golf-favicon-300x300.png';
const FAV_SM = 'wp-content/uploads/2024/07/golf-favicon-32x32.png';
const NAME = 'GOLF Lubricants';

// old VENOL icon file -> its GOLF replacement
const FAVICONS = [
  ['favicon-300x300.gif',         'golf-favicon-300x300.png'],
  ['cropped-favicon-32x32.gif',   'golf-favicon-32x32.png'],
  ['cropped-favicon-180x180.gif', 'golf-favicon-180x180.png'],
  ['cropped-favicon-192x192.gif', 'golf-favicon-192x192.png'],
  ['cropped-favicon-270x270.gif', 'golf-favicon-270x270.png'],
];
const FAV_DIR = 'wp-content/uploads/2024/07/';

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['.git', 'assets', 'tools', 'node_modules'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.html?$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** path from this page back to the project root, e.g. "../../" */
const upTo = (file) => {
  const rel = path.relative(path.dirname(file), ROOT).split(path.sep).join('/');
  return rel ? rel + '/' : '';
};

let scanned = 0, logoFixed = 0, altDropped = 0, favFixed = 0, already = 0, noLogo = 0, altClassDropped = 0;

for (const file of walk(ROOT)) {
  let html = fs.readFileSync(file, 'utf8');
  const before = html;
  scanned++;
  const up = upTo(file);

  const start = html.indexOf('av-logo-container');
  if (start === -1) {
    noLogo++;
  } else {
    const spanAt = html.indexOf("<span class='logo", start);
    const endAt = html.indexOf('</a></span>', spanAt);
    if (spanAt !== -1 && endAt !== -1) {
      const block = html.slice(spanAt, endAt + '</a></span>'.length);

      if (block.includes('golf-lubricants-logo.png')) {
        already++;
      } else {
        const href = (block.match(/<a[^>]*\bhref=['"]([^'"]+)['"]/) || [])[1] || (up + 'index.html');
        const img = `<img src="${up}${LOGO}" class="avia-standard-logo" `
                  + `alt="${NAME}" title="${NAME}" width="280" height="160" />`;
        const rebuilt =
          `<span class='logo avia-standard-logo'>`
          + `<a href='${href}' aria-label='${NAME}' title='${NAME}'>`
          + img
          + `</a></span>`;
        html = html.slice(0, spanAt) + rebuilt + html.slice(endAt + '</a></span>'.length);
        logoFixed++;
        if (/class=['"]alternate/.test(block)) altDropped++;
      }
    }
  }

  // Enfold marks headers that have a second ("alternate") logo with
  // av_alternate_logo_active, and the stylesheet then hides the PRIMARY logo
  // while the header is transparent, expecting the alternate to show instead:
  //   #top .av_header_transparency.av_alternate_logo_active .logo a>img {opacity:0}
  // There is no alternate logo any more, so that class would blank the header
  // logo at the top of every page. Drop it.
  if (html.includes('av_alternate_logo_active')) {
    html = html.replace(/\s*\bav_alternate_logo_active\b/g, '');
    altClassDropped++;
  }

  // Favicons. Only RELATIVE references inside real HTML documents are touched:
  // the mirror also contains RSS/XML feed documents saved with a .html name,
  // whose <url> metadata holds absolute https://venol.de/... links. Rewriting
  // a path inside an absolute URL would yield https://venol.de/../../wp-content.
  const isXml = /^\s*<\?xml/.test(html) || /<rss\b/i.test(html);
  if (!isXml) {
    let touched = false;
    for (const [oldFile, newFile] of FAVICONS) {
      // (^|["'\s(]) prevents matching when preceded by a host, and we
      // additionally require the ref not to be part of an absolute URL.
      const re = new RegExp('(["\'])((?:\\.\\./)*)' + FAV_DIR.replace(/\//g, '\\/')
                            + oldFile.replace(/\./g, '\\.') + '(["\'])', 'g');
      html = html.replace(re, (m, q1, ups, q2) => {
        touched = true;
        return q1 + up + FAV_DIR + newFile + q2;
      });
    }
    // A few captured 404 pages reference the icons by absolute venol.de URL.
    // Those are ordinary HTML documents (not feed metadata), so point them at
    // the local GOLF asset instead of the live site.
    for (const [oldFile, newFile] of FAVICONS) {
      const abs = new RegExp('https?:\\/\\/venol\\.de\\/' + FAV_DIR.replace(/\//g, '\\/')
                             + oldFile.replace(/\./g, '\\.'), 'g');
      html = html.replace(abs, () => { touched = true; return up + FAV_DIR + newFile; });
    }

    // Normalise the depth of every GOLF favicon reference. Recomputed from
    // scratch rather than patched, so a wrong prefix (e.g. a doubled ../../ on
    // a depth-1 page) is corrected rather than preserved.
    html = html.replace(
      /(["'])((?:\.\.\/)*)wp-content\/uploads\/2024\/07\/(golf-favicon-\d+x\d+\.png)(["'])/g,
      (m, q1, ups, fileName, q2) => {
        const want = q1 + up + FAV_DIR + fileName + q2;
        if (m !== want) touched = true;
        return want;
      });

    if (touched) {
      html = html.replace(/(<link[^>]*golf-favicon[^>]*?)type=["']image\/gif["']/gi, '$1type="image/png"');
      favFixed++;
    }
  }

  if (html !== before && !DRY) fs.writeFileSync(file, html);
}

console.log(`scanned HTML files          : ${scanned}`);
console.log(`  logo replaced with GOLF   : ${logoFixed}`);
console.log(`    (redundant alternate rm): ${altDropped}`);
console.log(`  already GOLF (idempotent) : ${already}`);
console.log(`  no logo container         : ${noLogo}  (redirect stubs / feeds)`);
console.log(`  favicon links repointed   : ${favFixed}`);
console.log(`  av_alternate_logo_active  : ${altClassDropped} removed`);
if (DRY) console.log('\n[dry-run] nothing written');
