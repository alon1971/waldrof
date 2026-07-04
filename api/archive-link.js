/**
 * POST /api/archive-link — admin permanent link delete from cached_results.
 * Dedicated route so delete never shares the search-history "list" code path.
 */
const cacheDb = require('./cache');
const authContext = require('./auth-context');
const subscription = require('./subscription');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Email',
};

function setCors(res) {
  Object.keys(corsHeaders).forEach(function (key) {
    res.setHeader(key, corsHeaders[key]);
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

function headerEmail(req) {
  const headers = req && req.headers ? req.headers : {};
  return String(
    headers['x-user-email'] ||
    headers['X-User-Email'] ||
    headers['x-useremail'] ||
    ''
  ).trim().toLowerCase();
}

/**
 * Admin gate: JWT email, or explicit X-User-Email / body.email for pro admins.
 * Client admin UI can be identity-email based when the bearer token is briefly missing.
 */
async function resolveArchiveAdmin(req, body) {
  const verified = await authContext.resolveVerifiedUser(req, body);
  let email = verified && verified.email
    ? String(verified.email).trim().toLowerCase()
    : '';
  if (!email) email = headerEmail(req);
  if (!email && body) {
    email = String(body.email || body.userEmail || (body.teacherUser && body.teacherUser.email) || '')
      .trim()
      .toLowerCase();
  }
  if (!subscription.isProUserEmail(email)) {
    const err = new Error('פעולה זו מותרת למנהל הארכיון בלבד');
    err.statusCode = 403;
    throw err;
  }
  return verified || { email: email, id: null };
}

async function executeArchiveLink(req) {
  const body = parseRequestBody(req) || {};
  const action = String(body.action || 'delete').trim().toLowerCase();

  if (action !== 'delete' && action !== 'delete_archive_link') {
    const err = new Error('פעולה לא נתמכת: ' + action);
    err.statusCode = 400;
    throw err;
  }

  await resolveArchiveAdmin(req, body);

  const cacheKey = String(body.cacheKey || '').trim();
  const url = String(body.url || body.linkUrl || '').trim();
  if (!url) {
    const err = new Error('חסר קישור למחיקה');
    err.statusCode = 400;
    throw err;
  }

  console.log('[archive-link] delete request', {
    cacheKey: cacheKey ? cacheKey.slice(0, 16) : null,
    url: url.slice(0, 120),
    gradeId: body.gradeId || body.currentGrade || null,
    topic: body.topic ? String(body.topic).slice(0, 80) : null,
    phase: body.phase || null,
  });

  const result = await cacheDb.removeArchiveLinkFromCache(cacheKey, url, {
    gradeId: body.gradeId || body.currentGrade,
    gradeLabel: body.gradeLabel,
    topic: body.topic,
    phase: body.phase,
    query: body.query || body.topic,
    periodBlock: body.periodBlock,
    updatedPayload: body.updatedPayload,
  });

  if (!result || !result.removed) {
    const reason = result && result.reason ? result.reason : 'unknown';
    console.warn('[archive-link] delete failed', {
      reason: reason,
      cacheKey: result && result.cacheKey ? result.cacheKey.slice(0, 16) : cacheKey.slice(0, 16),
    });
    let message = 'הקישור לא נשמר במחיקה מהארכיון';
    if (reason === 'row_not_found') {
      message = 'לא ניתן למצוא את שורת הארכיון (cache_key) ולכן לא ניתן למחוק';
    } else if (reason === 'save_failed') {
      message = 'עדכון cached_results נכשל — הקישור לא נמחק מהמסד';
    } else if (reason === 'bad_url') {
      message = 'כתובת הקישור למחיקה אינה תקינה';
    }
    const err = new Error(message);
    err.statusCode = reason === 'bad_url' ? 400 : 404;
    err.reason = reason;
    err.cacheKey = result && result.cacheKey ? result.cacheKey : cacheKey;
    throw err;
  }

  console.log('[archive-link] delete ok', {
    cacheKey: result.cacheKey ? result.cacheKey.slice(0, 16) : null,
    url: url.slice(0, 120),
  });

  return {
    ok: true,
    action: 'delete_archive_link',
    cacheKey: result.cacheKey || cacheKey,
    url: url,
  };
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
    const data = await executeArchiveLink(req);
    return sendJson(res, 200, { ok: true, data: data });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn('[archive-link]', status, err.message || err);
    return sendJson(res, status, {
      ok: false,
      error: err.message || String(err),
      reason: err.reason || null,
      cacheKey: err.cacheKey || null,
    });
  }
}

module.exports = {
  legacyHandler,
  executeArchiveLink,
};
