/**
 * Legacy alias — Community Archive catalog display does not use Drive crawl.
 * Proxies to the Supabase-backed local-catalog shape (grades + data).
 */
const communityCatalogLocal = require('./community-catalog-local');

module.exports = {
  legacyHandler: communityCatalogLocal.legacyHandler,
  handleRequest: communityCatalogLocal.legacyHandler,
};
