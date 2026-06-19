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

const PUBLIC_DIR = path.join(__dirname, 'public');

// Health check for Coolify.
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

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
var UPLOAD_INLINE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
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
    const upstream = await fetch(targetUrl.href, { method: 'GET', headers: { 'X-Portal-Key': PORTAL_KEY } });
    res.status(upstream.status);
    res.set('X-Content-Type-Options', 'nosniff');
    var ct = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (UPLOAD_INLINE_TYPES.indexOf(ct) !== -1) {
      res.set('Content-Type', ct); // safe to render inline (pdf preview / image thumbs)
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
