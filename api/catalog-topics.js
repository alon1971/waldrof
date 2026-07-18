/**
 * Shared catalog topic folder names + search aliases (e.g. יוון ↔ יוון העתיקה).
 * Used by drive-catalog-sync and api/cache.js community search.
 */

const CATALOG_TOPIC_ALIAS_CLUSTERS = [
  [
    'יוון', 'יוון העתיקה', 'greece', 'ancient greece',
    'היסטוריה של יוון', 'היסטוריה יוונית',
    'אלכסנדר הגדול', 'alexander the great',
    'אולימפיאדה', 'אולימפיה', 'olympics', 'olympic',
  ],
  ['מסעות אודיסאוס', 'אודיסאוס', 'אודיסיאה', 'odysseus', 'odyssey'],
  [
    'רומא', 'רומא העתיקה', 'האימפריה הרומית', 'היסטוריה רומית', 'רומאית',
    'rome', 'roman', 'roman empire', 'roman history', 'ancient rome',
  ],
];

/**
 * Search-only tags appended to haystacks / query expansion.
 * Kept separate from folder-resolution aliases so generic words like
 * "מיתולוגיה" do not remap Norse folders to יוון.
 */
const CATALOG_TOPIC_SEARCH_TAGS = {
  // Prefer "מיתולוגיה יוונית" over bare "מיתולוגיה" so Norse searches are not polluted.
  יוון: ['עתיקה', 'מיתולוגיה יוונית', 'היסטוריה יוונית', 'greek mythology', 'אלכסנדר הגדול', 'אולימפיאדה', 'אולימפיה'],
  רומא: ['האימפריה הרומית', 'היסטוריה רומית', 'roman empire', 'roman history', 'ancient rome'],
};

function stableNormalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getSearchTagsForCanonicalTopic(canonicalTopic) {
  const key = String(canonicalTopic || '').trim();
  const tags = CATALOG_TOPIC_SEARCH_TAGS[key];
  return Array.isArray(tags) ? tags.slice() : [];
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
      if (hit) {
        cluster.forEach(function (alias) { expanded.add(alias); });
        getSearchTagsForCanonicalTopic(cluster[0]).forEach(function (tag) {
          expanded.add(tag);
        });
      }
    });

    // Exact reverse match on search tags (e.g. עתיקה / מיתולוגיה → יוון cluster).
    Object.keys(CATALOG_TOPIC_SEARCH_TAGS).forEach(function (canonical) {
      const tags = CATALOG_TOPIC_SEARCH_TAGS[canonical] || [];
      const tagHit = tags.some(function (tag) {
        return stableNormalize(tag) === norm;
      });
      if (!tagHit) return;
      expanded.add(canonical);
      const cluster = CATALOG_TOPIC_ALIAS_CLUSTERS.find(function (c) {
        return c[0] === canonical;
      });
      if (cluster) cluster.forEach(function (alias) { expanded.add(alias); });
      tags.forEach(function (tag) { expanded.add(tag); });
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
  const searchTags = Array.isArray(e.searchTags)
    ? e.searchTags
    : getSearchTagsForCanonicalTopic(e.catalogTopic || e.topic || '');
  if (searchTags.length) {
    parts.push('[tags:' + searchTags.map(function (t) {
      return String(t || '').trim();
    }).filter(Boolean).join(' ') + ']');
  }
  return parts.length ? parts.join(' ') : null;
}

module.exports = {
  CATALOG_TOPIC_ALIAS_CLUSTERS,
  CATALOG_TOPIC_SEARCH_TAGS,
  getSearchTagsForCanonicalTopic,
  resolveCatalogTopicFromFolderName,
  expandCatalogTopicAliases,
  parseCatalogTopicFromNotes,
  packDriveCatalogNotes,
};
