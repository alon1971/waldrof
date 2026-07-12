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
  'is_trial',
  'search_count_monthly',
  'word_downloads_count',
  'auto_renew',
  'expires_at',
  'user_email',
  'user_full_name',
  'user_phone',
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

function buildBillingContactPatch(opts) {
  const o = opts || {};
  const out = {};
  const email = String(o.email || o.user_email || '').trim().toLowerCase();
  const fullName = String(o.fullName || o.name || o.user_full_name || '').trim();
  const phone = String(o.phone || o.user_phone || '').trim();
  if (email) out.user_email = email;
  if (fullName) out.user_full_name = fullName;
  if (phone) out.user_phone = phone;
  return out;
}

function extractPhoneFromAuthUser(authUser) {
  if (!authUser) return '';
  const meta = authUser.user_metadata || authUser.raw_user_meta_data || {};
  const candidates = [meta.phone, meta.phone_number, meta.mobile, authUser.phone];
  for (let i = 0; i < candidates.length; i++) {
    const value = String(candidates[i] || '').trim();
    if (value) return value;
  }
  return '';
}

function extractFullNameFromAuthUser(authUser) {
  if (!authUser) return '';
  const meta = authUser.user_metadata || authUser.raw_user_meta_data || {};
  return String(meta.full_name || meta.name || '').trim();
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

async function fetchSubscriptionByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('user_email', 'eq.' + normalized);
  params.set('limit', '5');
  const rows = await supabaseRequest('/rest/v1/' + SUBSCRIPTIONS_TABLE + '?' + params.toString(), { method: 'GET' });
  if (!Array.isArray(rows) || !rows.length) return null;
  for (let i = 0; i < rows.length; i++) {
    const plan = String(rows[i].plan_type || rows[i].tier || 'trial').toLowerCase();
    const isTrial = rows[i].is_trial;
    if (plan !== 'trial' && isTrial !== true && isTrial !== 'true') return rows[i];
  }
  return rows[0];
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
  const email = String((patch && patch.user_email) || '').trim().toLowerCase();
  let existing = await fetchSubscriptionByUserId(userId);
  if (!existing && email) {
    existing = await fetchSubscriptionByEmail(email);
  }

  const row = pickBillingFields(Object.assign({
    user_id: userId,
    updated_at: new Date().toISOString(),
  }, patch));
  if (email) row.user_email = email;

  if (existing) {
    // Patch the existing row identity (may differ from current auth user_id when matched by email).
    const rowKey = String(existing.user_id || userId).trim();
    const params = new URLSearchParams();
    params.set('user_id', 'eq.' + rowKey);
    const writePatch = Object.assign({}, row);
    // Align to the active auth user when possible.
    writePatch.user_id = userId;
    writePatch.updated_at = new Date().toISOString();
    try {
      const rows = await supabaseRequest('/rest/v1/' + SUBSCRIPTIONS_TABLE + '?' + params.toString(), {
        method: 'PATCH',
        body: JSON.stringify(writePatch),
      });
      return Array.isArray(rows) && rows.length ? rows[0] : Object.assign({}, existing, writePatch);
    } catch (patchErr) {
      // If user_id align conflicts, update fields without changing primary key.
      delete writePatch.user_id;
      const rows = await supabaseRequest('/rest/v1/' + SUBSCRIPTIONS_TABLE + '?' + params.toString(), {
        method: 'PATCH',
        body: JSON.stringify(writePatch),
      });
      return Array.isArray(rows) && rows.length ? rows[0] : Object.assign({}, existing, writePatch);
    }
  }

  const defaults = {
    search_count_monthly: 0,
    word_downloads_count: 0,
    auto_renew: true,
    plan_type: 'trial',
  };
  const insertRow = pickBillingFields(Object.assign(defaults, { user_id: userId }, patch));
  if (email) insertRow.user_email = email;
  const conflictTarget = insertRow.user_email ? 'user_email' : 'user_id';
  try {
    const rows = await supabaseRequest(
      '/rest/v1/' + SUBSCRIPTIONS_TABLE + '?on_conflict=' + encodeURIComponent(conflictTarget),
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(insertRow),
      }
    );
    return Array.isArray(rows) && rows.length ? rows[0] : insertRow;
  } catch (upsertErr) {
    // Unique email conflict — update the existing email row.
    if (email) {
      const byEmail = await fetchSubscriptionByEmail(email);
      if (byEmail) {
        const params = new URLSearchParams();
        params.set('user_id', 'eq.' + String(byEmail.user_id).trim());
        const writePatch = Object.assign({}, insertRow);
        delete writePatch.user_id;
        const rows = await supabaseRequest('/rest/v1/' + SUBSCRIPTIONS_TABLE + '?' + params.toString(), {
          method: 'PATCH',
          body: JSON.stringify(writePatch),
        });
        return Array.isArray(rows) && rows.length ? rows[0] : Object.assign({}, byEmail, writePatch);
      }
    }
    throw upsertErr;
  }
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
  const expiresAt = opts.expiresAt !== undefined ? opts.expiresAt : null;
  const autoRenew = opts.autoRenew !== false;
  const billingCycle = opts.billingCycle || (planType === 'standard' ? 'one_time' : 'yearly');

  if (!userId) throw new Error('activatePaidSubscription requires userId');

  const patch = Object.assign({
    plan_type: planType,
    is_trial: false,
    expires_at: expiresAt,
    auto_renew: autoRenew,
  }, buildBillingContactPatch(opts));

  // Fresh paid quota after purchase (20 lifetime / 25 monthly depending on plan).
  if (opts.searchCountMonthly != null || opts.resetSearchCount) {
    patch.search_count_monthly = opts.searchCountMonthly != null ? opts.searchCountMonthly : 0;
  }

  const subRow = await upsertSubscriptionRow(userId, patch);

  log('activated', {
    userId: userId,
    email: email || undefined,
    planType: planType,
    billingCycle: billingCycle,
    expiresAt: expiresAt,
  });
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
    is_trial: true,
    auto_renew: false,
    expires_at: null,
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
  params.set('select', 'user_id,plan_type,auto_renew,expires_at,created_at,updated_at');
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
