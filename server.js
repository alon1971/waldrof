/**
 * Waldrof production server — static files + /api/generate (Node HTTP).
 * Used by Render, local dev (npm run dev), and any standard Node.js host.
 * Set PERPLEXITY_API_KEY or AI_API_KEY in the host environment.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
})();

const generateApi = require('./api/generate');
const shareMaterialApi = require('./api/share-material');
const searchHistoryApi = require('./api/search-history');
const configApi = require('./api/config');
const knowledgeSeed = require('./api/knowledge-seed');
const cacheDb = require('./api/cache');
const env = require('./api/env');

if (typeof generateApi.handleGeneratePost !== 'function') {
  console.error('api/generate.js must export handleGeneratePost for Render Node hosting.');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

const API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function writeJsonResponse(nativeRes, statusCode, payload) {
  nativeRes.writeHead(statusCode, Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8' },
    API_CORS_HEADERS
  ));
  nativeRes.end(JSON.stringify(payload));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/** Minimal Vercel-style response helpers for api/generate legacyHandler. */
function createApiResponse(nativeRes) {
  const state = { statusCode: 200, headers: {} };
  return {
    status: function (code) {
      state.statusCode = code;
      return this;
    },
    setHeader: function (name, value) {
      state.headers[name] = value;
      return this;
    },
    json: function (payload) {
      state.headers['Content-Type'] = 'application/json; charset=utf-8';
      nativeRes.writeHead(state.statusCode, state.headers);
      nativeRes.end(JSON.stringify(payload));
    },
    end: function () {
      nativeRes.writeHead(state.statusCode, state.headers);
      nativeRes.end();
    },
  };
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relative);
  const rootResolved = path.resolve(ROOT);
  if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      if (relative !== 'index.html' && !path.extname(relative)) {
        return serveStatic(req, res, '/');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.js' || ext === '.html') {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function handleApiGenerate(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, API_CORS_HEADERS);
    return res.end();
  }
  if (req.method !== 'POST') {
    return writeJsonResponse(res, 405, { error: 'Method not allowed' });
  }

  let parsedBody = null;
  try {
    const raw = await readBody(req);
    if (!raw || !String(raw).trim()) {
      return writeJsonResponse(res, 400, { error: 'Missing JSON body' });
    }
    parsedBody = JSON.parse(raw);
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return writeJsonResponse(res, 400, { error: message || 'Invalid JSON body' });
  }

  try {
    const result = await generateApi.handleGeneratePost(parsedBody);
    const payload = result && result.data !== undefined
      ? { data: result.data, meta: result.meta || { fromCache: false } }
      : { data: result, meta: { fromCache: false } };
    return writeJsonResponse(res, 200, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    console.error('[api/generate]', statusCode, message);
    if (!res.headersSent) {
      return writeJsonResponse(res, statusCode, { error: message });
    }
  }
}

async function handleApiShareMaterial(req, res) {
  const apiRes = createApiResponse(res);
  try {
    let body;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const raw = await readBody(req);
      if (raw && raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch (parseErr) {
          apiRes.status(400).json({
            error: parseErr instanceof Error ? parseErr.message : 'Invalid JSON body',
          });
          return;
        }
      }
    }
    await shareMaterialApi.legacyHandler({ method: req.method, headers: req.headers, body: body }, apiRes);
  } catch (err) {
    if (!res.headersSent) {
      apiRes.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function handleApiSearchHistory(req, res) {
  const apiRes = createApiResponse(res);
  try {
    let body;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const raw = await readBody(req);
      if (raw && raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch (parseErr) {
          apiRes.status(400).json({
            error: parseErr instanceof Error ? parseErr.message : 'Invalid JSON body',
          });
          return;
        }
      }
    }
    const parsedUrl = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    await searchHistoryApi.legacyHandler({
      method: req.method,
      headers: req.headers,
      body: body,
      url: req.url,
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
    }, apiRes);
  } catch (err) {
    if (!res.headersSent) {
      apiRes.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function handleApiConfig(req, res) {
  const apiRes = createApiResponse(res);
  try {
    await configApi.legacyHandler({ method: req.method, headers: req.headers }, apiRes);
  } catch (err) {
    if (!res.headersSent) {
      apiRes.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const server = http.createServer(async function (req, res) {
  const pathname = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost')).pathname;

  if (pathname === '/health' || pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      service: 'waldrof',
      runtime: 'render-node',
      generateHandler: 'handleGeneratePost',
      cacheBackend: cacheDb.isSupabaseCacheEnabled() ? 'supabase' : 'local-fallback',
      perplexityKey: Boolean(process.env.PERPLEXITY_API_KEY || process.env.AI_API_KEY),
    }));
  }

  if (pathname === '/api/generate') {
    return handleApiGenerate(req, res);
  }

  if (pathname === '/api/share-material') {
    return handleApiShareMaterial(req, res);
  }

  if (pathname === '/api/search-history') {
    return handleApiSearchHistory(req, res);
  }

  if (pathname === '/api/config') {
    return handleApiConfig(req, res);
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, function () {
  console.log('Waldrof listening on http://' + HOST + ':' + PORT);
  console.log('Runtime: Render Node.js (server.js) — NOT Vercel serverless');
  console.log('API: GET /api/config | POST /api/generate | POST /api/share-material | POST /api/search-history | Health: GET /health');
  console.log('Local: http://localhost:' + PORT);
  console.log('[env] PERPLEXITY_API_KEY:', process.env.PERPLEXITY_API_KEY ? 'set' : (process.env.AI_API_KEY ? 'set (AI_API_KEY)' : 'MISSING'));
  console.log('[env] SUPABASE_URL:', env.getSupabaseUrl() ? 'set' : 'MISSING');
  console.log('[env] SUPABASE_SERVICE_ROLE_KEY:', env.getSupabaseServiceRoleKey() ? 'set' : (env.getSupabaseAnonKey() ? 'anon only' : 'MISSING'));
  console.log('[cache] Supabase cached_results:', cacheDb.isSupabaseCacheEnabled() ? 'enabled' : 'local fallback only');
  knowledgeSeed.seedKnowledgeBaseIfEmptyAsync();
});

server.on('error', function (err) {
  console.error('Server failed to start:', err);
  process.exit(1);
});
