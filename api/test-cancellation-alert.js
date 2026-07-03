/**
 * Manual test trigger for subscription cancellation admin alert.
 * POST /api/cron/test-cancellation-alert?email=...
 * Protected by CRON_SECRET when configured.
 */
const env = require('./env');
const billingEmail = require('./billing-email');
const billingDb = require('./billing-db');

const TABLE = 'user_subscriptions';
const LOG_PREFIX = '[test-cancellation-alert]';

function log(event, detail) {
  console.log(LOG_PREFIX, event, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function authHeaders() {
  const key = env.getSupabaseServiceRoleKey();
  if (!env.getSupabaseUrl() || !key) {
    throw new Error('Supabase service role required');
  }
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

async function readResponse(res, label) {
  const text = await res.text();
  if (!res.ok) {
    let message = (text || '').trim() || (label || 'request') + ' failed';
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

async function fetchSubscriptionByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('user_email', 'eq.' + normalized);
  params.set('limit', '1');
  const res = await fetch(env.getSupabaseUrl() + '/rest/v1/' + TABLE + '?' + params.toString(), {
    headers: authHeaders(),
  });
  const rows = await readResponse(res, 'subscription by email');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function runTestCancellationAlert(options) {
  const opts = options || {};
  const email = normalizeEmail(opts.email);
  if (!email) {
    const err = new Error('Missing required query/body field: email');
    err.statusCode = 400;
    throw err;
  }

  const row = await fetchSubscriptionByEmail(email);
  let userId = row && row.user_id ? String(row.user_id) : '';
  if (!userId && billingDb.isEnabled()) {
    userId = (await billingDb.findUserIdByEmail(email)) || '';
  }

  const detail = {
    userId: userId || undefined,
    email: email,
    fullName: (row && row.user_full_name) || opts.fullName || '',
    phone: (row && row.user_phone) || opts.phone || '',
    planType: (row && row.plan_type) || opts.planType || 'pro',
    expiresAt: opts.expiresAt || (row && row.expires_at) || null,
    cancelledAt: new Date().toISOString(),
    testTrigger: true,
  };

  log('trigger', detail);
  const emailResult = await billingEmail.sendCancellationAlert(detail);
  log('result', emailResult);

  return {
    ok: true,
    email: email,
    detail: detail,
    emailResult: emailResult,
    smtpConfigured: billingEmail.isEmailEnabled(),
    alertRecipient: env.getBillingReportEmail(),
  };
}

async function handleCronRequest(req, query) {
  let body = null;
  if (req && req.method === 'POST' && req.body) {
    body = typeof req.body === 'object' ? req.body : null;
  }
  const email = (query && query.email) || (body && body.email);
  return runTestCancellationAlert({
    email: email,
    expiresAt: (query && query.expiresAt) || (body && body.expiresAt),
  });
}

module.exports = {
  runTestCancellationAlert,
  handleCronRequest,
};
