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
const env = require('./api/env');
const cacheDb = require('./api/cache');
const shareMaterialApi = require('./api/share-material');
const communityIngestApi = require('./api/community-ingest-api');
const communityUploadApi = require('./api/community-upload');
const communityMaterialsApi = require('./api/community-materials');
const searchHistoryApi = require('./api/search-history');
const subscriptionApi = require('./api/subscription');
const configApi = require('./api/config');
const knowledgeSeed = require('./api/knowledge-seed');
const billingCheckout = require('./api/billing-checkout');
const billingWebhooks = require('./api/billing-webhooks');
const paymentSuccessWebhook = require('./api/payment-success-webhook');
const testCancellationAlert = require('./api/test-cancellation-alert');
const billingReport = require('./api/billing-report');
const purePhaseCApi = require('./api/pure-phase-c');
const pureGeneralSearchApi = require('./api/pure-general-search');

if (typeof generateApi.handleGeneratePost !== 'function') {
  console.error('api/generate.js must export handleGeneratePost for Render Node hosting.');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const GENERATE_ROUTE_TIMEOUT_MS = generateApi.GENERATE_ROUTE_TIMEOUT_MS || 120000;

const API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-user-email',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function writeJsonResponse(nativeRes, statusCode, payload) {
  nativeRes.writeHead(statusCode, Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8' },
    API_CORS_HEADERS
  ));
  nativeRes.end(cacheDb.safeJsonStringify(payload));
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
      nativeRes.end(cacheDb.safeJsonStringify(payload));
    },
    send: function (payload) {
      if (!state.headers['Content-Type']) {
        state.headers['Content-Type'] = 'application/json; charset=utf-8';
      }
      nativeRes.writeHead(state.statusCode, state.headers);
      nativeRes.end(typeof payload === 'string' ? payload : cacheDb.safeJsonStringify(payload));
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
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers.Pragma = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function applyLongRunningRouteTimeout(req, res) {
  req.setTimeout(GENERATE_ROUTE_TIMEOUT_MS);
  res.setTimeout(GENERATE_ROUTE_TIMEOUT_MS);
  res.on('timeout', function () {
    console.error('[api/generate] response timeout after', GENERATE_ROUTE_TIMEOUT_MS, 'ms');
    if (!res.headersSent) {
      writeJsonResponse(res, 504, {
        error: 'Gateway timeout — Perplexity research took too long. Please retry.',
      });
    }
  });
}

/** Detect SSE streaming requests — Accept: text/event-stream or body { stream: true }. */
function wantsEventStream(req, parsedBody) {
  const accept = String((req.headers && (req.headers.accept || req.headers.Accept)) || '');
  if (/text\/event-stream/i.test(accept)) return true;
  return Boolean(parsedBody && parsedBody.stream === true);
}

/**
 * Streaming variant of /api/generate. Opens the response immediately and keeps the
 * pipe alive with heartbeats + live Perplexity deltas so reverse proxies / browsers
 * never hit an idle Gateway timeout during long sonar-reasoning-pro generations.
 */
async function handleApiGenerateStream(req, res, parsedBody) {
  applyStreamingRouteTimeout(req, res);

  // Disable Nagle's algorithm so each small SSE frame is pushed onto the wire
  // immediately instead of being coalesced/buffered at the TCP layer.
  try { if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true); } catch (e) { /* ignore */ }

  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform stops proxies from gzipping/buffering or otherwise altering the body.
    'Cache-Control': 'no-cache, no-store, no-transform, must-revalidate',
    Connection: 'keep-alive',
    // Critical for Render/Nginx: never buffer this response, stream it straight through.
    'X-Accel-Buffering': 'no',
  }, API_CORS_HEADERS));

  // Push the response headers out to the client right now (before any model latency).
  try { if (typeof res.flushHeaders === 'function') res.flushHeaders(); } catch (e) { /* ignore */ }

  // Force any buffered bytes out to the browser after every write. res.flush exists
  // when compression middleware is active; otherwise the explicit write already
  // flushed and this is a harmless no-op.
  function flush() {
    try { if (typeof res.flush === 'function') res.flush(); } catch (e) { /* ignore */ }
  }

  let closed = false;
  function writeSse(event, dataObj) {
    if (closed || res.writableEnded) return;
    try {
      res.write('event: ' + event + '\n');
      res.write('data: ' + cacheDb.safeJsonStringify(dataObj == null ? {} : dataObj) + '\n\n');
      flush();
    } catch (e) { /* socket may have closed */ }
  }

  // Open immediately so the client sees bytes before any model latency.
  try { res.write('retry: 3000\n'); res.write(': open\n\n'); flush(); } catch (e) { /* ignore */ }

  const heartbeat = setInterval(function () {
    if (closed || res.writableEnded) return;
    try { res.write(': ping\n\n'); flush(); } catch (e) { /* ignore */ }
  }, 12000);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  }

  req.on('close', cleanup);

  const phase = parsedBody && parsedBody.phase ? parsedBody.phase : '(unknown)';
  const generateStartedAt = Date.now();

  const streamHooks = {
    onStatus: function (stage, detail) {
      writeSse('status', { stage: stage, detail: detail || null });
    },
    onDelta: function (delta) {
      if (delta) writeSse('delta', { text: delta });
    },
  };

  try {
    const result = await generateApi.handleGeneratePost(parsedBody, {
      headers: req.headers || {},
      socket: req.socket,
    }, streamHooks);

    const payload = generateApi.buildGenerateHttpPayload
      ? generateApi.buildGenerateHttpPayload(result)
      : (result && result.data !== undefined
        ? { data: result.data, meta: result.meta || { fromCache: false } }
        : { data: result, meta: { fromCache: false } });
    const httpStatus = generateApi.resolveGenerateHttpStatus
      ? generateApi.resolveGenerateHttpStatus(result)
      : 200;

    console.log(
      '[api/generate] (stream)',
      httpStatus,
      phase,
      Math.round((Date.now() - generateStartedAt) / 1000) + 's',
      payload.meta && payload.meta.fromCache ? '(cache)' : (httpStatus === 202 ? '(async)' : '(live)')
    );

    writeSse('result', { status: httpStatus, payload: payload });
    writeSse('done', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    console.error(
      '[api/generate] (stream)',
      statusCode,
      phase,
      Math.round((Date.now() - generateStartedAt) / 1000) + 's',
      message
    );
    writeSse('error', {
      status: statusCode,
      error: message,
      code: err && err.code ? err.code : undefined,
      usage: err && err.usage ? err.usage : undefined,
    });
    writeSse('done', {});
  } finally {
    cleanup();
    if (!res.writableEnded) {
      try { res.end(); } catch (e) { /* ignore */ }
    }
  }
}

/** Long timeout for SSE; on timeout just close the stream (never inject a JSON 504 into SSE bytes). */
function applyStreamingRouteTimeout(req, res) {
  req.setTimeout(GENERATE_ROUTE_TIMEOUT_MS);
  res.setTimeout(GENERATE_ROUTE_TIMEOUT_MS);
  res.on('timeout', function () {
    console.error('[api/generate] (stream) response timeout after', GENERATE_ROUTE_TIMEOUT_MS, 'ms');
    if (!res.writableEnded) {
      try { res.end(); } catch (e) { /* ignore */ }
    }
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

  applyLongRunningRouteTimeout(req, res);

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

  if (parsedBody && parsedBody.phase === 'grade') {
    cacheDb.normalizeGradeCacheRequest(parsedBody);
  }

  if (wantsEventStream(req, parsedBody)) {
    return handleApiGenerateStream(req, res, parsedBody);
  }

  const phase = parsedBody && parsedBody.phase ? parsedBody.phase : '(unknown)';
  const generateStartedAt = Date.now();
  try {
    const result = await generateApi.handleGeneratePost(parsedBody, {
      headers: req.headers || {},
      socket: req.socket,
    });
    const payload = generateApi.buildGenerateHttpPayload
      ? generateApi.buildGenerateHttpPayload(result)
      : (result && result.data !== undefined
        ? { data: result.data, meta: result.meta || { fromCache: false } }
        : { data: result, meta: { fromCache: false } });
    const httpStatus = generateApi.resolveGenerateHttpStatus
      ? generateApi.resolveGenerateHttpStatus(result)
      : 200;
    console.log(
      '[api/generate]',
      httpStatus,
      phase,
      Math.round((Date.now() - generateStartedAt) / 1000) + 's',
      payload.meta && payload.meta.fromCache ? '(cache)' : (httpStatus === 202 ? '(async)' : '(live)')
    );
    return writeJsonResponse(res, httpStatus, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    console.error(
      '[api/generate]',
      statusCode,
      phase,
      Math.round((Date.now() - generateStartedAt) / 1000) + 's',
      message
    );
    if (!res.headersSent) {
      return writeJsonResponse(res, statusCode, { error: message });
    }
  }
}

async function handleApiCommunityUpload(req, res) {
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
    await communityUploadApi.legacyHandler({ method: req.method, headers: req.headers, body: body }, apiRes);
  } catch (err) {
    if (!res.headersSent) {
      apiRes.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function handleApiCommunityMaterials(req, res) {
  const apiRes = createApiResponse(res);
  try {
    const parsedUrl = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    if (req.method === 'DELETE' || req.method === 'PATCH') {
      console.log('[api/community-materials]', req.method, 'id=', parsedUrl.searchParams.get('id') || '(none)');
    }
    let body;
    if (req.method === 'PATCH' || req.method === 'DELETE' || req.method === 'POST') {
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
    await communityMaterialsApi.legacyHandler({
      method: req.method,
      headers: req.headers,
      body: body,
      url: req.url,
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
      params: {},
    }, apiRes);
  } catch (err) {
    if (!res.headersSent) {
      apiRes.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function handleApiCommunityIngest(req, res) {
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
    await communityIngestApi.legacyHandler({ method: req.method, headers: req.headers, body: body }, apiRes);
  } catch (err) {
    if (!res.headersSent) {
      apiRes.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
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

async function handleApiSubscription(req, res) {
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
    await subscriptionApi.legacyHandler({
      method: req.method,
      headers: req.headers,
      body: body,
      url: req.url,
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

async function handleApiBillingCheckout(req, res) {
  const apiRes = createApiResponse(res);
  try {
    let body;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      if (raw && raw.trim()) body = JSON.parse(raw);
    }
    await billingCheckout.createCheckoutHandler({
      method: req.method,
      headers: req.headers,
      body: body,
    }, apiRes);
  } catch (err) {
    if (!res.headersSent) {
      apiRes.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function handleApiStripeWebhook(req, res) {
  try {
    const raw = await readBody(req);
    const result = await billingWebhooks.handleStripeWebhookRequest(req, raw);
    writeJsonResponse(res, 200, result);
  } catch (err) {
    const status = err.statusCode || 400;
    console.error('[api/webhooks/stripe]', status, err.message || err);
    writeJsonResponse(res, status, { error: err.message || String(err) });
  }
}

async function handleApiPaymentSuccessWebhook(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, API_CORS_HEADERS);
    return res.end();
  }
  if (req.method !== 'POST') {
    writeJsonResponse(res, 405, { error: 'Method not allowed' });
    return;
  }
  try {
    const raw = await readBody(req);
    let body = {};
    if (raw && raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch (parseErr) {
        writeJsonResponse(res, 400, { error: 'Invalid JSON body' });
        return;
      }
    }
    const result = await paymentSuccessWebhook.handlePaymentSuccessRequest(req, body);
    writeJsonResponse(res, 200, result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[api/webhooks/payment-success]', status, err.message || err);
    writeJsonResponse(res, status, { error: err.message || String(err) });
  }
}

async function handleApiTestCancellationAlertCron(req, res) {
  try {
    const parsedUrl = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    assertCronAuthorized(req, query);
    let body = null;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      if (raw && raw.trim()) body = JSON.parse(raw);
    }
    const result = await testCancellationAlert.handleCronRequest({
      method: req.method,
      body: body,
    }, query);
    writeJsonResponse(res, 200, result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[api/cron/test-cancellation-alert]', status, err.message || err);
    writeJsonResponse(res, status, { error: err.message || String(err) });
  }
}

async function handleApiBillingReportCron(req, res) {
  try {
    const parsedUrl = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    const result = await billingReport.runMonthlyReport({
      method: req.method,
      headers: req.headers,
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
    });
    writeJsonResponse(res, 200, result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[api/cron/billing-report]', status, err.message || err);
    writeJsonResponse(res, status, { error: err.message || String(err) });
  }
}

function assertCronAuthorized(req, query) {
  const secret = env.getCronSecret();
  if (!secret) return;
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const headerSecret = req.headers['x-cron-secret'] || req.headers['X-Cron-Secret'];
  const querySecret = query && query.secret;
  if (auth === secret || headerSecret === secret || querySecret === secret) return;
  const err = new Error('Unauthorized cron request');
  err.statusCode = 401;
  throw err;
}

async function handlePureApiRoute(req, res, apiModule) {
  const apiRes = createApiResponse(res);
  try {
    let body;
    if (req.method === 'POST') {
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
    await apiModule.legacyHandler({ method: req.method, headers: req.headers, body: body }, apiRes);
  } catch (err) {
    if (!res.headersSent) {
      apiRes.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function handleApiDriveCatalogSyncCron(req, res) {
  try {
    const parsedUrl = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    assertCronAuthorized(req, query);
    if (req.method !== 'GET' && req.method !== 'POST') {
      writeJsonResponse(res, 405, { error: 'Method not allowed' });
      return;
    }
    const result = await cacheDb.syncCommunityDriveCatalog({
      rootFolderId: query.rootFolderId || undefined,
      gradeId: query.gradeId || undefined,
    });
    writeJsonResponse(res, 200, result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[api/cron/drive-catalog-sync]', status, err.message || err);
    writeJsonResponse(res, status, { error: err.message || String(err) });
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
      archiveOnly: typeof generateApi.isArchiveOnlyMode === 'function' ? generateApi.isArchiveOnlyMode() : false,
      cacheBackend: cacheDb.isSupabaseCacheEnabled() ? 'supabase' : 'local-fallback',
      gradeCacheKey: 'phase+gradeId',
      perplexityKey: Boolean(env.getPerplexityApiKey()),
      communityServiceRole: env.hasRealServiceRoleKey ? env.hasRealServiceRoleKey() : Boolean(env.getSupabaseServiceRoleKey()),
    }));
  }

  if (pathname === '/api/generate') {
    return handleApiGenerate(req, res);
  }

  if (pathname === '/api/share-material') {
    return handleApiShareMaterial(req, res);
  }

  if (pathname === '/api/community-ingest') {
    return handleApiCommunityIngest(req, res);
  }

  if (pathname === '/api/community-upload') {
    return handleApiCommunityUpload(req, res);
  }

  if (pathname === '/api/community-materials') {
    return handleApiCommunityMaterials(req, res);
  }

  if (pathname === '/api/search-history') {
    return handleApiSearchHistory(req, res);
  }

  if (pathname === '/api/subscription') {
    return handleApiSubscription(req, res);
  }

  if (pathname === '/api/config') {
    return handleApiConfig(req, res);
  }

  if (pathname === '/api/billing/checkout') {
    return handleApiBillingCheckout(req, res);
  }

  if (pathname === '/api/webhooks/stripe') {
    return handleApiStripeWebhook(req, res);
  }

  if (pathname === '/api/webhooks/payment-success') {
    return handleApiPaymentSuccessWebhook(req, res);
  }

  if (pathname === '/api/cron/billing-report') {
    return handleApiBillingReportCron(req, res);
  }

  if (pathname === '/api/cron/drive-catalog-sync') {
    return handleApiDriveCatalogSyncCron(req, res);
  }

  if (pathname === '/api/cron/test-cancellation-alert') {
    return handleApiTestCancellationAlertCron(req, res);
  }

  if (pathname === '/api/pure-phase-c') {
    applyLongRunningRouteTimeout(req, res);
    return handlePureApiRoute(req, res, purePhaseCApi);
  }

  if (pathname === '/api/pure-general-search') {
    applyLongRunningRouteTimeout(req, res);
    return handlePureApiRoute(req, res, pureGeneralSearchApi);
  }

  serveStatic(req, res, pathname);
});

server.timeout = GENERATE_ROUTE_TIMEOUT_MS;
if (typeof server.headersTimeout === 'number') {
  server.headersTimeout = GENERATE_ROUTE_TIMEOUT_MS + 5000;
}
if (typeof server.requestTimeout === 'number') {
  server.requestTimeout = GENERATE_ROUTE_TIMEOUT_MS;
}
server.keepAliveTimeout = GENERATE_ROUTE_TIMEOUT_MS + 10000;

server.listen(PORT, HOST, function () {
  console.log('Waldrof listening on http://' + HOST + ':' + PORT);
  console.log('[api/generate] route timeout:', GENERATE_ROUTE_TIMEOUT_MS, 'ms');
  console.log('Runtime: Render Node.js (server.js) — NOT Vercel serverless');
  console.log('API: GET /api/config | POST /api/generate | POST /api/pure-phase-c | POST /api/pure-general-search | POST /api/share-material | GET/PATCH/DELETE /api/community-materials | POST /api/community-upload | POST /api/community-ingest | POST /api/search-history | POST /api/subscription | POST /api/billing/checkout | POST /api/webhooks/stripe | POST /api/webhooks/payment-success | GET /api/cron/billing-report | GET/POST /api/cron/drive-catalog-sync | Health: GET /health');
  console.log('Local: http://localhost:' + PORT);
  console.log('[env] PERPLEXITY_API_KEY:', env.getPerplexityApiKey() ? 'set' : 'MISSING');
  console.log('[env] SUPABASE_URL:', env.getSupabaseUrl() ? 'set' : 'MISSING');
  console.log('[env] SUPABASE_SERVICE_ROLE_KEY:', env.getSupabaseServiceRoleKey() ? 'set' : (env.getSupabaseAnonKey() ? 'anon only' : 'MISSING'));
  console.log('[env] GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID:', process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID ? 'set' : 'MISSING');
  console.log('[cache] Supabase cached_results:', cacheDb.isSupabaseCacheEnabled() ? 'enabled' : 'local fallback only');
  knowledgeSeed.seedKnowledgeBaseIfEmptyAsync();
  if (process.env.DRIVE_CATALOG_SYNC_ON_BOOT === '1' && cacheDb.isDriveCatalogSyncConfigured()) {
    console.log('[drive-catalog-sync] scheduling background fetch on boot');
    cacheDb.backgroundFetchDriveCatalog();
  }
});

server.on('error', function (err) {
  console.error('Server failed to start:', err);
  process.exit(1);
});
