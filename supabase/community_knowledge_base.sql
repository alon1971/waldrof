-- =============================================================================
-- Waldrof — community_knowledge_base (teacher-shared materials for hybrid RAG)
-- =============================================================================
-- Run in Supabase SQL Editor. Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- Stores parsed chunks from community uploads (PDF / Word / text) for retrieval
-- alongside ingested Drive archive and live Perplexity web search.

create extension if not exists vector;

create table if not exists public.community_knowledge_base (
  id                  uuid primary key default gen_random_uuid(),
  content             text not null,
  title               varchar(500) not null,
  author              varchar(255),
  contributor_email   varchar(320),
  contributor_name    varchar(255),
  grade_id            text,
  topic               text,
  chunk_index         integer not null default 0,
  source_material_id  uuid,
  file_name           text,
  file_path           text,
  file_type           text,
  content_tsv         tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored,
  embedding           vector(1536),
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint community_kb_content_not_empty
    check (char_length(trim(content)) > 0),
  constraint community_kb_title_not_empty
    check (char_length(trim(title)) > 0)
);

create index if not exists community_kb_content_fts_idx
  on public.community_knowledge_base using gin (content_tsv);

create index if not exists community_kb_grade_topic_idx
  on public.community_knowledge_base (grade_id, topic);

create index if not exists community_kb_contributor_idx
  on public.community_knowledge_base (contributor_email);

create index if not exists community_kb_created_at_idx
  on public.community_knowledge_base (created_at desc);

create index if not exists community_kb_source_material_idx
  on public.community_knowledge_base (source_material_id);

comment on table public.community_knowledge_base is
  'Parsed text chunks from teacher community uploads — hybrid search tier 3.';

-- Keyword search RPC (no embeddings required)
create or replace function public.search_community_knowledge_base_keywords(
  search_query text,
  match_count int default 8
)
returns table (
  id uuid,
  title varchar,
  author varchar,
  contributor_email varchar,
  contributor_name varchar,
  grade_id text,
  topic text,
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
      ckb.id,
      ckb.title,
      ckb.author,
      ckb.contributor_email,
      ckb.contributor_name,
      ckb.grade_id,
      ckb.topic,
      ckb.content,
      ts_rank_cd(ckb.content_tsv, tsq) as rank,
      ckb.created_at
    from public.community_knowledge_base ckb
    where ckb.content_tsv @@ tsq
    order by rank desc, ckb.created_at desc
    limit greatest(match_count, 1);
    return;
  end if;

  return query
  select
    ckb.id,
    ckb.title,
    ckb.author,
    ckb.contributor_email,
    ckb.contributor_name,
    ckb.grade_id,
    ckb.topic,
    ckb.content,
    0.5::real as rank,
    ckb.created_at
  from public.community_knowledge_base ckb
  where ckb.content ilike '%' || left(q, 120) || '%'
     or ckb.title ilike '%' || left(q, 120) || '%'
  order by ckb.created_at desc
  limit greatest(match_count, 1);
end;
$$;

-- Semantic vector search RPC (requires OPENAI embeddings on insert)
create or replace function public.match_community_knowledge_base(
  query_embedding vector(1536),
  match_count int default 6,
  match_threshold float default 0.22
)
returns table (
  id uuid,
  title varchar,
  author varchar,
  contributor_email varchar,
  contributor_name varchar,
  grade_id text,
  topic text,
  content text,
  similarity float
)
language sql
stable
as $$
  select
    ckb.id,
    ckb.title,
    ckb.author,
    ckb.contributor_email,
    ckb.contributor_name,
    ckb.grade_id,
    ckb.topic,
    ckb.content,
    (1 - (ckb.embedding <=> query_embedding))::float as similarity
  from public.community_knowledge_base ckb
  where ckb.embedding is not null
    and (1 - (ckb.embedding <=> query_embedding)) > match_threshold
  order by ckb.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

alter table public.community_knowledge_base enable row level security;

drop policy if exists "community_kb_select" on public.community_knowledge_base;
create policy "community_kb_select"
  on public.community_knowledge_base for select using (true);

drop policy if exists "community_kb_insert" on public.community_knowledge_base;
create policy "community_kb_insert"
  on public.community_knowledge_base for insert with check (true);

drop policy if exists "community_kb_update" on public.community_knowledge_base;
create policy "community_kb_update"
  on public.community_knowledge_base for update using (true);

drop policy if exists "community_kb_delete" on public.community_knowledge_base;
create policy "community_kb_delete"
  on public.community_knowledge_base for delete using (true);
