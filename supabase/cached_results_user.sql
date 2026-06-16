-- Extend cached_results for per-teacher search history
-- Run in Supabase SQL Editor after cached_results.sql

alter table public.cached_results
  add column if not exists user_id text,
  add column if not exists user_email text,
  add column if not exists grade_label text;

create index if not exists cached_results_user_id_idx
  on public.cached_results (user_id);

create index if not exists cached_results_user_email_idx
  on public.cached_results (user_email);

create index if not exists cached_results_user_topic_idx
  on public.cached_results (user_id, phase, created_at desc);

comment on column public.cached_results.user_id is 'Supabase auth user id or mock id — scopes search history';
comment on column public.cached_results.user_email is 'Teacher email for history fallback matching';
