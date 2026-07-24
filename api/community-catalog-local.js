/**
 * Legacy alias routes — Community Archive reads ONLY from Supabase
 * community_materials via /api/community-materials.
 *
 * These endpoints no longer serve local JSON or crawl Google Drive.
 */
const communityMaterials = require('./community-materials');

async function legacyHandler(req, res) {
  // Always proxy to the live community_materials list.
  return communityMaterials.legacyHandler(req, res);
}

module.exports = {
  legacyHandler,
  handleRequest: legacyHandler,
};
