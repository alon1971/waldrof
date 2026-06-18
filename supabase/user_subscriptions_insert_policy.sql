-- Allow authenticated users to create their own subscription row (first login).
-- Server-side writes should use SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).

drop policy if exists "Users insert own subscription" on public.user_subscriptions;
create policy "Users insert own subscription"
  on public.user_subscriptions for insert
  with check (auth.uid()::text = user_id);
