-- Optional: add billing_cycle when checkout is live (not required for search quotas).
-- Run in Supabase SQL Editor if you want to persist monthly/yearly plan choice.

alter table public.user_subscriptions
  add column if not exists billing_cycle text
    check (billing_cycle is null or billing_cycle in ('monthly', 'yearly'));

comment on column public.user_subscriptions.billing_cycle is
  'Paid plan billing interval (monthly or yearly); null for trial';
