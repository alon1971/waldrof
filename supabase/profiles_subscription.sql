-- Billing lifecycle columns for profiles (Pro User status + expiry).
-- Run in Supabase SQL Editor.

alter table public.profiles
  add column if not exists subscription_status text,
  add column if not exists subscription_expires_at timestamptz;

comment on column public.profiles.subscription_status is
  'Display status e.g. Pro User, Trial — synced from payment webhooks';
comment on column public.profiles.subscription_expires_at is
  'Paid access end date (mirrors user_subscriptions.expires_at)';
