-- Per-user search / Word download limits (admin-editable in Supabase).
-- Run in Supabase SQL Editor (safe to re-run).

alter table public.user_subscriptions
  add column if not exists search_limit_monthly integer default 2,
  add column if not exists word_downloads_limit integer default 17;

alter table public.user_subscriptions
  alter column search_limit_monthly set default 2;

alter table public.user_subscriptions
  alter column word_downloads_limit set default 17;

comment on column public.user_subscriptions.search_limit_monthly is
  'Max live searches: trial = lifetime cap; pro/standard = monthly cap (DB default 2)';
comment on column public.user_subscriptions.word_downloads_limit is
  'Max Word downloads for trial; NULL = unlimited pro/standard (DB default 17)';

-- Backfill existing rows where limits were never set.
update public.user_subscriptions
set
  search_limit_monthly = coalesce(
    search_limit_monthly,
    case
      when lower(coalesce(plan_type, 'trial')) = 'pro' then 25
      when lower(coalesce(plan_type, 'trial')) = 'standard' then 20
      else 2
    end
  ),
  word_downloads_limit = coalesce(
    word_downloads_limit,
    case
      when lower(coalesce(plan_type, 'trial')) = 'pro' then null
      when lower(coalesce(plan_type, 'trial')) = 'standard' then 20
      else 17
    end
  ),
  updated_at = now()
where search_limit_monthly is null
   or (word_downloads_limit is null and lower(coalesce(plan_type, 'trial')) = 'trial');
