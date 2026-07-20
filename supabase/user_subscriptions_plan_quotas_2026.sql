-- Align product quotas with the 3 support plans (safe to re-run).
-- Free (trial): 1 live search lifetime + 5 Word downloads total
-- One-time support (standard): 20 live searches lifetime, 20 Word downloads
-- Annual (pro): 25 live searches / month, unlimited Word

alter table public.user_subscriptions
  alter column search_limit_monthly set default 1;

alter table public.user_subscriptions
  alter column word_downloads_limit set default 5;

-- Stamp which calendar month search_count_monthly belongs to (pro monthly reset).
alter table public.user_subscriptions
  add column if not exists usage_month text;

comment on column public.user_subscriptions.search_limit_monthly is
  'Max live searches: trial/standard = lifetime cap; pro = monthly cap (25)';
comment on column public.user_subscriptions.word_downloads_limit is
  'Max Word downloads: trial=5, standard=20 (lifetime); NULL = unlimited (pro)';
comment on column public.user_subscriptions.usage_month is
  'YYYY-MM key for pro monthly search counter; reset search_count_monthly when this changes';

-- Update trial rows still on legacy free caps (2/3 searches, 17 downloads).
update public.user_subscriptions
set
  search_limit_monthly = 1,
  word_downloads_limit = 5,
  updated_at = now()
where lower(coalesce(plan_type, 'trial')) = 'trial'
  and coalesce(is_trial, true) = true
  and (
    coalesce(search_limit_monthly, 0) in (2, 3)
    or coalesce(word_downloads_limit, 0) in (17)
    or search_limit_monthly is null
    or word_downloads_limit is null
  );

-- Paid one-time support (standard): lifetime pool of 20.
update public.user_subscriptions
set
  search_limit_monthly = 20,
  word_downloads_limit = 20,
  updated_at = now()
where lower(coalesce(plan_type, '')) = 'standard'
  and coalesce(is_trial, false) = false;

-- Annual pro: 25 / month (overwrite legacy 30 and any other drift).
update public.user_subscriptions
set
  search_limit_monthly = 25,
  word_downloads_limit = null,
  updated_at = now()
where lower(coalesce(plan_type, '')) = 'pro'
  and coalesce(is_trial, false) = false
  and (
    coalesce(search_limit_monthly, 0) <> 25
    or word_downloads_limit is not null
  );
