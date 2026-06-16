-- =============================================================================
-- Waldrof — knowledge_base setup (Anthroposophical / Waldorf pedagogical RAG)
-- =============================================================================
--
-- WHAT THIS SCRIPT DOES
--   • Creates public.knowledge_base for text chunks (Steiner lectures, articles,
--     teacher-shared lesson plans, etc.)
--   • Adds a full-text search (GIN) index on content for fast keyword matching
--     without external embedding APIs
--   • Exposes search_knowledge_base_keywords() for server-side RPC queries
--   • Enables RLS with read/insert policies for the app server
--
-- HOW TO RUN IN SUPABASE DASHBOARD
--   1. Open https://supabase.com/dashboard and select your Waldrof project
--   2. In the left sidebar, click SQL → New query
--   3. Copy this ENTIRE file and paste it into the editor
--   4. Click Run (or press Ctrl+Enter / Cmd+Enter)
--   5. Confirm success: Table Editor → public → knowledge_base should appear
--
-- NOTE: Safe to re-run — uses IF NOT EXISTS / CREATE OR REPLACE where possible.
--       If you previously ran supabase/knowledge_base.sql (older schema with
--       document_title / source_author), do NOT run this on the same project
--       without migrating or dropping the old table first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Table: knowledge_base
-- -----------------------------------------------------------------------------
create table if not exists public.knowledge_base (
  id                uuid primary key default gen_random_uuid(),
  content           text not null,
  title             varchar(500) not null,
  author            varchar(255),
  contributor_email varchar(320),
  created_at        timestamptz not null default now(),

  constraint knowledge_base_content_not_empty
    check (char_length(trim(content)) > 0),

  constraint knowledge_base_title_not_empty
    check (char_length(trim(title)) > 0)
);

comment on table public.knowledge_base is
  'Waldorf / Anthroposophical pedagogical text chunks for RAG keyword search.';

comment on column public.knowledge_base.content is
  'A single semantic paragraph or chunk of pedagogical text.';

comment on column public.knowledge_base.title is
  'Source title or topic (e.g. GA lecture name, main-lesson block).';

comment on column public.knowledge_base.author is
  'Original author (e.g. Rudolf Steiner) or sharing teacher display name.';

comment on column public.knowledge_base.contributor_email is
  'Email of the community member who uploaded this chunk (null for admin imports).';

-- -----------------------------------------------------------------------------
-- 2. Full-text search index on content
-- -----------------------------------------------------------------------------
-- Generated tsvector column keeps the index in sync automatically on INSERT/UPDATE.
alter table public.knowledge_base
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('simple', coalesce(content, ''))) stored;

create index if not exists knowledge_base_content_fts_idx
  on public.knowledge_base using gin (content_tsv);

create index if not exists knowledge_base_title_idx
  on public.knowledge_base (title);

create index if not exists knowledge_base_author_idx
  on public.knowledge_base (author);

create index if not exists knowledge_base_contributor_email_idx
  on public.knowledge_base (contributor_email);

create index if not exists knowledge_base_created_at_idx
  on public.knowledge_base (created_at desc);

-- -----------------------------------------------------------------------------
-- 3. Keyword search RPC (used by the Waldrof server — no embeddings required)
-- -----------------------------------------------------------------------------
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

  -- Primary: PostgreSQL full-text search on content
  if tsq <> ''::tsquery then
    return query
    select
      kb.id,
      kb.title,
      kb.author,
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

  -- Fallback: ILIKE substring when tokenization yields an empty query
  return query
  select
    kb.id,
    kb.title,
    kb.author,
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

comment on function public.search_knowledge_base_keywords is
  'Full-text keyword search over knowledge_base.content for Waldrof RAG.';

-- -----------------------------------------------------------------------------
-- 4. Row Level Security (server uses service_role key; anon read allowed)
-- -----------------------------------------------------------------------------
alter table public.knowledge_base enable row level security;

drop policy if exists "knowledge_base_select" on public.knowledge_base;
create policy "knowledge_base_select"
  on public.knowledge_base
  for select
  using (true);

drop policy if exists "knowledge_base_insert" on public.knowledge_base;
create policy "knowledge_base_insert"
  on public.knowledge_base
  for insert
  with check (true);

drop policy if exists "knowledge_base_update" on public.knowledge_base;
create policy "knowledge_base_update"
  on public.knowledge_base
  for update
  using (true);

drop policy if exists "knowledge_base_delete" on public.knowledge_base;
create policy "knowledge_base_delete"
  on public.knowledge_base
  for delete
  using (true);

-- -----------------------------------------------------------------------------
-- 5. Quick verification (optional — results appear in the SQL output panel)
-- -----------------------------------------------------------------------------
-- insert into public.knowledge_base (content, title, author)
-- values (
--   'בגיל זה הילד חווה את העולם דרך דימוי וסיפור. שיעור ראשון בנושא האור יכול להתחיל בסיפור מעשייה על נר דולק בחושך.',
--   'תקופת האור — שיעור ראשון',
--   'דוגמה פדגוגית'
-- );
--
-- select * from public.search_knowledge_base_keywords('אור שיעור', 5);
