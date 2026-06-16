-- Supabase: Waldorf / Anthroposophical knowledge base for RAG
-- Run in Supabase SQL Editor (Dashboard → SQL → New query)
--
-- pgvector enables semantic search; full-text search works without embeddings.

create extension if not exists vector;

create table if not exists public.knowledge_base (
  id              uuid primary key default gen_random_uuid(),
  document_title  text not null,
  source_author   text,
  source_type     text not null default 'article'
    check (source_type in ('article', 'lecture', 'book', 'essay', 'other', 'community_teacher', 'ai_learned')),
  chunk_index     integer not null default 0,
  content         text not null,
  content_tsv     tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored,
  embedding       vector(1536),
  contributor_email text,
  contributor_name  text,
  grade_id          text,
  topic             text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists knowledge_base_content_tsv_idx
  on public.knowledge_base using gin (content_tsv);

create index if not exists knowledge_base_document_title_idx
  on public.knowledge_base (document_title);

create index if not exists knowledge_base_source_type_idx
  on public.knowledge_base (source_type);

create index if not exists knowledge_base_grade_topic_idx
  on public.knowledge_base (grade_id, topic);

create index if not exists knowledge_base_contributor_idx
  on public.knowledge_base (contributor_email);

-- IVFFlat index: create after ~100+ embedded rows for faster vector search.
-- create index if not exists knowledge_base_embedding_idx
--   on public.knowledge_base using ivfflat (embedding vector_cosine_ops) with (lists = 100);

comment on table public.knowledge_base is
  'Curated Waldorf / Anthroposophical text chunks with optional vector embeddings for RAG.';

create or replace function public.match_knowledge_base(
  query_embedding vector(1536),
  match_count int default 6,
  match_threshold float default 0.25
)
returns table (
  id uuid,
  document_title text,
  source_author text,
  source_type text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    kb.id,
    kb.document_title,
    kb.source_author,
    kb.source_type,
    kb.content,
    (1 - (kb.embedding <=> query_embedding))::float as similarity
  from public.knowledge_base kb
  where kb.embedding is not null
    and (1 - (kb.embedding <=> query_embedding)) > match_threshold
  order by kb.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

create or replace function public.search_knowledge_base_text(
  search_query text,
  match_count int default 6
)
returns table (
  id uuid,
  document_title text,
  source_author text,
  source_type text,
  content text,
  rank real
)
language plpgsql stable
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

  if tsq = ''::tsquery then
    return query
    select
      kb.id,
      kb.document_title,
      kb.source_author,
      kb.source_type,
      kb.content,
      0.5::real as rank
    from public.knowledge_base kb
    where kb.content ilike '%' || left(q, 120) || '%'
    order by kb.created_at desc
    limit greatest(match_count, 1);
    return;
  end if;

  return query
  select
    kb.id,
    kb.document_title,
    kb.source_author,
    kb.source_type,
    kb.content,
    ts_rank_cd(kb.content_tsv, tsq) as rank
  from public.knowledge_base kb
  where kb.content_tsv @@ tsq
  order by rank desc
  limit greatest(match_count, 1);
end;
$$;

alter table public.knowledge_base enable row level security;

drop policy if exists "knowledge_base_read" on public.knowledge_base;
create policy "knowledge_base_read"
  on public.knowledge_base for select
  using (true);

drop policy if exists "knowledge_base_insert" on public.knowledge_base;
create policy "knowledge_base_insert"
  on public.knowledge_base for insert
  with check (true);

drop policy if exists "knowledge_base_update" on public.knowledge_base;
create policy "knowledge_base_update"
  on public.knowledge_base for update
  using (true);

drop policy if exists "knowledge_base_delete" on public.knowledge_base;
create policy "knowledge_base_delete"
  on public.knowledge_base for delete
  using (true);
