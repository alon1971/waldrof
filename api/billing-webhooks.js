/**
 * Stripe webhook handler — activates Pro subscriptions and syncs lifecycle events.
 */
const billingDb = require('./billing-db');
const billingStripe = require('./billing-stripe');

const LOG_PREFIX = '[billing-webhook]';

function log(event, detail) {
  console.log(LOG_PREFIX, event, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function resolveUserIdFromStripeObject(obj) {
  const metadata = (obj && obj.metadata) || {};
  if (metadata.user_id) return metadata.user_id;
  const email = (obj && obj.customer_email) || metadata.email || (obj && obj.customer_details && obj.customer_details.email);
  if (email) {
    const userId = await billingDb.findUserIdByEmail(email);
    if (userId) return userId;
  }
  return null;
}

async function handleCheckoutCompleted(session) {
  const userId = session.client_reference_id || await resolveUserIdFromStripeObject(session);
  const email = session.customer_email || (session.customer_details && session.customer_details.email) || '';
  if (!userId) {
    log('checkout_no_user', { sessionId: session.id, email: email });
    return { ok: false, reason: 'user_not_found' };
  }

  let expiresAt = null;
  let autoRenew = true;
  if (session.subscription) {
    const sub = await billingStripe.retrieveSubscription(session.subscription);
    expiresAt = billingStripe.expiresAtFromStripeSubscription(sub);
    autoRenew = !sub.cancel_at_period_end;
  }

  const metadata = session.metadata || {};
  await billingDb.activatePaidSubscription({
    userId: userId,
    email: email,
    planType: billingStripe.planTypeFromMetadata(metadata),
    billingCycle: billingStripe.billingCycleFromMetadata(metadata),
    expiresAt: expiresAt,
    stripeCustomerId: session.customer || null,
    stripeSubscriptionId: session.subscription || null,
    autoRenew: autoRenew,
    paymentProvider: 'stripe',
  });

  return { ok: true, userId: userId };
}

async function handleSubscriptionUpdated(subscription) {
  const userId = await resolveUserIdFromStripeObject(subscription);
  if (!userId) {
    const existing = await billingDb.fetchSubscriptionByStripeId(subscription.id);
    if (!existing) return { ok: false, reason: 'user_not_found' };
    return syncSubscriptionForUser(existing.user_id, subscription);
  }
  return syncSubscriptionForUser(userId, subscription);
}

async function syncSubscriptionForUser(userId, subscription) {
  const metadata = subscription.metadata || {};
  const status = subscription.status;
  const expiresAt = billingStripe.expiresAtFromStripeSubscription(subscription);
  const autoRenew = !subscription.cancel_at_period_end && status === 'active';

  if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
    if (expiresAt && new Date(expiresAt).getTime() > Date.now()) {
      await billingDb.markSubscriptionCancelledAtPeriodEnd(userId, expiresAt);
      return { ok: true, userId: userId, status: 'access_until_expiry' };
    }
    await billingDb.downgradeExpiredSubscription(userId);
    return { ok: true, userId: userId, status: 'downgraded' };
  }

  await billingDb.activatePaidSubscription({
    userId: userId,
    planType: billingStripe.planTypeFromMetadata(metadata),
    billingCycle: billingStripe.billingCycleFromMetadata(metadata),
    expiresAt: expiresAt,
    stripeCustomerId: subscription.customer || null,
    stripeSubscriptionId: subscription.id,
    autoRenew: autoRenew,
    paymentProvider: 'stripe',
  });

  return { ok: true, userId: userId, status: status };
}

async function handleSubscriptionDeleted(subscription) {
  const existing = await billingDb.fetchSubscriptionByStripeId(subscription.id);
  const userId = (existing && existing.user_id) || await resolveUserIdFromStripeObject(subscription);
  if (!userId) return { ok: false, reason: 'user_not_found' };

  const expiresAt = billingStripe.expiresAtFromStripeSubscription(subscription);
  if (expiresAt && new Date(expiresAt).getTime() > Date.now()) {
    await billingDb.markSubscriptionCancelledAtPeriodEnd(userId, expiresAt);
    return { ok: true, userId: userId, status: 'access_until_expiry' };
  }

  await billingDb.downgradeExpiredSubscription(userId);
  return { ok: true, userId: userId, status: 'downgraded' };
}

async function handleInvoicePaid(invoice) {
  if (!invoice.subscription) return { ok: true, skipped: true };
  const sub = await billingStripe.retrieveSubscription(invoice.subscription);
  return handleSubscriptionUpdated(sub);
}

async function processStripeEvent(event) {
  const type = event.type;
  log('event', { type: type, id: event.id });

  switch (type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(event.data.object);
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(event.data.object);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event.data.object);
    case 'invoice.paid':
      return handleInvoicePaid(event.data.object);
    default:
      return { ok: true, ignored: true, type: type };
  }
}

async function handleStripeWebhookRequest(req, rawBody) {
  if (!billingStripe.isStripeEnabled()) {
    const err = new Error('Stripe billing not configured');
    err.statusCode = 503;
    throw err;
  }
  if (!billingDb.isEnabled()) {
    const err = new Error('Supabase service role required for billing webhooks');
    err.statusCode = 503;
    throw err;
  }

  const signature = req.headers['stripe-signature'] || req.headers['Stripe-Signature'];
  if (!signature) {
    const err = new Error('Missing Stripe-Signature header');
    err.statusCode = 400;
    throw err;
  }

  const event = billingStripe.verifyWebhookSignature(rawBody, signature);
  const result = await processStripeEvent(event);
  return { received: true, type: event.type, result: result };
}

module.exports = {
  handleStripeWebhookRequest,
  processStripeEvent,
};
