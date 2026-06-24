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

  r.get('/api/artwork', async (req, res) => {
    const path = String(req.query.path || '');

    // Determine upstream URL: HA-relative paths go through HA, absolute URLs
    // are fetched directly.
    const isAbsolute = /^https?:\/\//i.test(path);
    const upstreamUrl = isAbsolute ? path : `${config.haUrl}${path}`;
    const fetchOpts = isAbsolute
      ? {}
      : { headers: { Authorization: `Bearer ${config.haToken}` } };

    try {
      const upstream = await fetchImpl(upstreamUrl, fetchOpts);
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);

      const ct = upstream.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await upstream.arrayBuffer());

      // Cache for fallback when upstream dies later
      cache.set(path, { buf, contentType: ct });

      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(buf);
    } catch (err) {
      // Upstream unreachable — serve from cache if available
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
