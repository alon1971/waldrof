/**
 * GET /api/community-catalog-drive
 *
 * Alias for the local on-disk Community Archive index.
 * Heavy Drive crawls are intentionally disabled for מאגר קהילתי.
 */
const communityCatalogLocal = require('./community-catalog-local');

module.exports = {
  legacyHandler: communityCatalogLocal.legacyHandler,
  handleRequest: communityCatalogLocal.legacyHandler,
};
