/**
 * POST /api/webhooks/payment-success — Make.com payment gateway callback.
 * Payload: { email, name, phone, plan } (e.g. plan: "annual_pro")
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

function parsePlan(plan) {
  const raw = String(plan || 'annual_pro').trim().toLowerCase();
  let planType = 'pro';

  if (raw.includes('standard') || raw.includes('educator')) {
    planType = 'standard';
  }

  return { planType: planType };
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
  const expiresAt = expiresAtOneYearFromNow();

  const subRow = await billingDb.activatePaidSubscription({
    userId: userId,
    email: email,
    planType: parsed.planType,
    expiresAt: expiresAt,
    autoRenew: true,
  });

  log('activated', {
    userId: userId,
    email: email,
    plan: plan,
    planType: parsed.planType,
    phone: phone || undefined,
    expiresAt: expiresAt,
  });

  return {
    ok: true,
    userId: userId,
    email: email,
    planType: parsed.planType,
    expiresAt: expiresAt,
    subscription: subRow,
  };
}

module.exports = {
  handlePaymentSuccessRequest,
  parsePlan,
};
