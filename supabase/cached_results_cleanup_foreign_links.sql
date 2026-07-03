-- Retroactive cleanup: remove cached_results rows that contain foreign (non EN/HE) source URLs.
-- Targets Russian and other blocked domains (.ru, CyberLeninka, VK, KPFU, etc.).
-- Run in Supabase SQL Editor. Review the SELECT preview before DELETE.

-- Step 1: Preview rows that will be deleted
SELECT
  cache_key,
  phase,
  grade_id,
  topic,
  created_at,
  last_hit_at
FROM public.cached_results
WHERE result_data::text ~* '(https?://|www\.)[^"\s]*\.(ru|su)(/|"|\\|:|\s|$)'
   OR result_data::text ~* 'cyberleninka'
   OR result_data::text ~* 'elibrary\.ru'
   OR result_data::text ~* '(https?://|www\.)[^"\s]*vk\.com'
   OR result_data::text ~* 'vkontakte'
   OR result_data::text ~* 'kpfu'
   OR result_data::text ~* '(https?://|www\.)[^"\s]*\.ua(/|"|\\|:|\s|$)'
ORDER BY created_at DESC;

-- Step 2: Delete (uncomment after verifying preview)
-- BEGIN;
-- DELETE FROM public.cached_results
-- WHERE result_data::text ~* '(https?://|www\.)[^"\s]*\.(ru|su)(/|"|\\|:|\s|$)'
--    OR result_data::text ~* 'cyberleninka'
--    OR result_data::text ~* 'elibrary\.ru'
--    OR result_data::text ~* '(https?://|www\.)[^"\s]*vk\.com'
--    OR result_data::text ~* 'vkontakte'
--    OR result_data::text ~* 'kpfu'
--    OR result_data::text ~* '(https?://|www\.)[^"\s]*\.ua(/|"|\\|:|\s|$)';
-- COMMIT;

-- Step 3: Verify (should return 0 rows)
-- SELECT COUNT(*) AS remaining_foreign_link_rows
-- FROM public.cached_results
-- WHERE result_data::text ~* '(https?://|www\.)[^"\s]*\.(ru|su)(/|"|\\|:|\s|$)'
--    OR result_data::text ~* 'cyberleninka'
--    OR result_data::text ~* 'elibrary\.ru'
--    OR result_data::text ~* '(https?://|www\.)[^"\s]*vk\.com'
--    OR result_data::text ~* 'vkontakte'
--    OR result_data::text ~* 'kpfu'
--    OR result_data::text ~* '(https?://|www\.)[^"\s]*\.ua(/|"|\\|:|\s|$)';
