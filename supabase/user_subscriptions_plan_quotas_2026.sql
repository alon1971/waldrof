-- Align product quotas with the 3 support plans (safe to re-run).
-- Free (trial): 1 live search lifetime + 5 Word downloads total
-- One-time support (standard): 20 live searches lifetime, unlimited Word
-- Annual (pro): 25 live searches / month, unlimited Word

alter table public.user_subscriptions
  alter column search_limit_monthly set default 1;

alter table public.user_subscriptions
  alter column word_downloads_limit set default 5;

comment on column public.user_subscriptions.search_limit_monthly is
  'Max live searches: trial/standard = lifetime cap; pro = monthly cap';
comment on column public.user_subscriptions.word_downloads_limit is
  'Max Word downloads for trial (lifetime total); NULL = unlimited for paid plans';

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
  word_downloads_limit = null,
  updated_at = now()
where lower(coalesce(plan_type, '')) = 'standard'
  and coalesce(is_trial, false) = false;

-- Annual pro: 25 / month.
update public.user_subscriptions
set
  search_limit_monthly = 25,
  word_downloads_limit = null,
  updated_at = now()
where lower(coalesce(plan_type, '')) = 'pro'
  and coalesce(is_trial, false) = false;
