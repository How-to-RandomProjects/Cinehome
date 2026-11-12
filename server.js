'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = process.env.CINEHOME_HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || process.env.CINEHOME_PORT || 3000);
const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, 'index.html');
const REMOTE_FILE = path.join(ROOT, 'remote.html');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const MAX_BODY = 64 * 1024;

const tmdbCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

// Room-isolated command queues & SSE connections: Map<roomId, Set<res>>
const roomClients = new Map();
// Map<roomId, { seq: number, commands: Array }>
const roomQueues = new Map();

function getLocalNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getServerDefaultTmdbKey() {
  const envKey = (process.env.TMDB_API_KEY || process.env.TMDB_KEY || '').trim();
  if (envKey) return envKey;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof parsed.tmdbApiKey === 'string' && parsed.tmdbApiKey.trim()) {
      return parsed.tmdbApiKey.trim();
    }
  } catch (_) {}
  return '';
}

function sanitizeRoomId(raw) {
  const clean = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  return clean.slice(0, 24) || 'DEFAULT';
}

function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (_) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function broadcastToRoom(roomId, payload) {
  if (!roomQueues.has(roomId)) {
    roomQueues.set(roomId, { seq: 0, commands: [] });
  }
  const state = roomQueues.get(roomId);
  state.seq += 1;
  const entry = { seq: state.seq, time: Date.now(), ...payload };
  state.commands.push(entry);
  if (state.commands.length > 30) state.commands.shift();

  // Prune old inactive rooms periodically
  if (roomQueues.size > 500) {
    const now = Date.now();
    for (const [k, v] of roomQueues.entries()) {
      const last = v.commands[v.commands.length - 1];
      if (!last || now - last.time > 3600000) roomQueues.delete(k);
    }
  }

  const clients = roomClients.get(roomId);
  let delivered = 0;
  if (clients) {
    const message = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of clients) {
      try {
        client.write(message);
        delivered++;
      } catch (_) {
        clients.delete(client);
      }
    }
  }
  return delivered;
}

async function handle(req, res) {
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const protoHeader = req.headers['x-forwarded-proto'] || 'http';
  const url = new URL(req.url, `${protoHeader}://${hostHeader}`);
  const pathname = url.pathname;

  // 1. Public Status Check (Whether server has a built-in TMDB key or client needs one)
  if (req.method === 'GET' && pathname === '/api/status') {
    const serverKey = getServerDefaultTmdbKey();
    return send(res, 200, { hasServerKey: Boolean(serverKey) });
  }

  // 2. Network / Public URL Info for Device-Specific QR Code
  if (req.method === 'GET' && pathname === '/api/network-info') {
    const roomId = sanitizeRoomId(url.searchParams.get('room'));
    const isPublicHost = Boolean(process.env.VERCEL || req.headers['x-vercel-id'] || !hostHeader.startsWith('localhost') && !hostHeader.startsWith('127.0.0.1'));
    const baseUrl = isPublicHost
      ? `${protoHeader}://${hostHeader}`
      : `http://${getLocalNetworkIP()}:${PORT}`;

    const clients = roomClients.get(roomId);
    return send(res, 200, {
      room: roomId,
      remoteUrl: `${baseUrl}/remote?room=${encodeURIComponent(roomId)}`,
      connectedScreens: clients ? clients.size : 0
    });
  }

  // 3. Room-Isolated SSE Stream
  if (req.method === 'GET' && pathname === '/api/remote-events') {
    const roomId = sanitizeRoomId(url.searchParams.get('room'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    if (!roomClients.has(roomId)) roomClients.set(roomId, new Set());
    const set = roomClients.get(roomId);
    set.add(res);

    const currentSeq = roomQueues.get(roomId)?.seq || 0;
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', room: roomId, seq: currentSeq })}\n\n`);

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      set.delete(res);
      if (set.size === 0) roomClients.delete(roomId);
    });
    return;
  }

  // 4. Room-Isolated Serverless Polling Endpoint
  if (req.method === 'GET' && pathname === '/api/remote-poll') {
    const roomId = sanitizeRoomId(url.searchParams.get('room'));
    const since = Number(url.searchParams.get('since') || 0);
    const state = roomQueues.get(roomId);
    if (!state) return send(res, 200, { seq: 0, commands: [] });

    const pending = state.commands.filter(c => c.seq > since && Date.now() - c.time < 12000);
    return send(res, 200, { seq: state.seq, commands: pending });
  }

  // 5. Receive Remote Command for Specific Device Room
  if (req.method === 'POST' && pathname === '/api/remote-cmd') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }); }

    const roomId = sanitizeRoomId(body.room || url.searchParams.get('room'));
    const delivered = broadcastToRoom(roomId, { action: body.action, value: body.value });
    return send(res, 200, { ok: true, room: roomId, deliveredTo: delivered || 1 });
  }

  // 6. Validate User TMDB Key
  if (req.method === 'POST' && pathname === '/api/validate-key') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }); }

    const testKey = String(body.apiKey || '').trim();
    if (!testKey) return send(res, 400, { valid: false, error: 'API key is required' });

    try {
      const check = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(testKey)}`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!check.ok) return send(res, 400, { valid: false, error: 'TMDB rejected this API key.' });
      return send(res, 200, { valid: true });
    } catch (_) {
      return send(res, 502, { valid: false, error: 'Could not reach TMDB to verify key.' });
    }
  }

  // 7. TMDB Proxy (Uses User-Provided Key Header or Server Env Key)
  if (req.method === 'GET' && pathname === '/api/tmdb') {
    const userKey = String(req.headers['x-tmdb-key'] || url.searchParams.get('api_key') || '').trim();
    const effectiveKey = userKey || getServerDefaultTmdbKey();

    if (!effectiveKey) {
      return send(res, 428, { error: 'TMDB API key required' });
    }

    const tmdbPath = url.searchParams.get('path') || '';
    if (!tmdbPath.startsWith('/') || tmdbPath.startsWith('//') || tmdbPath.includes('..') || tmdbPath.includes('://')) {
      return send(res, 400, { error: 'Invalid TMDB path' });
    }

    const cached = tmdbCache.get(tmdbPath);
    if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
      return send(res, 200, cached.data);
    }

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const target = new URL(`https://api.themoviedb.org/3${tmdbPath}`);
        target.searchParams.set('api_key', effectiveKey);
        const upstream = await fetch(target, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15000)
        });
        const text = await upstream.text();
        if (upstream.ok) {
          tmdbCache.set(tmdbPath, { time: Date.now(), data: text });
          return send(res, upstream.status, text);
        }
        if (upstream.status === 401) {
          return send(res, 401, { error: 'Invalid TMDB API key' });
        }
      } catch (err) {
        lastError = err;
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    return send(res, 502, { error: 'TMDB request failed', detail: lastError?.message });
  }

  // 8. Serve Mobile Web Remote (/remote)
  if (req.method === 'GET' && pathname === '/remote') {
    try {
      const html = fs.readFileSync(REMOTE_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store'
      });
      return res.end(html);
    } catch (_) {
      return send(res, 500, 'Could not read remote.html', 'text/plain');
    }
  }

  // 9. Serve Main TV Interface (/)
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store'
      });
      return res.end(html);
    } catch (_) {
      return send(res, 500, 'Could not read index.html', 'text/plain');
    }
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error('Request error:', error.message);
    if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
    else res.destroy();
  });
});

if (process.env.VERCEL) {
  module.exports = (req, res) => {
    handle(req, res).catch(error => {
      console.error('Vercel handler error:', error.message);
      if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
    });
  };
} else {
  server.listen(PORT, HOST, () => {
    const ip = getLocalNetworkIP();
    console.log(`CineHome running at: http://${ip}:${PORT}`);
  });
}
