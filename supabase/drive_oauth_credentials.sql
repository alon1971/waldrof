-- Google Drive user OAuth refresh token (live site connect flow).
-- Written by /api/auth/google-drive/callback via SERVICE_ROLE_KEY.
-- Safe to re-run.

create table if not exists public.drive_oauth_credentials (
  id smallint primary key default 1 check (id = 1),
  refresh_token text not null,
  account_email text,
  updated_at timestamptz not null default now()
);

alter table public.drive_oauth_credentials add column if not exists refresh_token text;
alter table public.drive_oauth_credentials add column if not exists account_email text;
alter table public.drive_oauth_credentials add column if not exists updated_at timestamptz not null default now();

alter table public.drive_oauth_credentials enable row level security;

-- No public policies — only service role (bypasses RLS) may read/write.
drop policy if exists "drive_oauth_credentials_select_public" on public.drive_oauth_credentials;
drop policy if exists "drive_oauth_credentials_insert_public" on public.drive_oauth_credentials;
drop policy if exists "drive_oauth_credentials_update_public" on public.drive_oauth_credentials;
drop policy if exists "drive_oauth_credentials_delete_public" on public.drive_oauth_credentials;

comment on table public.drive_oauth_credentials is
  'Single-row store for Google Drive user OAuth refresh_token (folder owner quota).';
