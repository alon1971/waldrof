/**
 * POST /api/webhooks/payment-success — Grow payment success callback (via Make).
 *
 * Call this ONLY after Grow confirms a real charge — never from the checkout-link
 * webhook that generates a paymentLinkProcessId for the teacher.
 *
 * Required payload:
 *   { email, plan, paymentStatus: "success" }
 * Optional: name, phone, transactionId / asmachta, paid: true
 *
 * plan examples: "annual_pro", "one_time_support", "standard", "pro"
 */
const env = require('./env');
const billingDb = require('./billing-db');

const LOG_PREFIX = '[payment-success-webhook]';

const LEAD_OR_CHECKOUT_INTENTS = {
  checkout_link: true,
  checkout_link_request: true,
  lead: true,
  upgrade_lead: true,
  create_payment_link: true,
};

const SUCCESS_STATUSES = {
  success: true,
  paid: true,
  completed: true,
  approved: true,
  'charge.succeeded': true,
};

const SUCCESS_EVENTS = {
  payment_success: true,
  'grow.payment_success': true,
  'payment.success': true,
  'charge.succeeded': true,
};

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
 * Refuse checkout-link / lead payloads so Make cannot upgrade users before Grow charge.
 * Require an explicit payment-success signal from Grow (via Make).
 */
function assertGrowPaymentConfirmed(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const intent = String(p.intent || '').trim().toLowerCase();
  const event = String(p.event || p.type || '').trim().toLowerCase();

  if (LEAD_OR_CHECKOUT_INTENTS[intent] || LEAD_OR_CHECKOUT_INTENTS[event]) {
    const err = new Error(
      'Checkout-link / lead webhooks must not activate subscriptions. ' +
      'Call this endpoint only after Grow confirms payment (paymentStatus:"success").'
    );
    err.statusCode = 400;
    throw err;
  }

  const status = String(
    p.paymentStatus || p.payment_status || p.status || ''
  ).trim().toLowerCase();

  const confirmed =
    p.paymentConfirmed === true ||
    p.paid === true ||
    p.confirmed === true ||
    SUCCESS_STATUSES[status] === true ||
    SUCCESS_EVENTS[event] === true ||
    Boolean(
      p.transactionId ||
      p.transaction_id ||
      p.asmachta ||
      p.confirmationNumber ||
      p.confirmation_number
    );

  if (confirmed) return;

  const err = new Error(
    'Payment not confirmed. From the Grow payment-success scenario send ' +
    'paymentStatus:"success" (or paid:true / transactionId). ' +
    'Do not call this endpoint from the checkout-link webhook.'
  );
  err.statusCode = 400;
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
  assertGrowPaymentConfirmed(payload);

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
  assertGrowPaymentConfirmed,
};
