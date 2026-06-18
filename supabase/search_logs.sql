-- Live search audit log — profile_id must exist in public.profiles.
-- Run profiles.sql first.

create table if not exists public.search_logs (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  phase text,
  grade_id text,
  topic text,
  query_text text,
  from_cache boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists search_logs_profile_created_idx
  on public.search_logs (profile_id, created_at desc);

comment on table public.search_logs is 'Audit trail for live Waldorf /api/generate searches per teacher profile';

alter table public.search_logs enable row level security;

drop policy if exists "Users read own search logs" on public.search_logs;
create policy "Users read own search logs"
  on public.search_logs for select
  using (auth.uid() = profile_id);

drop policy if exists "Users insert own search logs" on public.search_logs;
create policy "Users insert own search logs"
  on public.search_logs for insert
  with check (auth.uid() = profile_id);
