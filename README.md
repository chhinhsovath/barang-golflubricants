# golflubricants — local mirror

An HTTrack capture of `venol.de` (06 Nov 2026), rebranded to GOLF Lubricants.
Static files only: no build step, no database, no PHP.

## Run it

```bash
node serve.js                 # http://localhost:8080
node serve.js --port 3000     # another port
node serve.js --no-webp       # serve the original jpg/png
node serve.js --no-compress   # disable br/gzip
```

Node 18+. No dependencies.

The server handles the mirror's quirks: directory URLs resolve to `index.html`,
query strings are stripped before lookup, and it serves brotli/gzip from an
in-memory cache with ETag/304, byte-range support for video, and long-lived
caching for hashed assets.

## Optimization tools

Re-run these after re-capturing the mirror. All are idempotent.

| Tool | Does |
|---|---|
| `tools/make-webp.sh` | Writes `<file>.webp` next to every jpg/png (~8s, 12 cores). `serve.js` serves these automatically when the browser sends `Accept: image/webp`. |
| `tools/bundle-assets.js` | Merges the theme's CSS/JS into `assets/bundle/`. Run with `--dry-run` first. |
| `tools/lazy-images.js` | Adds `loading="lazy"` to offscreen images. |
| `tools/fix-logo.js` | Makes the GOLF logo + favicons consistent across every page. |
| `tools/shrink-video.sh` | Re-encodes the promo videos under Cloudflare's 25 MiB asset limit. |
| `tools/shrink-pdf.sh` | Shrinks the catalogue PDFs under the same limit. |
| `tools/cleanup.js` | Removes WordPress plumbing and HTTrack scrape artifacts. |

```bash
./tools/make-webp.sh
node tools/bundle-assets.js --dry-run && node tools/bundle-assets.js
node tools/lazy-images.js
node tools/fix-logo.js
```

`*.webp` is gitignored — it is derived output, regenerate it rather than commit it.

### Re-running the bundler

`tools/bundle-assets.js` reads the *current* HTML, so running it twice is safe
(the second pass simply finds one bundle link where there were sixty). To
rebundle from scratch after editing theme CSS/JS, restore the HTML first:

```bash
git checkout <baseline-commit> -- . && node tools/bundle-assets.js
```

## Results (homepage, measured end to end)

| | Baseline | Optimized |
|---|---|---|
| Requests | 166 | 67 |
| Transfer | 10.17 MB | 2.60 MB |
| HTML | 165 KB | 34 KB (brotli) |

Across all 143 pages, subresource requests fell from 14,411 to 1,112 (−92.3%).
WebP variants total 71 MB against 498 MB of originals (−86%).

## Deploy (Cloudflare Workers)

Live: <https://barang-golflubricants.sovath.workers.dev>

```bash
export CLOUDFLARE_ACCOUNT_ID=0917cab6a3763a18518040978bf8835f
npx wrangler deploy
```

`wrangler.jsonc` serves the repo root as static assets; `.assetsignore` keeps
git history, tooling and source-only files out of the upload. `worker/index.js`
exists for one job — WebP content negotiation, the same trick `serve.js` uses
locally — so the HTML never needs rewriting. Only `/wp-content/*` is routed
through the Worker; everything else is served straight from the asset store.

### The 25 MiB asset limit

Cloudflare rejects any single asset over 25 MiB. Five files exceeded it and all
five were in use, so they were compressed rather than dropped:

| File | Before | After |
|---|---|---|
| Venol Production (2026/10) | 100.3 MiB | 23.0 MiB |
| Venol Production (2024/09) | 54.4 MiB | 23.1 MiB |
| Nexium Production | 36.5 MiB | 23.1 MiB |
| Folder_VENOL_EN.pdf | 31.9 MiB | 19.4 MiB |
| Folder_NEXIUM_EN_2025.pdf | 25.2 MiB | 22.5 MiB |

Pristine originals live in `_originals/` (gitignored, local only). The PDF
originals are also in git history — recover with
`git show 3ba0739:wp-content/uploads/2025/10/Folder_VENOL_EN.pdf > out.pdf`.
**The video originals exist ONLY in `_originals/`** — they were never tracked.

`tools/shrink-pdf.sh` is a two-stage pipeline for a reason: these are Corel
brochures whose pages are CMYK JPEG-2000 images, and ghostscript alone cannot
read that combination — it emits a PDF with a broken xref that renders zero
pages. `pdftocairo` rewrites clean PDF operators first, then ghostscript
re-encodes. The script validates page count, parse errors and size before
replacing anything, and restores the original if any check fails.

### Platform note

Cloudflare's asset server does not honour HTTP Range requests — a ranged GET
returns 200 with the whole body, for Worker-routed and plain assets alike. The
videos still play (progressive download), but seeking is less efficient than it
is under `serve.js` locally, which does serve 206.

## Branding

The capture was mid-rebrand from VENOL to GOLF Lubricants. As captured:

- the header's inline `<svg>` was the **VENOL** mark, on all 143 pages;
- a **GOLF** `<img class="alternate">` existed on only the 5 language
  homepages, and Enfold shows an alternate logo solely while the header is
  transparent. So most pages showed VENOL, and the homepages flipped
  VENOL to GOLF on scroll.

`tools/fix-logo.js` now puts one GOLF mark in every header state, on all 143
pages, and repoints all five favicon sizes. It also strips Enfold's
`av_alternate_logo_active` class — that class hides the *primary* logo while
the header is transparent, so leaving it would blank the header logo once the
alternate was gone.

GOLF assets were derived from the one piece of GOLF artwork in the mirror
(`venol-motor-oil-logo-GT-Flag-white.png`, which despite its name is a JPEG
containing the GOLF logo):

- `wp-content/uploads/2024/08/golf-lubricants-logo.png` — 280x160, 2x the 80px header slot
- `wp-content/uploads/2024/07/golf-favicon-{32,180,192,270,300}.png` — centre-cropped square

**Still VENOL, deliberately untouched:** page `<title>`s and body copy. Rewriting
those across five languages is a separate job.

## What was removed

`tools/cleanup.js` stripped the parts of the capture that do nothing in a
static mirror (759 files, 5.4 MB). All of it is recoverable from the baseline
commit `3ba0739`.

- **WordPress plumbing** — `wp-json/` (393 oEmbed/REST dumps), `wp-admin/`,
  `xmlrpc*.php`, plus the 959 `<link>` tags across 143 pages that pointed at
  them (`rel=pingback`, `rel=EditURI`, `rel=shortlink`, oEmbed alternates,
  `api.w.org`).
- **HTTrack artifacts** — 128 `index<hash>.html` shortlink stubs, 3 captured
  "Page not found" pages, `uber-uns/index - Copy.html` (byte-identical to its
  sibling), and a directory HTTrack created by mistaking a LayerSlider console
  message for a URL.
- **Orphaned theme CSS/JS** — 224 files superseded by `assets/bundle/`.
- **Dead VENOL branding** — the old favicon `.gif`s and unused VENOL logo.

Two guards worth knowing about, because both caught real mistakes:

1. Orphan detection is scoped to `wp-content/` and `wp-includes/`. Without that
   scope, root-level files that nothing references — `serve.js` above all —
   look orphaned and get deleted.
2. `layerslider.transitions994d.js` is still referenced by a standalone
   `<script>` tag that the bundler correctly leaves alone (it only merges runs
   of two or more). It must not be removed. Always re-run the reference audit
   after cleaning.

The GOLF artwork source is preserved at
`_originals/branding/golf-lubricants-source-1280x731.jpg` — it is the only
full-resolution GOLF image, and every logo/favicon is derived from it.

## Known mirror artifacts (present in the original capture, not introduced here)

- The "Years on the market / Products / Supported countries" counters render as
  `OO` / `OOO+` and never count up. Verified identical in the untouched
  baseline — the Enfold number animation did not survive the capture.
- Pages still reference `googletagmanager.com` and `fonts.googleapis.com`, so
  the site is not fully offline-capable. Trackers were left in place by choice.
- One Font Awesome WOFF2 was saved by HTTrack under a `.html` name; `serve.js`
  detects it by magic bytes and serves the correct MIME type.
