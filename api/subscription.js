/**
 * POST /api/subscription — tier limits, usage tracking, auto_renew.
 */
const env = require('./env');
const cacheDb = require('./cache');

const TABLE = 'user_subscriptions';

const TIER_LIMITS = {
  trial: { lifetime: 10, monthly: null, wordDownloads: 10 },
  standard: { lifetime: null, monthly: 200, wordDownloads: null },
  pro: { lifetime: null, monthly: 1000, wordDownloads: null },
};

const LEGACY_TIER_MAP = {
  educator: 'standard',
  expert: 'pro',
};

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

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(statusCode).send(cacheDb.safeJsonStringify(payload));
}

function pickDefinedFields(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(function (key) {
    if (obj[key] !== undefined) out[key] = obj[key];
  });
  return out;
}

/** Read Supabase REST bodies safely — never call res.json() on empty/non-JSON responses. */
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
    throw new Error(message);
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

/** Service role bypasses RLS; otherwise use the signed-in teacher JWT for RLS policies. */
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

  const res = await fetch(cfg.url + pathSuffix, Object.assign({
    headers: Object.assign(
      buildSupabaseAuthHeaders(userToken),
      (options && options.headers) || {}
    ),
  }, options || {}));

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
  const tier = normalizeTier(meta.tier || meta.subscription_tier || 'trial');
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
      email: String(fromBody.email || '').trim(),
      name: fromBody.name || fromBody.displayName || '',
      tier: normalizeTier(fromBody.tier || 'trial'),
    };
  }

  const err = new Error('יש להתחבר כדי לנהל מנוי');
  err.statusCode = 401;
  throw err;
}

function buildUsagePayload(row) {
  const tier = normalizeTier(row.tier);
  const limits = TIER_LIMITS[tier];
  const month = currentMonthKey();
  let used = 0;
  let limit = null;
  let period = 'lifetime';

  if (tier === 'trial') {
    used = Number(row.trial_searches_used) || 0;
    limit = limits.lifetime;
    period = 'lifetime';
  } else {
    const usageMonth = row.usage_month || month;
    used = usageMonth === month ? (Number(row.monthly_searches_used) || 0) : 0;
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
    billingCycle: row.billing_cycle || null,
    autoRenew: row.auto_renew !== false,
    searchesUsed: used,
    searchLimit: limit,
    usagePeriod: period,
    usageMonth: row.usage_month || month,
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

  const res = await supabaseRequest(
    '/rest/v1/' + TABLE + '?' + params.toString(),
    { method: 'GET' },
    userToken
  );
  const rows = await readSupabaseResponse(res, 'subscription read');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function subscriptionRowFromPatch(user, patch, existing) {
  const prev = existing || {};
  const now = new Date().toISOString();
  return {
    user_id: user.id,
    user_email: user.email || prev.user_email || '',
    tier: normalizeTier((patch && patch.tier) || prev.tier || user.tier || 'trial'),
    billing_cycle: (patch && patch.billing_cycle) != null
      ? patch.billing_cycle
      : (prev.billing_cycle != null ? prev.billing_cycle : null),
    trial_searches_used: (patch && patch.trial_searches_used) != null
      ? patch.trial_searches_used
      : (Number(prev.trial_searches_used) || 0),
    word_downloads_count: (patch && patch.word_downloads_count) != null
      ? patch.word_downloads_count
      : (Number(prev.word_downloads_count) || 0),
    monthly_searches_used: (patch && patch.monthly_searches_used) != null
      ? patch.monthly_searches_used
      : (Number(prev.monthly_searches_used) || 0),
    usage_month: (patch && patch.usage_month) || prev.usage_month || currentMonthKey(),
    auto_renew: (patch && patch.auto_renew) != null
      ? patch.auto_renew
      : (prev.auto_renew !== false),
    updated_at: now,
  };
}

async function insertSubscriptionRow(user, patch, userToken) {
  const now = new Date().toISOString();
  const row = subscriptionRowFromPatch(user, patch, null);
  row.created_at = now;

  const res = await supabaseRequest('/rest/v1/' + TABLE, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  }, userToken);

  const rows = await readSupabaseResponse(res, 'subscription insert');
  return Array.isArray(rows) && rows.length ? rows[0] : row;
}

async function updateSubscriptionRow(userId, patch, existing, user, userToken) {
  const params = new URLSearchParams();
  params.set('user_id', 'eq.' + userId);
  const body = pickDefinedFields(Object.assign({}, patch, { updated_at: new Date().toISOString() }));
  delete body.user_id;
  delete body.created_at;

  const res = await supabaseRequest('/rest/v1/' + TABLE + '?' + params.toString(), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body),
  }, userToken);

  const rows = await readSupabaseResponse(res, 'subscription update');
  if (Array.isArray(rows) && rows.length) return rows[0];
  const baseUser = user || { id: userId, email: existing && existing.user_email };
  return subscriptionRowFromPatch(baseUser, patch, existing);
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
    row = await upsertSubscriptionRow(user, {
      tier: user.tier || 'trial',
      trial_searches_used: 0,
      word_downloads_count: 0,
      monthly_searches_used: 0,
      usage_month: currentMonthKey(),
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
  const row = await ensureSubscription(user, userToken);
  const usageBefore = buildUsagePayload(row);
  if (!usageBefore.allowed) {
    const err = new Error('חרגתם ממכסת החיפושים — שדרגו את המסלול');
    err.statusCode = 429;
    err.code = 'RATE_LIMIT';
    err.usage = usageBefore;
    throw err;
  }

  const tier = normalizeTier(row.tier);
  const month = currentMonthKey();
  const patch = { tier: tier };

  if (tier === 'trial') {
    patch.trial_searches_used = (Number(row.trial_searches_used) || 0) + 1;
  } else {
    const sameMonth = row.usage_month === month;
    patch.usage_month = month;
    patch.monthly_searches_used = sameMonth
      ? (Number(row.monthly_searches_used) || 0) + 1
      : 1;
  }

  const updated = await updateSubscriptionRow(user.id, patch, row, user, userToken);
  const usage = buildUsagePayload(updated);
  console.log('[subscription] record_search user=%s searchesUsed=%s', user.id, usage.searchesUsed);
  return { ok: true, action: 'record_search', usage: usage };
}

async function recordWordDownload(user, userToken) {
  const row = await ensureSubscription(user, userToken);
  const tier = normalizeTier(row.tier);

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
  if (normalizeTier(row.tier) === 'trial') {
    const err = new Error('אין מנוי בתשלום לביטול');
    err.statusCode = 400;
    throw err;
  }
  const updated = await updateSubscriptionRow(user.id, { auto_renew: false }, row, user, userToken);
  return {
    ok: true,
    action: 'cancel_renewal',
    subscription: {
      tier: normalizeTier(updated.tier),
      billingCycle: updated.billing_cycle || null,
      autoRenew: false,
    },
  };
}

async function executeSubscription(req) {
  const body = req.method === 'GET' ? null : parseRequestBody(req);
  const userToken = extractUserToken(req);
  const user = await resolveUser(req, body);
  const action = body && body.action ? String(body.action).trim() : 'status';

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
    console.warn('[subscription]', status, err.message || err);
    return sendJson(res, status, {
      error: err.message || String(err),
      code: err.code || undefined,
      usage: err.usage || undefined,
    });
  }
}

/** Record one live search from an HTTP request (e.g. after /api/generate succeeds). */
async function recordLiveSearchFromRequest(req) {
  const body = req && req.body;
  const userToken = extractUserToken(req);
  const user = await resolveUser(req, body);
  if (!isEnabled()) {
    console.warn('[subscription] recordLiveSearch skipped — Supabase not configured');
    return null;
  }
  return recordSearch(user, userToken);
}

module.exports = {
  legacyHandler,
  executeSubscription,
  recordLiveSearchFromRequest,
  recordSearch,
  resolveUser,
  TIER_LIMITS,
  normalizeTier,
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
    const data = await executeSubscription({
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body,
    });
    return Response.json({ data: data }, { status: 200, headers });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn('[subscription]', status, err.message || err);
    return Response.json({
      error: err.message || String(err),
      code: err.code || undefined,
      usage: err.usage || undefined,
    }, { status, headers });
  }
}

module.exports.fetch = fetchHandler;
