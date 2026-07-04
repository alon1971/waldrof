-- Enforce one subscription row per teacher email.
-- Run in Supabase SQL Editor (safe to re-run after first successful apply).
--
-- Steps:
-- 1) Normalize emails (lowercase, empty → NULL)
-- 2) Merge usage counters onto the keeper row per email
-- 3) Delete duplicate rows for the same email
-- 4) Add UNIQUE constraint on user_email

-- 1. Normalize
UPDATE public.user_subscriptions
SET user_email = NULL
WHERE user_email IS NOT NULL AND btrim(user_email) = '';

UPDATE public.user_subscriptions
SET user_email = lower(btrim(user_email))
WHERE user_email IS NOT NULL AND user_email <> lower(btrim(user_email));

-- 2–3. Deduplicate: keep best row per email (paid > active expiry > usage > recency)
WITH ranked AS (
  SELECT
    user_id,
    lower(btrim(user_email)) AS email_key,
    ROW_NUMBER() OVER (
      PARTITION BY lower(btrim(user_email))
      ORDER BY
        CASE
          WHEN coalesce(is_trial, true) = false
            AND lower(coalesce(plan_type, 'trial')) <> 'trial'
          THEN 0
          ELSE 1
        END,
        CASE
          WHEN expires_at IS NOT NULL AND expires_at > now() THEN 0
          ELSE 1
        END,
        coalesce(search_count_monthly, 0) DESC,
        coalesce(word_downloads_count, 0) DESC,
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST,
        user_id
    ) AS rn
  FROM public.user_subscriptions
  WHERE user_email IS NOT NULL AND btrim(user_email) <> ''
),
agg AS (
  SELECT
    lower(btrim(user_email)) AS email_key,
    max(coalesce(search_count_monthly, 0)) AS max_searches,
    max(coalesce(word_downloads_count, 0)) AS max_downloads
  FROM public.user_subscriptions
  WHERE user_email IS NOT NULL AND btrim(user_email) <> ''
  GROUP BY lower(btrim(user_email))
),
keepers AS (
  SELECT r.user_id, r.email_key, a.max_searches, a.max_downloads
  FROM ranked r
  JOIN agg a ON a.email_key = r.email_key
  WHERE r.rn = 1
),
merged AS (
  UPDATE public.user_subscriptions us
  SET
    user_email = k.email_key,
    search_count_monthly = greatest(coalesce(us.search_count_monthly, 0), k.max_searches),
    word_downloads_count = greatest(coalesce(us.word_downloads_count, 0), k.max_downloads),
    updated_at = now()
  FROM keepers k
  WHERE us.user_id = k.user_id
  RETURNING us.user_id
)
DELETE FROM public.user_subscriptions us
USING ranked r
WHERE us.user_id = r.user_id
  AND r.rn > 1;

-- 4. Unique constraint on user_email (PostgreSQL allows multiple NULLs)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_subscriptions_user_email_key'
      AND conrelid = 'public.user_subscriptions'::regclass
  ) THEN
    ALTER TABLE public.user_subscriptions
      ADD CONSTRAINT user_subscriptions_user_email_key UNIQUE (user_email);
  END IF;
END $$;

COMMENT ON CONSTRAINT user_subscriptions_user_email_key ON public.user_subscriptions IS
  'One subscription row per teacher email; app upserts on conflict.';

-- Supporting index for lookups (no-op if constraint already provides it)
CREATE INDEX IF NOT EXISTS user_subscriptions_user_email_idx
  ON public.user_subscriptions (user_email)
  WHERE user_email IS NOT NULL;
