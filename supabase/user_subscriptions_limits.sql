-- Per-user search / Word download limits (admin-editable in Supabase).
-- Run in Supabase SQL Editor (safe to re-run).

alter table public.user_subscriptions
  add column if not exists search_limit_monthly integer,
  add column if not exists word_downloads_limit integer;

comment on column public.user_subscriptions.search_limit_monthly is
  'Max live searches: trial = lifetime cap; pro/standard = monthly cap';
comment on column public.user_subscriptions.word_downloads_limit is
  'Max Word downloads for trial; NULL = unlimited (pro/standard)';

-- Backfill defaults: trial 2 searches + 5 downloads; paid tiers 30 searches/month, unlimited downloads.
update public.user_subscriptions
set
  search_limit_monthly = coalesce(
    search_limit_monthly,
    case
      when lower(coalesce(plan_type, 'trial')) in ('pro', 'standard') then 30
      else 2
    end
  ),
  word_downloads_limit = coalesce(
    word_downloads_limit,
    case
      when lower(coalesce(plan_type, 'trial')) in ('pro', 'standard') then null
      else 5
    end
  ),
  updated_at = now()
where search_limit_monthly is null
   or (word_downloads_limit is null and lower(coalesce(plan_type, 'trial')) = 'trial');
