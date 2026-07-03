-- is_trial flag on user_subscriptions (source of truth alongside plan_type).
-- Run in Supabase SQL Editor (safe to re-run).

alter table public.user_subscriptions
  add column if not exists is_trial boolean not null default true;

alter table public.user_subscriptions
  alter column is_trial set default true;

comment on column public.user_subscriptions.is_trial is
  'When false, user is on a paid plan (see plan_type); when true, trial/free tier';

-- Sync is_trial from existing plan_type for rows not yet aligned.
update public.user_subscriptions
set
  is_trial = case
    when lower(coalesce(plan_type, 'trial')) in ('pro', 'standard') then false
    else true
  end,
  updated_at = now()
where is_trial is distinct from case
  when lower(coalesce(plan_type, 'trial')) in ('pro', 'standard') then false
  else true
end;
