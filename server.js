'use strict';

/*
 * Agri360 Client Portal — server
 * --------------------------------
 * A tiny standalone Express service deployed on Coolify. It:
 *   (a) serves the static client-facing SPA from ./public, and
 *   (b) PROXIES every /api/* request to the Agri360 CRM, injecting the shared
 *       portal key as an `X-Portal-Key` header SERVER-SIDE so the browser
 *       never sees the secret.
 *
 * Node 20 has global fetch, so express is the only dependency.
 */

const path = require('path');
const express = require('express');

const app = express();

const PORT = process.env.PORT || 3000;
const CRM_API_BASE = (process.env.CRM_API_BASE || 'https://agri360.proagrihub.com').replace(/\/+$/, '');
const PORTAL_KEY = process.env.PORTAL_KEY || '';
// Shared secret the CRM's video-request-callback authenticates against via the
// X-Sister-Auth header (HMAC/static mode). The portal proxy is server-to-server
// and sends no browser Origin, so origin-pinning can't authenticate the callback
// — we inject this secret for that one path instead. Must match the value set on
// the Agri360 side (VIDEO_REQUEST_SHARED_SECRET).
const VIDEO_REQUEST_SHARED_SECRET = process.env.VIDEO_REQUEST_SHARED_SECRET || '';

const PUBLIC_DIR = path.join(__dirname, 'public');

// Health check for Coolify.
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// The native video-request form uploads files as multipart/form-data. The JSON
// proxy below would discard the file parts (it re-serialises req.body as JSON),
// so forward THIS one path RAW — body + Content-Type (multipart boundary)
// preserved — to the CRM's public upload route. Registered BEFORE express.json so
// the multipart stream is captured as a Buffer, not parsed as JSON. Must come
// before app.all('/api/*') so the generic proxy never sees it.
app.post('/api/video-request-form/upload', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  try {
    const headers = { 'X-Portal-Key': PORTAL_KEY };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    const upstream = await fetch(CRM_API_BASE + '/api/video-request-form/upload', {
      method: 'POST', headers, body: req.body,
    });
    const ct = upstream.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      let data = null;
      try { data = await upstream.json(); } catch (_e) { data = null; }
      return res.status(upstream.status).json(data);
    }
    const text = await upstream.text();
    if (ct) res.set('Content-Type', ct);
    return res.status(upstream.status).send(text);
  } catch (err) {
    console.error('video-request upload proxy error:', err && err.message);
    return res.status(502).json({ error: 'Upload failed' });
  }
});

// Parse JSON bodies so we can re-serialise them to the CRM. Allow generous size
// for change-requests that may carry base64 screenshots.
app.use(express.json({ limit: '25mb' }));

/*
 * Proxy ANY /api/* call to the CRM at the same path, adding the portal key.
 * Returns the CRM's status + JSON (or text) verbatim. The key is never sent to
 * the browser and never logged.
 */
app.all('/api/*', async (req, res) => {
  const targetUrl = CRM_API_BASE + req.originalUrl; // originalUrl keeps /api/... + query

  const headers = {
    'Accept': 'application/json',
    'X-Portal-Key': PORTAL_KEY,
  };
  // Staff branding editor: the JWT rides in the URL fragment and is sent by
  // the SPA as X-Editor-Token. Forward it so PUT /public/:token/branding can
  // authorize the write. Never log this header.
  if (req.headers['x-editor-token']) {
    headers['X-Editor-Token'] = String(req.headers['x-editor-token']);
  }

  // The native in-portal video request form submits to the CRM's sister-app
  // callback, which is authenticated by a shared secret (X-Sister-Auth), NOT the
  // portal key. Inject it server-side only for that exact path shape so the
  // secret never reaches the browser and never rides other CRM routes.
  if (VIDEO_REQUEST_SHARED_SECRET &&
      /^\/api\/booking-forms\/[^/]+\/video-request-callback$/.test(req.path)) {
    headers['X-Sister-Auth'] = VIDEO_REQUEST_SHARED_SECRET;
  }

  const init = { method: req.method, headers };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    // req.body is {} when there was no JSON body; only forward when meaningful.
    init.body = JSON.stringify(req.body == null ? {} : req.body);
  }

  try {
    const upstream = await fetch(targetUrl, init);
    const status = upstream.status;
    const contentType = upstream.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      let data;
      try {
        data = await upstream.json();
      } catch (_e) {
        data = null;
      }
      return res.status(status).json(data);
    }

    const text = await upstream.text();
    if (contentType) res.set('Content-Type', contentType);
    return res.status(status).send(text);
  } catch (err) {
    // Upstream/network failure — surface as 502 without leaking internals.
    console.error('CRM proxy error:', req.method, req.path, '-', err && err.message);
    return res.status(502).json({ error: 'Upstream CRM request failed' });
  }
});

/*
 * Proxy CRM-served uploads (design files, images, PDFs) so they are
 * SAME-ORIGIN to the portal. Required for the website-design <iframe> PDF
 * preview: the CRM serves files with CSP `frame-ancestors 'self'`, which
 * blocks a cross-origin portal from framing them. Streams the binary body
 * and content-type verbatim. These files are public on the CRM; the portal
 * key is forwarded harmlessly.
 */
// Allowlist of content-types safe to serve inline on our own origin (cannot
// execute script). Anything else (svg/html/xml/…) is forced to a download.
// Inline images/PDFs (preview thumbs) plus video (the client-portal video
// approval player). None of these can execute script, so serving them inline on
// our own origin is safe under the same model as the image/PDF allowlist.
var UPLOAD_INLINE_TYPES = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/ogg', 'video/x-m4v',
];
app.get('/uploads/*', async (req, res) => {
  // Validate the path: only /uploads/<safe segments>, no traversal / encoded
  // traversal / backslashes — so it can never be rewritten to another CRM route
  // (the X-Portal-Key would otherwise ride along to a non-uploads endpoint).
  var sub = req.params[0] || '';
  if (sub.indexOf('..') !== -1 || sub.indexOf('\\') !== -1 || /%2e%2e|%2f|%5c/i.test(sub)) {
    return res.status(400).end();
  }
  var safePath = '/uploads/' + sub.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  var targetUrl;
  try { targetUrl = new URL(safePath, CRM_API_BASE); } catch (e) { return res.status(400).end(); }
  if (targetUrl.href.indexOf(new URL('/uploads/', CRM_API_BASE).href) !== 0) {
    return res.status(400).end();
  }
  try {
    // Forward the browser's Range header so <video> seeking works (the upstream
    // returns 206 + Content-Range, which we pass through verbatim).
    const upstreamHeaders = { 'X-Portal-Key': PORTAL_KEY };
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;
    const upstream = await fetch(targetUrl.href, { method: 'GET', headers: upstreamHeaders });
    res.status(upstream.status);
    res.set('X-Content-Type-Options', 'nosniff');
    // Pass through the headers a media player needs for seeking / progress.
    ['accept-ranges', 'content-range', 'content-length'].forEach(function (h) {
      var v = upstream.headers.get(h);
      if (v) res.set(h, v);
    });
    var ct = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (UPLOAD_INLINE_TYPES.indexOf(ct) !== -1) {
      res.set('Content-Type', ct); // safe to render inline (pdf preview / image thumbs / video player)
    } else {
      // Never serve attacker-influenced types (svg/html/xml) inline on our origin.
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', 'attachment');
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    console.error('CRM uploads proxy error:', req.path, '-', err && err.message);
    return res.status(502).end();
  }
});

// Static SPA assets.
app.use(express.static(PUBLIC_DIR));

// SPA fallback: any non-/api GET serves index.html so client routes
// (/form/:token, /approvals/:token) deep-link correctly.
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Agri360 Client Portal listening on :${PORT} -> CRM ${CRM_API_BASE}`);
  if (!PORTAL_KEY) {
    console.warn('WARNING: PORTAL_KEY is not set — CRM calls will be rejected.');
  }
});
