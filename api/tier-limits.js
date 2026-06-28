/**
 * Free-tier (trial) lifetime search cap — server-side source of truth.
 *
 * BETA TESTING (Jun 2026): raised from 3 → 20 for friend beta cohort.
 * Revert TRIAL_LIFETIME_SEARCH_LIMIT to 3 when beta testing ends.
 */
const TRIAL_LIFETIME_SEARCH_LIMIT = 20;

module.exports = {
  TRIAL_LIFETIME_SEARCH_LIMIT,
};
