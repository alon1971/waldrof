/**
 * Supabase persistence for automated billing lifecycle.
 * Uses service role for webhook/cron writes.
 */
const env = require('./env');

const SUBSCRIPTIONS_TABLE = 'user_subscriptions';
const PROFILES_TABLE = 'profiles';
const LOG_PREFIX = '[billing-db]';

const BILLING_WRITE_COLUMNS = [
  'user_id',
  'plan_type',
  'search_count_monthly',
  'word_downloads_count',
  'auto_renew',
  'expires_at',
  'stripe_customer_id',
  'stripe_subscription_id',
  'payment_provider',
  'updated_at',
];

function log(event, detail) {
  try {
    console.log(LOG_PREFIX, event, typeof detail === 'string' ? detail : JSON.stringify(detail));
  } catch (e) {
    console.log(LOG_PREFIX, event, detail);
  }
}

function getConfig() {
  return {
    url: env.getSupabaseUrl(),
    serviceKey: env.getSupabaseServiceRoleKey(),
  };
}

function isEnabled() {
  const cfg = getConfig();
  return Boolean(cfg.url && cfg.serviceKey);
}

function authHeaders() {
  const cfg = getConfig();
  if (!cfg.url || !cfg.serviceKey) throw new Error('Supabase service role not configured');
  return {
    apikey: cfg.serviceKey,
    Authorization: 'Bearer ' + cfg.serviceKey,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

async function readResponse(res, label) {
  const text = await res.text();
  if (!res.ok) {
    let message = (text || '').trim() || (label || 'Supabase') + ' request failed';
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.message) message = String(parsed.message);
    } catch (e) { /* keep */ }
    const err = new Error(message);
    err.statusCode = res.status;
    throw err;
  }
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

async function supabaseRequest(pathSuffix, options) {
  const cfg = getConfig();
  const res = await fetch(cfg.url + pathSuffix, Object.assign({}, options || {}, {
    headers: Object.assign({}, authHeaders(), (options && options.headers) || {}),
  }));
  return readResponse(res, pathSuffix);
}

function pickBillingFields(obj) {
  const out = {};
  BILLING_WRITE_COLUMNS.forEach(function (key) {
    if (obj && obj[key] !== undefined) out[key] = obj[key];
  });
  return out;
}

function subscriptionStatusLabel(planType) {
  const tier = String(planType || 'trial').toLowerCase();
  if (tier === 'pro' || tier === 'standard') return 'Pro User';
  return 'Trial';
}

async function findUserIdByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;

  const authRes = await fetch(
    getConfig().url + '/auth/v1/admin/users?email=' + encodeURIComponent(normalized),
    { headers: authHeaders() }
  );
  const authData = await readResponse(authRes, 'auth users');
  if (authData && Array.isArray(authData.users) && authData.users.length) {
    return authData.users[0].id;
  }
  return null;
}

async function fetchSubscriptionByUserId(userId) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('user_id', 'eq.' + userId);
  params.set('limit', '1');
  const rows = await supabaseRequest('/rest/v1/' + SUBSCRIPTIONS_TABLE + '?' + params.toString(), { method: 'GET' });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function fetchSubscriptionByStripeId(stripeSubscriptionId) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('stripe_subscription_id', 'eq.' + stripeSubscriptionId);
  params.set('limit', '1');
  const rows = await supabaseRequest('/rest/v1/' + SUBSCRIPTIONS_TABLE + '?' + params.toString(), { method: 'GET' });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function upsertSubscriptionRow(userId, patch) {
  const existing = await fetchSubscriptionByUserId(userId);
  const row = pickBillingFields(Object.assign({
    user_id: userId,
    updated_at: new Date().toISOString(),
  }, patch));

  if (existing) {
    const params = new URLSearchParams();
    params.set('user_id', 'eq.' + userId);
    delete row.user_id;
    const rows = await supabaseRequest('/rest/v1/' + SUBSCRIPTIONS_TABLE + '?' + params.toString(), {
      method: 'PATCH',
      body: JSON.stringify(row),
    });
    return Array.isArray(rows) && rows.length ? rows[0] : Object.assign({}, existing, row);
  }

  const defaults = {
    search_count_monthly: 0,
    word_downloads_count: 0,
    auto_renew: true,
    plan_type: 'trial',
  };
  const insertRow = pickBillingFields(Object.assign(defaults, { user_id: userId }, patch));
  const rows = await supabaseRequest('/rest/v1/' + SUBSCRIPTIONS_TABLE, {
    method: 'POST',
    body: JSON.stringify(insertRow),
  });
  return Array.isArray(rows) && rows.length ? rows[0] : insertRow;
}

async function updateProfileFields(userId, patch) {
  const profilePatch = {
    updated_at: new Date().toISOString(),
  };
  if (patch && patch.display_name !== undefined) profilePatch.display_name = patch.display_name;
  if (patch && patch.email !== undefined) profilePatch.email = patch.email;

  const params = new URLSearchParams();
  params.set('id', 'eq.' + userId);
  await supabaseRequest('/rest/v1/' + PROFILES_TABLE + '?' + params.toString(), {
    method: 'PATCH',
    body: JSON.stringify(profilePatch),
  });
}

async function updateProfileSubscription(userId, email, patch) {
  const profilePatch = {
    updated_at: new Date().toISOString(),
  };
  if (patch.subscription_status !== undefined) profilePatch.subscription_status = patch.subscription_status;
  if (patch.subscription_expires_at !== undefined) profilePatch.subscription_expires_at = patch.subscription_expires_at;
  if (email) profilePatch.email = email;

  const params = new URLSearchParams();
  params.set('id', 'eq.' + userId);
  try {
    await supabaseRequest('/rest/v1/' + PROFILES_TABLE + '?' + params.toString(), {
      method: 'PATCH',
      body: JSON.stringify(profilePatch),
    });
  } catch (err) {
    log('profile_update_fallback', { userId: userId, message: err.message });
    await supabaseRequest('/rest/v1/' + PROFILES_TABLE, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(Object.assign({ id: userId }, profilePatch)),
    });
  }
}

async function activatePaidSubscription(options) {
  const opts = options || {};
  const userId = opts.userId;
  const email = opts.email;
  const planType = opts.planType || 'pro';
  const expiresAt = opts.expiresAt;
  const stripeCustomerId = opts.stripeCustomerId || null;
  const stripeSubscriptionId = opts.stripeSubscriptionId || null;
  const autoRenew = opts.autoRenew !== false;

  if (!userId) throw new Error('activatePaidSubscription requires userId');

  const subRow = await upsertSubscriptionRow(userId, {
    plan_type: planType,
    expires_at: expiresAt,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    payment_provider: opts.paymentProvider || 'stripe',
    auto_renew: autoRenew,
  });

  log('activated', { userId: userId, email: email || undefined, planType: planType, expiresAt: expiresAt });
  return subRow;
}

async function markSubscriptionCancelledAtPeriodEnd(userId, expiresAt) {
  const subRow = await upsertSubscriptionRow(userId, {
    auto_renew: false,
    expires_at: expiresAt || undefined,
  });
  await updateProfileSubscription(userId, null, {
    subscription_status: subscriptionStatusLabel(subRow.plan_type || 'pro'),
    subscription_expires_at: expiresAt || subRow.expires_at,
  });
  log('cancel_at_period_end', { userId: userId, expiresAt: expiresAt });
  return subRow;
}

async function downgradeExpiredSubscription(userId) {
  const subRow = await upsertSubscriptionRow(userId, {
    plan_type: 'trial',
    auto_renew: false,
    expires_at: null,
    stripe_subscription_id: null,
  });
  await updateProfileSubscription(userId, null, {
    subscription_status: 'Trial',
    subscription_expires_at: null,
  });
  log('downgraded_expired', { userId: userId });
  return subRow;
}

async function fetchAllSubscriptions() {
  const params = new URLSearchParams();
  params.set('select', 'user_id,plan_type,auto_renew,expires_at,created_at,updated_at,stripe_subscription_id');
  params.set('order', 'updated_at.desc');
  const rows = await supabaseRequest('/rest/v1/' + SUBSCRIPTIONS_TABLE + '?' + params.toString(), { method: 'GET' });
  return Array.isArray(rows) ? rows : [];
}

async function fetchProfilesByIds(ids) {
  if (!ids || !ids.length) return [];
  const params = new URLSearchParams();
  params.set('select', 'id,email,display_name,subscription_status,subscription_expires_at');
  params.set('id', 'in.(' + ids.join(',') + ')');
  const rows = await supabaseRequest('/rest/v1/' + PROFILES_TABLE + '?' + params.toString(), { method: 'GET' });
  return Array.isArray(rows) ? rows : [];
}

async function processExpiredSubscriptions() {
  const now = new Date().toISOString();
  const all = await fetchAllSubscriptions();
  let downgraded = 0;
  for (let i = 0; i < all.length; i++) {
    const row = all[i];
    const tier = String(row.plan_type || 'trial').toLowerCase();
    if (tier === 'trial') continue;
    if (!row.expires_at) continue;
    if (row.auto_renew === true) continue;
    if (new Date(row.expires_at).getTime() > Date.now()) continue;
    await downgradeExpiredSubscription(row.user_id);
    downgraded += 1;
  }
  return { downgraded: downgraded, checkedAt: now };
}

module.exports = {
  isEnabled,
  findUserIdByEmail,
  fetchSubscriptionByUserId,
  fetchSubscriptionByStripeId,
  activatePaidSubscription,
  markSubscriptionCancelledAtPeriodEnd,
  downgradeExpiredSubscription,
  processExpiredSubscriptions,
  fetchAllSubscriptions,
  fetchProfilesByIds,
  subscriptionStatusLabel,
  updateProfileFields,
};
