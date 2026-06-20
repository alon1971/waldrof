/**
 * Stripe subscription billing — checkout, cancel-at-period-end, webhook helpers.
 */
const env = require('./env');

const LOG_PREFIX = '[billing-stripe]';

function log(event, detail) {
  console.log(LOG_PREFIX, event, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function getStripeSecretKey() {
  return String(process.env.STRIPE_SECRET_KEY || '').trim();
}

function isStripeEnabled() {
  return Boolean(getStripeSecretKey());
}

function getStripe() {
  if (!isStripeEnabled()) throw new Error('STRIPE_SECRET_KEY not configured');
  // eslint-disable-next-line global-require
  const Stripe = require('stripe');
  return new Stripe(getStripeSecretKey(), { apiVersion: '2024-11-20.acacia' });
}

function getWebhookSecret() {
  return String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
}

function getPriceId(billingCycle) {
  const cycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
  if (cycle === 'yearly') {
    return String(process.env.STRIPE_PRICE_PRO_YEARLY || '').trim();
  }
  return String(process.env.STRIPE_PRICE_PRO_MONTHLY || '').trim();
}

function planTypeFromMetadata(metadata) {
  const raw = metadata && (metadata.plan_type || metadata.tier || metadata.plan);
  const tier = String(raw || 'pro').toLowerCase();
  if (tier === 'standard' || tier === 'pro') return 'pro';
  return 'pro';
}

function billingCycleFromMetadata(metadata) {
  const raw = metadata && (metadata.billing_cycle || metadata.billingCycle);
  return raw === 'yearly' ? 'yearly' : 'monthly';
}

function expiresAtFromStripeSubscription(subscription) {
  if (!subscription) return null;
  const end = subscription.current_period_end;
  if (!end) return null;
  return new Date(end * 1000).toISOString();
}

async function createCheckoutSession(options) {
  const opts = options || {};
  const billingCycle = opts.billingCycle === 'yearly' ? 'yearly' : 'monthly';
  const priceId = getPriceId(billingCycle);
  if (!priceId) {
    throw new Error('Stripe price ID not configured for ' + billingCycle + ' billing');
  }

  const stripe = getStripe();
  const successUrl = opts.successUrl || env.getBillingSuccessUrl();
  const cancelUrl = opts.cancelUrl || env.getBillingCancelUrl();

  const sessionParams = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: opts.userId || undefined,
    customer_email: opts.email || undefined,
    metadata: {
      user_id: opts.userId || '',
      plan_type: opts.planType || 'pro',
      billing_cycle: billingCycle,
    },
    subscription_data: {
      metadata: {
        user_id: opts.userId || '',
        plan_type: opts.planType || 'pro',
        billing_cycle: billingCycle,
      },
    },
  };

  if (opts.stripeCustomerId) {
    sessionParams.customer = opts.stripeCustomerId;
    delete sessionParams.customer_email;
  }

  const session = await stripe.checkout.sessions.create(sessionParams);
  log('checkout_created', { sessionId: session.id, userId: opts.userId });
  return session;
}

async function cancelSubscriptionAtPeriodEnd(stripeSubscriptionId) {
  if (!stripeSubscriptionId) {
    throw new Error('No Stripe subscription on file');
  }
  const stripe = getStripe();
  const updated = await stripe.subscriptions.update(stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
  log('cancel_at_period_end', { subscriptionId: stripeSubscriptionId });
  return updated;
}

async function retrieveSubscription(stripeSubscriptionId) {
  const stripe = getStripe();
  return stripe.subscriptions.retrieve(stripeSubscriptionId);
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = getWebhookSecret();
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

function mrrForRow(row) {
  const tier = String(row.plan_type || 'trial').toLowerCase();
  if (tier === 'trial') return 0;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return 0;
  const cycle = row.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
  if (cycle === 'yearly') return 468 / 12;
  return 49;
}

module.exports = {
  isStripeEnabled,
  getStripeSecretKey,
  getWebhookSecret,
  getPriceId,
  planTypeFromMetadata,
  billingCycleFromMetadata,
  expiresAtFromStripeSubscription,
  createCheckoutSession,
  cancelSubscriptionAtPeriodEnd,
  retrieveSubscription,
  verifyWebhookSignature,
  mrrForRow,
};
