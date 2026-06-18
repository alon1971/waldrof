/**
 * POST /api/subscription — tier limits, usage tracking, auto_renew.
 */
const env = require('./env');

const TABLE = 'user_subscriptions';

const TIER_LIMITS = {
  trial: { lifetime: 20, monthly: null },
  standard: { lifetime: null, monthly: 300 },
  pro: { lifetime: null, monthly: 600 },
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
  return Boolean(cfg.url && cfg.serviceKey);
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

async function supabaseRequest(pathSuffix, options) {
  const cfg = getSupabaseConfig();
  const apiKey = cfg.serviceKey || cfg.anonKey;
  if (!cfg.url || !apiKey) throw new Error('Supabase not configured');

  const res = await fetch(cfg.url + pathSuffix, Object.assign({
    headers: Object.assign({
      apikey: apiKey,
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }, (options && options.headers) || {}),
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
  const user = await res.json();
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
  };
}

async function fetchSubscriptionRow(userId) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('user_id', 'eq.' + userId);
  params.set('limit', '1');

  const res = await supabaseRequest('/rest/v1/' + TABLE + '?' + params.toString(), { method: 'GET' });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || 'subscription read failed');
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function upsertSubscriptionRow(user, patch) {
  const now = new Date().toISOString();
  const base = {
    user_id: user.id,
    user_email: user.email || '',
    tier: normalizeTier((patch && patch.tier) || user.tier || 'trial'),
    billing_cycle: (patch && patch.billing_cycle) != null ? patch.billing_cycle : null,
    trial_searches_used: (patch && patch.trial_searches_used) != null ? patch.trial_searches_used : 0,
    monthly_searches_used: (patch && patch.monthly_searches_used) != null ? patch.monthly_searches_used : 0,
    usage_month: (patch && patch.usage_month) || currentMonthKey(),
    auto_renew: (patch && patch.auto_renew) != null ? patch.auto_renew : true,
    updated_at: now,
  };

  const res = await supabaseRequest('/rest/v1/' + TABLE, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(base),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || 'subscription upsert failed');
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : base;
}

async function ensureSubscription(user) {
  let row = await fetchSubscriptionRow(user.id);
  if (!row) {
    row = await upsertSubscriptionRow(user, {
      tier: user.tier || 'trial',
      trial_searches_used: 0,
      monthly_searches_used: 0,
      usage_month: currentMonthKey(),
      auto_renew: true,
    });
  }
  return row;
}

async function getStatus(user) {
  const row = await ensureSubscription(user);
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

async function recordSearch(user) {
  const row = await ensureSubscription(user);
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

  const updated = await upsertSubscriptionRow(user, Object.assign({}, row, patch));
  return { ok: true, action: 'record_search', usage: buildUsagePayload(updated) };
}

async function cancelRenewal(user) {
  const row = await ensureSubscription(user);
  if (normalizeTier(row.tier) === 'trial') {
    const err = new Error('אין מנוי בתשלום לביטול');
    err.statusCode = 400;
    throw err;
  }
  const updated = await upsertSubscriptionRow(user, Object.assign({}, row, { auto_renew: false }));
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
  const user = await resolveUser(req, body);
  const action = body && body.action ? String(body.action).trim() : 'status';

  if (!isEnabled()) {
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
      },
    };
  }

  if (action === 'record_search') return recordSearch(user);
  if (action === 'cancel_renewal') return cancelRenewal(user);
  return getStatus(user);
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

module.exports = {
  legacyHandler,
  executeSubscription,
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
