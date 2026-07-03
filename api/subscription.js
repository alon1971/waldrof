/**
 * POST /api/subscription — tier limits, usage tracking, auto_renew.
 *
 * Production Supabase schema (verified 2026-06-18):
 *   user_id, plan_type, search_count_monthly, word_downloads_count,
 *   auto_renew, expires_at, created_at, updated_at
 */
const env = require('./env');
const cacheDb = require('./cache');
const authContext = require('./auth-context');
const { TRIAL_LIFETIME_SEARCH_LIMIT, PRO_MONTHLY_SEARCH_LIMIT } = require('./tier-limits');

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
  'user_email',
  'user_full_name',
  'user_phone',
  'updated_at',
];

const TIER_LIMITS = {
  trial: { lifetime: TRIAL_LIFETIME_SEARCH_LIMIT, monthly: null, wordDownloads: 17, wordDownloadsMonthly: true },
  standard: { lifetime: null, monthly: 300, wordDownloads: null },
  pro: { lifetime: null, monthly: PRO_MONTHLY_SEARCH_LIMIT, wordDownloads: null },
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

function extractPhoneFromAuthMeta(meta, user) {
  const m = meta || {};
  const candidates = [
    m.phone,
    m.phone_number,
    m.mobile,
    user && user.phone,
  ];
  for (let i = 0; i < candidates.length; i++) {
    const value = String(candidates[i] || '').trim();
    if (value) return value;
  }
  return '';
}

function buildSubscriptionContactPatch(user, patch) {
  const u = user || {};
  const p = patch || {};
  const email = normalizeEmail(p.user_email || p.email || u.email);
  const fullName = String(
    p.user_full_name || p.fullName || p.name || p.displayName || u.fullName || u.name || ''
  ).trim();
  const phone = String(p.user_phone || p.phone || u.phone || u.user_phone || '').trim();
  const out = {};
  if (email) out.user_email = email;
  if (fullName) out.user_full_name = fullName;
  if (phone) out.user_phone = phone;
  return out;
}

function shouldRefreshSubscriptionContact(row, contactPatch) {
  if (!row || !contactPatch) return false;
  if (contactPatch.user_email && !String(row.user_email || '').trim()) return true;
  if (contactPatch.user_full_name && !String(row.user_full_name || '').trim()) return true;
  if (contactPatch.user_phone && !String(row.user_phone || '').trim()) return true;
  if (contactPatch.user_email && normalizeEmail(row.user_email) !== contactPatch.user_email) return true;
  if (contactPatch.user_full_name && String(row.user_full_name || '').trim() !== contactPatch.user_full_name) return true;
  if (contactPatch.user_phone && String(row.user_phone || '').trim() !== contactPatch.user_phone) return true;
  return false;
}

async function enrichUserFromProfile(user, userToken) {
  if (!user || !user.id) return user;
  try {
    const params = new URLSearchParams();
    params.set('select', 'email,display_name');
    params.set('id', 'eq.' + mapSupabaseUserId(user.id, user.email));
    params.set('limit', '1');
    const res = await supabaseRequest(
      '/rest/v1/profiles?' + params.toString(),
      { method: 'GET' },
      userToken
    );
    const rows = await readSupabaseResponse(res, 'profiles read');
    const profile = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!profile) return user;
    return Object.assign({}, user, {
      email: user.email || profile.email || '',
      name: user.name || profile.display_name || user.name,
      fullName: user.fullName || profile.display_name || user.fullName,
    });
  } catch (profileErr) {
    logUsage('profile_enrich_skip', profileErr.message || profileErr);
    return user;
  }
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
  const fullName = meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : '');
  return {
    id: user.id,
    email: user.email || '',
    name: fullName,
    fullName: fullName,
    phone: extractPhoneFromAuthMeta(meta, user),
    tier: 'trial',
  };
}

function applyLocalDemoUserIdMapping(user) {
  return authContext.mapUserForSupabaseQuery(user);
}

function mapSupabaseUserId(userId, email) {
  return authContext.mapUserIdForSupabaseQuery(userId, email) || String(userId || '').trim();
}

async function resolveUser(req, body) {
  const authHeader = String(req.headers.authorization || req.headers.Authorization || '');
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const verified = await verifySupabaseToken(token);
  if (verified && verified.id) return verified;

  const fromBody = body && body.teacherUser;
  if (fromBody && fromBody.id) {
    return applyLocalDemoUserIdMapping({
      id: fromBody.id,
      email: normalizeEmail(fromBody.email),
      name: fromBody.name || fromBody.displayName || '',
      fullName: fromBody.fullName || fromBody.name || fromBody.displayName || '',
      phone: fromBody.phone || fromBody.user_phone || '',
      tier: normalizeTier(fromBody.tier || fromBody.plan_type || 'trial'),
    });
  }

  const email = extractUserEmail(req, body);
  if (email) {
    return applyLocalDemoUserIdMapping({
      id: fromBody && fromBody.id ? String(fromBody.id).trim() : ('email:' + email),
      email: email,
      name: (fromBody && (fromBody.name || fromBody.displayName)) || email.split('@')[0],
      fullName: (fromBody && (fromBody.fullName || fromBody.name || fromBody.displayName)) || email.split('@')[0],
      phone: (fromBody && (fromBody.phone || fromBody.user_phone)) || '',
      tier: isProUserEmail(email) ? 'pro' : normalizeTier((fromBody && fromBody.tier) || 'trial'),
    });
  }

  const err = new Error('יש להתחבר כדי לנהל מנוי');
  err.statusCode = 401;
  throw err;
}

function readWordDownloadsFromRow(row, tier) {
  const month = currentMonthKey();
  const raw = Number(row && row.word_downloads_count) || 0;
  if (tier !== 'trial') return raw;
  const rowMonth = monthFromRow(row);
  return rowMonth === month ? raw : 0;
}

function isSubscriptionExpired(row) {
  if (!row || !row.expires_at) return false;
  const tier = planTypeFromRow(row);
  if (tier === 'trial') return false;
  return new Date(row.expires_at).getTime() <= Date.now();
}

/** Paid access tier: stays pro/standard until expires_at; only then trial. */
function effectiveTierFromRow(row) {
  if (isSubscriptionExpired(row)) return 'trial';
  return planTypeFromRow(row);
}

function readSearchLimitFromRow(row, tier) {
  const stored = row && row.search_limit_monthly;
  if (stored != null && stored !== '') {
    const n = Number(stored);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  const limits = TIER_LIMITS[tier];
  if (tier === 'trial') return limits.lifetime;
  return limits.monthly;
}

function readWordDownloadLimitFromRow(row, tier) {
  if (row && row.word_downloads_limit != null && row.word_downloads_limit !== '') {
    const n = Number(row.word_downloads_limit);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return TIER_LIMITS[tier].wordDownloads;
}

async function downgradeSubscriptionIfExpired(user, row, userToken) {
  if (!row || !user || !user.id) return row;
  if (planTypeFromRow(row) === 'trial') return row;
  if (!isSubscriptionExpired(row)) return row;
  logUsage('downgrade_expired', {
    user_id: user.id,
    expires_at: row.expires_at,
    previous_plan: planTypeFromRow(row),
  });
  return updateSubscriptionRow(user.id, {
    plan_type: 'trial',
    auto_renew: false,
    expires_at: null,
  }, row, user, userToken);
}

async function notifyCancellationRequested(user, row, expiresAt) {
  const detail = {
    userId: user && user.id,
    email: normalizeEmail((user && user.email) || (row && row.user_email)),
    fullName: (row && row.user_full_name) || (user && (user.fullName || user.name)) || '',
    phone: (row && row.user_phone) || (user && user.phone) || '',
    planType: planTypeFromRow(row),
    expiresAt: expiresAt || (row && row.expires_at) || null,
    cancelledAt: new Date().toISOString(),
  };
  logUsage('cancel_requested', detail);
  try {
    const billingEmail = require('./billing-email');
    await billingEmail.sendCancellationAlert(detail);
  } catch (notifyErr) {
    logUsage('cancel_notify_failed', notifyErr.message || notifyErr);
  }
}

function buildSearchLimitError(usage) {
  const tier = usage && usage.tier ? usage.tier : 'trial';
  if (tier === 'trial') {
    const err = new Error('חרגתם ממכסת ' + TRIAL_LIFETIME_SEARCH_LIMIT + ' החיפושים החינמיים — שדרגו לפרו כדי להמשיך');
    err.statusCode = 429;
    err.code = 'RATE_LIMIT';
    err.usage = usage;
    return err;
  }
  const limit = usage && usage.searchLimit != null ? usage.searchLimit : PRO_MONTHLY_SEARCH_LIMIT;
  const err = new Error('מכסת ' + limit + ' החיפושים החודשית הסתיימה — המונה יתאפס בתחילת החודש הבא');
  err.statusCode = 429;
  err.code = 'RATE_LIMIT_MONTHLY';
  err.usage = usage;
  return err;
}

function buildUsagePayload(row) {
  const tier = effectiveTierFromRow(row);
  const month = currentMonthKey();
  const used = readSearchCountFromRow(row, tier);
  const limit = readSearchLimitFromRow(row, tier);
  const period = tier === 'trial' ? 'lifetime' : 'monthly';

  const wordDownloadsUsed = readWordDownloadsFromRow(row, tier);
  const wordDownloadLimit = readWordDownloadLimitFromRow(row, tier);
  const wordDownloadsAllowed = wordDownloadLimit == null
    ? true
    : wordDownloadsUsed < wordDownloadLimit;

  const expired = isSubscriptionExpired(row);
  const paidActive = tier !== 'trial' && !expired;

  return {
    tier: tier,
    autoRenew: row.auto_renew !== false,
    expiresAt: row && row.expires_at ? row.expires_at : null,
    subscriptionExpired: expired,
    searchesUsed: used,
    searchLimit: limit,
    usagePeriod: period,
    usageMonth: monthFromRow(row) || month,
    remaining: limit === null ? null : Math.max(0, limit - used),
    allowed: paidActive ? (limit === null ? true : used < limit) : (tier === 'trial' ? (limit === null ? true : used < limit) : false),
    wordDownloadsUsed: wordDownloadsUsed,
    wordDownloadLimit: wordDownloadLimit,
    wordDownloadsRemaining: wordDownloadLimit == null
      ? null
      : Math.max(0, wordDownloadLimit - wordDownloadsUsed),
    wordDownloadsAllowed: wordDownloadsAllowed,
  };
}

async function fetchSubscriptionRow(userId, userToken, emailHint) {
  const pk = mapSupabaseUserId(userId, emailHint);
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('user_id', 'eq.' + pk);
  params.set('limit', '1');

  logUsage('fetch:before', { user_id: pk, raw_user_id: userId });

  const res = await supabaseRequest(
    '/rest/v1/' + TABLE + '?' + params.toString(),
    { method: 'GET' },
    userToken
  );
  const rows = await readSupabaseResponse(res, 'subscription read');
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;

  logUsage('fetch:after', {
    user_id: pk,
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
  const contact = buildSubscriptionContactPatch(user, patch);

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
    user_email: contact.user_email || prev.user_email || null,
    user_full_name: contact.user_full_name || prev.user_full_name || null,
    user_phone: contact.user_phone || prev.user_phone || null,
    updated_at: new Date().toISOString(),
  });
}

async function insertSubscriptionRow(user, patch, userToken) {
  user = applyLocalDemoUserIdMapping(user);
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
  const pk = mapSupabaseUserId(userId, user && user.email);
  const params = new URLSearchParams();
  params.set('user_id', 'eq.' + pk);

  const mergedRow = user
    ? subscriptionRowFromPatch(user, patch, existing)
    : pickSubscriptionWriteFields(Object.assign({}, patch, {
      plan_type: patch.plan_type || patch.tier,
      updated_at: new Date().toISOString(),
    }));
  const writePatch = Object.assign({}, mergedRow);
  delete writePatch.user_id;

  logUsage('update:before', {
    user_id: pk,
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
    user_id: pk,
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
    logUsage('update:upsert_fallback', { user_id: pk, merged: merged });

    const upsertRes = await supabaseRequest('/rest/v1/' + TABLE + '?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(merged),
    }, userToken);
    const upsertRows = await readSupabaseResponse(upsertRes, 'subscription upsert');
    logUsage('update:upsert_after', {
      user_id: pk,
      rows_affected: Array.isArray(upsertRows) ? upsertRows.length : 0,
      response: upsertRows,
    });
    if (Array.isArray(upsertRows) && upsertRows.length) return upsertRows[0];
    return merged;
  }

  const refetched = await fetchSubscriptionRow(userId, userToken, user && user.email);
  if (refetched) return refetched;
  return subscriptionRowFromPatch(user || { id: userId, tier: 'trial' }, patch, existing);
}

async function upsertSubscriptionRow(user, patch, userToken) {
  user = applyLocalDemoUserIdMapping(user);
  const existing = await fetchSubscriptionRow(user.id, userToken, user.email);
  if (existing) {
    return updateSubscriptionRow(user.id, patch, existing, user, userToken);
  }
  return insertSubscriptionRow(user, patch, userToken);
}

async function ensureSubscription(user, userToken) {
  user = applyLocalDemoUserIdMapping(user);
  user = await enrichUserFromProfile(user, userToken);
  const contactPatch = buildSubscriptionContactPatch(user);
  let row = await fetchSubscriptionRow(user.id, userToken, user.email);
  if (!row) {
    logUsage('ensure:create_row', { user_id: user.id });
    row = await insertSubscriptionRow(user, Object.assign({
      plan_type: normalizeTier(user.tier || 'trial'),
      search_count_monthly: 0,
      word_downloads_count: 0,
      auto_renew: true,
    }, contactPatch), userToken);
  } else if (shouldRefreshSubscriptionContact(row, contactPatch)) {
    row = await updateSubscriptionRow(user.id, contactPatch, row, user, userToken);
  }
  row = await downgradeSubscriptionIfExpired(user, row, userToken);
  return row;
}

async function getStatus(user, userToken) {
  user = applyLocalDemoUserIdMapping(user);
  const row = await ensureSubscription(user, userToken);
  const usage = buildUsagePayload(row);
  return {
    ok: true,
    action: 'status',
    subscription: {
      tier: usage.tier,
      autoRenew: usage.autoRenew,
      expiresAt: usage.expiresAt,
    },
    usage: usage,
  };
}

async function recordSearch(user, userToken) {
  user = applyLocalDemoUserIdMapping(user);
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
  if (isSubscriptionExpired(row)) {
    const usage = buildUsagePayload(row);
    const err = new Error('תוקף המנוי הסתיים — שדרגו מחדש כדי להמשיך');
    err.statusCode = 403;
    err.code = 'SUBSCRIPTION_EXPIRED';
    err.usage = usage;
    throw err;
  }
  const usageBefore = buildUsagePayload(row);

  logUsage('record_search:before_increment', {
    user_id: user.id,
    searchesUsed_before: usageBefore.searchesUsed,
    search_count_monthly_raw: row.search_count_monthly,
    plan_type: row.plan_type,
  });

  if (!usageBefore.allowed) {
    throw buildSearchLimitError(usageBefore);
  }

  const tier = effectiveTierFromRow(row);
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
  user = applyLocalDemoUserIdMapping(user);
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
  const tier = effectiveTierFromRow(row);

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
    const downloadCap = usageBefore.wordDownloadLimit != null ? usageBefore.wordDownloadLimit : 5;
    const err = new Error('הגעתם למגבלת ' + downloadCap + ' הורדות Word בחודש במסלול החינמי. שדרגו למסלול פרו להורדות ללא הגבלה.');
    err.statusCode = 429;
    err.code = 'WORD_DOWNLOAD_LIMIT';
    err.usage = usageBefore;
    throw err;
  }

  const month = currentMonthKey();
  const rowMonth = monthFromRow(row);
  const currentDownloads = tier === 'trial' && rowMonth !== month
    ? 0
    : (Number(row.word_downloads_count) || 0);

  const updated = await updateSubscriptionRow(user.id, {
    word_downloads_count: currentDownloads + 1,
    updated_at: new Date().toISOString(),
  }, row, user, userToken);
  return {
    ok: true,
    action: 'record_word_download',
    usage: buildUsagePayload(updated),
  };
}

async function cancelRenewal(user, userToken) {
  user = applyLocalDemoUserIdMapping(user);
  const row = await ensureSubscription(user, userToken);
  if (planTypeFromRow(row) === 'trial') {
    const err = new Error('אין מנוי בתשלום לביטול');
    err.statusCode = 400;
    throw err;
  }

  let expiresAt = row.expires_at || null;
  const stripeSubscriptionId = row.stripe_subscription_id;

  if (stripeSubscriptionId) {
    try {
      const billingStripe = require('./billing-stripe');
      const billingDb = require('./billing-db');
      if (billingStripe.isStripeEnabled()) {
        const updated = await billingStripe.cancelSubscriptionAtPeriodEnd(stripeSubscriptionId);
        expiresAt = billingStripe.expiresAtFromStripeSubscription(updated);
        if (billingDb.isEnabled()) {
          await billingDb.markSubscriptionCancelledAtPeriodEnd(user.id, expiresAt);
        }
      }
    } catch (gatewayErr) {
      console.warn(LOG_PREFIX, 'cancel gateway error', gatewayErr.message || gatewayErr);
      const err = new Error('לא ניתן לבטל את המנוי אצל ספק התשלום — נסו שוב או פנו לתמיכה');
      err.statusCode = 502;
      throw err;
    }
  }

  const currentPlan = planTypeFromRow(row);
  const updated = await updateSubscriptionRow(user.id, {
    auto_renew: false,
    expires_at: expiresAt,
    plan_type: currentPlan,
  }, row, user, userToken);

  await notifyCancellationRequested(user, updated, expiresAt);

  const effectiveTier = effectiveTierFromRow(updated);
  return {
    ok: true,
    action: 'cancel_renewal',
    subscription: {
      tier: effectiveTier,
      planType: planTypeFromRow(updated),
      autoRenew: false,
      expiresAt: updated.expires_at || null,
      accessUntilExpiry: effectiveTier !== 'trial',
    },
    usage: buildUsagePayload(updated),
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
  if (action === 'cancel_renewal' || action === 'cancel_subscription') return cancelRenewal(user, userToken);
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
    ? applyLocalDemoUserIdMapping(explicitUser)
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
    user = applyLocalDemoUserIdMapping(await resolveUser(req, body));
  } catch (authErr) {
    if (authErr && authErr.statusCode === 401) return { allowed: true, unauthenticated: true };
    throw authErr;
  }
  const row = await ensureSubscription(user, userToken);
  if (isSubscriptionExpired(row)) {
    const usage = buildUsagePayload(row);
    const err = new Error('תוקף המנוי הסתיים — שדרגו מחדש כדי להמשיך');
    err.statusCode = 403;
    err.code = 'SUBSCRIPTION_EXPIRED';
    err.usage = usage;
    throw err;
  }
  const usage = buildUsagePayload(row);
  if (!usage.allowed) {
    throw buildSearchLimitError(usage);
  }
  return { allowed: true, usage: usage };
}

function buildRequestShape(body, headers) {
  return { body: body || {}, headers: headers || {} };
}

async function assertLiveSearchAllowedForPureApi(body, headers) {
  const reqShape = buildRequestShape(body, headers);
  const email = extractUserEmail(reqShape, body);
  if (isProUserEmail(email)) {
    return { allowed: true, proUser: true, usage: buildProUserUsagePayload(email) };
  }
  if (!isEnabled()) {
    const userToken = extractUserToken(reqShape);
    if (!userToken && !email) {
      const err = new Error('יש להתחבר כדי לבצע מחקר חי');
      err.statusCode = 401;
      err.code = 'AUTH_REQUIRED';
      throw err;
    }
    return { allowed: true, skipped: true };
  }
  let user;
  try {
    user = applyLocalDemoUserIdMapping(await resolveUser(reqShape, body));
  } catch (authErr) {
    const err = new Error('יש להתחבר כדי לבצע מחקר חי');
    err.statusCode = 401;
    err.code = 'AUTH_REQUIRED';
    throw err;
  }
  const row = await ensureSubscription(user, extractUserToken(reqShape));
  if (isSubscriptionExpired(row)) {
    const usage = buildUsagePayload(row);
    const expiredErr = new Error('תוקף המנוי הסתיים — שדרגו מחדש כדי להמשיך');
    expiredErr.statusCode = 403;
    expiredErr.code = 'SUBSCRIPTION_EXPIRED';
    expiredErr.usage = usage;
    throw expiredErr;
  }
  const usage = buildUsagePayload(row);
  if (!usage.allowed) {
    throw buildSearchLimitError(usage);
  }
  return { allowed: true, usage: usage, user: user };
}

async function assertWordDownloadAllowedFromRequest(req) {
  const body = req && req.body;
  const email = extractUserEmail(req, body);
  if (isProUserEmail(email)) {
    return { allowed: true, proUser: true, usage: buildProUserUsagePayload(email) };
  }
  if (!isEnabled()) {
    const err = new Error('מערכת המנויים אינה זמינה — נסו שוב מאוחר יותר');
    err.statusCode = 503;
    err.code = 'SUBSCRIPTION_UNAVAILABLE';
    throw err;
  }
  const userToken = extractUserToken(req);
  const user = applyLocalDemoUserIdMapping(await resolveUser(req, body));
  const row = await ensureSubscription(user, userToken);
  const tier = effectiveTierFromRow(row);
  if (tier !== 'trial') {
    return { allowed: true, unlimited: true, usage: buildUsagePayload(row) };
  }
  const usage = buildUsagePayload(row);
  if (!usage.wordDownloadsAllowed) {
    const err = new Error('הגעתם למגבלת 5 הורדות Word בחודש במסלול החינמי. שדרגו למסלול פרו להורדות ללא הגבלה.');
    err.statusCode = 429;
    err.code = 'WORD_DOWNLOAD_LIMIT';
    err.usage = usage;
    throw err;
  }
  return { allowed: true, usage: usage, user: user };
}

module.exports = {
  legacyHandler,
  executeSubscription,
  recordLiveSearchFromRequest,
  assertSearchAllowedFromRequest,
  assertLiveSearchAllowedForPureApi,
  assertWordDownloadAllowedFromRequest,
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
  buildSearchLimitError,
  buildUsagePayload,
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
