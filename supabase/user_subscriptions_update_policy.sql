-- Ensure UPDATE RLS policy validates the patched row (WITH CHECK).
-- Run in Supabase SQL Editor if search counts fail to persist after the first increment.

drop policy if exists "Users update own subscription" on public.user_subscriptions;
create policy "Users update own subscription"
  on public.user_subscriptions for update
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);
