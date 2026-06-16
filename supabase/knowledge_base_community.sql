-- Extend knowledge_base for community teacher contributions & AI background learning
-- Run after knowledge_base.sql if the table already exists.

alter table public.knowledge_base
  add column if not exists contributor_email text,
  add column if not exists contributor_name text,
  add column if not exists grade_id text,
  add column if not exists topic text;

alter table public.knowledge_base drop constraint if exists knowledge_base_source_type_check;
alter table public.knowledge_base add constraint knowledge_base_source_type_check
  check (source_type in (
    'article', 'lecture', 'book', 'essay', 'other',
    'community_teacher', 'ai_learned'
  ));

create index if not exists knowledge_base_grade_topic_idx
  on public.knowledge_base (grade_id, topic);

create index if not exists knowledge_base_contributor_idx
  on public.knowledge_base (contributor_email);

comment on column public.knowledge_base.contributor_email is 'Teacher email when source_type = community_teacher';
comment on column public.knowledge_base.grade_id is 'Waldorf grade id (e.g. grade-3) for filtering RAG context';
