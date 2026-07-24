/**
 * Legacy alias — Community Archive catalog display does not use Drive.
 * Proxies to Supabase community_materials list.
 */
const communityMaterials = require('./community-materials');

module.exports = {
  legacyHandler: communityMaterials.legacyHandler,
  handleRequest: communityMaterials.legacyHandler,
};
