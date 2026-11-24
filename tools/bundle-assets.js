#!/usr/bin/env node
/**
 * Bundle the mirror's CSS/JS to cut per-page requests.
 *
 *   node tools/bundle-assets.js --dry-run     # report only
 *   node tools/bundle-assets.js               # apply
 *   node tools/bundle-assets.js --revert      # restore from git
 *
 * Strategy
 *  CSS: one global union bundle per media type. Verified (order-check) that no
 *       two pages order the same pair of stylesheets differently, so a single
 *       topological order preserves every page's cascade. Shared bundle => the
 *       browser caches it once for the whole site.
 *  JS : contiguous runs of local <script src> are merged per run. Inline
 *       scripts (WP's l10n/config data) stay exactly where they are, so global
 *       execution order is unchanged. Runs are deduped by content hash.
 *  Also: drops the dead <!--[if lt IE 9]> html5shiv shim, and adds
 *       display=swap + preconnect to the Google Fonts request.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT_REL = 'assets/bundle';
const OUT_DIR = path.join(ROOT, OUT_REL);
const DRY = process.argv.includes('--dry-run');

const LINK_RE = /[ \t]*<link\b[^>]*\bstylesheet\b[^>]*>[ \t]*\n?/gi;
const SCRIPT_SRC_RE = /[ \t]*<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>[ \t]*\n?/gi;
const SHIV_RE = /[ \t]*<!--\[if lt IE 9\]>\s*<script[^>]*html5shiv[^>]*>\s*<\/script>\s*<!\[endif\]-->[ \t]*\n?/gi;

const attr = (tag, name) => {
  const m = tag.match(new RegExp(name + '=["\']([^"\']+)["\']', 'i'));
  return m ? m[1] : null;
};
const isLocal = (u) => u && !/^(https?:)?\/\//i.test(u) && !/^(data|mailto|tel|javascript):/i.test(u);
const stripQ = (u) => u.split('?')[0].split('#')[0];

function htmlFiles() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'assets' || e.name === 'tools') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.html?$/i.test(e.name)) out.push(p);
    }
  })(ROOT);
  return out.sort();
}

/* ---------- pass 1: collect ---------- */
const pages = [];
for (const file of htmlFiles()) {
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const dir = path.dirname(file);
  const css = [];
  for (const m of html.matchAll(LINK_RE)) {
    const href = attr(m[0], 'href');
    if (!isLocal(href)) continue;
    const abs = path.resolve(dir, stripQ(href));
    if (!fs.existsSync(abs)) continue;
    css.push({ abs, media: (attr(m[0], 'media') || 'all').trim() });
  }
  const js = [];
  for (const m of html.matchAll(SCRIPT_SRC_RE)) {
    const src = attr(m[0], 'src');
    if (!isLocal(src)) continue;
    const abs = path.resolve(dir, stripQ(src));
    if (!fs.existsSync(abs)) continue;
    js.push({ abs, index: m.index, raw: m[0] });
  }
  SHIV_RE.lastIndex = 0;
  const hasShiv = SHIV_RE.test(html);
  SHIV_RE.lastIndex = 0;
  if (css.length || js.length || hasShiv) pages.push({ file, dir, html, css, js });
}

/* ---------- pass 2: global CSS order (topological) ---------- */
function globalOrder(media) {
  const succ = new Map(), indeg = new Map(), nodes = [];
  const add = (n) => { if (!succ.has(n)) { succ.set(n, new Set()); indeg.set(n, 0); nodes.push(n); } };
  for (const p of pages) {
    const seq = p.css.filter((c) => c.media === media).map((c) => c.abs);
    seq.forEach(add);
    for (let i = 0; i + 1 < seq.length; i++) {
      if (seq[i] === seq[i + 1]) continue;
      if (!succ.get(seq[i]).has(seq[i + 1])) {
        succ.get(seq[i]).add(seq[i + 1]);
        indeg.set(seq[i + 1], indeg.get(seq[i + 1]) + 1);
      }
    }
  }
  // Kahn, stable on first-seen order
  const ready = nodes.filter((n) => indeg.get(n) === 0);
  const out = [];
  while (ready.length) {
    const n = ready.shift();
    out.push(n);
    for (const s of succ.get(n)) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) ready.push(s);
    }
  }
  if (out.length !== nodes.length) {
    throw new Error(`CSS order cycle in media=${media} (${out.length}/${nodes.length}) — cannot union-bundle`);
  }
  return out;
}

/** Rewrite relative url(...) so it resolves from the bundle's directory. */
function rewriteCss(css, fromDir, toDir) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (full, q, u) => {
    const t = u.trim();
    if (!isLocal(t) || t.startsWith('/') || t.startsWith('#')) return full;
    const abs = path.resolve(fromDir, stripQ(t));
    const suffix = t.slice(stripQ(t).length);
    let rel = path.relative(toDir, abs).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `url("${rel}${suffix}")`;
  });
}

const media = [...new Set(pages.flatMap((p) => p.css.map((c) => c.media)))];
const cssBundles = {};   // media -> {name, bytes, files}
for (const m of media) {
  const order = globalOrder(m);
  if (!order.length) continue;
  const parts = order.map((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    return `/* ${rel} */\n` + rewriteCss(raw, path.dirname(f), OUT_DIR);
  });
  const body = parts.join('\n');
  const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 10);
  const slug = m === 'all' ? 'site' : m.replace(/[^a-z0-9]+/gi, '-');
  cssBundles[m] = { name: `${slug}.${hash}.css`, body, files: order.length, bytes: Buffer.byteLength(body) };
}

/* ---------- pass 3: JS runs ---------- */
const jsBundles = new Map();     // hash -> {name, body, bytes, files}
for (const p of pages) {
  // group consecutive local scripts that are adjacent in the document
  // (only whitespace between them) so inline scripts always split a run
  p.runs = [];
  let cur = null;
  for (const s of p.js) {
    if (cur) {
      const between = p.html.slice(cur.end, s.index);
      if (/^\s*$/.test(between)) { cur.items.push(s); cur.end = s.index + s.raw.length; continue; }
    }
    if (cur) p.runs.push(cur);
    cur = { items: [s], start: s.index, end: s.index + s.raw.length };
  }
  if (cur) p.runs.push(cur);
  p.runs = p.runs.filter((r) => r.items.length > 1);

  for (const run of p.runs) {
    const key = run.items.map((i) => path.relative(ROOT, i.abs)).join('|');
    const kh = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
    if (!jsBundles.has(kh)) {
      const body = run.items.map((i) => {
        const rel = path.relative(ROOT, i.abs).split(path.sep).join('/');
        // ;\n guards against a source lacking a trailing semicolon
        return `/* ${rel} */\n` + fs.readFileSync(i.abs, 'utf8') + '\n;';
      }).join('\n');
      const ch = crypto.createHash('sha1').update(body).digest('hex').slice(0, 10);
      jsBundles.set(kh, { name: `js-${ch}.js`, body, files: run.items.length, bytes: Buffer.byteLength(body) });
    }
    run.bundle = jsBundles.get(kh);
  }
}

/* ---------- report ---------- */
const kb = (b) => (b / 1024).toFixed(0) + ' KB';
console.log('=== CSS bundles ===');
for (const [m, b] of Object.entries(cssBundles)) console.log(`  media=${m}: ${b.files} files -> ${b.name} (${kb(b.bytes)})`);
console.log(`\n=== JS bundles === (${jsBundles.size} unique runs)`);
for (const b of jsBundles.values()) console.log(`  ${b.files} files -> ${b.name} (${kb(b.bytes)})`);

let before = 0, after = 0;
for (const p of pages) {
  before += p.css.length + p.js.length;
  const bundledJs = p.runs.reduce((t, r) => t + r.items.length, 0);
  after += Object.keys(cssBundles).filter((m) => p.css.some((c) => c.media === m)).length
         + p.runs.length + (p.js.length - bundledJs);
}
console.log(`\n=== requests across ${pages.length} pages ===`);
console.log(`  before: ${before}   after: ${after}   saved: ${before - after} (-${((1 - after / before) * 100).toFixed(1)}%)`);

if (DRY) { console.log('\n[dry-run] nothing written'); process.exit(0); }

/* ---------- apply ---------- */
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const b of Object.values(cssBundles)) fs.writeFileSync(path.join(OUT_DIR, b.name), b.body);
for (const b of jsBundles.values()) fs.writeFileSync(path.join(OUT_DIR, b.name), b.body);

let edited = 0;
for (const p of pages) {
  let html = p.html;
  const relTo = (name) => {
    let r = path.relative(p.dir, path.join(OUT_DIR, name)).split(path.sep).join('/');
    return r.startsWith('.') ? r : './' + r;
  };

  // JS: replace each run (back to front so indices stay valid)
  for (const run of [...p.runs].reverse()) {
    const tag = `<script src="${relTo(run.bundle.name)}"></script>`;
    html = html.slice(0, run.start) + tag + html.slice(run.end);
  }

  // CSS: drop every local stylesheet link, then insert bundles at the first one
  const perMedia = {};
  for (const c of p.css) perMedia[c.media] = true;
  let firstAt = -1;
  html = html.replace(LINK_RE, (tag, off) => {
    const href = attr(tag, 'href');
    if (!isLocal(href)) return tag;
    if (firstAt === -1) { firstAt = off; return '\u0000CSSMARK\u0000'; }
    return '';
  });
  if (firstAt !== -1) {
    const links = Object.keys(cssBundles)
      .filter((m) => perMedia[m])
      .map((m) => `<link rel="stylesheet" href="${relTo(cssBundles[m].name)}" media="${m}">`)
      .join('\n');
    html = html.replace('\u0000CSSMARK\u0000', links + '\n');
  }

  // dead IE8 shim
  html = html.replace(SHIV_RE, '');

  // Google Fonts: non-blocking swap + preconnect
  html = html.replace(/<link([^>]*fonts\.googleapis\.com\/css\?)([^>]*?)>/gi, (tag, a, b) => {
    if (/display=swap/.test(tag)) return tag;
    return tag.replace(/(fonts\.googleapis\.com\/css\?[^"']*)/, '$1&display=swap');
  });
  if (/fonts\.googleapis\.com/.test(html) && !/preconnect[^>]*fonts\.gstatic/.test(html)) {
    html = html.replace(/<head>/i, '<head>\n<link rel="preconnect" href="https://fonts.googleapis.com">\n'
      + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
  }

  if (html !== p.html) { fs.writeFileSync(p.file, html); edited++; }
}
console.log(`\nwrote ${Object.keys(cssBundles).length + jsBundles.size} bundles to ${OUT_REL}/`);
console.log(`rewrote ${edited} HTML files`);
