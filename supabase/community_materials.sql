-- Community materials catalog + storage policies for Waldrof
-- Run in Supabase SQL editor. Server APIs use SERVICE_ROLE_KEY and bypass RLS.

-- ---------------------------------------------------------------------------
-- Table: community_materials (catalog index)
-- ---------------------------------------------------------------------------
create table if not exists public.community_materials (
  id uuid primary key default gen_random_uuid(),
  grade_level text not null,
  topic text not null,
  file_path text,
  file_name text,
  notes text,
  user_id uuid,
  google_docs_url text,
  created_at timestamptz not null default now()
);

create index if not exists community_materials_grade_topic_idx
  on public.community_materials (grade_level, topic);

create index if not exists community_materials_created_at_idx
  on public.community_materials (created_at desc);

alter table public.community_materials enable row level security;

-- Public read for catalog browsing (anon + authenticated)
drop policy if exists "community_materials_select_public" on public.community_materials;
create policy "community_materials_select_public"
  on public.community_materials for select
  using (true);

-- Writes go through Render API with service role; block direct client mutations
drop policy if exists "community_materials_insert_anon" on public.community_materials;
drop policy if exists "community_materials_update_anon" on public.community_materials;
drop policy if exists "community_materials_delete_anon" on public.community_materials;

-- ---------------------------------------------------------------------------
-- Storage bucket: community-uploads
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('community-uploads', 'community-uploads', true, 5242880, null)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- Public read of uploaded community files
drop policy if exists "community_uploads_select_public" on storage.objects;
create policy "community_uploads_select_public"
  on storage.objects for select
  using (bucket_id = 'community-uploads');

-- Direct browser uploads are blocked; server uploads via service role bypass RLS
drop policy if exists "community_uploads_insert_public" on storage.objects;
drop policy if exists "community_uploads_update_public" on storage.objects;
drop policy if exists "community_uploads_delete_public" on storage.objects;
