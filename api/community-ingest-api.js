/**
 * POST /api/community-ingest — index community uploads into community_knowledge_base.
 * Body: { gradeId, topic, title?, author?, filePath?, fileName?, fileType?, text?, materialId?, indexBundle? }
 * Re-index an entire topic folder: { gradeId, topic, indexBundle: true }
 * Auth: Authorization: Bearer <supabase_access_token> (preferred)
 */
const communityIngest = require('./community-ingest');
const env = require('./env');

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

async function verifySupabaseToken(token) {
  const url = env.getSupabaseUrl();
  const apiKey = env.getSupabaseAnonKey() || env.getSupabaseServiceRoleKey();
  if (!url || !token || !apiKey) return null;

  const res = await fetch(url + '/auth/v1/user', {
    headers: {
      Authorization: 'Bearer ' + token,
      apikey: apiKey,
    },
  });

  if (!res.ok) return null;
  const user = await res.json();
  if (!user || !user.id) return null;

  const meta = user.user_metadata || {};
  return {
    id: user.id,
    email: user.email || '',
    name: meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : ''),
  };
}

async function executeCommunityIngest(req) {
  if (!communityIngest.isIngestEnabled()) {
    const err = new Error('מאגר הקהילה אינו מוגדר בשרת (Supabase חסר)');
    err.statusCode = 503;
    throw err;
  }

  const body = parseRequestBody(req);
  if (!body || typeof body !== 'object') {
    const err = new Error('גוף הבקשה חסר');
    err.statusCode = 400;
    throw err;
  }

  const authHeader = String(req.headers.authorization || req.headers.Authorization || '');
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const verified = token ? await verifySupabaseToken(token) : null;

  const payload = Object.assign({}, body);
  if (verified && verified.email) {
    payload.contributorEmail = verified.email;
    if (!payload.author && !payload.contributorName) {
      payload.contributorName = verified.name || verified.email;
    }
  }

  return communityIngest.ingestCommunityUpload(payload);
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
    const data = await executeCommunityIngest(req);
    return sendJson(res, 200, { data: data });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn('[community-ingest]', status, err.message || err);
    return sendJson(res, status, { error: err.message || String(err) });
  }
}

module.exports = {
  legacyHandler,
  executeCommunityIngest,
};
