-- user_subscriptions — commercial tier limits & billing state
-- Run in Supabase SQL Editor after enabling auth

create table if not exists public.user_subscriptions (
  user_id text primary key,
  user_email text,
  tier text not null default 'trial'
    check (tier in ('trial', 'standard', 'pro')),
  billing_cycle text check (billing_cycle is null or billing_cycle in ('monthly', 'yearly')),
  trial_searches_used integer not null default 0 check (trial_searches_used >= 0),
  word_downloads_count integer not null default 0 check (word_downloads_count >= 0),
  monthly_searches_used integer not null default 0 check (monthly_searches_used >= 0),
  usage_month text,
  auto_renew boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_subscriptions_email_idx
  on public.user_subscriptions (user_email);

-- One row per teacher email (NULLs allowed). See user_subscriptions_email_unique.sql for
-- production backfill + constraint on existing databases.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_subscriptions_user_email_key'
      and conrelid = 'public.user_subscriptions'::regclass
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_user_email_key unique (user_email);
  end if;
end $$;

comment on table public.user_subscriptions is 'Per-user subscription tier, search quotas, and auto-renew flag';
comment on column public.user_subscriptions.trial_searches_used is 'Lifetime trial searches (cap 10)';
comment on column public.user_subscriptions.word_downloads_count is 'Lifetime Word downloads (trial cap 10)';
comment on column public.user_subscriptions.monthly_searches_used is 'Searches in current usage_month for paid tiers';
comment on column public.user_subscriptions.auto_renew is 'When false, subscription ends at current billing period';

alter table public.user_subscriptions enable row level security;

create policy "Users read own subscription"
  on public.user_subscriptions for select
  using (auth.uid()::text = user_id);

create policy "Users update own subscription"
  on public.user_subscriptions for update
  using (auth.uid()::text = user_id);
