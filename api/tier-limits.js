/**
 * Search / Word quota limits — server-side source of truth.
 *
 * trial:    lifetime caps (never reset) — 1 live search, 5 Word downloads.
 * standard: one-time support — 20 live searches lifetime, unlimited Word.
 * pro:      annual subscription — 25 live searches per calendar month, unlimited Word.
 */
const TRIAL_LIFETIME_SEARCH_LIMIT = 1;
const STANDARD_LIFETIME_SEARCH_LIMIT = 20;
const PRO_MONTHLY_SEARCH_LIMIT = 25;
const TRIAL_WORD_DOWNLOAD_LIMIT = 5;

module.exports = {
  TRIAL_LIFETIME_SEARCH_LIMIT,
  STANDARD_LIFETIME_SEARCH_LIMIT,
  PRO_MONTHLY_SEARCH_LIMIT,
  TRIAL_WORD_DOWNLOAD_LIMIT,
};
