/**
 * POST /api/curriculum-status — lightweight Supabase cache probe for phase_c curriculum.
 * No Perplexity calls; stitches completed chunk caches when all 3 are ready.
 */
const curriculumMigration = require('./curriculum-migration');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(statusCode).json(payload);
}

function parseRequestBody(req) {
  const rawBody = req.body;
  if (rawBody === undefined || rawBody === null) return null;
  if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return rawBody.trim() ? JSON.parse(rawBody) : null;
  if (Buffer.isBuffer(rawBody)) {
    const text = rawBody.toString('utf8');
    return text.trim() ? JSON.parse(text) : null;
  }
  return rawBody;
}

async function executeCurriculumStatus(req) {
  if (req.method !== 'POST') {
    const err = new Error('Method not allowed');
    err.statusCode = 405;
    throw err;
  }

  const body = parseRequestBody(req) || {};
  const status = await curriculumMigration.probeServeReadyPhaseCCurriculum(body);
  return status;
}

async function legacyHandler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const status = await executeCurriculumStatus(req);
    return sendJson(res, 200, { data: status });
  } catch (err) {
    const code = err.statusCode || 500;
    console.warn('[curriculum-status]', code, err.message || err);
    return sendJson(res, code, { error: err.message || String(err) });
  }
}

module.exports = {
  legacyHandler,
  executeCurriculumStatus,
};

/** Web Standard fetch handler — Vercel serverless. */
async function fetchHandler(request) {
  const headers = new Headers(corsHeaders);
  headers.set('Connection', 'keep-alive');
  headers.set('Cache-Control', 'no-store, max-age=0');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  }

  let body = null;
  try {
    const text = await request.text();
    body = text && text.trim() ? JSON.parse(text) : null;
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return Response.json({ error: message || 'Invalid JSON body' }, { status: 400, headers });
  }

  try {
    const status = await executeCurriculumStatus({
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body,
    });
    return Response.json({ data: status }, { status: 200, headers });
  } catch (err) {
    const code = err.statusCode || 500;
    console.warn('[curriculum-status]', code, err.message || err);
    return Response.json({ error: err.message || String(err) }, { status: code, headers });
  }
}

module.exports.fetch = fetchHandler;
