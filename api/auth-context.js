/**
 * Shared Supabase auth user resolution for server APIs.
 * Prefer verified JWT UUIDs — never trust client-supplied mock IDs for FK-backed tables.
 */
const env = require('./env');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Accept any RFC-4122-shaped UUID for DB filters (incl. nil / local demo mock). */
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_DEMO_USER_KEY = 'email:demo.user@gmail.com';
const LOCAL_DEMO_EMAIL = 'demo.user@gmail.com';
const LOCAL_DEMO_MOCK_UUID = '00000000-0000-0000-0000-000000000000';

/** True only on local dev — never on Render/production hosts. */
function isLocalDevServer() {
  if (process.env.RENDER === 'true') return false;
  if (process.env.VERCEL === '1' || process.env.VERCEL_ENV) return false;
  if (process.env.RAILWAY_ENVIRONMENT) return false;
  return true;
}

/**
 * Strip synthetic `email:` user keys (e.g. "email:a@b.com" → "a@b.com").
 * Returns '' when the value is not an email-prefixed key.
 */
function extractEmailFromUserKey(userId) {
  const id = String(userId || '').trim();
  const match = /^email:(.+)$/i.exec(id);
  return match ? String(match[1] || '').trim().toLowerCase() : '';
}

/** True when value looks like a UUID Postgres will accept (not "email:…"). */
function isUuidShaped(value) {
  return UUID_SHAPE_RE.test(String(value || '').trim());
}

/**
 * Map a client/auth user id to a value safe for Supabase UUID columns.
 * - Real JWT UUIDs pass through.
 * - Local demo key maps to LOCAL_DEMO_MOCK_UUID.
 * - `email:…` / other non-UUID strings return null (callers must query by email).
 */
function mapUserIdForSupabaseQuery(userId, email) {
  const id = String(userId || '').trim();
  const em = String(email || '').trim().toLowerCase();
  const emailFromKey = extractEmailFromUserKey(id);

  if (isLocalDevServer()) {
    if (
      id === LOCAL_DEMO_USER_KEY
      || em === LOCAL_DEMO_USER_KEY
      || em === LOCAL_DEMO_EMAIL
      || emailFromKey === LOCAL_DEMO_EMAIL
    ) {
      return LOCAL_DEMO_MOCK_UUID;
    }
  }

  if (id && isUuidShaped(id) && !isMockUserId(id)) {
    return id;
  }

  // Never send "email:…" or free-text into uuid filters/columns.
  return null;
}

/** Map demo / non-UUID user id on a teacher/subscription object before Supabase reads/writes. */
function mapUserForSupabaseQuery(user) {
  if (!user || typeof user !== 'object') return user;
  const mappedId = mapUserIdForSupabaseQuery(user.id, user.email);
  const emailFromKey = extractEmailFromUserKey(user.id);
  const next = Object.assign({}, user);
  let changed = false;
  if (mappedId && mappedId !== user.id) {
    next.id = mappedId;
    changed = true;
  } else if (!mappedId && user.id) {
    // Drop synthetic non-UUID ids so callers fall back to email lookups.
    next.id = null;
    changed = true;
  }
  if (!next.email && emailFromKey) {
    next.email = emailFromKey;
    changed = true;
  }
  return changed ? next : user;
}

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
    const rawId = fromBody.id ? String(fromBody.id).trim() : null;
    if (opts.requireUuidForId && rawId && !isValidAuthUuid(rawId)) {
      return null;
    }
    const emailFromKey = extractEmailFromUserKey(rawId);
    const mappedId = mapUserIdForSupabaseQuery(rawId, fromBody.email || emailFromKey);
    return {
      id: mappedId || (rawId && isUuidShaped(rawId) ? rawId : null),
      email: String(fromBody.email || emailFromKey || '').trim(),
      name: fromBody.name || fromBody.displayName || fromBody.email || emailFromKey || '',
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
  isUuidShaped,
  isMockUserId,
  isLocalDevServer,
  extractEmailFromUserKey,
  mapUserIdForSupabaseQuery,
  mapUserForSupabaseQuery,
  LOCAL_DEMO_USER_KEY,
  LOCAL_DEMO_EMAIL,
  LOCAL_DEMO_MOCK_UUID,
  extractBearerToken,
  verifySupabaseToken,
  resolveVerifiedUser,
  resolveTeacherUser,
  sanitizeCachedUserFields,
  pickCachedUserId,
};
