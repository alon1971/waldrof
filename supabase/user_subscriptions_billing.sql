-- Payment provider linkage for automated subscription lifecycle.
-- Run in Supabase SQL Editor after user_subscriptions_billing_cycle.sql.

alter table public.user_subscriptions
  add column if not exists billing_cycle text
    check (billing_cycle is null or billing_cycle in ('monthly', 'yearly')),
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists payment_provider text;

create index if not exists user_subscriptions_stripe_subscription_id_idx
  on public.user_subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;

comment on column public.user_subscriptions.stripe_subscription_id is
  'Stripe subscription id for webhook sync and cancel-at-period-end';
comment on column public.user_subscriptions.payment_provider is
  'stripe | grow | hameshulam — set by webhook handler';
