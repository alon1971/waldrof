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
  [
    'מיתולוגיה נורדית', 'נורדית', 'נורד', 'נורדים', 'סיפורי הצפון', 'סיפורי צפון',
    'אסגארד', 'אודין', 'תור', 'norse', 'norse mythology', 'odin', 'thor',
  ],
  [
    'אדם וחיות', 'אדם חיות', 'אדם חיה', 'האדם וחיות', 'האדם חיות',
    'אדם וממלכת החי', 'האדם וממלכת החי', 'האדם בממלכת החי', 'ממלכת החי',
    'human and animal', 'kingdom of nature',
  ],
  /**
   * Nutrition / health / אדם עולם — semantic expand so תזונה/בריאות also
   * retrieve אדם-עולם community materials.
   */
  [
    'אדם עולם', 'אדם-עולם', 'adam olam', 'adam-olam',
    'תזונה', 'בריאות', 'תזונה ובריאות', 'תזונה וולדורף',
    'nutrition', 'health', 'waldorf nutrition',
  ],
];

/**
 * Mutually exclusive topic families — searching one actively excludes the others
 * (e.g. מיתולוגיה נורדית must never pull יוון/רומא folders or synonyms).
 */
const TOPIC_EXCLUDE_GROUPS = [
  {
    id: 'mythology_norse',
    markers: [
      'מיתולוגיה נורדית', 'נורדית', 'נורד', 'נורדים', 'סיפורי הצפון', 'סיפורי צפון',
      'אסגארד', 'אודין', 'תור', 'norse', 'norse mythology', 'odin', 'thor',
    ],
    exclude: [
      'מיתולוגיה יוונית', 'יוון', 'יוון העתיקה', 'יוונית', 'greek mythology', 'ancient greece',
      'הומרוס', 'אודיסאוס', 'אלכסנדר', 'אולימפ',
      'מיתולוגיה רומית', 'רומא', 'רומא העתיקה', 'רומית', 'roman mythology', 'rome', 'roman',
    ],
  },
  {
    id: 'mythology_greek',
    markers: [
      'מיתולוגיה יוונית', 'יוון', 'יוון העתיקה', 'יוונית', 'greek mythology', 'ancient greece',
      'הומרוס', 'הומר', 'אודיסאוס', 'אודיסיאה', 'אלכסנדר הגדול', 'אולימפיאדה', 'אולימפיה',
    ],
    exclude: [
      'מיתולוגיה נורדית', 'נורדית', 'נורד', 'נורדים', 'סיפורי הצפון', 'norse', 'norse mythology',
      'אסגארד', 'אודין', 'תור', 'odin', 'thor',
      'מיתולוגיה רומית', 'רומא', 'רומא העתיקה', 'רומית', 'roman mythology',
    ],
  },
  {
    id: 'mythology_roman',
    markers: [
      'מיתולוגיה רומית', 'רומא', 'רומא העתיקה', 'האימפריה הרומית', 'רומית',
      'rome', 'roman', 'roman mythology', 'ancient rome',
    ],
    exclude: [
      'מיתולוגיה נורדית', 'נורדית', 'נורד', 'סיפורי הצפון', 'norse', 'norse mythology',
      'אסגארד', 'אודין', 'תור',
      'מיתולוגיה יוונית', 'יוון', 'יוון העתיקה', 'יוונית', 'greek mythology',
      'הומרוס', 'אודיסאוס',
    ],
  },
];

/**
 * Cross-cutting / transversal topics — without an explicit grade lock, search
 * spans all community grade folders (broadScan).
 */
const CROSS_CUTTING_TOPIC_ALIASES = [
  'התפתחות המדעים', 'התפתחות המדע', 'התפתחות מדע', 'התפתחות מדעים',
  'התפתחות השפה', 'התפתחות שפה', 'התפתחות הלשון', 'התפתחות לשון',
  'התפתחות האדם', 'התפתחות האנושות',
  'development of the sciences', 'development of science', 'development of sciences',
  'language development', 'development of language',
];

const HEBREW_GRADE_LETTER_TO_ID = {
  א: '1', ב: '2', ג: '3', ד: '4', ה: '5', ו: '6', ז: '7', ח: '8',
};

/**
 * Search-only tags appended to haystacks / query expansion.
 * Kept separate from folder-resolution aliases so generic words like
 * "מיתולוגיה" do not remap Norse folders to יוון.
 */
const CATALOG_TOPIC_SEARCH_TAGS = {
  // Prefer "מיתולוגיה יוונית" over bare "מיתולוגיה" so Norse searches are not polluted.
  יוון: ['עתיקה', 'מיתולוגיה יוונית', 'היסטוריה יוונית', 'greek mythology', 'אלכסנדר הגדול', 'אולימפיאדה', 'אולימפיה'],
  רומא: ['האימפריה הרומית', 'היסטוריה רומית', 'roman empire', 'roman history', 'ancient rome'],
  'מיתולוגיה נורדית': ['סיפורי הצפון', 'נורדית', 'norse mythology', 'odin', 'thor'],
  'אדם וחיות': ['ממלכת החי', 'האדם בממלכת החי', 'אדם חיה', 'אדם חיות', 'human and animal'],
  'אדם עולם': ['תזונה', 'בריאות', 'תזונה ובריאות', 'nutrition', 'health', 'adam olam'],
};

function stableNormalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u05F3\u05F4׳״`'"]/g, '')
    .replace(/[-–—_/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function getSearchTagsForCanonicalTopic(canonicalTopic) {
  const key = String(canonicalTopic || '').trim();
  const tags = CATALOG_TOPIC_SEARCH_TAGS[key];
  return Array.isArray(tags) ? tags.slice() : [];
}

function isGradeShellFolderName(folderName) {
  const s = String(folderName || '').trim();
  if (!s) return false;
  if (/^(כללי|general)$/iu.test(s)) return false;
  // Nested Drive shells that mirror a classroom folder (must never become topics).
  // Covers תיקייה/תיקיית/תקיה/תקיית spelling variants.
  if (/ת(?:י)?קי(?:ה|ית)/i.test(s) && /כיתה/i.test(s)) return true;
  if (/^ת(?:י)?קי(?:ה|ית)\s+כיתה[\s\-_/]*[א-ח]/iu.test(s)) return true;
  if (/^כיתה[\s\-_/]*[א-ח]['׳"]?\s*$/iu.test(s)) return true;
  return false;
}

function resolveCatalogTopicFromFolderName(folderName) {
  const name = String(folderName || '').trim();
  if (!name) return '';
  if (isGradeShellFolderName(name)) return '';

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
  let hebrewTopicMatch = null;
  try {
    hebrewTopicMatch = require('../hebrew-topic-match');
  } catch (e) {
    hebrewTopicMatch = null;
  }

  (terms || []).forEach(function (term) {
    const cleaned = String(term || '').trim();
    if (!cleaned) return;
    expanded.add(cleaned);
    const norm = stableNormalize(cleaned);
    CATALOG_TOPIC_ALIAS_CLUSTERS.forEach(function (cluster) {
    const hit = cluster.some(function (alias) {
      const aliasNorm = stableNormalize(alias);
      if (!aliasNorm) return false;
      if (aliasNorm === norm) return true;

      // אדם עולם / תזונה / בריאות: avoid bare «עולם» (from מגלי עולם) expanding here.
      const isAdamOlamCluster = cluster[0] === 'אדם עולם';
      if (isAdamOlamCluster) {
        if (norm === 'עולם' || norm === 'אדם') return false;
        if (
          hebrewTopicMatch
          && typeof hebrewTopicMatch.aliasMatchesQueryByTokens === 'function'
          && hebrewTopicMatch.aliasMatchesQueryByTokens(norm, aliasNorm)
        ) {
          return true;
        }
        return (aliasNorm.length >= 3 && norm.indexOf(aliasNorm) >= 0)
          || (norm.length >= 4 && aliasNorm.indexOf(norm) >= 0 && norm.indexOf(' ') >= 0);
      }

      if (aliasNorm.length >= 3 && norm.indexOf(aliasNorm) >= 0) return true;
      if (norm.length >= 3 && aliasNorm.indexOf(norm) >= 0) return true;
      if (
        hebrewTopicMatch
        && typeof hebrewTopicMatch.aliasMatchesQueryByTokens === 'function'
        && hebrewTopicMatch.aliasMatchesQueryByTokens(norm, aliasNorm)
      ) {
        return true;
      }
      return false;
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

function textMatchesAnyAlias(text, aliases) {
  const hay = stableNormalize(text);
  if (!hay || !Array.isArray(aliases)) return false;
  for (let i = 0; i < aliases.length; i++) {
    const alias = stableNormalize(aliases[i]);
    if (!alias || alias.length < 2) continue;
    if (hay === alias) return true;
    if (alias.length >= 3 && hay.indexOf(alias) >= 0) return true;
    if (hay.length >= 4 && alias.indexOf(hay) >= 0) return true;
  }
  return false;
}

/**
 * Extract an explicit classroom from free text (e.g. «פיזיקה כיתה ו'» → «6»).
 * Returns '' when no hard grade marker is present.
 */
function extractGradeIdFromQuery(text) {
  const src = String(text || '');
  if (!src.trim()) return '';

  const heb = src.match(/כיתה\s*([א-ח])['׳"]?/i)
    || src.match(/בכיתה\s*([א-ח])['׳"]?/i)
    || src.match(/לכיתה\s*([א-ח])['׳"]?/i);
  if (heb && HEBREW_GRADE_LETTER_TO_ID[heb[1]]) {
    return HEBREW_GRADE_LETTER_TO_ID[heb[1]];
  }

  const en = src.match(/(?:grade|class|waldorf\s+class)\s*([1-8])\b/i);
  if (en) return String(en[1]);

  const digitGrade = src.match(/\b([1-8])\s*(?:st|nd|rd|th)?\s*grade\b/i);
  if (digitGrade) return String(digitGrade[1]);

  return '';
}

function findActiveExcludeGroup(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  for (let i = 0; i < TOPIC_EXCLUDE_GROUPS.length; i++) {
    const group = TOPIC_EXCLUDE_GROUPS[i];
    if (textMatchesAnyAlias(q, group.markers)) return group;
  }
  return null;
}

/** Terms that must be stripped from expansion / rejected as rival hits. */
function getExcludedTermsForQuery(query) {
  const group = findActiveExcludeGroup(query);
  return group && Array.isArray(group.exclude) ? group.exclude.slice() : [];
}

function termMatchesExcludedList(term, excludedTerms) {
  const t = stableNormalize(term);
  if (!t || !Array.isArray(excludedTerms) || !excludedTerms.length) return false;
  return textMatchesAnyAlias(t, excludedTerms);
}

function stripExcludedSearchTerms(query, terms) {
  const excluded = getExcludedTermsForQuery(query);
  if (!excluded.length) return Array.isArray(terms) ? terms.slice() : [];
  return (terms || []).filter(function (term) {
    return !termMatchesExcludedList(term, excluded);
  });
}

/**
 * True when candidate belongs to a rival mythology / epoch family of the query.
 */
function topicsAreMutuallyExcluded(queryOrExpected, candidate) {
  const excluded = getExcludedTermsForQuery(queryOrExpected);
  if (!excluded.length) return false;
  const candidateText = String(candidate || '').trim();
  if (!candidateText) return false;
  if (termMatchesExcludedList(candidateText, excluded)) return true;
  const candidateCanon = resolveCatalogTopicFromFolderName(candidateText);
  return Boolean(candidateCanon && termMatchesExcludedList(candidateCanon, excluded));
}

function isCrossCuttingTopic(query) {
  return textMatchesAnyAlias(query, CROSS_CUTTING_TOPIC_ALIASES);
}

/**
 * Resolve community grade lock + broad-scan policy:
 * - Explicit UI / query grade → strict classroom filter
 * - Cross-cutting topic without hard grade → broad multi-grade scan
 */
function resolveCommunityGradeScanPolicy(query, options) {
  const opts = options || {};
  const q = String(query || opts.userMessage || opts.topic || '').trim();
  const uiGrade = String(opts.gradeId || opts.currentGrade || '').trim();
  const queryGrade = extractGradeIdFromQuery(q);
  const lockedGradeId = uiGrade || queryGrade || '';
  const crossCutting = isCrossCuttingTopic(q)
    || isCrossCuttingTopic(opts.topic)
    || isCrossCuttingTopic(opts.catalogTopic);
  const allowBroadScan = !lockedGradeId && (
    opts.globalScan === true
    || opts.broadScan === true
    || crossCutting
  );
  return {
    lockedGradeId: lockedGradeId,
    queryGradeId: queryGrade,
    uiGradeId: uiGrade,
    crossCutting: crossCutting,
    allowBroadScan: allowBroadScan,
  };
}

module.exports = {
  CATALOG_TOPIC_ALIAS_CLUSTERS,
  CATALOG_TOPIC_SEARCH_TAGS,
  TOPIC_EXCLUDE_GROUPS,
  CROSS_CUTTING_TOPIC_ALIASES,
  getSearchTagsForCanonicalTopic,
  resolveCatalogTopicFromFolderName,
  isGradeShellFolderName,
  expandCatalogTopicAliases,
  parseCatalogTopicFromNotes,
  packDriveCatalogNotes,
  extractGradeIdFromQuery,
  findActiveExcludeGroup,
  getExcludedTermsForQuery,
  stripExcludedSearchTerms,
  topicsAreMutuallyExcluded,
  isCrossCuttingTopic,
  resolveCommunityGradeScanPolicy,
  textMatchesAnyAlias,
};
