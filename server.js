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

const roomClients = new Map();
const roomQueues = new Map();
let globalSeq = 0;

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

function sanitizeRoomId(raw) {
  const clean = String(raw || 'DEFAULT').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
  return clean || 'DEFAULT';
}

function readServerConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}

  const envKey = (process.env.TMDB_API_KEY || process.env.TMDB_KEY || '').trim();
  const fileKey = typeof fileConfig.tmdbApiKey === 'string' ? fileConfig.tmdbApiKey.trim() : '';
  return {
    tmdbApiKey: envKey || fileKey || '',
    customPlayers: Array.isArray(fileConfig.customPlayers) ? fileConfig.customPlayers : null
  };
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
  globalSeq++;
  const entry = { seq: globalSeq, time: Date.now(), room: roomId, ...payload };

  if (!roomQueues.has(roomId)) roomQueues.set(roomId, []);
  const queue = roomQueues.get(roomId);
  queue.push(entry);
  if (queue.length > 30) queue.shift();

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
  const serverCfg = readServerConfig();

  if (req.method === 'GET' && pathname === '/api/boot-info') {
    const isVercel = Boolean(process.env.VERCEL || req.headers['x-vercel-id']);
    const ip = isVercel ? hostHeader : getLocalNetworkIP();
    const baseUrl = isVercel ? `${protoHeader}://${hostHeader}` : `http://${ip}:${PORT}`;
    return send(res, 200, {
      hasServerKey: Boolean(serverCfg.tmdbApiKey),
      serverPlayers: serverCfg.customPlayers,
      baseUrl
    });
  }

  if (req.method === 'GET' && pathname === '/api/remote-events') {
    const roomId = sanitizeRoomId(url.searchParams.get('room'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', room: roomId, seq: globalSeq })}\n\n`);

    if (!roomClients.has(roomId)) roomClients.set(roomId, new Set());
    roomClients.get(roomId).add(res);

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      const set = roomClients.get(roomId);
      if (set) {
        set.delete(res);
        if (set.size === 0) roomClients.delete(roomId);
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/remote-poll') {
    const roomId = sanitizeRoomId(url.searchParams.get('room'));
    const since = Number(url.searchParams.get('since') || 0);
    const queue = roomQueues.get(roomId) || [];
    const pending = queue.filter(c => c.seq > since && Date.now() - c.time < 12000);
    const connectedCount = roomClients.has(roomId) ? roomClients.get(roomId).size : 0;
    return send(res, 200, { seq: globalSeq, commands: pending, connectedScreens: connectedCount });
  }

  if (req.method === 'POST' && pathname === '/api/remote-cmd') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }); }
    const roomId = sanitizeRoomId(body.room || url.searchParams.get('room'));
    const delivered = broadcastToRoom(roomId, body);
    return send(res, 200, { ok: true, room: roomId, deliveredTo: delivered });
  }

  if (req.method === 'GET' && pathname === '/api/tmdb') {
    const clientKey = (req.headers['x-tmdb-key'] || '').trim();
    const activeKey = serverCfg.tmdbApiKey || clientKey;

    if (!activeKey) {
      return send(res, 428, { error: 'TMDB_API_KEY_REQUIRED' });
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
        target.searchParams.set('api_key', activeKey);
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
    console.log(`CineHome TV running at:     http://${ip}:${PORT}`);
    console.log(`Mobile Web Remote at:     http://${ip}:${PORT}/remote`);
  });
}
