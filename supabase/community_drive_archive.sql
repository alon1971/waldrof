-- Community Drive archive — Gemini summaries of Google Drive materials.
-- CACHE SOURCE ISOLATION: fully separate from Perplexity public.cached_results.
-- Lookups for מאגר קהילתי / Drive must use this table only (never cached_results).
-- Run in Supabase SQL editor. Server APIs use SERVICE_ROLE_KEY and bypass RLS.
-- Safe to re-run: CREATE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.

create table if not exists public.community_drive_archive (
  id uuid primary key default gen_random_uuid(),
  archive_key text not null unique,
  search_query text not null default '',
  query_text text not null default '',
  grade_id text not null default '',
  grade_level text not null default '',
  topic text not null default '',
  summary_md text not null default '',
  summary_text text not null default '',
  community_status text not null default 'empty',
  source_fingerprint text not null default '',
  drive_fingerprint text not null default '',
  source_file_ids jsonb not null default '[]'::jsonb,
  file_refs jsonb not null default '[]'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Repair tables created before archive_key / search_query / summary_text existed
alter table public.community_drive_archive add column if not exists archive_key text;
alter table public.community_drive_archive add column if not exists search_query text not null default '';
alter table public.community_drive_archive add column if not exists query_text text not null default '';
alter table public.community_drive_archive add column if not exists grade_id text not null default '';
alter table public.community_drive_archive add column if not exists grade_level text not null default '';
alter table public.community_drive_archive add column if not exists topic text not null default '';
alter table public.community_drive_archive add column if not exists summary_md text not null default '';
alter table public.community_drive_archive add column if not exists summary_text text not null default '';
alter table public.community_drive_archive add column if not exists community_status text not null default 'empty';
alter table public.community_drive_archive add column if not exists source_fingerprint text not null default '';
alter table public.community_drive_archive add column if not exists drive_fingerprint text not null default '';
alter table public.community_drive_archive add column if not exists source_file_ids jsonb not null default '[]'::jsonb;
alter table public.community_drive_archive add column if not exists file_refs jsonb not null default '[]'::jsonb;
alter table public.community_drive_archive add column if not exists citations jsonb not null default '[]'::jsonb;
alter table public.community_drive_archive add column if not exists model text;
alter table public.community_drive_archive add column if not exists created_at timestamptz not null default now();
alter table public.community_drive_archive add column if not exists updated_at timestamptz not null default now();

-- Keep dual summary / fingerprint / grade columns in sync for older + newer writers
update public.community_drive_archive
set search_query = coalesce(nullif(trim(search_query), ''), nullif(trim(query_text), ''), '')
where coalesce(trim(search_query), '') = '';

update public.community_drive_archive
set query_text = coalesce(nullif(trim(query_text), ''), nullif(trim(search_query), ''), '')
where coalesce(trim(query_text), '') = '';

update public.community_drive_archive
set summary_text = coalesce(nullif(trim(summary_text), ''), nullif(trim(summary_md), ''), '')
where coalesce(trim(summary_text), '') = '';

update public.community_drive_archive
set summary_md = coalesce(nullif(trim(summary_md), ''), nullif(trim(summary_text), ''), '')
where coalesce(trim(summary_md), '') = '';

update public.community_drive_archive
set grade_level = coalesce(nullif(trim(grade_level), ''), nullif(trim(grade_id), ''), '')
where coalesce(trim(grade_level), '') = '';

update public.community_drive_archive
set drive_fingerprint = coalesce(nullif(trim(drive_fingerprint), ''), nullif(trim(source_fingerprint), ''), '')
where coalesce(trim(drive_fingerprint), '') = '';

create unique index if not exists community_drive_archive_archive_key_uidx
  on public.community_drive_archive (archive_key);

create index if not exists community_drive_archive_updated_at_idx
  on public.community_drive_archive (updated_at desc);

create index if not exists community_drive_archive_search_query_idx
  on public.community_drive_archive (search_query);

create index if not exists community_drive_archive_query_idx
  on public.community_drive_archive (query_text);

create index if not exists community_drive_archive_grade_id_idx
  on public.community_drive_archive (grade_id);

alter table public.community_drive_archive enable row level security;

-- Public read (UI may hydrate from API; direct PostgREST read is ok for summaries)
drop policy if exists "community_drive_archive_select_public" on public.community_drive_archive;
create policy "community_drive_archive_select_public"
  on public.community_drive_archive for select
  using (true);

-- Writes only via service role (no authenticated insert/update policies)
drop policy if exists "community_drive_archive_insert_auth" on public.community_drive_archive;
drop policy if exists "community_drive_archive_update_auth" on public.community_drive_archive;
drop policy if exists "community_drive_archive_delete_auth" on public.community_drive_archive;
