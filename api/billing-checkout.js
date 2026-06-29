/**
 * Billing API handlers — checkout session creation.
 */
const billingDb = require('./billing-db');
const billingStripe = require('./billing-stripe');
const subscription = require('./subscription');
const env = require('./env');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Email',
};

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (typeof res.json === 'function') return res.status(statusCode).json(payload);
  if (typeof res.send === 'function') return res.status(statusCode).send(JSON.stringify(payload));
  throw new Error('sendJson: response adapter missing');
}

async function createCheckoutHandler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    if (!billingStripe.isStripeEnabled()) {
      return sendJson(res, 503, { error: 'Automatic checkout is not configured yet', code: 'CHECKOUT_UNAVAILABLE' });
    }

    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const user = await subscription.resolveUser(req, body);
    const billingCycle = body.billingCycle === 'yearly' ? 'yearly' : 'monthly';
    const planType = subscription.normalizeTier(body.planType || body.tier || 'pro');

    // Without a configured price ID a Stripe session cannot be created — signal the
    // client to fall back to the Grow checkout instead of surfacing a raw 500.
    if (!billingStripe.getPriceId(billingCycle)) {
      return sendJson(res, 503, {
        error: 'Stripe checkout is not configured for ' + billingCycle + ' billing',
        code: 'CHECKOUT_UNAVAILABLE',
      });
    }

    let stripeCustomerId = null;
    if (billingDb.isEnabled()) {
      try {
        const existing = await billingDb.fetchSubscriptionByUserId(user.id);
        if (existing && existing.stripe_customer_id) {
          stripeCustomerId = existing.stripe_customer_id;
        }
      } catch (lookupErr) {
        // Non-UUID demo/test user ids (e.g. "email:...") make the uuid column lookup
        // fail — that must not block checkout; just create a fresh Stripe customer.
        console.warn('[billing-checkout] subscription lookup skipped:', lookupErr.message || lookupErr);
      }
    }

    const session = await billingStripe.createCheckoutSession({
      userId: user.id,
      email: user.email,
      planType: planType,
      billingCycle: billingCycle,
      stripeCustomerId: stripeCustomerId,
    });

    return sendJson(res, 200, {
      data: {
        checkoutUrl: session.url,
        sessionId: session.id,
      },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return sendJson(res, status, { error: err.message || String(err) });
  }
}

module.exports = {
  createCheckoutHandler,
  corsHeaders,
};
