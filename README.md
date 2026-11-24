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

## Known mirror artifacts (present in the original capture, not introduced here)

- The "Years on the market / Products / Supported countries" counters render as
  `OO` / `OOO+` and never count up. Verified identical in the untouched
  baseline — the Enfold number animation did not survive the capture.
- Pages still reference `googletagmanager.com` and `fonts.googleapis.com`, so
  the site is not fully offline-capable. Trackers were left in place by choice.
- One Font Awesome WOFF2 was saved by HTTrack under a `.html` name; `serve.js`
  detects it by magic bytes and serves the correct MIME type.
