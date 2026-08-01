// server.js — Node HTTP entrypoint for Ledgerly.
//
// Launches a standard Node http server and routes:
//   /api/*           -> api.js (handleApi)
//   everything else  -> static files from ./public (the future index.html home)
//
// Pure node:http + node:fs — no Express, no third-party deps. This mirrors the
// wrangler.toml pages_build_output_dir = "./public" contract so the same
// backend files can deploy to Cloudflare Pages with a thin binding shim.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { handleApi } from './api.js';

const PORT = Number(process.env.PORT) || 8788;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = resolvePath(process.env.LEDGERLY_PUBLIC || './public');

// --- MIME types -------------------------------------------------------------
const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.mjs': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain;charset=utf-8',
  '.map': 'application/json;charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

function mimeFor(pathname) {
  return MIME[extname(pathname).toLowerCase()] || 'application/octet-stream';
}

// --- Range-aware file sender (lets the server stream large receipts/docs) ----
async function sendFile(res, absPath, pathname) {
  let info;
  try {
    info = await stat(absPath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (!info.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('Not found');
    return;
  }

  const type = mimeFor(pathname);
  const headers = { 'Content-Type': type, 'Content-Length': info.size };

  // Respect a single-byte range request (e.g. media scrubbing).
  const range = res.req && res.req.headers && res.req.headers.range;
  let fileBuf;
  if (range && typeof range === 'string' && range.startsWith('bytes=')) {
    const [startStr, endStr] = range.slice(6).split('-');
    const start = Number(startStr);
    const end = endStr ? Number(endStr) : info.size - 1;
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end < info.size && start <= end) {
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      headers['Accept-Ranges'] = 'bytes';
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      let whole;
      try {
        whole = await readFile(absPath);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain;charset=utf-8' });
        res.end('Read error');
        return;
      }
      res.end(whole.subarray(start, end + 1));
      return;
    }
  }

  headers['Accept-Ranges'] = 'bytes';
  // No ETag precompute on every request — the file set is small (dev server).
  // Use size+mtime as a weak cache-key.
  const etagBase = `${info.size}-${Math.floor(Number(info.mtimeMs))}`;
  headers['ETag'] = `"${createHash('sha1').update(etagBase).digest('hex').slice(0, 16)}"`;
  try {
    fileBuf = await readFile(absPath);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('Read error');
    return;
  }
  res.writeHead(200, headers);
  res.end(fileBuf);
}

// --- Static handler with directory traversal protection ---------------------
function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  let rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  if (rel.startsWith('/')) rel = rel.slice(1);

  // Resolve candidate paths: pathname, then /index.html for roots.
  const candidates = [];
  if (rel === '' || rel === '.' ) {
    candidates.push('index.html');
  } else {
    candidates.push(rel);
    // If it looks like a directory (no ext), try directory/index.html.
    if (!extname(rel)) candidates.push(join(rel, 'index.html'));
    // SPA-style fallback so client-side routing works once index.html exists.
  }

  for (const cand of candidates) {
    const abs = join(PUBLIC_DIR, cand);
    const inside = relative(PUBLIC_DIR, abs);
    if (inside.startsWith('..') || resolvePath(abs) === PUBLIC_DIR) {
      // would escape the public dir or hit the root; skip
      continue;
    }
    if (existsSync(abs)) {
      return sendFile(res, abs, cand);
    }
  }

  // SPA fallback: serve index.html for any non-API, non-existent path
  // (lets client-side routing take over once index.html is added).
  const indexAbs = join(PUBLIC_DIR, 'index.html');
  if (existsSync(indexAbs)) {
    return sendFile(res, indexAbs, 'index.html');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
  res.end('Not found');
}

// --- Server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // Attach the parsed URL early so handlers/sendFile can both read it.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || HOST}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('Bad request');
    return;
  }
  req._url = url; // available to sendFile via res.req._url if ever needed

  const pathname = url.pathname;

  // CORS preflight for everything (api.js repeats it for /api/*).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // API routes live under /api/*.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  // Everything else is static content.
  return serveStatic(req, res, url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Ledgerly: port ${PORT} is in use. Set PORT=<n> and retry.`);
  } else {
    console.error('Ledgerly server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const origin = `http://${HOST}:${PORT}`;
  console.log(`Ledgerly server listening on ${origin}`);
  console.log(`  API:    ${origin}/api/state`);
  console.log(`  Static: ${PUBLIC_DIR}`);
  if (!existsSync(PUBLIC_DIR)) {
    console.log(`  (public dir does not yet exist — index.html will be served once added)`);
  }
});

// Graceful shutdown so the SQLite WAL flushes cleanly.
function shutdown(signal) {
  console.log(`\nLedgerly: ${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  // Force exit if something hangs.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
