/**
 * POST /api/webhooks/payment-success — Grow payment success callback (via Make).
 *
 * Call this ONLY after Grow confirms a real charge — never from the checkout-link
 * webhook that generates a paymentLinkProcessId for the teacher.
 *
 * Required payload:
 *   { plan, paymentStatus: "success", user_id }  — preferred (stable account match)
 *   or { plan, paymentStatus: "success", email } — fallback when user_id missing
 * Optional: name, phone, account_email, metadata.user_id, transactionId / asmachta, paid: true
 *
 * plan examples: "annual_pro", "one_time_support", "standard", "pro"
 */
const env = require('./env');
const billingDb = require('./billing-db');
const billingEmail = require('./billing-email');
const authContext = require('./auth-context');

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
 *   standard — one-time support (100 ₪): 20 lifetime searches, 20 Word downloads, no expiry
 *   pro      — annual subscription (220 ₪): 25 searches/month, unlimited Word, 1-year expiry
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

/**
 * Extract user_id from webhook payload / nested metadata (Make/Grow custom fields).
 */
function extractUserIdFromPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const meta = (p.metadata && typeof p.metadata === 'object') ? p.metadata : {};
  const custom = (p.custom && typeof p.custom === 'object') ? p.custom : {};
  const data = (p.data && typeof p.data === 'object') ? p.data : {};
  const dataMeta = (data.metadata && typeof data.metadata === 'object') ? data.metadata : {};

  const candidates = [
    p.user_id,
    p.userId,
    meta.user_id,
    meta.userId,
    custom.user_id,
    custom.userId,
    data.user_id,
    data.userId,
    dataMeta.user_id,
    dataMeta.userId,
  ];

  for (let i = 0; i < candidates.length; i++) {
    const id = String(candidates[i] || '').trim();
    if (id && authContext.isUuidShaped(id)) return id;
  }
  return '';
}

/**
 * Prefer registered account email over payer/checkout email for subscription identity.
 */
function extractAccountEmailFromPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const meta = (p.metadata && typeof p.metadata === 'object') ? p.metadata : {};
  return normalizeEmail(
    p.account_email ||
    p.accountEmail ||
    meta.account_email ||
    meta.accountEmail ||
    ''
  );
}

async function alertUnmatchedPayment(details) {
  const d = details || {};
  log('user_not_found', d);
  console.error(LOG_PREFIX, 'ALERT unmatched_payment', JSON.stringify(d));
  try {
    await billingEmail.sendUnmatchedPaymentAlert(d);
  } catch (alertErr) {
    log('unmatched_payment_alert_failed', {
      message: alertErr && alertErr.message ? alertErr.message : String(alertErr),
    });
  }
}

/**
 * Resolve the auth user for a Grow payment.
 * Primary: user_id / metadata.user_id (set at checkout initiation).
 * Fallback: payer email / account_email via Auth admin lookup.
 */
async function resolvePaymentUser(payload) {
  const checkoutEmail = normalizeEmail(payload.email);
  const accountEmail = extractAccountEmailFromPayload(payload);
  const metadataUserId = extractUserIdFromPayload(payload);
  const plan = payload.plan;

  if (metadataUserId) {
    const authUser = await billingDb.findAuthUserById(metadataUserId);
    if (authUser && authUser.id) {
      const registeredEmail = normalizeEmail(authUser.email);
      if (checkoutEmail && registeredEmail && checkoutEmail !== registeredEmail) {
        log('email_mismatch_using_user_id', {
          userId: authUser.id,
          checkoutEmail: checkoutEmail,
          registeredEmail: registeredEmail,
          plan: plan,
        });
      }
      return {
        userId: authUser.id,
        // Keep subscription keyed to the registered account email.
        email: registeredEmail || accountEmail || checkoutEmail,
        checkoutEmail: checkoutEmail || undefined,
        matchMethod: 'user_id',
      };
    }
    log('user_id_not_found', {
      userId: metadataUserId,
      checkoutEmail: checkoutEmail || undefined,
      plan: plan,
    });
  }

  const emailForLookup = accountEmail || checkoutEmail;
  if (emailForLookup) {
    const authUser = await billingDb.findAuthUserByEmail(emailForLookup);
    if (authUser && authUser.id) {
      return {
        userId: authUser.id,
        email: normalizeEmail(authUser.email) || emailForLookup,
        checkoutEmail: checkoutEmail || undefined,
        matchMethod: 'email',
      };
    }
  }

  // Last resort: payer email differed from account_email — try payer email too.
  if (checkoutEmail && checkoutEmail !== emailForLookup) {
    const authUser = await billingDb.findAuthUserByEmail(checkoutEmail);
    if (authUser && authUser.id) {
      return {
        userId: authUser.id,
        email: normalizeEmail(authUser.email) || checkoutEmail,
        checkoutEmail: checkoutEmail,
        matchMethod: 'checkout_email',
      };
    }
  }

  await alertUnmatchedPayment({
    userId: metadataUserId || undefined,
    email: checkoutEmail || accountEmail || undefined,
    accountEmail: accountEmail || undefined,
    checkoutEmail: checkoutEmail || undefined,
    plan: plan,
    reason: metadataUserId
      ? 'user_id_and_email_not_found'
      : 'email_not_found',
  });

  return null;
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
  const metadataUserId = extractUserIdFromPayload(payload);

  if (!metadataUserId && !email && !extractAccountEmailFromPayload(payload)) {
    const err = new Error('Missing required field: user_id or email');
    err.statusCode = 400;
    throw err;
  }

  const resolved = await resolvePaymentUser(payload);
  if (!resolved || !resolved.userId) {
    const err = new Error(
      'User not found for payment' +
      (metadataUserId ? ' user_id=' + metadataUserId : '') +
      (email ? ' email=' + email : '')
    );
    err.statusCode = 404;
    throw err;
  }

  const parsed = parsePlan(plan);

  const activateOpts = {
    userId: resolved.userId,
    email: resolved.email,
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
    userId: resolved.userId,
    email: resolved.email,
    checkoutEmail: resolved.checkoutEmail,
    matchMethod: resolved.matchMethod,
    plan: plan,
    planType: parsed.planType,
    billingCycle: parsed.billingCycle,
    phone: phone || undefined,
    expiresAt: parsed.expiresAt,
  });

  return {
    ok: true,
    userId: resolved.userId,
    email: resolved.email,
    checkoutEmail: resolved.checkoutEmail,
    matchMethod: resolved.matchMethod,
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
  extractUserIdFromPayload,
  resolvePaymentUser,
};
