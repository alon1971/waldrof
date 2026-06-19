-- Run once in Supabase SQL editor if PATCH/DELETE return 401 for logged-in teachers.
-- Allows authenticated users to update/delete community_materials rows via user JWT.

drop policy if exists "community_materials_update_auth" on public.community_materials;
create policy "community_materials_update_auth"
  on public.community_materials for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "community_materials_delete_auth" on public.community_materials;
create policy "community_materials_delete_auth"
  on public.community_materials for delete
  to authenticated
  using (true);
