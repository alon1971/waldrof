/**
 * GET/POST /api/search-history — list a teacher's cached lesson plans (phase=topic).
 */
const cacheDb = require('./cache');
const env = require('./env');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    serviceKey: env.getSupabaseServiceRoleKey(),
    anonKey: env.getSupabaseAnonKey(),
  };
}

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
  const cfg = getSupabaseConfig();
  if (!cfg.url || !token) return null;
  const apiKey = cfg.anonKey || cfg.serviceKey;
  if (!apiKey) return null;

  const res = await fetch(cfg.url + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: apiKey },
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

async function resolveTeacher(req, body) {
  const authHeader = String(req.headers.authorization || req.headers.Authorization || '');
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  const verified = await verifySupabaseToken(token);
  if (verified && (verified.id || verified.email)) return verified;

  const fromBody = body && body.teacherUser;
  if (fromBody && (fromBody.id || fromBody.email)) {
    return {
      id: fromBody.id || null,
      email: String(fromBody.email || '').trim(),
      name: fromBody.name || fromBody.displayName || fromBody.email || '',
    };
  }

  const err = new Error('יש להתחבר כדי לצפות בהיסטוריית החיפושים');
  err.statusCode = 401;
  throw err;
}

async function executeSearchHistory(req) {
  const body = req.method === 'GET' ? null : parseRequestBody(req);
  const teacher = await resolveTeacher(req, body);
  const action = body && body.action ? String(body.action).trim() : 'list';

  if (action === 'reload') {
    const cacheKey = String((body && body.cacheKey) || '').trim();
    if (!cacheKey) {
      const err = new Error('חסר מזהה חיפוש');
      err.statusCode = 400;
      throw err;
    }
    const item = await cacheDb.getTeacherLessonByCacheKey(teacher, cacheKey);
    if (!item) {
      const err = new Error('לא נמצאה תכנית שיעור שמורה עבור חיפוש זה');
      err.statusCode = 404;
      throw err;
    }
    return { ok: true, action: 'reload', item: item };
  }

  if (action === 'save_chat') {
    const cacheKey = String((body && body.cacheKey) || '').trim();
    if (!cacheKey) {
      const err = new Error('חסר מזהה חיפוש');
      err.statusCode = 400;
      throw err;
    }
    const saved = await cacheDb.saveTopicChatSession(teacher, cacheKey, {
      messages: body && body.messages,
      ragContext: body && body.ragContext,
      ragChunkIds: body && body.ragChunkIds,
      lessonSnapshot: body && body.lessonSnapshot,
    });
    if (!saved) {
      const err = new Error('לא ניתן לשמור את שיחת העוזר הפדגוגי');
      err.statusCode = 404;
      throw err;
    }
    return { ok: true, action: 'save_chat', cacheKey: cacheKey };
  }

  const limit = Math.min(
    Number((body && body.limit) || (req.query && req.query.limit)) || 20,
    40
  );

  const items = await cacheDb.listTeacherSearchHistory(teacher, { limit: limit });
  return {
    ok: true,
    action: 'list',
    count: items.length,
    items: items,
    teacher: { id: teacher.id, email: teacher.email },
  };
}

async function legacyHandler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const data = await executeSearchHistory(req);
    return sendJson(res, 200, { data: data });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn('[search-history]', status, err.message || err);
    return sendJson(res, status, { error: err.message || String(err) });
  }
}

module.exports = {
  legacyHandler,
  executeSearchHistory,
};

/** Web Standard fetch handler — Vercel serverless. */
async function fetchHandler(request) {
  const headers = new Headers(corsHeaders);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  }

  let body = null;
  if (request.method === 'POST') {
    try {
      const text = await request.text();
      body = text && text.trim() ? JSON.parse(text) : null;
    } catch (parseErr) {
      const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return Response.json({ error: message || 'Invalid JSON body' }, { status: 400, headers });
    }
  }

  try {
    const data = await executeSearchHistory({
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body,
      query: {},
    });
    return Response.json({ data: data }, { status: 200, headers });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn('[search-history]', status, err.message || err);
    return Response.json({ error: err.message || String(err) }, { status, headers });
  }
}

module.exports.fetch = fetchHandler;
