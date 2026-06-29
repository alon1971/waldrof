/**
 * Search quota limits — server-side source of truth.
 *
 * trial: lifetime cap (never resets monthly).
 * pro:   monthly cap (resets each calendar month).
 */
const TRIAL_LIFETIME_SEARCH_LIMIT = 20;
const PRO_MONTHLY_SEARCH_LIMIT = 30;

module.exports = {
  TRIAL_LIFETIME_SEARCH_LIMIT,
  PRO_MONTHLY_SEARCH_LIMIT,
};
