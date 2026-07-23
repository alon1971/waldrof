-- Supabase: Perplexity / live-web pedagogical API cache table
-- CACHE SOURCE ISOLATION: Perplexity/web only — NOT community Drive summaries.
-- Community Drive Gemini summaries use public.community_drive_archive.
-- Run in Supabase SQL Editor (Dashboard → SQL → New query)

create table if not exists public.cached_results (
  cache_key   text primary key,
  phase       text not null,
  grade_id    text,
  topic       text,
  query_text  text,
  user_id     text,
  user_email  text,
  grade_label text,
  result_data jsonb not null,
  hit_count   integer not null default 0,
  created_at  timestamptz not null default now(),
  last_hit_at timestamptz
);

create index if not exists cached_results_phase_idx on public.cached_results (phase);
create index if not exists cached_results_topic_idx on public.cached_results (topic);

comment on table public.cached_results is
  'Perplexity/live-web cache for /api/generate (keyed by buildCacheKey). Isolated from community_drive_archive.';

-- Service role (used by Render server) bypasses RLS.
-- If you only use SUPABASE_ANON_KEY on the server, enable these policies:

alter table public.cached_results enable row level security;

drop policy if exists "cached_results_server_read" on public.cached_results;
create policy "cached_results_server_read"
  on public.cached_results for select
  using (true);

drop policy if exists "cached_results_server_write" on public.cached_results;
create policy "cached_results_server_write"
  on public.cached_results for insert
  with check (true);

drop policy if exists "cached_results_server_update" on public.cached_results;
create policy "cached_results_server_update"
  on public.cached_results for update
  using (true);
