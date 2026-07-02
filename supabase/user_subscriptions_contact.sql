-- Teacher contact columns on user_subscriptions for Supabase admin / CRM.
-- Run in Supabase SQL Editor (safe to re-run).

alter table public.user_subscriptions
  add column if not exists user_email text,
  add column if not exists user_full_name text,
  add column if not exists user_phone text;

create index if not exists user_subscriptions_user_email_idx
  on public.user_subscriptions (lower(user_email))
  where user_email is not null and btrim(user_email) <> '';

comment on column public.user_subscriptions.user_email is 'Teacher email (denormalized for admin)';
comment on column public.user_subscriptions.user_full_name is 'Teacher full display name';
comment on column public.user_subscriptions.user_phone is 'Teacher phone number';

-- Backfill email + name from profiles and auth.users for existing rows.
update public.user_subscriptions us
set
  user_email = coalesce(
    nullif(btrim(us.user_email), ''),
    nullif(btrim(p.email), ''),
    nullif(btrim(au.email), '')
  ),
  user_full_name = coalesce(
    nullif(btrim(us.user_full_name), ''),
    nullif(btrim(p.display_name), ''),
    nullif(btrim(au.raw_user_meta_data->>'full_name'), ''),
    nullif(btrim(au.raw_user_meta_data->>'name'), ''),
    nullif(btrim(split_part(coalesce(au.email, p.email, us.user_email), '@', 1)), '')
  ),
  user_phone = coalesce(
    nullif(btrim(us.user_phone), ''),
    nullif(btrim(au.raw_user_meta_data->>'phone'), ''),
    nullif(btrim(au.raw_user_meta_data->>'phone_number'), ''),
    nullif(btrim(au.raw_user_meta_data->>'mobile'), ''),
    nullif(btrim(au.phone), '')
  ),
  updated_at = now()
from auth.users au
left join public.profiles p on p.id = au.id
where au.id::text = us.user_id::text
  and (
    nullif(btrim(us.user_email), '') is null
    or nullif(btrim(us.user_full_name), '') is null
    or nullif(btrim(us.user_phone), '') is null
  );
