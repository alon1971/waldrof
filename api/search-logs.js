/**
 * Optional live-search audit log (search_logs.profile_id → profiles.id).
 * Failures never block /api/generate — table may be absent on older deployments.
 */
const env = require('./env');
const authContext = require('./auth-context');

const LOG_TABLE = 'search_logs';
const PROFILE_TABLE = 'profiles';

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServiceRoleKey() || env.getSupabaseAnonKey(),
  };
}

function isEnabled() {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && cfg.key);
}

function buildAuthHeaders(userToken) {
  const cfg = getSupabaseConfig();
  const apiKey = cfg.key;
  const bearer = env.getSupabaseServiceRoleKey() || userToken || apiKey;
  return {
    apikey: apiKey,
    Authorization: 'Bearer ' + bearer,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
}

async function supabaseRequest(pathSuffix, options, userToken) {
  const cfg = getSupabaseConfig();
  const opts = options || {};
  const headers = Object.assign({}, buildAuthHeaders(userToken), opts.headers || {});
  return fetch(cfg.url + pathSuffix, Object.assign({}, opts, { headers }));
}

function isMissingTableError(err) {
  const msg = String((err && err.message) || err || '');
  return /Could not find the table/i.test(msg)
    || /schema cache/i.test(msg)
    || /relation .* does not exist/i.test(msg);
}

function isForeignKeyError(err) {
  const msg = String((err && err.message) || err || '');
  return /foreign key constraint/i.test(msg)
    || /search_logs_profile_id_fkey/i.test(msg);
}

async function readResponse(res, label) {
  const text = await res.text();
  if (!res.ok) {
    let message = (text || '').trim() || (label || 'Supabase') + ' request failed';
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.message) message = String(parsed.message);
    } catch (e) { /* keep raw */ }
    const err = new Error(message);
    err.statusCode = res.status;
    throw err;
  }
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function profileExists(profileId, userToken) {
  const params = new URLSearchParams();
  params.set('select', 'id');
  params.set('id', 'eq.' + profileId);
  params.set('limit', '1');
  const res = await supabaseRequest(
    '/rest/v1/' + PROFILE_TABLE + '?' + params.toString(),
    { method: 'GET' },
    userToken
  );
  const rows = await readResponse(res, 'profiles read');
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureProfile(user, userToken) {
  if (!user || !authContext.isValidAuthUuid(user.id)) return false;

  if (await profileExists(user.id, userToken)) return true;

  const row = {
    id: user.id,
    email: user.email || null,
    display_name: user.displayName || user.name || null,
    updated_at: new Date().toISOString(),
  };

  const res = await supabaseRequest('/rest/v1/' + PROFILE_TABLE, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  }, userToken);

  if (res.ok) return true;

  const detail = await res.text();
  if (/duplicate key|23505/i.test(detail)) return true;
  if (/Could not find the table/i.test(detail)) return false;

  console.warn('[search_logs] ensureProfile failed:', res.status, detail.slice(0, 200));
  return false;
}

async function insertSearchLog(row, userToken) {
  const res = await supabaseRequest('/rest/v1/' + LOG_TABLE, {
    method: 'POST',
    body: JSON.stringify(row),
  }, userToken);
  await readResponse(res, 'search_logs insert');
}

/**
 * Record a billable live search — async, non-throwing.
 */
async function logLiveSearchFromRequest(req, body, meta) {
  if (!isEnabled()) return null;

  const userToken = authContext.extractBearerToken(req);
  let user;
  try {
    user = await authContext.resolveVerifiedUser(req, body);
  } catch (authErr) {
    console.warn('[search_logs] resolve user failed:', authErr.message || authErr);
    return null;
  }

  if (!user || !authContext.isValidAuthUuid(user.id)) {
    return null;
  }

  const m = meta || {};
  const row = {
    profile_id: user.id,
    phase: body && body.phase ? String(body.phase) : null,
    grade_id: body && (body.gradeId || body.currentGrade) ? String(body.gradeId || body.currentGrade) : null,
    topic: body && body.topic ? String(body.topic).trim() : null,
    query_text: body && (body.topic || body.archiveQuery || body.gradeLabel)
      ? String(body.topic || body.archiveQuery || body.gradeLabel).trim()
      : null,
    from_cache: Boolean(m.fromCache),
    created_at: new Date().toISOString(),
  };

  try {
    const hasProfile = await ensureProfile(user, userToken);
    if (!hasProfile) {
      console.warn('[search_logs] skipped — profile row missing for', user.id);
      return null;
    }
    await insertSearchLog(row, userToken);
    return { ok: true, profileId: user.id };
  } catch (err) {
    if (isMissingTableError(err)) {
      return null;
    }
    if (isForeignKeyError(err)) {
      console.warn('[search_logs] FK skipped — invalid profile_id:', user.id, err.message || err);
      return null;
    }
    console.warn('[search_logs] insert failed:', err.message || err);
    return null;
  }
}

function logLiveSearchFromRequestAsync(req, body, meta) {
  logLiveSearchFromRequest(req, body, meta).catch(function (err) {
    console.warn('[search_logs] async log failed:', err.message || err);
  });
}

module.exports = {
  logLiveSearchFromRequest,
  logLiveSearchFromRequestAsync,
  ensureProfile,
  isEnabled,
};
