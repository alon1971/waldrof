/**
 * GET /api/config — public runtime configuration for the browser (no secrets).
 */
const env = require('./env');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store, max-age=0',
};

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(statusCode).json(payload);
}

function getPublicConfigResponse() {
  const config = env.getPublicClientConfig();
  return {
    ok: true,
    data: config,
    meta: {
      cloudConfigured: Boolean(config.supabaseUrl && config.supabaseAnonKey),
    },
  };
}

async function getPublicConfigResponseAsync() {
  return getPublicConfigResponse();
}

async function legacyHandler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  return sendJson(res, 200, await getPublicConfigResponseAsync());
}

async function fetchHandler(request) {
  const headers = new Headers(corsHeaders);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  }

  return Response.json(await getPublicConfigResponseAsync(), { status: 200, headers });
}

module.exports = {
  legacyHandler,
  fetch: fetchHandler,
  getPublicConfigResponse,
  getPublicConfigResponseAsync,
};
