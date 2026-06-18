/**
 * Shared Supabase auth user resolution for server APIs.
 * Prefer verified JWT UUIDs — never trust client-supplied mock IDs for FK-backed tables.
 */
const env = require('./env');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidAuthUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

function extractBearerToken(req) {
  if (!req || !req.headers) return '';
  const raw = req.headers.authorization || req.headers.Authorization || '';
  return String(raw).replace(/^Bearer\s+/i, '').trim();
}

function isMockUserId(id) {
  const value = String(id || '').trim();
  return !value || value.indexOf('mock_') === 0 || value.indexOf('mock-') === 0;
}

async function verifySupabaseToken(token) {
  const tokenValue = String(token || '').trim();
  if (!tokenValue) return null;

  const url = env.getSupabaseUrl();
  const apiKey = env.getSupabaseAnonKey() || env.getSupabaseServiceRoleKey();
  if (!url || !apiKey) return null;

  const res = await fetch(url + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + tokenValue, apikey: apiKey },
  });
  if (!res.ok) return null;

  let user;
  try {
    const text = await res.text();
    user = text && text.trim() ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  }
  if (!user || !user.id || !isValidAuthUuid(user.id)) return null;

  const meta = user.user_metadata || {};
  return {
    id: user.id,
    email: user.email || '',
    name: meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : ''),
    displayName: meta.full_name || meta.name || '',
    verified: true,
  };
}

/**
 * Resolve teacher for DB writes (profiles, search_logs, cached_results.user_id).
 * Returns verified JWT user only — never mock / client-only IDs.
 */
async function resolveVerifiedUser(req, body) {
  const token = extractBearerToken(req);
  const verified = await verifySupabaseToken(token);
  if (verified) return verified;

  const fromBody = body && body.teacherUser;
  if (fromBody && fromBody.id && isValidAuthUuid(fromBody.id) && !isMockUserId(fromBody.id)) {
    return {
      id: String(fromBody.id).trim(),
      email: String(fromBody.email || '').trim(),
      name: fromBody.name || fromBody.displayName || '',
      displayName: fromBody.displayName || fromBody.name || '',
      verified: false,
    };
  }
  return null;
}

/**
 * Resolve teacher for UI/history — allows body fallback by email when unauthenticated flows need it.
 */
async function resolveTeacherUser(req, body, options) {
  const opts = options || {};
  const verified = await resolveVerifiedUser(req, body);
  if (verified) return verified;

  const fromBody = body && body.teacherUser;
  if (fromBody && (fromBody.id || fromBody.email)) {
    const id = fromBody.id ? String(fromBody.id).trim() : null;
    if (opts.requireUuidForId && id && !isValidAuthUuid(id)) {
      return null;
    }
    return {
      id: id,
      email: String(fromBody.email || '').trim(),
      name: fromBody.name || fromBody.displayName || fromBody.email || '',
      displayName: fromBody.displayName || fromBody.name || '',
      verified: false,
    };
  }
  return null;
}

/** Strip invalid user ids before cached_results upsert (avoids search_logs FK triggers). */
function sanitizeCachedUserFields(body, verifiedUser) {
  if (!body || typeof body !== 'object') return body;
  const user = verifiedUser || null;
  if (user && isValidAuthUuid(user.id)) {
    body.userId = user.id;
    body.userEmail = user.email || body.userEmail || '';
    body.teacherUser = Object.assign({}, body.teacherUser || {}, {
      id: user.id,
      email: user.email || '',
      name: user.name || user.displayName || '',
      displayName: user.displayName || user.name || '',
    });
    return body;
  }
  delete body.userId;
  if (body.teacherUser && typeof body.teacherUser === 'object') {
    const next = Object.assign({}, body.teacherUser);
    delete next.id;
    body.teacherUser = next;
  }
  return body;
}

function pickCachedUserId(body) {
  const candidates = [
    body && body.userId,
    body && body.teacherUser && body.teacherUser.id,
  ];
  for (let i = 0; i < candidates.length; i++) {
    const id = String(candidates[i] || '').trim();
    if (isValidAuthUuid(id) && !isMockUserId(id)) return id;
  }
  return null;
}

module.exports = {
  isValidAuthUuid,
  isMockUserId,
  extractBearerToken,
  verifySupabaseToken,
  resolveVerifiedUser,
  resolveTeacherUser,
  sanitizeCachedUserFields,
  pickCachedUserId,
};
