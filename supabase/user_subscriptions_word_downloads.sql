-- Add Word download counter for trial paywall
-- Run in Supabase SQL Editor (safe if column already exists)

alter table public.user_subscriptions
  add column if not exists word_downloads_count integer not null default 0
    check (word_downloads_count >= 0);

comment on column public.user_subscriptions.word_downloads_count is
  'Lifetime Word file downloads (trial cap 10; paid tiers unlimited)';
