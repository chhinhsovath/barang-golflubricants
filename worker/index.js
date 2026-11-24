/**
 * Worker entry for the GOLF Lubricants static mirror.
 *
 * Static assets are served by Cloudflare directly; this script exists for one
 * job that the asset server cannot do on its own: WebP content negotiation.
 *
 * tools/make-webp.sh writes a sibling "<file>.webp" next to every jpg/png.
 * When the browser advertises image/webp we serve that sibling instead, which
 * is the same trick serve.js uses locally (498 MB of originals -> 71 MB).
 * Doing it here means the HTML is never rewritten, so the theme's slider,
 * lightbox and srcset logic stay untouched.
 *
 * Only /wp-content/* runs through here (see run_worker_first in
 * wrangler.jsonc); every other path is served straight from the asset
 * store without a Worker invocation.
 */
const WEBP_SRC = /\.(jpe?g|png)$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const wantsWebp =
      (request.method === 'GET' || request.method === 'HEAD') &&
      WEBP_SRC.test(url.pathname) &&
      (request.headers.get('Accept') || '').includes('image/webp');

    if (wantsWebp) {
      const webpUrl = new URL(url);
      webpUrl.pathname = url.pathname + '.webp';

      const webpRes = await env.ASSETS.fetch(new Request(webpUrl, request));

      // A miss returns the configured not_found_handling response, so only
      // treat a real 2xx as a usable variant.
      if (webpRes.ok) {
        const res = new Response(webpRes.body, webpRes);
        res.headers.set('Content-Type', 'image/webp');
        // Caches must key on Accept, or a webp body could reach a client
        // that never asked for one.
        res.headers.append('Vary', 'Accept');
        return res;
      }
    }

    return env.ASSETS.fetch(request);
  },
};
