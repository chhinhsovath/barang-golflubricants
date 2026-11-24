#!/usr/bin/env node
/**
 * Static dev server for the HTTrack mirror.
 *   node serve.js [--port 8080] [--root .] [--no-compress]
 *
 * Handles the mirror's quirks:
 *  - /foo/        -> /foo/index.html
 *  - /foo         -> /foo/index.html  (or /foo.html)
 *  - ?query       -> stripped before lookup (HTTrack baked queries into filenames)
 *  - HTTrack's "<name><hash>.<ext>" variants are served as-is when referenced.
 *
 * Tuning: in-memory gzip/brotli cache for text assets, long cache headers for
 * hashed/static assets, ETag + 304, byte-range support for video.
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(argOf('--port', process.env.PORT || 8080));
const ROOT = path.resolve(argOf('--root', __dirname));
const COMPRESS = !argv.includes('--no-compress');
const QUIET = argv.includes('--quiet');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.php': 'text/html; charset=utf-8',
};
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|rss\+xml)|image\/svg)/;
const IMMUTABLE = /\.(css|js|mjs|jpe?g|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|mp4|webm|mp3|pdf)$/i;

// encoded-body cache: key = realpath + mtime + encoding
const encCache = new Map();
const ENC_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const ENC_CACHE_ITEM_MAX = 4 * 1024 * 1024;
let encCacheBytes = 0;

// resolution cache: url path -> {file, stat} (mirror is read-mostly)
const resolveCache = new Map();

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const p = path.normalize(path.join(root, decoded));
  return p.startsWith(root) ? p : null;
}

async function statFile(p) {
  try {
    const s = await fsp.stat(p);
    return s.isFile() ? s : null;
  } catch { return null; }
}

/** Resolve a request path to an on-disk file, mimicking the mirror's layout. */
async function resolve(urlPath) {
  const hit = resolveCache.get(urlPath);
  if (hit !== undefined) return hit;

  const base = safeJoin(ROOT, urlPath);
  let out = null;
  if (base) {
    const endsWithSlash = urlPath.split('?')[0].endsWith('/');
    const candidates = endsWithSlash
      ? [path.join(base, 'index.html')]
      : [base, path.join(base, 'index.html'), base + '.html', base + '/index.htm'];
    for (const c of candidates) {
      const s = await statFile(c);
      if (s) { out = { file: c, size: s.size, mtimeMs: s.mtimeMs }; break; }
    }
  }
  if (resolveCache.size < 20000) resolveCache.set(urlPath, out);
  return out;
}

function etagOf(r) {
  return 'W/"' + r.size.toString(16) + '-' + Math.floor(r.mtimeMs).toString(16) + '"';
}

function pickEncoding(req, type, size) {
  if (!COMPRESS || !COMPRESSIBLE.test(type) || size < 1024 || size > ENC_CACHE_ITEM_MAX) return null;
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

function encode(buf, enc) {
  return enc === 'br'
    ? zlib.brotliCompressSync(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      })
    : zlib.gzipSync(buf, { level: 6 });
}

async function getEncoded(r, enc) {
  const key = r.file + ':' + Math.floor(r.mtimeMs) + ':' + enc;
  const c = encCache.get(key);
  if (c) return c;
  const raw = await fsp.readFile(r.file);
  const body = encode(raw, enc);
  if (encCacheBytes + body.length < ENC_CACHE_MAX_BYTES) {
    encCache.set(key, body);
    encCacheBytes += body.length;
  }
  return body;
}

const server = http.createServer(async (req, res) => {
  const t0 = process.hrtime.bigint();
  let status = 200;
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      status = 405;
      res.writeHead(405, { 'Allow': 'GET, HEAD', 'Content-Length': 0 }).end();
      return;
    }
    const r = await resolve(req.url);
    if (!r) {
      status = 404;
      const body = Buffer.from('<!doctype html><meta charset=utf-8><title>404</title>'
        + '<body style="font:16px/1.5 system-ui;padding:3rem"><h1>404</h1><p><code>'
        + req.url.replace(/[<&]/g, '') + '</code> not found in the mirror.</p>');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    const ext = path.extname(r.file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = etagOf(r);
    const headers = {
      'Content-Type': type,
      'ETag': etag,
      'Last-Modified': new Date(r.mtimeMs).toUTCString(),
      'Cache-Control': IMMUTABLE.test(r.file)
        ? 'public, max-age=31536000'
        : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };

    if (req.headers['if-none-match'] === etag) {
      status = 304;
      res.writeHead(304, headers).end();
      return;
    }

    // Range requests (video scrubbing) — always served uncompressed.
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null) { start = r.size - (end || 0); end = r.size - 1; }
        if (end === null || end >= r.size) end = r.size - 1;
        if (start > end || start < 0) {
          status = 416;
          res.writeHead(416, { 'Content-Range': `bytes */${r.size}` }).end();
          return;
        }
        status = 206;
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${r.size}`,
          'Content-Length': end - start + 1,
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(r.file, { start, end }).pipe(res);
        return;
      }
    }

    const enc = pickEncoding(req, type, r.size);
    if (enc) {
      const body = await getEncoded(r, enc);
      headers['Content-Encoding'] = enc;
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    headers['Content-Length'] = r.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(r.file).pipe(res);
  } catch (err) {
    status = 500;
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('500 ' + err.message);
  } finally {
    res.on('finish', () => {
      if (QUIET) return;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (status >= 400 || ms > 150) {
        console.log(`${status} ${ms.toFixed(1)}ms ${req.method} ${req.url}`);
      }
    });
  }
});

server.keepAliveTimeout = 65000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`mirror served from ${ROOT}`);
  console.log(`  http://localhost:${PORT}/        (de)`);
  console.log(`  compression: ${COMPRESS ? 'br/gzip + in-memory cache' : 'off'}`);
});
