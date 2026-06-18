-- =============================================================================
-- Waldrof — align knowledge_base schema with the app (title/author + keyword RPC)
-- Run once in Supabase SQL Editor AFTER creating knowledge_base.
--
-- Handles both cases:
--   • Legacy table from supabase/knowledge_base.sql (document_title, source_author)
--   • Already migrated table from supabase/setup_knowledge_base.sql (title, author)
-- =============================================================================

-- 1. Legacy → app column names (no-op if already migrated)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'knowledge_base' and column_name = 'document_title'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'knowledge_base' and column_name = 'title'
  ) then
    alter table public.knowledge_base rename column document_title to title;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'knowledge_base' and column_name = 'source_author'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'knowledge_base' and column_name = 'author'
  ) then
    alter table public.knowledge_base rename column source_author to author;
  end if;
end $$;

-- 2. Ensure FTS column exists (legacy tables already have content_tsv)
alter table public.knowledge_base
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('simple', coalesce(content, ''))) stored;

create index if not exists knowledge_base_content_fts_idx
  on public.knowledge_base using gin (content_tsv);

-- 3. Keyword search RPC used by api/rag.js
create or replace function public.search_knowledge_base_keywords(
  search_query text,
  match_count int default 8
)
returns table (
  id uuid,
  title varchar,
  author varchar,
  contributor_email varchar,
  content text,
  rank real,
  created_at timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  tsq tsquery;
  q text;
begin
  q := trim(coalesce(search_query, ''));
  if q = '' then
    return;
  end if;

  tsq := plainto_tsquery('simple', q);

  if tsq <> ''::tsquery then
    return query
    select
      kb.id,
      kb.title::varchar,
      kb.author::varchar,
      kb.contributor_email,
      kb.content,
      ts_rank_cd(kb.content_tsv, tsq) as rank,
      kb.created_at
    from public.knowledge_base kb
    where kb.content_tsv @@ tsq
    order by rank desc, kb.created_at desc
    limit greatest(match_count, 1);
    return;
  end if;

  return query
  select
    kb.id,
    kb.title::varchar,
    kb.author::varchar,
    kb.contributor_email,
    kb.content,
    0.5::real as rank,
    kb.created_at
  from public.knowledge_base kb
  where kb.content ilike '%' || left(q, 120) || '%'
     or kb.title ilike '%' || left(q, 120) || '%'
  order by kb.created_at desc
  limit greatest(match_count, 1);
end;
$$;

-- 4. RLS (safe to re-run)
alter table public.knowledge_base enable row level security;

drop policy if exists "knowledge_base_select" on public.knowledge_base;
create policy "knowledge_base_select" on public.knowledge_base for select using (true);

drop policy if exists "knowledge_base_insert" on public.knowledge_base;
create policy "knowledge_base_insert" on public.knowledge_base for insert with check (true);

drop policy if exists "knowledge_base_read" on public.knowledge_base;
create policy "knowledge_base_read" on public.knowledge_base for select using (true);

drop policy if exists "knowledge_base_insert" on public.knowledge_base;
create policy "knowledge_base_insert" on public.knowledge_base for insert with check (true);
