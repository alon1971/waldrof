/**
 * Shared catalog topic folder names + search aliases (e.g. יוון ↔ יוון העתיקה).
 * Used by drive-catalog-sync and api/cache.js community search.
 */

const CATALOG_TOPIC_ALIAS_CLUSTERS = [
  ['יוון', 'יוון העתיקה', 'greece', 'ancient greece', 'היסטוריה של יוון'],
  ['מסעות אודיסאוס', 'אודיסאוס', 'אודיסיאה', 'odysseus', 'odyssey'],
];

function stableNormalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function resolveCatalogTopicFromFolderName(folderName) {
  const name = String(folderName || '').trim();
  if (!name) return '';

  const norm = stableNormalize(name);
  for (let i = 0; i < CATALOG_TOPIC_ALIAS_CLUSTERS.length; i++) {
    const cluster = CATALOG_TOPIC_ALIAS_CLUSTERS[i];
    const matched = cluster.some(function (alias) {
      const aliasNorm = stableNormalize(alias);
      return aliasNorm === norm
        || (aliasNorm.length >= 3 && norm.indexOf(aliasNorm) >= 0)
        || (norm.length >= 3 && aliasNorm.indexOf(norm) >= 0);
    });
    if (matched) return cluster[0];
  }
  return name;
}

function expandCatalogTopicAliases(terms) {
  const expanded = new Set();
  (terms || []).forEach(function (term) {
    const cleaned = String(term || '').trim();
    if (!cleaned) return;
    expanded.add(cleaned);
    const norm = stableNormalize(cleaned);
    CATALOG_TOPIC_ALIAS_CLUSTERS.forEach(function (cluster) {
      const hit = cluster.some(function (alias) {
        const aliasNorm = stableNormalize(alias);
        return aliasNorm === norm
          || (aliasNorm.length >= 3 && norm.indexOf(aliasNorm) >= 0)
          || (norm.length >= 3 && aliasNorm.indexOf(norm) >= 0);
      });
      if (hit) cluster.forEach(function (alias) { expanded.add(alias); });
    });
  });
  return Array.from(expanded).filter(Boolean);
}

function parseCatalogTopicFromNotes(rawNotes) {
  const notes = String(rawNotes || '');
  const catalogMatch = notes.match(/\[catalogTopic:([^\]]+)\]/);
  if (catalogMatch) return catalogMatch[1].trim();
  const subfolderMatch = notes.match(/\[subfolder:([^\]]+)\]/);
  if (subfolderMatch) return resolveCatalogTopicFromFolderName(subfolderMatch[1].trim());
  return '';
}

function packDriveCatalogNotes(extras) {
  const e = extras || {};
  const parts = [];
  if (e.subfolder) parts.push('[subfolder:' + String(e.subfolder).trim() + ']');
  if (e.catalogTopic) parts.push('[catalogTopic:' + String(e.catalogTopic).trim() + ']');
  if (e.driveFileId) parts.push('[driveFileId:' + String(e.driveFileId).trim() + ']');
  if (e.drivePath) parts.push('[drivePath:' + String(e.drivePath).trim() + ']');
  if (e.title) parts.push('[title:' + String(e.title).trim() + ']');
  if (e.description) parts.push('[desc:' + String(e.description).trim() + ']');
  return parts.length ? parts.join(' ') : null;
}

module.exports = {
  CATALOG_TOPIC_ALIAS_CLUSTERS,
  resolveCatalogTopicFromFolderName,
  expandCatalogTopicAliases,
  parseCatalogTopicFromNotes,
  packDriveCatalogNotes,
};
