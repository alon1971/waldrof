/**
 * POST /api/subscription — tier limits, usage tracking, auto_renew.
 *
 * Production Supabase schema (verified 2026-06-18):
 *   user_id, plan_type, search_count_monthly, word_downloads_count,
 *   auto_renew, expires_at, created_at, updated_at
 */
const env = require('./env');
const cacheDb = require('./cache');

const TABLE = 'user_subscriptions';
const LOG_PREFIX = '[subscription]';

/** Columns that exist in production user_subscriptions — never send tier/trial_searches_used. */
const SUBSCRIPTION_WRITE_COLUMNS = [
  'user_id',
  'plan_type',
  'search_count_monthly',
  'word_downloads_count',
  'auto_renew',
  'expires_at',
  'updated_at',
];

const TIER_LIMITS = {
  trial: { lifetime: 10, monthly: null, wordDownloads: 10 },
  standard: { lifetime: null, monthly: 200, wordDownloads: null },
  pro: { lifetime: null, monthly: 1000, wordDownloads: null },
};

const LEGACY_TIER_MAP = {
  educator: 'standard',
  expert: 'pro',
};

/** Permanent PRO tier — bypass all search counters and rate limits. */
const PRO_USERS = ['alon1971@gmail.com'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Email',
};

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function extractUserEmail(req, body) {
  if (req && req.headers) {
    const fromHeader = req.headers['x-user-email'] || req.headers['X-User-Email'];
    if (fromHeader) return normalizeEmail(fromHeader);
  }
  if (!body || typeof body !== 'object') return '';
  if (body.userEmail) return normalizeEmail(body.userEmail);
  if (body.email) return normalizeEmail(body.email);
  if (body.teacherUser && body.teacherUser.email) return normalizeEmail(body.teacherUser.email);
  return '';
}

function isProUserEmail(email) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && PRO_USERS.indexOf(normalized) >= 0;
}

function buildProUserUsagePayload(email) {
  return {
    tier: 'pro',
    billingCycle: null,
    autoRenew: true,
    searchesUsed: 0,
    searchLimit: null,
    usagePeriod: 'monthly',
    usageMonth: currentMonthKey(),
    remaining: null,
    allowed: true,
    wordDownloadsUsed: 0,
    wordDownloadLimit: null,
    wordDownloadsRemaining: null,
    wordDownloadsAllowed: true,
    proUser: true,
    email: normalizeEmail(email),
  };
}

function logUsage(event, detail) {
  try {
    console.log(LOG_PREFIX, event, typeof detail === 'string' ? detail : JSON.stringify(detail));
  } catch (e) {
    console.log(LOG_PREFIX, event, detail);
  }
}

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    serviceKey: env.getSupabaseServiceRoleKey(),
    anonKey: env.getSupabaseAnonKey(),
  };
}

function isEnabled() {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && (cfg.serviceKey || cfg.anonKey));
}

function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function normalizeTier(tier) {
  const t = String(tier || 'trial').trim().toLowerCase();
  if (LEGACY_TIER_MAP[t]) return LEGACY_TIER_MAP[t];
  return TIER_LIMITS[t] ? t : 'trial';
}

function planTypeFromRow(row) {
  return normalizeTier((row && (row.plan_type || row.tier)) || 'trial');
}

function monthFromRow(row) {
  if (row && row.usage_month) return String(row.usage_month);
  if (row && row.updated_at) return String(row.updated_at).slice(0, 7);
  return currentMonthKey();
}

/** Read live search count from production or legacy column names. */
function readSearchCountFromRow(row, tier) {
  const plan = tier || planTypeFromRow(row);
  const raw = Number(
    row && (row.search_count_monthly != null ? row.search_count_monthly : row.trial_searches_used)
  ) || 0;
  if (plan === 'trial') return raw;
  const month = currentMonthKey();
  const rowMonth = monthFromRow(row);
  if (row && row.monthly_searches_used != null && row.usage_month) {
    return row.usage_month === month ? (Number(row.monthly_searches_used) || 0) : 0;
  }
  return rowMonth === month ? raw : 0;
}

function pickSubscriptionWriteFields(obj) {
  const out = {};
  SUBSCRIPTION_WRITE_COLUMNS.forEach(function (key) {
    if (obj && obj[key] !== undefined) out[key] = obj[key];
  });
  return out;
}

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (typeof res.json === 'function') {
    return res.status(statusCode).json(payload);
  }
  if (typeof res.send === 'function') {
    return res.status(statusCode).send(cacheDb.safeJsonStringify(payload));
  }
  throw new Error('sendJson: response adapter missing json/send');
}

function pickDefinedFields(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(function (key) {
    if (obj[key] !== undefined) out[key] = obj[key];
  });
  return out;
}

async function readSupabaseResponse(res, label) {
  const text = await res.text();
  if (!res.ok) {
    const detail = (text || '').trim();
    let message = detail || (label || 'Supabase') + ' request failed';
    if (detail) {
      try {
        const parsed = JSON.parse(detail);
        if (parsed && parsed.message) message = String(parsed.message);
      } catch (e) { /* keep raw detail */ }
    }
    const err = new Error(message);
    err.statusCode = res.status;
    err.supabaseBody = detail;
    throw err;
  }
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(
      (label || 'Supabase') + ' returned invalid JSON (' + msg + '): ' + trimmed.slice(0, 160)
    );
  }
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

function extractUserToken(req) {
  if (!req || !req.headers) return '';
  const raw = req.headers.authorization || req.headers.Authorization || '';
  return String(raw).replace(/^Bearer\s+/i, '').trim();
}

function buildSupabaseAuthHeaders(userToken) {
  const cfg = getSupabaseConfig();
  const apiKey = cfg.serviceKey || cfg.anonKey;
  if (!cfg.url || !apiKey) throw new Error('Supabase not configured');
  const bearer = cfg.serviceKey || userToken || apiKey;
  if (!cfg.serviceKey && !userToken) {
    throw new Error('Supabase subscription write requires SUPABASE_SERVICE_ROLE_KEY or a signed-in user token');
  }
  return {
    apikey: apiKey,
    Authorization: 'Bearer ' + bearer,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

async function supabaseRequest(pathSuffix, options, userToken) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !(cfg.serviceKey || cfg.anonKey)) throw new Error('Supabase not configured');

  const opts = options || {};
  const headers = Object.assign(
    {},
    buildSupabaseAuthHeaders(userToken),
    opts.headers || {}
  );
  const res = await fetch(cfg.url + pathSuffix, Object.assign({}, opts, { headers }));
  return res;
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
  let user;
  try {
    const text = await res.text();
    user = text && text.trim() ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  }
  if (!user || !user.id) return null;
  const meta = user.user_metadata || {};
  const tier = normalizeTier(meta.tier || meta.subscription_tier || meta.plan_type || 'trial');
  return {
    id: user.id,
    email: user.email || '',
    name: meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : ''),
    tier: tier,
  };
}

async function resolveUser(req, body) {
  const authHeader = String(req.headers.authorization || req.headers.Authorization || '');
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const verified = await verifySupabaseToken(token);
  if (verified && verified.id) return verified;

  const fromBody = body && body.teacherUser;
  if (fromBody && fromBody.id) {
    return {
      id: fromBody.id,
      email: normalizeEmail(fromBody.email),
      name: fromBody.name || fromBody.displayName || '',
      tier: normalizeTier(fromBody.tier || fromBody.plan_type || 'trial'),
    };
  }

  const email = extractUserEmail(req, body);
  if (email) {
    return {
      id: fromBody && fromBody.id ? String(fromBody.id).trim() : ('email:' + email),
      email: email,
      name: (fromBody && (fromBody.name || fromBody.displayName)) || email.split('@')[0],
      tier: isProUserEmail(email) ? 'pro' : normalizeTier((fromBody && fromBody.tier) || 'trial'),
    };
  }

  const err = new Error('יש להתחבר כדי לנהל מנוי');
  err.statusCode = 401;
  throw err;
}

function buildUsagePayload(row) {
  const tier = planTypeFromRow(row);
  const limits = TIER_LIMITS[tier];
  const month = currentMonthKey();
  const used = readSearchCountFromRow(row, tier);
  let limit = null;
  let period = 'lifetime';

  if (tier === 'trial') {
    limit = limits.lifetime;
    period = 'lifetime';
  } else {
    limit = limits.monthly;
    period = 'monthly';
  }

  const wordDownloadsUsed = Number(row.word_downloads_count) || 0;
  const wordDownloadLimit = limits.wordDownloads;
  const wordDownloadsAllowed = wordDownloadLimit == null
    ? true
    : wordDownloadsUsed < wordDownloadLimit;

  return {
    tier: tier,
    billingCycle: null,
    autoRenew: row.auto_renew !== false,
    searchesUsed: used,
    searchLimit: limit,
    usagePeriod: period,
    usageMonth: monthFromRow(row) || month,
    remaining: limit === null ? null : Math.max(0, limit - used),
    allowed: limit === null ? true : used < limit,
    wordDownloadsUsed: wordDownloadsUsed,
    wordDownloadLimit: wordDownloadLimit,
    wordDownloadsRemaining: wordDownloadLimit == null
      ? null
      : Math.max(0, wordDownloadLimit - wordDownloadsUsed),
    wordDownloadsAllowed: wordDownloadsAllowed,
  };
}

async function fetchSubscriptionRow(userId, userToken) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('user_id', 'eq.' + userId);
  params.set('limit', '1');

  logUsage('fetch:before', { user_id: userId });

  const res = await supabaseRequest(
    '/rest/v1/' + TABLE + '?' + params.toString(),
    { method: 'GET' },
    userToken
  );
  const rows = await readSupabaseResponse(res, 'subscription read');
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;

  logUsage('fetch:after', {
    user_id: userId,
    found: Boolean(row),
    search_count_monthly: row ? row.search_count_monthly : null,
    plan_type: row ? row.plan_type : null,
  });

  return row;
}

function subscriptionRowFromPatch(user, patch, existing) {
  const prev = existing || {};
  const tier = normalizeTier((patch && patch.plan_type) || (patch && patch.tier) || prev.plan_type || prev.tier || user.tier || 'trial');
  const prevCount = readSearchCountFromRow(prev, tier);
  const nextCount = (patch && patch.search_count_monthly != null)
    ? Number(patch.search_count_monthly)
    : prevCount;

  return pickSubscriptionWriteFields({
    user_id: user.id,
    plan_type: tier,
    search_count_monthly: nextCount,
    word_downloads_count: (patch && patch.word_downloads_count) != null
      ? patch.word_downloads_count
      : (Number(prev.word_downloads_count) || 0),
    auto_renew: (patch && patch.auto_renew) != null
      ? patch.auto_renew
      : (prev.auto_renew !== false),
    expires_at: (patch && patch.expires_at !== undefined) ? patch.expires_at : (prev.expires_at || null),
    updated_at: new Date().toISOString(),
  });
}

async function insertSubscriptionRow(user, patch, userToken) {
  const row = subscriptionRowFromPatch(user, Object.assign({
    search_count_monthly: 0,
    word_downloads_count: 0,
    auto_renew: true,
  }, patch || {}), null);

  logUsage('insert:before', { user_id: user.id, row: row });

  const res = await supabaseRequest('/rest/v1/' + TABLE, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  }, userToken);

  const rows = await readSupabaseResponse(res, 'subscription insert');
  const inserted = Array.isArray(rows) && rows.length ? rows[0] : row;

  logUsage('insert:after', {
    user_id: user.id,
    status: 'ok',
    rows_returned: Array.isArray(rows) ? rows.length : 0,
    search_count_monthly: inserted.search_count_monthly,
  });

  return inserted;
}

async function updateSubscriptionRow(userId, patch, existing, user, userToken) {
  const params = new URLSearchParams();
  params.set('user_id', 'eq.' + userId);

  const writePatch = pickSubscriptionWriteFields(
    Object.assign({}, patch, {
      plan_type: patch.plan_type || patch.tier,
      updated_at: new Date().toISOString(),
    })
  );
  delete writePatch.user_id;

  logUsage('update:before', {
    user_id: userId,
    patch: writePatch,
    before_count: existing ? readSearchCountFromRow(existing) : null,
  });

  const res = await supabaseRequest('/rest/v1/' + TABLE + '?' + params.toString(), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(writePatch),
  }, userToken);

  const rows = await readSupabaseResponse(res, 'subscription update');
  const rowsAffected = Array.isArray(rows) ? rows.length : 0;

  logUsage('update:after', {
    user_id: userId,
    rows_affected: rowsAffected,
    response: rows,
  });

  if (rowsAffected > 0) return rows[0];

  if (existing) {
    const merged = subscriptionRowFromPatch(
      user || { id: userId, tier: planTypeFromRow(existing) },
      patch,
      existing
    );
    logUsage('update:upsert_fallback', { user_id: userId, merged: merged });

    const upsertRes = await supabaseRequest('/rest/v1/' + TABLE + '?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(merged),
    }, userToken);
    const upsertRows = await readSupabaseResponse(upsertRes, 'subscription upsert');
    logUsage('update:upsert_after', {
      user_id: userId,
      rows_affected: Array.isArray(upsertRows) ? upsertRows.length : 0,
      response: upsertRows,
    });
    if (Array.isArray(upsertRows) && upsertRows.length) return upsertRows[0];
    return merged;
  }

  const refetched = await fetchSubscriptionRow(userId, userToken);
  if (refetched) return refetched;
  return subscriptionRowFromPatch(user || { id: userId, tier: 'trial' }, patch, existing);
}

async function upsertSubscriptionRow(user, patch, userToken) {
  const existing = await fetchSubscriptionRow(user.id, userToken);
  if (existing) {
    return updateSubscriptionRow(user.id, patch, existing, user, userToken);
  }
  return insertSubscriptionRow(user, patch, userToken);
}

async function ensureSubscription(user, userToken) {
  let row = await fetchSubscriptionRow(user.id, userToken);
  if (!row) {
    logUsage('ensure:create_row', { user_id: user.id });
    row = await insertSubscriptionRow(user, {
      plan_type: normalizeTier(user.tier || 'trial'),
      search_count_monthly: 0,
      word_downloads_count: 0,
      auto_renew: true,
    }, userToken);
  }
  return row;
}

async function getStatus(user, userToken) {
  const row = await ensureSubscription(user, userToken);
  const usage = buildUsagePayload(row);
  return {
    ok: true,
    action: 'status',
    subscription: {
      tier: usage.tier,
      billingCycle: usage.billingCycle,
      autoRenew: usage.autoRenew,
    },
    usage: usage,
  };
}

async function recordSearch(user, userToken) {
  const email = normalizeEmail(user && user.email);
  if (isProUserEmail(email)) {
    logUsage('record_search:pro_bypass', { email: email });
    return { ok: true, action: 'record_search', usage: buildProUserUsagePayload(email), proUser: true };
  }

  logUsage('record_search:start', {
    user_id: user && user.id,
    has_token: Boolean(userToken),
    service_role: Boolean(getSupabaseConfig().serviceKey),
  });

  const row = await ensureSubscription(user, userToken);
  const usageBefore = buildUsagePayload(row);

  logUsage('record_search:before_increment', {
    user_id: user.id,
    searchesUsed_before: usageBefore.searchesUsed,
    search_count_monthly_raw: row.search_count_monthly,
    plan_type: row.plan_type,
  });

  if (!usageBefore.allowed) {
    const err = new Error('חרגתם ממכסת החיפושים — שדרגו את המסלול');
    err.statusCode = 429;
    err.code = 'RATE_LIMIT';
    err.usage = usageBefore;
    throw err;
  }

  const tier = planTypeFromRow(row);
  const month = currentMonthKey();
  const currentCount = readSearchCountFromRow(row, tier);
  let nextCount = currentCount + 1;

  if (tier !== 'trial') {
    const rowMonth = monthFromRow(row);
    if (rowMonth !== month) {
      nextCount = 1;
    }
  }

  const patch = {
    plan_type: tier,
    search_count_monthly: nextCount,
  };

  const updated = await updateSubscriptionRow(user.id, patch, row, user, userToken);
  const usage = buildUsagePayload(updated);

  logUsage('record_search:after_increment', {
    user_id: user.id,
    searchesUsed_after: usage.searchesUsed,
    search_count_monthly_raw: updated.search_count_monthly,
    rows_match: usage.searchesUsed === nextCount,
  });

  if (usage.searchesUsed <= usageBefore.searchesUsed) {
    const err = new Error('לא ניתן לשמור את ספירת החיפושים — נסו שוב או פנו לתמיכה');
    err.statusCode = 500;
    err.code = 'USAGE_PERSIST_FAILED';
    err.usage = usage;
    logUsage('record_search:FAILED', {
      user_id: user.id,
      before: usageBefore.searchesUsed,
      after: usage.searchesUsed,
      patch: patch,
    });
    throw err;
  }

  logUsage('record_search:OK', { user_id: user.id, searchesUsed: usage.searchesUsed });
  return { ok: true, action: 'record_search', usage: usage };
}

async function recordWordDownload(user, userToken) {
  const email = normalizeEmail(user && user.email);
  if (isProUserEmail(email)) {
    return {
      ok: true,
      action: 'record_word_download',
      usage: buildProUserUsagePayload(email),
      unlimited: true,
      proUser: true,
    };
  }

  const row = await ensureSubscription(user, userToken);
  const tier = planTypeFromRow(row);

  if (tier !== 'trial') {
    return {
      ok: true,
      action: 'record_word_download',
      usage: buildUsagePayload(row),
      unlimited: true,
    };
  }

  const usageBefore = buildUsagePayload(row);
  if (!usageBefore.wordDownloadsAllowed) {
    const err = new Error('הגעת למגבלת ההורדות במסלול החינמי. כדי להמשיך להוריד קבצים מעוצבים, יש לשדרג למסלול סטנדרט או פרו');
    err.statusCode = 429;
    err.code = 'WORD_DOWNLOAD_LIMIT';
    err.usage = usageBefore;
    throw err;
  }

  const updated = await updateSubscriptionRow(user.id, {
    word_downloads_count: (Number(row.word_downloads_count) || 0) + 1,
  }, row, user, userToken);
  return {
    ok: true,
    action: 'record_word_download',
    usage: buildUsagePayload(updated),
  };
}

async function cancelRenewal(user, userToken) {
  const row = await ensureSubscription(user, userToken);
  if (planTypeFromRow(row) === 'trial') {
    const err = new Error('אין מנוי בתשלום לביטול');
    err.statusCode = 400;
    throw err;
  }
  const updated = await updateSubscriptionRow(user.id, { auto_renew: false }, row, user, userToken);
  return {
    ok: true,
    action: 'cancel_renewal',
    subscription: {
      tier: planTypeFromRow(updated),
      billingCycle: null,
      autoRenew: false,
    },
  };
}

async function executeSubscription(req) {
  const body = req.method === 'GET' ? null : parseRequestBody(req);
  const email = extractUserEmail(req, body);
  const action = body && body.action ? String(body.action).trim() : 'status';

  if (isProUserEmail(email)) {
    const usage = buildProUserUsagePayload(email);
    if (action === 'record_search' || action === 'record_word_download') {
      return { ok: true, action: action, usage: usage, proUser: true };
    }
    return {
      ok: true,
      action: action,
      subscription: { tier: 'pro', billingCycle: null, autoRenew: true },
      usage: usage,
      proUser: true,
    };
  }

  const userToken = extractUserToken(req);
  const user = await resolveUser(req, body);

  if (!isEnabled()) {
    if (action === 'record_search' || action === 'record_word_download') {
      return { ok: true, action: action, fallback: true };
    }
    return {
      ok: true,
      action: action,
      fallback: true,
      usage: {
        tier: user.tier || 'trial',
        searchesUsed: 0,
        searchLimit: TIER_LIMITS.trial.lifetime,
        usagePeriod: 'lifetime',
        remaining: TIER_LIMITS.trial.lifetime,
        allowed: true,
        autoRenew: true,
        wordDownloadsUsed: 0,
        wordDownloadLimit: TIER_LIMITS.trial.wordDownloads,
        wordDownloadsAllowed: true,
      },
    };
  }

  if (action === 'record_search') return recordSearch(user, userToken);
  if (action === 'record_word_download') return recordWordDownload(user, userToken);
  if (action === 'cancel_renewal') return cancelRenewal(user, userToken);
  return getStatus(user, userToken);
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
    const data = await executeSubscription(req);
    return sendJson(res, 200, { data: data });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn(LOG_PREFIX, status, err.message || err);
    return sendJson(res, status, {
      error: err.message || String(err),
      code: err.code || undefined,
      usage: err.usage || undefined,
    });
  }
}

async function recordLiveSearchFromRequest(req, explicitUser) {
  const body = req && req.body;
  const email = extractUserEmail(req, body);
  if (isProUserEmail(email)) {
    logUsage('recordLiveSearch:pro_bypass', { email: email });
    return { ok: true, action: 'record_search', usage: buildProUserUsagePayload(email), proUser: true };
  }
  const userToken = extractUserToken(req);
  const user = explicitUser && explicitUser.id
    ? explicitUser
    : await resolveUser(req, body);
  if (!isEnabled()) {
    console.warn(LOG_PREFIX, 'recordLiveSearch skipped — Supabase not configured');
    return null;
  }
  logUsage('recordLiveSearchFromRequest', {
    user_id: user.id,
    has_auth_header: Boolean(userToken),
    explicit_user: Boolean(explicitUser && explicitUser.id),
  });
  return recordSearch(user, userToken);
}

async function assertSearchAllowedFromRequest(req) {
  const body = req && req.body;
  const email = extractUserEmail(req, body);
  if (isProUserEmail(email)) {
    return { allowed: true, proUser: true, usage: buildProUserUsagePayload(email) };
  }
  if (!isEnabled()) return { allowed: true, skipped: true };
  const userToken = extractUserToken(req);
  let user;
  try {
    user = await resolveUser(req, body);
  } catch (authErr) {
    if (authErr && authErr.statusCode === 401) return { allowed: true, unauthenticated: true };
    throw authErr;
  }
  const row = await ensureSubscription(user, userToken);
  const usage = buildUsagePayload(row);
  if (!usage.allowed) {
    const err = new Error('חרגתם ממכסת החיפושים — שדרגו את המסלול');
    err.statusCode = 429;
    err.code = 'RATE_LIMIT';
    err.usage = usage;
    throw err;
  }
  return { allowed: true, usage: usage };
}

module.exports = {
  legacyHandler,
  executeSubscription,
  recordLiveSearchFromRequest,
  assertSearchAllowedFromRequest,
  recordSearch,
  resolveUser,
  extractUserToken,
  extractUserEmail,
  isProUserEmail,
  buildProUserUsagePayload,
  isEnabled,
  PRO_USERS,
  TIER_LIMITS,
  normalizeTier,
};

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
    const data = await executeSubscription({
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body,
    });
    return Response.json({ data: data }, { status: 200, headers });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn(LOG_PREFIX, status, err.message || err);
    return Response.json({
      error: err.message || String(err),
      code: err.code || undefined,
      usage: err.usage || undefined,
    }, { status, headers });
  }
}

module.exports.fetch = fetchHandler;
