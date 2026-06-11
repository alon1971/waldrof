/**
 * Local dev server — static files + /api/generate (loads PERPLEXITY_API_KEY from .env via api/generate.js).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const generateApi = require('./api/generate');
const handler = generateApi.legacyHandler || generateApi;
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

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
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function mockRes(res) {
  const state = { statusCode: 200, headers: {} };
  return {
    status: function (code) { state.statusCode = code; return this; },
    setHeader: function (k, v) { state.headers[k] = v; },
    json: function (obj) {
      state.headers['Content-Type'] = 'application/json';
      res.writeHead(state.statusCode, state.headers);
      res.end(JSON.stringify(obj));
    },
    end: function () {
      res.writeHead(state.statusCode, state.headers);
      res.end();
    },
  };
}

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer(async function (req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname === '/api/generate') {
    try {
      const raw = await readBody(req);
      const mockReq = {
        method: req.method,
        body: raw ? JSON.parse(raw) : undefined,
      };
      await handler(mockReq, mockRes(res));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  serveStatic(req, res);
}).listen(PORT, function () {
  console.log('Waldrof ready at http://localhost:' + PORT);
  console.log('Live Perplexity research via /api/generate');
});
