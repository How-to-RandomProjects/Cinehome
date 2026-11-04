'use strict';

// CineHome local server. Requires Node.js 18+ (built-in fetch).
// Keeps the TMDB API key in config.json and proxies TMDB requests server-side.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = process.env.CINEHOME_HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || process.env.CINEHOME_PORT || 3000);
const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, 'index.html');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const MAX_BODY = 64 * 1024;

const DEFAULT_REMOTE_PROFILE = {
  UP: ['2', 'ArrowUp', 'Up', 'Numpad8'],
  DOWN: ['8', 'ArrowDown', 'Down', 'Numpad2'],
  LEFT: ['4', 'ArrowLeft', 'Left', 'Numpad4'],
  RIGHT: ['6', 'ArrowRight', 'Right', 'Numpad6'],
  SELECT: ['5', 'Enter', 'Select', 'NumpadEnter'],
  BACK: ['0', 'Escape', 'Backspace', 'BrowserBack', 'GoBack', 'Numpad0'],
  SEARCH: ['1', 'Numpad1'],
  MIRROR: ['3', 'F3', 'Numpad3']
};
const ACTIONS = Object.keys(DEFAULT_REMOTE_PROFILE);
const DEFAULT_PLAYER_TEMPLATES = {
  vidriftMovie: 'https://embed.vidrift.net/embed/movie/{id}?title={title}',
  vidriftTV: 'https://embed.vidrift.net/embed/tv/{id}/1/1',
  cinemaosMovie: 'https://cinemaos.tech/player/{id}?theme=ffffff',
  cinemaosTV: 'https://cinemaos.tech/player/{id}?theme=ffffff&type=tv&s=1&e=1',
  vidfastMovie: 'https://vidfast.vc/movie/{id}?autoPlay=true',
  vidfastTV: 'https://vidfast.vc/tv/{id}/1/1?autoPlay=true'
};

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      tmdbApiKey: typeof parsed.tmdbApiKey === 'string' ? parsed.tmdbApiKey : '',
      playerTemplates: { ...DEFAULT_PLAYER_TEMPLATES, ...(parsed.playerTemplates || {}) },
      remoteProfile: parsed.remoteProfile && typeof parsed.remoteProfile === 'object' ? parsed.remoteProfile : null
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read config.json:', error.message);
    return { tmdbApiKey: '', playerTemplates: { ...DEFAULT_PLAYER_TEMPLATES }, remoteProfile: null };
  }
}

function writeConfig(config) {
  const temp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch (_) {}
  fs.renameSync(temp, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
}

function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN'
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

function validatePlayerTemplates(input) {
  const result = {};
  for (const key of Object.keys(DEFAULT_PLAYER_TEMPLATES)) {
    const value = typeof input?.[key] === 'string' && input[key].trim()
      ? input[key].trim()
      : DEFAULT_PLAYER_TEMPLATES[key];
    let parsed;
    try { parsed = new URL(value.replaceAll('{id}', '123').replaceAll('{title}', 'Example')); }
    catch (_) { throw new Error(`Invalid URL for ${key}`); }
    if (parsed.protocol !== 'https:' || !value.includes('{id}')) {
      throw new Error(`${key} must be an HTTPS URL containing the {id} placeholder`);
    }
    result[key] = value;
  }
  return result;
}

function validateRemoteProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Remote profile is missing');
  const profile = {};
  const keyToAction = new Map();
  for (const action of ACTIONS) {
    const keys = input[action];
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8) {
      throw new Error(`Invalid keys for ${action}`);
    }
    const clean = [...new Set(keys.filter(k => typeof k === 'string' && k.length > 0 && k.length <= 80))];
    if (!clean.length) throw new Error(`No valid keys for ${action}`);
    for (const key of clean) {
      const owner = keyToAction.get(key);
      if (owner && owner !== action) throw new Error(`Key ${key} is already assigned to ${owner}`);
      keyToAction.set(key, action);
    }
    profile[action] = clean;
  }
  return profile;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const config = readConfig();

  if (req.method === 'GET' && pathname === '/api/status') {
    return send(res, 200, { configured: Boolean(config.tmdbApiKey) });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return send(res, 200, { playerTemplates: config.playerTemplates });
  }

  if (req.method === 'GET' && pathname === '/api/remote-config') {
    return send(res, 200, { profile: config.remoteProfile || null });
  }

  if (req.method === 'POST' && pathname === '/api/setup') {
    if (config.tmdbApiKey) return send(res, 409, { error: 'CineHome is already configured. To reset setup, stop the server and remove config.json, then restart.' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return send(res, 400, { error: error.message }); }
    const apiKey = typeof body.tmdbApiKey === 'string' ? body.tmdbApiKey.trim() : '';
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(apiKey)) return send(res, 400, { error: 'That does not look like a valid TMDB API key.' });
    let playerTemplates;
    try { playerTemplates = validatePlayerTemplates(body.playerTemplates || {}); }
    catch (error) { return send(res, 400, { error: error.message }); }
    try {
      const test = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(10000) });
      if (!test.ok) return send(res, 400, { error: 'TMDB did not accept this key. Check it and try again.' });
    } catch (_) {
      return send(res, 502, { error: 'Could not contact TMDB to verify the key. Check internet access and try again.' });
    }
    const fresh = { tmdbApiKey: apiKey, playerTemplates, remoteProfile: null };
    try { writeConfig(fresh); }
    catch (error) { return send(res, 500, { error: 'Could not write config.json: ' + error.message }); }
    return send(res, 200, { ok: true, playerTemplates });
  }

  if (req.method === 'POST' && pathname === '/api/save-remote-config') {
    let body;
    try { body = await readBody(req); }
    catch (error) { return send(res, 400, { error: error.message }); }
    let profile;
    try { profile = validateRemoteProfile(body.profile); }
    catch (error) { return send(res, 400, { error: error.message }); }
    config.remoteProfile = profile;
    try { writeConfig(config); }
    catch (error) { return send(res, 500, { error: 'Could not save remote profile: ' + error.message }); }
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/tmdb') {
    if (!config.tmdbApiKey) return send(res, 428, { error: 'CineHome setup is required' });
    const tmdbPath = url.searchParams.get('path') || '';
    if (!tmdbPath.startsWith('/') || tmdbPath.startsWith('//') || tmdbPath.includes('..') || tmdbPath.includes('://')) {
      return send(res, 400, { error: 'Invalid TMDB path' });
    }
    try {
      const target = new URL(`https://api.themoviedb.org/3${tmdbPath}`);
      target.searchParams.set('api_key', config.tmdbApiKey);
      const upstream = await fetch(target, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const text = await upstream.text();
      return send(res, upstream.status, text, upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    } catch (error) {
      return send(res, 502, { error: 'TMDB request failed', detail: error.name === 'TimeoutError' ? 'Request timed out' : 'Check server internet access' });
    }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data:; frame-src https: about:; connect-src 'self' https://api.themoviedb.org https://image.tmdb.org;"
      });
      return res.end(html);
    } catch (_) {
      return send(res, 500, 'Could not read index.html', 'text/plain; charset=utf-8');
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

server.listen(PORT, HOST, () => {
  console.log(`CineHome server running at http://localhost:${PORT}`);
  console.log(`Open this server from your TV using the phone's LAN IP and port ${PORT}.`);
  if (!readConfig().tmdbApiKey) console.log('First-run setup will appear when CineHome is opened.');
});
