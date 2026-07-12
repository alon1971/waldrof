/**
 * POST /api/webhooks/payment-success — Make.com / Grow payment gateway callback.
 * Payload: { email, name, phone, plan }
 *   plan examples: "annual_pro", "one_time_support", "standard", "pro"
 */
const env = require('./env');
const billingDb = require('./billing-db');

const LOG_PREFIX = '[payment-success-webhook]';

function log(event, detail) {
  console.log(LOG_PREFIX, event, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function assertAuthorized(req) {
  const secret = env.getPaymentWebhookSecret();
  if (!secret) return;
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const headerSecret = req.headers['x-webhook-secret'] || req.headers['X-Webhook-Secret'];
  if (auth === secret || headerSecret === secret) return;
  const err = new Error('Unauthorized webhook request');
  err.statusCode = 401;
  throw err;
}

/**
 * Map Grow / Make plan labels to product tiers:
 *   standard — one-time support (100 ₪): 20 lifetime searches, no expiry
 *   pro      — annual subscription (220 ₪): 25 searches/month, 1-year expiry
 */
function parsePlan(plan) {
  const raw = String(plan || 'annual_pro').trim().toLowerCase();

  const isOneTime =
    raw.includes('standard') ||
    raw.includes('educator') ||
    raw.includes('one_time') ||
    raw.includes('onetime') ||
    raw.includes('one-time') ||
    raw.includes('support') ||
    raw.includes('100');

  if (isOneTime && !raw.includes('annual') && !raw.includes('year') && !raw.includes('220')) {
    return {
      planType: 'standard',
      billingCycle: 'one_time',
      autoRenew: false,
      expiresAt: null,
      resetSearchCount: true,
    };
  }

  return {
    planType: 'pro',
    billingCycle: 'yearly',
    autoRenew: true,
    expiresAt: expiresAtOneYearFromNow(),
    resetSearchCount: true,
  };
}

function expiresAtOneYearFromNow() {
  const now = new Date();
  now.setFullYear(now.getFullYear() + 1);
  return now.toISOString();
}

async function handlePaymentSuccessRequest(req, body) {
  assertAuthorized(req);

  if (!billingDb.isEnabled()) {
    const err = new Error('Supabase service role required for payment webhooks');
    err.statusCode = 503;
    throw err;
  }

  const payload = body && typeof body === 'object' ? body : {};
  const email = normalizeEmail(payload.email);
  const name = String(payload.name || '').trim();
  const phone = String(payload.phone || '').trim();
  const plan = payload.plan;

  if (!email) {
    const err = new Error('Missing required field: email');
    err.statusCode = 400;
    throw err;
  }

  const userId = await billingDb.findUserIdByEmail(email);
  if (!userId) {
    log('user_not_found', { email: email, plan: plan });
    const err = new Error('User not found for email: ' + email);
    err.statusCode = 404;
    throw err;
  }

  const parsed = parsePlan(plan);

  const activateOpts = {
    userId: userId,
    email: email,
    fullName: name,
    phone: phone,
    planType: parsed.planType,
    expiresAt: parsed.expiresAt,
    autoRenew: parsed.autoRenew,
    billingCycle: parsed.billingCycle,
  };
  if (parsed.resetSearchCount) {
    activateOpts.searchCountMonthly = 0;
  }

  const subRow = await billingDb.activatePaidSubscription(activateOpts);

  log('activated', {
    userId: userId,
    email: email,
    plan: plan,
    planType: parsed.planType,
    billingCycle: parsed.billingCycle,
    phone: phone || undefined,
    expiresAt: parsed.expiresAt,
  });

  return {
    ok: true,
    userId: userId,
    email: email,
    planType: parsed.planType,
    billingCycle: parsed.billingCycle,
    expiresAt: parsed.expiresAt,
    subscription: subRow,
  };
}

module.exports = {
  handlePaymentSuccessRequest,
  parsePlan,
};
