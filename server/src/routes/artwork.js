// GET /api/artwork?path=<url>
//
// Pipes artwork from upstream (HA or absolute URLs) to the browser so the
// kiosk can render it same-origin without knowing the HA token. Images are
// cached in memory so they persist when the upstream becomes unreachable
// (e.g. Zidoo poster API powering off).
//
// The frontend never calls this directly; state.js rewrites artwork URLs in
// the /api/state payload to hit here.

import { Router } from 'express';

// In-memory artwork cache. Survives between requests but clears on addon
// restart (acceptable — no worse than current behaviour).
const cache = new Map(); // key = url, value = { buf: Buffer, contentType: string }

export function artworkRoute({ config, fetchImpl = globalThis.fetch }) {
  const r = Router();

  // CORS: allow HA dashboard (different origin/port) to load images
  r.options('/api/artwork', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.end();
  });
  r.use('/api/artwork', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });

  // Fetch from upstream and cache the result. Only caches if response
  // is actually an image (content-type starts with image/).
  // Returns the buffer on success, throws on failure.
  async function fetchAndCache(key, url, opts) {
    const upstream = await fetchImpl(url, opts);
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const ct = upstream.headers.get('content-type') || '';
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (!ct.startsWith('image/')) {
      throw new Error(`upstream returned non-image content-type: ${ct}`);
    }
    cache.set(key, { buf, contentType: ct });
    return buf;
  }

  r.get('/api/artwork', async (req, res) => {
    const path = String(req.query.path || '');

    // Determine upstream URL: HA-relative paths go through HA, absolute URLs
    // are fetched directly.
    const isAbsolute = /^https?:\/\//i.test(path);
    const upstreamUrl = isAbsolute ? path : `${config.haUrl}${path}`;
    const fetchOpts = isAbsolute
      ? {}
      : { headers: { Authorization: `Bearer ${config.haToken}` } };

    // If we have a cached copy, serve it immediately and refresh in background.
    // This prevents blank images when upstream is slow (e.g. Zidoo booting).
    const cached = cache.get(path);

    if (cached) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('X-Artwork-Cache', 'stale-while-revalidate');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(cached.buf);
      // Refresh cache in background — don't block the response
      fetchAndCache(path, upstreamUrl, fetchOpts).catch(() => {});
      return;
    }

    // No cache — must wait for upstream
    try {
      const buf = await fetchAndCache(path, upstreamUrl, fetchOpts);
      const ct = cache.get(path).contentType;
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('X-Artwork-Cache', 'miss');
      res.end(buf);
    } catch (err) {
      // No cache and upstream failed — check if we have ANY cached image for this path
      const cached = cache.get(path);
      if (cached) {
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('X-Artwork-Cache', 'hit');
        res.end(cached.buf);
      } else {
        res.status(502).json({ error: 'artwork_unreachable', message: err.message });
      }
    }
  });

  return r;
}
