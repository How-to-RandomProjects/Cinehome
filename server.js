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
const FALLBACK_TMDB_KEY = '970bd0b45df9d662f02f81535049b33c';

const tmdbCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

const sseClients = new Set();
let recentCommands = [];
let cmdSeq = 0;
let memoryPlayers = null;

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

function readConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}

  const envKey = (process.env.TMDB_API_KEY || process.env.TMDB_KEY || '').trim();
  const fileKey = typeof fileConfig.tmdbApiKey === 'string' ? fileConfig.tmdbApiKey.trim() : '';
  const tmdbApiKey = envKey || fileKey || FALLBACK_TMDB_KEY;

  const customPlayers = memoryPlayers
    || (Array.isArray(fileConfig.customPlayers) ? fileConfig.customPlayers : []);

  return { tmdbApiKey, customPlayers };
}

function writeConfig(config) {
  memoryPlayers = config.customPlayers;
  try {
    const temp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, CONFIG_FILE);
  } catch (_) {
    // Vercel serverless filesystem is read-only; persisted in memory & browser localStorage
  }
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

function broadcastCommand(payload) {
  cmdSeq++;
  const entry = { seq: cmdSeq, time: Date.now(), ...payload };
  recentCommands.push(entry);
  if (recentCommands.length > 25) recentCommands.shift();

  const message = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

async function handle(req, res) {
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const protoHeader = req.headers['x-forwarded-proto'] || 'http';
  const url = new URL(req.url, `${protoHeader}://${hostHeader}`);
  const pathname = url.pathname;
  const config = readConfig();

  // 1. Server / Deployment Info for QR Code
  if (req.method === 'GET' && pathname === '/api/network-info') {
    const isVercel = Boolean(process.env.VERCEL || req.headers['x-vercel-id']);
    if (isVercel) {
      return send(res, 200, {
        ip: hostHeader,
        port: '',
        remoteUrl: `${protoHeader}://${hostHeader}/remote`,
        connectedScreens: sseClients.size
      });
    }
    const ip = getLocalNetworkIP();
    return send(res, 200, {
      ip,
      port: PORT,
      remoteUrl: `http://${ip}:${PORT}/remote`,
      connectedScreens: sseClients.size
    });
  }

  // 2. Real-Time SSE Event Stream (Local LAN)
  if (req.method === 'GET' && pathname === '/api/remote-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', seq: cmdSeq })}\n\n`);
    sseClients.add(res);

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  // 3. Polling Fallback for Serverless Remote Commands
  if (req.method === 'GET' && pathname === '/api/remote-poll') {
    const since = Number(url.searchParams.get('since') || 0);
    const pending = recentCommands.filter(c => c.seq > since && Date.now() - c.time < 10000);
    return send(res, 200, { seq: cmdSeq, commands: pending });
  }

  // 4. Receive Command from Phone Web Remote
  if (req.method === 'POST' && pathname === '/api/remote-cmd') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }); }
    broadcastCommand(body);
    return send(res, 200, { ok: true, deliveredTo: sseClients.size || 1 });
  }

  // 5. Custom Players API
  if (req.method === 'GET' && pathname === '/api/players') {
    return send(res, 200, { players: config.customPlayers });
  }

  if (req.method === 'POST' && pathname === '/api/players') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }); }
    if (!Array.isArray(body.players)) return send(res, 400, { error: 'Invalid players list' });
    config.customPlayers = body.players;
    writeConfig(config);
    return send(res, 200, { ok: true, players: config.customPlayers });
  }

  // 6. TMDB Proxy
  if (req.method === 'GET' && pathname === '/api/tmdb') {
    if (!config.tmdbApiKey) {
      return send(res, 428, { error: 'TMDB API key missing' });
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
        target.searchParams.set('api_key', config.tmdbApiKey);
        const upstream = await fetch(target, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15000)
        });
        const text = await upstream.text();
        if (upstream.ok) {
          tmdbCache.set(tmdbPath, { time: Date.now(), data: text });
          return send(res, upstream.status, text);
        }
      } catch (err) {
        lastError = err;
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    return send(res, 502, { error: 'TMDB request failed', detail: lastError?.message });
  }

  // 7. Serve Mobile Web Remote (/remote)
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

  // 8. Serve Main TV Interface (/)
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
