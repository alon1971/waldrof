/**
 * Community Drive archive — Gemini pedagogical summaries of Drive hits.
 * Used only by the standalone /api/community-summarizer flow (not live web search).
 * Public archive (no userId). Smart cache: Drive modifiedTime delta + semantic relevance.
 *
 * CACHE SOURCE ISOLATION: lookups and upserts hit community_drive_archive ONLY.
 * Never read or write public.cached_results (Perplexity / live web) from this module.
 * Never fall back to cached_results for community / repository probes.
 */
const crypto = require('crypto');
const env = require('./env');
const driveCatalogSync = require('./drive-catalog-sync');
const jsonRepair = require('./json-repair');
const catalogTopics = require('./catalog-topics');
const archiveDisambiguation = require('./archive-disambiguation');
const hebrewTopicMatch = require('../hebrew-topic-match');

const TABLE_NAME = 'community_drive_archive';
const GEMINI_MODEL = 'gemini-2.5-pro';
const GEMINI_FALLBACK_MODELS = ['gemini-2.5-flash'];
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/**
 * Output ceiling for long pedagogical work plans.
 * JSON-wrapped summaries used to truncate early; plain Markdown + high ceiling fixes that.
 */
const GEMINI_MAX_OUTPUT_TOKENS = 16384;
/**
 * Bump this when the pedagogical prompt / depth contract changes so old shallow
 * archive rows are not reused (fingerprint alone is not enough).
 */
const PROMPT_VERSION = 'v3-deep-workplan';

/** Exact UI copy from product spec (Hebrew). */
const COMMUNITY_SUMMARY_HEADING = 'סיכום נושא מתוך המאגר הקהילתי';
const COMMUNITY_SUMMARY_EMPTY = 'לצערי, הנושא שביקשת אינו נמצא במאגר (ייתכן והוא נקרא בשם אחר, ולכן כדאי לבדוק בתיקיות באופן ידני).';

const MAX_FILES_FOR_SUMMARY = 40;
const MAX_CHARS_PER_FILE = 22000;
const MAX_TOTAL_CHARS = 160000;
/** Prefer inlineData under this size; larger PDFs/images use Gemini Files API. */
const MAX_GEMINI_INLINE_BYTES = 12 * 1024 * 1024;
/** Gemini document understanding PDF/image ceiling (~50MB). */
const MAX_GEMINI_MULTIMODAL_BYTES = 50 * 1024 * 1024;
const MAX_MULTIMODAL_FILES = 12;
/** PDF/image text shorter than this is treated as unreliable → send binary to Gemini. */
const MIN_RELIABLE_PDF_TEXT_CHARS = 1800;
/** Reject / regenerate summaries shorter than this (~deep Hebrew work plan). */
const MIN_DEEP_SUMMARY_CHARS = 4200;
/** Exact / alias equivalence threshold for silent cache reuse. */
const SEMANTIC_EQUIV_MIN_SCORE = 0.88;
/** Partial / "did you mean" suggestion threshold. */
const PARTIAL_SUGGEST_MIN_SCORE = archiveDisambiguation.ARCHIVE_PARTIAL_SUGGEST_MIN_SCORE || 0.72;

/**
 * Strip Markdown fences (```json … ```) that Gemini sometimes wraps around JSON.
 */
function stripGeminiJsonFences(text) {
  if (typeof jsonRepair.stripMarkdownJsonFences === 'function') {
    return jsonRepair.stripMarkdownJsonFences(text);
  }
  let raw = String(text || '').replace(/^\uFEFF/, '').trim();
  const fenced = raw.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  else {
    raw = raw.replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/```\s*$/gi, '').trim();
  }
  return raw;
}

/**
 * Parse Gemini model text as JSON after fence cleanup.
 * Logs the raw response on failure so silent crashes are avoided.
 */
function parseGeminiSummaryJson(rawText) {
  const raw = String(rawText || '');
  const cleaned = stripGeminiJsonFences(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') {
      const summary = parsed.summary != null
        ? String(parsed.summary).trim()
        : (parsed.text != null ? String(parsed.text).trim() : '');
      if (summary) return summary;
    }
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
    throw new Error('JSON parsed but missing summary/text field');
  } catch (err) {
    console.error(
      '[community-drive-archive] Gemini summary JSON.parse failed:',
      err && err.message ? err.message : err
    );
    console.error(
      '[community-drive-archive] Gemini raw response (first 2000 chars):',
      raw.slice(0, 2000)
    );

    // Truncated / lightly-broken JSON: pull "summary" via balanced-ish extract.
    const summaryMatch = cleaned.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/s)
      || cleaned.match(/"summary"\s*:\s*"([\s\S]*?)(?:"\s*}?\s*$)/);
    if (summaryMatch && summaryMatch[1]) {
      try {
        const unescaped = JSON.parse('"' + summaryMatch[1].replace(/"\s*$/, '') + '"');
        if (String(unescaped || '').trim()) {
          console.warn('[community-drive-archive] recovered summary from partial JSON');
          return String(unescaped).trim();
        }
      } catch (e2) {
        const loose = summaryMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .trim();
        if (loose) {
          console.warn('[community-drive-archive] recovered summary via loose unescape');
          return loose;
        }
      }
    }

    // Fallback: plain Hebrew prose (no JSON object).
    const plain = cleaned.trim();
    if (plain && plain.charAt(0) !== '{' && plain.charAt(0) !== '[') {
      console.warn('[community-drive-archive] falling back to plain-text Gemini summary');
      return plain;
    }
    // Broken object that still contains long Hebrew prose after the opening brace.
    const proseAfterBrace = plain.replace(/^\{\s*"summary"\s*:\s*"?/, '').replace(/"\s*\}\s*$/, '').trim();
    if (proseAfterBrace.length > 80 && /[\u0590-\u05FF]/.test(proseAfterBrace)) {
      console.warn('[community-drive-archive] falling back to Hebrew prose sliced from broken JSON');
      return proseAfterBrace;
    }
    throw new Error('המודל החזיר תשובה שאינה JSON תקין');
  }
}

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServiceRoleKey() || env.getSupabaseServerKey(),
  };
}

function stableNormalize(value) {
  if (typeof hebrewTopicMatch.stableNormalize === 'function') {
    return hebrewTopicMatch.stableNormalize(value);
  }
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Expand a topic into pedagogical aliases for cache-key candidates and Drive matching.
 * Uses catalog + hebrew alias clusters (e.g. האימפריה הרומית ↔ רומא העתיקה).
 */
function expandCommunityTopicAliases(topic) {
  const seed = String(topic || '').trim();
  if (!seed) return [];
  const out = new Set();
  out.add(seed);
  out.add(stableNormalize(seed));
  try {
    if (typeof catalogTopics.expandCatalogTopicAliases === 'function') {
      catalogTopics.expandCatalogTopicAliases([seed]).forEach(function (alias) {
        const a = String(alias || '').trim();
        if (a) out.add(a);
      });
    }
    const canon = typeof catalogTopics.resolveCatalogTopicFromFolderName === 'function'
      ? catalogTopics.resolveCatalogTopicFromFolderName(seed)
      : '';
    if (canon) out.add(String(canon).trim());
  } catch (e) { /* ignore */ }
  try {
    if (typeof hebrewTopicMatch.expandHebrewSearchTerms === 'function') {
      hebrewTopicMatch.expandHebrewSearchTerms(seed, 12).forEach(function (alias) {
        const a = String(alias || '').trim();
        if (a && a.length >= 2) out.add(a);
      });
    }
  } catch (e2) { /* ignore */ }
  return Array.from(out).filter(Boolean);
}

/** Canonical display topic for a query (first catalog cluster head when available). */
function resolveCanonicalCommunityTopic(topic) {
  const seed = String(topic || '').trim();
  if (!seed) return '';
  try {
    if (typeof catalogTopics.resolveCatalogTopicFromFolderName === 'function') {
      const canon = catalogTopics.resolveCatalogTopicFromFolderName(seed);
      if (canon) return String(canon).trim();
    }
  } catch (e) { /* ignore */ }
  return seed;
}

function topicsAreSemanticEquivalent(topicA, topicB) {
  const a = String(topicA || '').trim();
  const b = String(topicB || '').trim();
  if (!a || !b) return false;
  if (stableNormalize(a) === stableNormalize(b)) return true;
  if (typeof hebrewTopicMatch.sharesAllowedPedagogicalAlias === 'function'
    && hebrewTopicMatch.sharesAllowedPedagogicalAlias(a, b)) {
    return true;
  }
  try {
    const canonA = resolveCanonicalCommunityTopic(a);
    const canonB = resolveCanonicalCommunityTopic(b);
    if (canonA && canonB && stableNormalize(canonA) === stableNormalize(canonB)) return true;
  } catch (e) { /* ignore */ }
  if (typeof driveCatalogSync.topicsStrictlyCompatible === 'function'
    && driveCatalogSync.topicsStrictlyCompatible(a, b)) {
    const score = typeof hebrewTopicMatch.scoreHebrewTopicSimilarity === 'function'
      ? hebrewTopicMatch.scoreHebrewTopicSimilarity(a, b, '')
      : 0;
    return score >= SEMANTIC_EQUIV_MIN_SCORE;
  }
  if (typeof hebrewTopicMatch.scoreHebrewTopicSimilarity === 'function') {
    return hebrewTopicMatch.scoreHebrewTopicSimilarity(a, b, '') >= SEMANTIC_EQUIV_MIN_SCORE;
  }
  return false;
}

function scoreCommunityTopicSimilarity(query, candidate) {
  if (!query || !candidate) return 0;
  if (stableNormalize(query) === stableNormalize(candidate)) return 1;
  if (topicsAreSemanticEquivalent(query, candidate)) return 0.95;
  if (typeof hebrewTopicMatch.scoreHebrewTopicSimilarity === 'function') {
    return Number(hebrewTopicMatch.scoreHebrewTopicSimilarity(query, candidate, '')) || 0;
  }
  const q = stableNormalize(query);
  const c = stableNormalize(candidate);
  if (q.length >= 3 && c.indexOf(q) >= 0) return 0.8;
  if (c.length >= 3 && q.indexOf(c) >= 0) return 0.78;
  return 0;
}

function buildArchiveKey(query, options) {
  const opts = options || {};
  const topicRaw = String(opts.topic || opts.catalogTopic || query || '').trim();
  const topicCanon = resolveCanonicalCommunityTopic(topicRaw) || topicRaw;
  const parts = [
    stableNormalize(topicCanon || query),
    String(opts.gradeId || opts.currentGrade || '').trim(),
    stableNormalize(topicCanon),
    String(opts.phase || 'hybrid').trim(),
    PROMPT_VERSION,
  ];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 40);
}

/** Pre-normalization archive_key shape (query + topic as typed). */
function buildLegacyArchiveKey(query, options) {
  const opts = options || {};
  const parts = [
    stableNormalize(query),
    String(opts.gradeId || opts.currentGrade || '').trim(),
    stableNormalize(opts.topic || opts.catalogTopic || ''),
    String(opts.phase || 'hybrid').trim(),
    PROMPT_VERSION,
  ];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 40);
}

/** All archive_key candidates for exact + alias lookups (community_drive_archive only). */
function buildArchiveKeyCandidates(query, options) {
  const opts = options || {};
  const aliases = expandCommunityTopicAliases(opts.topic || query);
  const keys = new Set();
  keys.add(buildArchiveKey(query, opts));
  keys.add(buildLegacyArchiveKey(query, opts));
  aliases.forEach(function (alias) {
    const aliasOpts = Object.assign({}, opts, {
      topic: alias,
      catalogTopic: alias,
    });
    keys.add(buildArchiveKey(alias, aliasOpts));
    keys.add(buildLegacyArchiveKey(alias, aliasOpts));
  });
  return Array.from(keys);
}

/**
 * Quality gate: shallow / incomplete archived or model output must be regenerated.
 */
function isSummaryDeepEnough(summary) {
  const s = String(summary || '').trim();
  if (s.length < MIN_DEEP_SUMMARY_CHARS) return false;
  const sectionChecks = [
    /רקע והדגשה\s*פדגוגית/,
    /סינתזה\s*רחבה/,
    /פעילויות\s*יצירתיות|אמנותיות/,
    /דרכי\s*הערכה|מודלים\s*למבחן|מבחן\/?עבודה|מחוון|רובריקה/,
    /מראי\s*מקום/,
  ];
  let hits = 0;
  for (let i = 0; i < sectionChecks.length; i++) {
    if (sectionChecks[i].test(s)) hits += 1;
  }
  // Require most of the mandated work-plan skeleton.
  if (hits < 4) return false;
  // Prefer structured headings over a flat paragraph blob.
  const headingCount = (s.match(/^#{1,3}\s+/gm) || []).length;
  return headingCount >= 4;
}

function buildSourceFingerprint(fileRefs) {
  const parts = (fileRefs || [])
    .map(function (ref) {
      return [
        String(ref.driveFileId || ref.id || '').trim(),
        String(ref.modifiedTime || '').trim(),
        String(ref.name || ref.fileName || '').trim(),
      ].join(':');
    })
    .filter(Boolean)
    .sort();
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

function normalizeFileRefsFromMatches(matches) {
  const seen = new Set();
  const refs = [];
  (matches || []).forEach(function (match) {
    if (!match) return;
    const driveFileId = String(match.driveFileId || '').trim()
      || (String(match.id || '').indexOf('drive:') === 0 ? String(match.id).slice(6) : '');
    if (!driveFileId || seen.has(driveFileId)) return;
    seen.add(driveFileId);
    refs.push({
      driveFileId: driveFileId,
      name: String(match.fileName || match.title || match.displayTitle || '').trim(),
      folderPath: String(
        match.locationPath
        || match.drivePath
        || match.pathLabels
        || match.filePath
        || ''
      ).trim().replace(/\s*\/\s*/g, ' > '),
      folder: String(match.catalogTopic || match.topic || '').trim(),
      fileUrl: String(match.webViewLink || match.fileUrl || '').trim(),
      webViewLink: String(match.webViewLink || match.fileUrl || '').trim(),
      mimeType: String(match.mimeType || '').trim(),
      resourceKey: String(match.resourceKey || '').trim(),
      modifiedTime: String(match.modifiedTime || '').trim(),
      gradeId: String(match.gradeId || match.grade_level || '').trim(),
    });
  });
  return refs.slice(0, MAX_FILES_FOR_SUMMARY);
}

async function fetchArchiveRow(archiveKey) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key || !archiveKey) return null;
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('archive_key', 'eq.' + archiveKey);
  params.set('limit', '1');
  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404 || /relation|does not exist/i.test(text)) {
      console.warn('[community-drive-archive] table missing — run supabase/community_drive_archive.sql');
      return null;
    }
    console.warn('[community-drive-archive] fetch failed:', res.status, text.slice(0, 200));
    return null;
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * List community_drive_archive rows for a grade (never cached_results).
 */
async function fetchArchiveRowsForGrade(gradeId, options) {
  const opts = options || {};
  const cfg = getSupabaseConfig();
  const gid = String(gradeId || '').trim();
  if (!cfg.url || !cfg.key || !gid) return [];
  const params = new URLSearchParams();
  params.set(
    'select',
    'archive_key,search_query,query_text,grade_id,topic,summary_md,community_status,'
    + 'source_fingerprint,source_file_ids,file_refs,model,created_at,updated_at'
  );
  params.set('grade_id', 'eq.' + gid);
  params.set('community_status', 'eq.ok');
  params.set('order', 'updated_at.desc');
  params.set('limit', String(Math.max(1, Math.min(Number(opts.limit) || 80, 120))));
  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404 || /relation|does not exist/i.test(text)) {
      console.warn('[community-drive-archive] table missing — run supabase/community_drive_archive.sql');
      return [];
    }
    console.warn('[community-drive-archive] grade list failed:', res.status, text.slice(0, 200));
    return [];
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

function archiveRowTopicLabel(row) {
  if (!row) return '';
  return String(row.topic || row.search_query || row.query_text || '').trim();
}

/**
 * Convert literal escaped newlines ("\\n") into real line breaks so UI/DOCX
 * never render the characters "\n" as visible text.
 */
function normalizeEscapedNewlines(text) {
  let s = String(text == null ? '' : text);
  if (!s) return '';
  if (s.indexOf('\\n') !== -1 || s.indexOf('\\r') !== -1 || s.indexOf('\\t') !== -1) {
    s = s
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, '\t');
  }
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return s;
}

/** Leaf file/folder name only — strip "נתיב > תיקייה > …" hierarchies. */
function shortCitationDisplayName(value, fallback) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return String(fallback || 'קובץ Drive');
  s = s.replace(/^\d+[\.\)]\s*/, '').trim();
  const dashSplit = s.split(/\s*[—–]\s+/);
  if (dashSplit.length > 1 && dashSplit[0].trim()) {
    s = dashSplit[0].trim();
  }
  if (/[>\/]/.test(s)) {
    const parts = s.split(/\s*>\s*|\s*\/\s*/).map(function (p) {
      return String(p || '').trim();
    }).filter(Boolean);
    if (parts.length) s = parts[parts.length - 1];
  }
  return s || String(fallback || 'קובץ Drive');
}

/**
 * Shorten markdown link labels and strip trailing path captions in «מראי מקום».
 */
function sanitizeCommunitySummaryMarkdown(summary) {
  let s = normalizeEscapedNewlines(summary);
  if (!s) return '';
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (_m, label, url) {
    return '[' + shortCitationDisplayName(label, label) + '](' + url + ')';
  });
  s = s.replace(/(\]\(https?:\/\/[^)\s]+\))\s*[—–-]\s*[^\n]+/g, '$1');
  return s.trim();
}

function isUsableArchiveRow(row) {
  if (!row || row.community_status !== 'ok') return false;
  const summary = sanitizeCommunitySummaryMarkdown(row.summary_md);
  if (!summary) return false;
  return isSummaryDeepEnough(summary);
}

/**
 * Exact archive_key (+ alias key candidates) lookup in community_drive_archive only.
 */
async function fetchArchiveRowByKeyCandidates(query, options) {
  const keys = buildArchiveKeyCandidates(query, options);
  for (let i = 0; i < keys.length; i++) {
    try {
      const row = await fetchArchiveRow(keys[i]);
      if (isUsableArchiveRow(row)) {
        return { row: row, archiveKey: keys[i], matchType: i === 0 ? 'exact' : 'alias' };
      }
    } catch (err) {
      console.warn('[community-drive-archive] key candidate lookup failed:', err.message || err);
    }
  }
  return null;
}

/**
 * Find best community_drive_archive match for a topic+grade.
 * Returns exact / semantic / partial — never touches cached_results.
 */
async function findCommunityArchiveMatch(query, options) {
  const opts = options || {};
  const q = String(query || '').trim();
  const gradeId = String(opts.gradeId || opts.currentGrade || '').trim();
  if (!q || !gradeId) return null;

  const byKey = await fetchArchiveRowByKeyCandidates(q, opts);
  if (byKey && byKey.row) {
    return {
      matchType: byKey.matchType === 'alias' ? 'semantic' : 'exact',
      similarity: byKey.matchType === 'alias' ? 0.95 : 1,
      row: byKey.row,
      archiveKey: byKey.archiveKey || byKey.row.archive_key,
      suggestedTopic: archiveRowTopicLabel(byKey.row) || q,
      requestedTopic: q,
      gradeId: gradeId,
    };
  }

  let rows = [];
  try {
    rows = await fetchArchiveRowsForGrade(gradeId, { limit: 80 });
  } catch (listErr) {
    console.warn('[community-drive-archive] semantic grade scan failed:', listErr.message || listErr);
    return null;
  }

  let best = null;
  rows.forEach(function (row) {
    if (!isUsableArchiveRow(row)) return;
    const label = archiveRowTopicLabel(row);
    if (!label) return;
    if (
      typeof hebrewTopicMatch.isInvalidCrossDomainTopicSuggestion === 'function'
      && hebrewTopicMatch.isInvalidCrossDomainTopicSuggestion(q, label)
    ) {
      return;
    }
    const score = scoreCommunityTopicSimilarity(q, label);
    if (!best || score > best.score) {
      best = { row: row, topic: label, score: score };
    }
  });

  if (!best || !best.row) return null;

  if (best.score >= SEMANTIC_EQUIV_MIN_SCORE || topicsAreSemanticEquivalent(q, best.topic)) {
    return {
      matchType: 'semantic',
      similarity: best.score,
      row: best.row,
      archiveKey: best.row.archive_key,
      suggestedTopic: best.topic,
      requestedTopic: q,
      gradeId: gradeId,
    };
  }

  if (
    archiveDisambiguation.shouldOfferPartialArchiveSuggestion(
      q,
      best.topic,
      best.score,
      gradeId,
      opts.gradeLabel || ''
    )
  ) {
    return {
      matchType: 'partial',
      similarity: best.score,
      row: best.row,
      archiveKey: best.row.archive_key,
      suggestedTopic: best.topic,
      requestedTopic: q,
      gradeId: gradeId,
    };
  }

  return null;
}

/**
 * Suggest a close Drive folder topic under the grade when exact listing is empty.
 */
function suggestDriveFolderTopic(query, gradeTopicFolders) {
  const q = String(query || '').trim();
  const folders = Array.isArray(gradeTopicFolders) ? gradeTopicFolders : [];
  if (!q || !folders.length) return null;
  let best = null;
  folders.forEach(function (folder) {
    const name = String(folder || '').trim();
    if (!name || name === '__general__') return;
    if (
      typeof hebrewTopicMatch.isInvalidCrossDomainTopicSuggestion === 'function'
      && hebrewTopicMatch.isInvalidCrossDomainTopicSuggestion(q, name)
    ) {
      return;
    }
    const score = scoreCommunityTopicSimilarity(q, name);
    if (!best || score > best.score) best = { topic: name, score: score };
  });
  if (!best) return null;
  if (best.score >= SEMANTIC_EQUIV_MIN_SCORE || topicsAreSemanticEquivalent(q, best.topic)) {
    return { matchType: 'semantic', suggestedTopic: best.topic, similarity: best.score };
  }
  if (best.score >= PARTIAL_SUGGEST_MIN_SCORE) {
    return { matchType: 'partial', suggestedTopic: best.topic, similarity: best.score };
  }
  return null;
}

function parseIsoMs(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Drive metadata delta vs an archived community_drive_archive row.
 *
 * Counts as "new/changed" only when:
 *  - driveFileId is not in the archived corpus (source_file_ids / file_refs), OR
 *  - known file's modifiedTime differs from the stored file_refs.modifiedTime, OR
 *  - archive stored no file ids: file modifiedTime is after created_at/updated_at.
 *
 * Intentionally does NOT treat "modifiedTime > created_at" for known file ids as a
 * change — that false-positive forced full extract+Gemini on every request.
 */
function findNewOrChangedDriveFiles(matches, existingRow) {
  const row = existingRow || {};
  const sinceMs = parseIsoMs(row.created_at) || parseIsoMs(row.updated_at);
  const knownIds = new Set();
  (Array.isArray(row.source_file_ids) ? row.source_file_ids : []).forEach(function (id) {
    const s = String(id || '').trim();
    if (s) knownIds.add(s);
  });
  const knownModified = {};
  (Array.isArray(row.file_refs) ? row.file_refs : []).forEach(function (ref) {
    if (!ref) return;
    const id = String(ref.driveFileId || ref.id || '').trim();
    if (!id) return;
    knownIds.add(id);
    if (ref.modifiedTime) knownModified[id] = String(ref.modifiedTime);
  });

  const fresh = [];
  (matches || []).forEach(function (match) {
    if (!match) return;
    const id = String(match.driveFileId || '').trim()
      || (String(match.id || '').indexOf('drive:') === 0 ? String(match.id).slice(6) : '');
    if (!id) return;
    const mod = String(match.modifiedTime || '').trim();
    const modMs = parseIsoMs(mod);

    if (knownIds.size > 0) {
      if (!knownIds.has(id)) {
        // Brand-new file id since the archive was written.
        fresh.push(match);
        return;
      }
      // Known corpus member: only a real modifiedTime change vs stored ref counts.
      if (knownModified[id] && mod && knownModified[id] !== mod) {
        fresh.push(match);
      }
      return;
    }

    // Archive row had no file ids — fall back to created_at vs Drive modifiedTime.
    if (sinceMs > 0 && modMs > sinceMs) {
      fresh.push(match);
    }
  });
  return fresh;
}

/**
 * Fast semantic relevance: are new Drive files about the requested topic?
 */
function areNewFilesRelevantToTopic(topic, newFiles) {
  const q = String(topic || '').trim();
  if (!q || !(newFiles || []).length) return false;
  return (newFiles || []).some(function (file) {
    if (!file) return false;
    const name = String(file.fileName || file.title || file.displayTitle || file.name || '').trim();
    const folder = String(file.catalogTopic || file.topic || file.folder || '').trim();
    if (typeof driveCatalogSync.nameMatchesTopicCentrally === 'function'
      && driveCatalogSync.nameMatchesTopicCentrally(name, q, q)) {
      return true;
    }
    if (typeof driveCatalogSync.topicsStrictlyCompatible === 'function') {
      if (folder && driveCatalogSync.topicsStrictlyCompatible(q, folder)) return true;
      if (name && driveCatalogSync.topicsStrictlyCompatible(q, name)) return true;
    }
    if (topicsAreSemanticEquivalent(q, name) || topicsAreSemanticEquivalent(q, folder)) {
      return true;
    }
    return scoreCommunityTopicSimilarity(q, name || folder) >= PARTIAL_SUGGEST_MIN_SCORE;
  });
}

function formatArchivedSummaryResult(existing, archiveKey, extras) {
  const extra = extras || {};
  const summary = sanitizeCommunitySummaryMarkdown(existing.summary_md);
  return {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: summary,
    communityStatus: 'ok',
    fromArchive: true,
    deltaUpdated: false,
    archiveKey: archiveKey || existing.archive_key,
    fileRefs: Array.isArray(existing.file_refs) ? existing.file_refs : [],
    sourceFingerprint: String(existing.source_fingerprint || ''),
    model: existing.model || null,
    instantHit: Boolean(extra.instantHit),
    smartCacheHit: Boolean(extra.smartCacheHit),
    matchedTopic: extra.matchedTopic || archiveRowTopicLabel(existing) || '',
    matchType: extra.matchType || 'exact',
  };
}

/**
 * Build a Perplexity-style "did you mean" payload (no full summary yet).
 */
function buildDidYouMeanResult(query, options, suggestion) {
  const opts = options || {};
  const suggested = String(
    (suggestion && (suggestion.suggestedTopic || suggestion.topic)) || ''
  ).trim();
  const prompt = suggested
    ? ('האם התכוונת ל-' + suggested + '?')
    : 'האם התכוונת לנושא קרוב במאגר הקהילתי?';
  return {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: prompt,
    communityStatus: 'needs_confirmation',
    fromArchive: false,
    deltaUpdated: false,
    archiveKey: null,
    fileRefs: [],
    sourceFingerprint: '',
    model: null,
    didYouMean: true,
    needsConfirmation: true,
    suggestedTopic: suggested,
    requestedTopic: String(query || '').trim(),
    similarity: suggestion && suggestion.similarity != null ? suggestion.similarity : null,
    matchType: (suggestion && suggestion.matchType) || 'partial',
    gradeId: String(opts.gradeId || opts.currentGrade || '').trim(),
  };
}

/**
 * Smart cache evaluation against live Drive matches.
 * - No new files since created_at → reuse archive
 * - New files irrelevant to topic → reuse archive
 * - New files relevant → null (caller must re-summarize)
 */
function evaluateSmartCacheAgainstDrive(existing, matches, options) {
  const opts = options || {};
  if (!isUsableArchiveRow(existing)) return null;
  if (opts.forceRefresh === true || opts.refresh === true) return null;

  const newFiles = findNewOrChangedDriveFiles(matches, existing);
  if (!newFiles.length) {
    console.log(
      '[community-drive-archive] SMART CACHE HIT — no new Drive files since',
      existing.created_at || existing.updated_at,
      '| key:',
      String(existing.archive_key || '').slice(0, 12)
    );
    return formatArchivedSummaryResult(existing, existing.archive_key, {
      smartCacheHit: true,
      instantHit: false,
      matchedTopic: opts.matchedTopic || archiveRowTopicLabel(existing),
      matchType: opts.matchType || 'exact',
    });
  }

  const topic = String(opts.topic || opts.matchedTopic || existing.topic || '').trim();
  const relevant = areNewFilesRelevantToTopic(topic, newFiles);
  if (!relevant) {
    console.log(
      '[community-drive-archive] SMART CACHE HIT — new Drive files not relevant to topic',
      JSON.stringify(topic),
      '| newFiles:',
      newFiles.length,
      '| key:',
      String(existing.archive_key || '').slice(0, 12)
    );
    return formatArchivedSummaryResult(existing, existing.archive_key, {
      smartCacheHit: true,
      instantHit: false,
      matchedTopic: topic,
      matchType: opts.matchType || 'exact',
    });
  }

  console.log(
    '[community-drive-archive] SMART CACHE MISS — relevant new Drive files; will re-summarize',
    '| newFiles:',
    newFiles.map(function (f) { return f.fileName || f.driveFileId; }).join(' | ')
  );
  return null;
}

/**
 * Archive lookup with semantic normalization.
 * Does NOT skip Drive delta checks — callers must pass matches into evaluateSmartCacheAgainstDrive.
 * Kept for backward compatibility; prefer findCommunityArchiveMatch + evaluateSmartCacheAgainstDrive.
 */
async function tryInstantArchiveRetrieval(query, options) {
  const opts = options || {};
  if (opts.forceRefresh === true || opts.refresh === true) return null;
  if (opts.skipDriveDeltaCheck === true) {
    // Legacy path: only when caller explicitly opts into blind instant hit.
    const match = await findCommunityArchiveMatch(query, opts);
    if (!match || !match.row || match.matchType === 'partial') return null;
    return formatArchivedSummaryResult(match.row, match.archiveKey, {
      instantHit: true,
      smartCacheHit: true,
      matchedTopic: match.suggestedTopic,
      matchType: match.matchType,
    });
  }
  // Default: do not return archive without Drive delta verification.
  return null;
}

async function upsertArchiveRow(record) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    throw new Error('Supabase not configured for community_drive_archive');
  }
  const payload = Object.assign({}, record, {
    updated_at: new Date().toISOString(),
  });
  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?on_conflict=archive_key', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('community_drive_archive upsert failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const data = text ? JSON.parse(text) : [];
  return Array.isArray(data) ? data[0] : data;
}

function extractGeminiText(payload) {
  const candidates = payload && payload.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return '';
  const parts = candidates[0].content && candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(function (part) {
    return part && typeof part.text === 'string' ? part.text : '';
  }).join('').trim();
}

function resolveMultimodalMime(mimeType, fileName) {
  const mime = String(mimeType || '').toLowerCase().trim();
  const name = String(fileName || '').toLowerCase();
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'application/pdf';
  if (mime === 'image/jpeg' || mime === 'image/jpg' || /\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (mime === 'image/png' || /\.png$/i.test(name)) return 'image/png';
  if (mime === 'image/webp' || /\.webp$/i.test(name)) return 'image/webp';
  if (mime === 'image/gif' || /\.gif$/i.test(name)) return 'image/gif';
  if (mime.indexOf('image/') === 0) return mime;
  return '';
}

function isMultimodalCandidate(ref) {
  if (!ref) return false;
  const reason = String(ref.failReason || '');
  if (reason === 'not_found' || reason === 'broken_shortcut') return false;
  return Boolean(resolveMultimodalMime(ref.mimeType, ref.name));
}

/**
 * Resumable upload to Gemini Files API (for PDFs/images above inline size).
 */
async function uploadGeminiFile(buffer, mimeType, displayName) {
  const apiKey = env.getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const mime = String(mimeType || 'application/octet-stream');
  const startRes = await fetch(GEMINI_API_BASE.replace('/v1beta', '') + '/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file: { display_name: String(displayName || 'community-drive.pdf').slice(0, 120) },
    }),
  });
  if (!startRes.ok) {
    const text = await startRes.text();
    throw new Error('Gemini Files start failed (' + startRes.status + '): ' + text.slice(0, 300));
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url') || startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('Gemini Files start returned no upload URL');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Type': mime,
    },
    body: bytes,
  });
  const uploadRaw = await uploadRes.text();
  let uploadPayload;
  try {
    uploadPayload = JSON.parse(uploadRaw);
  } catch (e) {
    throw new Error('Gemini Files upload returned non-JSON: ' + String(uploadRaw || '').slice(0, 300));
  }
  if (!uploadRes.ok) {
    const msg = uploadPayload.error && uploadPayload.error.message
      ? uploadPayload.error.message
      : uploadRaw.slice(0, 300);
    throw new Error('Gemini Files upload failed (' + uploadRes.status + '): ' + msg);
  }
  const file = uploadPayload.file || uploadPayload;
  if (!file || !file.uri) {
    throw new Error('Gemini Files upload missing file.uri');
  }
  return file;
}

async function waitForGeminiFileActive(fileName, options) {
  const opts = options || {};
  const apiKey = env.getGeminiApiKey();
  const rawName = String(fileName || '').trim();
  if (!apiKey || !rawName) return null;
  const pathName = rawName.indexOf('files/') === 0 ? rawName : ('files/' + rawName);
  const maxAttempts = Number(opts.maxAttempts) > 0 ? Number(opts.maxAttempts) : 20;
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(GEMINI_API_BASE + '/' + pathName, {
      headers: { 'x-goog-api-key': apiKey },
    });
    const raw = await res.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      throw new Error('Gemini Files get returned non-JSON: ' + String(raw || '').slice(0, 200));
    }
    if (!res.ok) {
      const msg = payload.error && payload.error.message ? payload.error.message : raw.slice(0, 200);
      throw new Error('Gemini Files get failed (' + res.status + '): ' + msg);
    }
    const state = String(payload.state || '').toUpperCase();
    if (state === 'ACTIVE') return payload;
    if (state === 'FAILED') {
      throw new Error('Gemini Files processing failed for ' + pathName);
    }
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
  }
  throw new Error('Gemini Files still processing after wait: ' + pathName);
}

/**
 * Download a Drive PDF/image for multimodal Gemini when text extract yielded 0 chars.
 * Resolves shortcuts to their targets before media download.
 */
async function prepareMultimodalMediaParts(failedRefs, accessToken) {
  const partsMeta = [];
  const seenIds = new Set();
  const refs = [];
  (failedRefs || []).forEach(function (ref) {
    if (!ref || !isMultimodalCandidate(ref)) return;
    const id = String(ref.driveFileId || ref.id || '').trim();
    if (id && seenIds.has(id)) return;
    if (id) seenIds.add(id);
    refs.push(ref);
  });
  const capped = refs.slice(0, MAX_MULTIMODAL_FILES);
  const maxDownload = typeof driveCatalogSync.MAX_MULTIMODAL_DOWNLOAD_BYTES === 'number'
    ? driveCatalogSync.MAX_MULTIMODAL_DOWNLOAD_BYTES
    : MAX_GEMINI_MULTIMODAL_BYTES;

  for (let i = 0; i < capped.length; i++) {
    const ref = capped[i];
    let mime = resolveMultimodalMime(ref.mimeType, ref.name);
    if (!mime) continue;
    try {
      console.log(
        '[community-drive-archive] multimodal fallback — downloading',
        ref.name || ref.driveFileId,
        '| mime:',
        mime,
        '| reason:',
        ref.failReason || 'thin_extract'
      );

      let downloadId = ref.driveFileId;
      let resourceKey = ref.resourceKey || '';
      // Resolve shortcut shells so we download the real PDF/image bytes.
      try {
        const meta = await driveCatalogSync.fetchDriveFileMeta(
          downloadId,
          accessToken,
          null,
          { resourceKey: resourceKey }
        );
        if (meta && String(meta.mimeType || '') === 'application/vnd.google-apps.shortcut') {
          const target = await driveCatalogSync.resolveShortcutTarget(meta, accessToken);
          if (!target || !target.id) {
            console.warn('[community-drive-archive] multimodal skip — broken shortcut:', ref.name);
            continue;
          }
          downloadId = target.id;
          resourceKey = target.resourceKey || '';
          mime = resolveMultimodalMime(target.mimeType, target.name || ref.name) || mime;
          console.log(
            '[community-drive-archive] multimodal via shortcut target:',
            ref.name,
            '→',
            downloadId,
            mime
          );
        } else if (meta && meta.mimeType) {
          mime = resolveMultimodalMime(meta.mimeType, meta.name || ref.name) || mime;
          if (meta.resourceKey) resourceKey = meta.resourceKey;
        }
      } catch (metaErr) {
        // Keep original id; download may still succeed with resourceKey.
        console.warn(
          '[community-drive-archive] multimodal meta resolve warning:',
          ref.name,
          metaErr && metaErr.message ? metaErr.message : metaErr
        );
      }

      if (!resolveMultimodalMime(mime, ref.name)) {
        console.warn('[community-drive-archive] multimodal skip — unsupported mime after resolve:', mime);
        continue;
      }

      const buffer = await driveCatalogSync.downloadDriveFileBuffer(
        downloadId,
        accessToken,
        {
          resourceKey: resourceKey,
          maxBytes: maxDownload,
        }
      );
      if (!buffer || !buffer.length) {
        console.warn('[community-drive-archive] multimodal download empty:', ref.name);
        continue;
      }
      if (buffer.length > MAX_GEMINI_MULTIMODAL_BYTES) {
        console.warn(
          '[community-drive-archive] multimodal skip — over Gemini PDF/image cap:',
          ref.name,
          buffer.length,
          'bytes'
        );
        continue;
      }

      let contentPart;
      if (buffer.length <= MAX_GEMINI_INLINE_BYTES) {
        contentPart = {
          inlineData: {
            mimeType: mime,
            data: buffer.toString('base64'),
          },
        };
        console.log(
          '[community-drive-archive] multimodal inlineData ready:',
          ref.name,
          '| bytes:',
          buffer.length
        );
      } else {
        const uploaded = await uploadGeminiFile(buffer, mime, ref.name || ref.driveFileId);
        const active = await waitForGeminiFileActive(uploaded.name || uploaded.uri);
        const fileUri = (active && active.uri) || uploaded.uri;
        contentPart = {
          fileData: {
            mimeType: mime,
            fileUri: fileUri,
          },
        };
        console.log(
          '[community-drive-archive] multimodal Files API ready:',
          ref.name,
          '| bytes:',
          buffer.length,
          '| uri:',
          fileUri
        );
      }

      partsMeta.push({
        ref: ref,
        contentPart: contentPart,
        byteLength: buffer.length,
        mimeType: mime,
      });
    } catch (mediaErr) {
      console.warn(
        '[community-drive-archive] multimodal prepare failed:',
        ref.name || ref.driveFileId,
        mediaErr && mediaErr.message ? mediaErr.message : mediaErr
      );
    }
  }
  return partsMeta;
}

async function callGeminiModel(model, systemPrompt, userParts, options) {
  const opts = options || {};
  const apiKey = env.getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  const parts = Array.isArray(userParts) ? userParts : [{ text: String(userParts || '') }];
  const url = GEMINI_API_BASE + '/models/' + encodeURIComponent(model) + ':generateContent';
  // Plain Markdown (not JSON) — wrapping a long Hebrew work plan in JSON routinely
  // truncates / shortens the pedagogical body. Keep optional JSON only as a last resort.
  const wantJson = opts.responseJson === true;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: parts }],
      generationConfig: {
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.55,
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        ...(wantJson ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });
  const raw = await res.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    console.error(
      '[community-drive-archive] Gemini HTTP envelope JSON.parse failed:',
      e && e.message ? e.message : e
    );
    console.error(
      '[community-drive-archive] Gemini HTTP raw response (first 2000 chars):',
      String(raw || '').slice(0, 2000)
    );
    throw new Error('Gemini returned non-JSON (' + res.status + '): ' + String(raw || '').slice(0, 300));
  }
  if (!res.ok) {
    const msg = payload.error && payload.error.message ? payload.error.message : raw.slice(0, 300);
    const err = new Error('Gemini ' + model + ' error ' + res.status + ': ' + msg);
    err.statusCode = res.status;
    throw err;
  }
  const finishReason = payload
    && payload.candidates
    && payload.candidates[0]
    && payload.candidates[0].finishReason;
  if (finishReason && String(finishReason).toUpperCase() === 'MAX_TOKENS') {
    console.warn('[community-drive-archive] Gemini hit MAX_TOKENS — summary may be truncated:', model);
  }
  const text = extractGeminiText(payload);
  if (!text) throw new Error('Gemini ' + model + ' returned an empty summary');
  const parsed = wantJson
    ? parseGeminiSummaryJson(text)
    : (/^\s*\{/.test(text) ? parseGeminiSummaryJson(text) : text);
  return sanitizeCommunitySummaryMarkdown(parsed);
}

function buildCommunitySummarySystemPrompt() {
  return [
    'אתה יועץ פדגוגי בכיר ומנוסה בחינוך ולדורף, הכותב תכניות עבודה לימודיות מעמיקות ומפורטות למורים.',
    'תפקידך לעבד ולחלץ טקסט מכל הקבצים שסופקו בתיקיית הנושא — ללא יוצא מן הכלל — תוך תשומת לב מיוחדת למחברות תלמידים, מחברות מורים, ספרי שיעור ראשי (main lesson books), מסמכי Word/Google Docs, וקבצי PDF (כולל סרוקים).',
    'אסור בתכלית האיסור להפיק תקציר שטחי, סיכום קצר, רשימת בולטים דלה, או אבסטרקט כללי. המורה הקורא חייב להרגיש שנעשתה עבודה רצינית, איכותית ועמוקה — מסמך תכנית עבודה מקיף ובר־יישום בכיתה.',
    'בצע סינתזה אמיתית בין כל המקורות לכדי מסמך פדגוגי אחד אחיד ועשיר — לא העתקה של קטעים זה לצד זה, ולא כותרות עם משפט בודד.',
    'אסור להסתמך על ידע חיצוני או על חיפוש ברשת — רק על הטקסטים/המסמכים/ה־PDF שסופקו. אם פרט מסוים אינו מופיע במקורות, ציין במפורש שאינו נמצא בחומרים שסופקו — אל תמציא.',
    'כתוב בעברית פדגוגית עשירה, רהוטה, מקצועית ועמוקה. פסקאות מלאות (לא שורות בודדות). סיים כל פסקה וכל סעיף בצורה מלאה — אל תקטע משפטים באמצע.',
    'דרישת אורך ועומק (חובה): כשיש תוכן במקורות, המסמך חייב להיות מפורט ומקיף — מינימום 1200–2000 מילים (ורצוי יותר אם החומר מאפשר). כל אחד מחמשת הסעיפים הראשיים חייב לכלול לפחות 3–5 פסקאות או תתי־סעיפים עם פירוט קונקרטי. אסור להסתפק בכותרת + משפט אחד או ברשימת בולטים שטחית.',
    'מבנה Markdown חובה בתוך שדה summary — כותרת ראשית (#), ואז חמשת הסעיפים הבאים בדיוק כ־## (המקבילים ל־<h2>) עם תתי־סעיפים ב־### (המקבילים ל־<h3>) ובולטים מפורטים בכל סעיף:',
    '## 1. רקע והדגשה פדגוגית — סקירה מעמיקה של התקופה/הנושא במסגרת הפדגוגיה הוולדורפית והתפתחות התודעה לשכבת הגיל/הכיתה הספציפית; השאלות המנחות, הרעיון המרכזי, והמתח/הנושא הרוחני־התפתחותי העולים מהחומרים. הרחב מעבר להגדרה קצרה.',
    '## 2. סינתזה רחבה של החומרים — סינתזה יסודית ומפורטת של חומרי ההוראה מכל הקבצים בתיקייה (מערכי שיעור, מחברות, ספרי שיעור ראשי, PDF ומסמכים); ארגן עם כותרות ## / ### ברורות; פרט נושאים, פרקים, מושגים ורצף אפשרי לאורך התקופה כפי שמשתקף במקורות — לא כותרות כלליות בלבד.',
    '## 3. הצעות לפעילויות יצירתיות ואמנותיות — רעיונות קונקרטיים ומעשיים לעבודה אמנותית, יצירתית או חווייתית הנשענים על חומרי התיקייה (ציור לוח, כתיבה יוצרת, תנועה, מלאכה, סיפור, עבודה מעשית וכו׳).',
    '## 4. דרכי הערכה ומודלים למבחן/עבודה — מודלי הערכה מעשיים, מחוונים/רובריקות, או מבני מבחן/עבודה כפי שנמצאים בקבצים או נגזרים מהם; מפרט דרישות לתלמיד. אם אין חומרי הערכה במקורות — ציין זאת במפורש ואל תמציא מבחן, אך תאר כיצד המקורות מציגים מיומנויות לתרגול/הפנמה.',
    '## 5. מראי מקום והפניות למאגר — רשימה ברורה של הקבצים/הקישורים מהמאגר הקהילתי שבהם נעשה שימוש, כדי שהמורה יוכל לגשת בקלות לחומרי המקור.',
    'הדגש מושגי מפתח ב־**מודגש**. בהדגשות Markdown שמור על זוגות תקינים של **…** באותה יחידת טקסט — אל תשבור ** באמצע שורה ללא סגירה.',
    'חובה להשלים את כל חמשת הסעיפים עד הסוף בעומק מלא — אל תעצור באמצע משפט, אל תקצר בגלל אורך, אל תדלג על סעיפים, ואל תסיים במשפט כללי כמו «ועוד».',
    'בסעיף מראי מקום הצג רק את שם הקובץ או שם התיקייה הישיר (למשל «עבודת רנסנס.pdf») — אסור לציין נתיבי תיקיות ארוכים עם «>».',
    'כל מראה מקום בשורה נפרדת כקישור Markdown: [שם הקובץ](url).',
    'פורמט פלט חובה: החזר את מסמך ה־Markdown המלא בלבד — התחל ב־# כותרת, המשך עם ## / ###, וסיים במראי מקום.',
    'אסור לעטוף ב-JSON, אסור {"summary":...}, אסור ```markdown או ```json — רק גוף המסמך בעברית.',
  ].join(' ');
}

function resolveGradeLabelForPrompt(gradeId) {
  const gid = String(gradeId || '').trim();
  if (!gid) return '';
  if (gid === 'general') return 'כללי (פדגוגיה כללית / חוצה־כיתות)';
  const map = {
    '1': "כיתה א׳", '2': "כיתה ב׳", '3': "כיתה ג׳", '4': "כיתה ד׳",
    '5': "כיתה ה׳", '6': "כיתה ו׳", '7': "כיתה ז׳", '8': "כיתה ח׳",
  };
  return map[gid] || ('כיתה ' + gid);
}

function buildCommunitySummaryTextPreamble(query, options, fileBundles, mediaMeta) {
  const opts = options || {};
  const gradeLabel = resolveGradeLabelForPrompt(opts.gradeId || opts.currentGrade);
  const sourcesBlock = (fileBundles || []).map(function (bundle, idx) {
    const leafName = shortCitationDisplayName(bundle.name, 'קובץ Drive');
    return [
      '=== מקור טקסט ' + (idx + 1) + ' ===',
      'שם קובץ להצגה במראי מקום: ' + leafName,
      bundle.webViewLink ? ('קישור Drive: ' + bundle.webViewLink) : '',
      'תוכן:',
      String(bundle.text || '').slice(0, MAX_CHARS_PER_FILE),
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const mediaBlock = (mediaMeta || []).map(function (item, idx) {
    const ref = item.ref || {};
    const leafName = shortCitationDisplayName(ref.name, 'קובץ Drive');
    return [
      '=== מסמך/תמונה מצורפת ' + (idx + 1) + ' ===',
      'שם קובץ להצגה במראי מקום: ' + leafName,
      ref.webViewLink || ref.fileUrl ? ('קישור Drive: ' + (ref.webViewLink || ref.fileUrl)) : '',
      'סוג: ' + (item.mimeType || ref.mimeType || ''),
      'הוראה: קרא/י לעומק את המסמך או התמונה המצורפים (PDF סרוק / תמונה / מחברת) וחלץ מהם את מלוא התוכן הפדגוגי לתכנית העבודה המעמיקה — אל תסתפק בתקציר שטחי.',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return [
    'נושא החיפוש: ' + String(query || '').trim(),
    gradeLabel ? ('שכבת גיל / כיתה: ' + gradeLabel) : '',
    opts.topic ? ('נושא קטלוג: ' + opts.topic) : '',
    '',
    'עבד וחלץ טקסט מכל הקבצים והמסמכים שלהלן (מחברות תלמידים/מורים, ספרי שיעור ראשי, מסמכים ו־PDF כולל סרוקים) ובנה תכנית עבודה לימודית מעמיקה, מפורטת ומורחבת למורה — סינתזה אמיתית בין המקורות, לא תקציר שטחי ולא סיכום קצר/דל.',
    'כשיש חומר במקורות: כתוב מסמך מפורט באורך מינימום 1200–2000 מילים (או יותר לפי עומק החומר). כל סעיף ראשי חייב להיות עשיר בתוכן — לא כותרת עם משפט בודד ולא רשימת בולטים שטחית.',
    'חובה לכלול את חמשת הסעיפים עם כותרות ## (<h2>) ותתי־סעיפים ### (<h3>)/בולטים מפורטים: (1) רקע והדגשה פדגוגית; (2) סינתזה רחבה של החומרים; (3) הצעות לפעילויות יצירתיות ואמנותיות; (4) דרכי הערכה ומודלים למבחן/עבודה; (5) מראי מקום והפניות למאגר.',
    'שלב בין מערכי שיעור, מחברות, ספרי שיעור ראשי, דפי עבודה, מבחנים, PDF וחומרי רקע לכתיבה קוהרנטית אחת עם ## / ### ובולטים מפורטים.',
    'כתוב עד להשלמה מלאה של כל הסעיפים כולל מראי מקום — בלי קיטוע באמצע משפט ובלי קיצור מלאכותי.',
    'הכותרת הראשית של המסמך חייבת להיות:',
    COMMUNITY_SUMMARY_HEADING,
    '',
    'פורמט פלט חובה: החזר רק את מסמך ה־Markdown המלא בעברית (כותרת #, סעיפי ## / ###, מראי מקום).',
    'אין JSON, אין {"summary":...}, אין עטיפת ```.',
    '',
    sourcesBlock,
    mediaBlock,
  ].filter(function (line) { return line !== ''; }).join('\n');
}

async function summarizeWithGemini15Pro(query, fileBundles, options) {
  return summarizeCommunitySourcesWithGemini(query, fileBundles, [], options);
}

/**
 * Text bundles and/or multimodal PDF/image parts → one pedagogical summary.
 * Retries once with a stricter depth instruction when the first draft is shallow.
 */
async function summarizeCommunitySourcesWithGemini(query, fileBundles, mediaMeta, options) {
  const opts = options || {};
  const systemPrompt = buildCommunitySummarySystemPrompt();
  const preamble = buildCommunitySummaryTextPreamble(query, opts, fileBundles, mediaMeta);
  const userParts = [{ text: preamble }];
  (mediaMeta || []).forEach(function (item) {
    if (item && item.contentPart) userParts.push(item.contentPart);
  });

  const models = [GEMINI_MODEL].concat(GEMINI_FALLBACK_MODELS);
  let lastErr = null;
  let bestSummary = '';
  let bestModel = null;

  for (let i = 0; i < models.length; i++) {
    try {
      let summary = await callGeminiModel(models[i], systemPrompt, userParts, {
        temperature: 0.55,
      });
      console.log(
        '[community-drive-archive] Gemini draft length:',
        summary.length,
        '| model:',
        models[i],
        '| deepEnough:',
        isSummaryDeepEnough(summary)
      );

      if (!isSummaryDeepEnough(summary)) {
        console.warn(
          '[community-drive-archive] shallow draft — retrying with depth enforcement:',
          models[i]
        );
        const retryParts = userParts.slice();
        retryParts[0] = {
          text: preamble + '\n\n' + [
            '=== הנחיית העמקה (חובה) ===',
            'הטיוטה הקודמת הייתה קצרה/דלה מדי. כתוב מחדש תכנית עבודה מלאה ומעמיקה.',
            'מינימום 1500 מילים. חובה לכלול את כל חמשת הסעיפים עם ## ו־###.',
            'שלוף מהקבצים המצורפים פעילויות יצירתיות/אמנותיות ומודלי הערכה/מבחנים/עבודות במפורש.',
            'אל תקצר. אל תחזיר תקציר. אל תחזיר JSON.',
          ].join(' ')
        };
        try {
          const retrySummary = await callGeminiModel(models[i], systemPrompt, retryParts, {
            temperature: 0.65,
          });
          if (retrySummary && retrySummary.length >= summary.length) {
            summary = retrySummary;
          }
          console.log(
            '[community-drive-archive] retry length:',
            summary.length,
            '| deepEnough:',
            isSummaryDeepEnough(summary)
          );
        } catch (retryErr) {
          console.warn(
            '[community-drive-archive] depth retry failed:',
            retryErr && retryErr.message ? retryErr.message : retryErr
          );
        }
      }

      if (!bestSummary || summary.length > bestSummary.length) {
        bestSummary = summary;
        bestModel = models[i];
      }
      if (isSummaryDeepEnough(summary)) {
        return {
          summary: summary,
          model: models[i],
          multimodalFileCount: (mediaMeta || []).length,
        };
      }
      // Keep trying fallback models if the draft is still shallow.
      lastErr = new Error('Gemini returned a shallow pedagogical summary');
      continue;
    } catch (err) {
      lastErr = err;
      const status = err && err.statusCode;
      if (status === 404 || status === 400) {
        console.warn('[community-drive-archive] model unavailable:', models[i], err.message || err);
        continue;
      }
      throw err;
    }
  }

  if (bestSummary) {
    console.warn(
      '[community-drive-archive] returning best-effort summary (may still be shorter than ideal)',
      '| chars:',
      bestSummary.length
    );
    return {
      summary: bestSummary,
      model: bestModel,
      multimodalFileCount: (mediaMeta || []).length,
    };
  }
  throw lastErr || new Error('Gemini summarization failed');
}

async function extractTextsForRefs(fileRefs, accessToken) {
  const bundles = [];
  const failedRefs = [];
  const multimodalPreferredRefs = [];
  let totalChars = 0;
  console.log(
    '[community-drive-archive] extracting text from',
    (fileRefs || []).length,
    'Drive file(s) for multi-file merge…'
  );
  for (let i = 0; i < (fileRefs || []).length; i++) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      console.warn(
        '[community-drive-archive] total char budget reached — remaining files skipped'
      );
      break;
    }
    const ref = fileRefs[i];
    try {
      const extracted = await driveCatalogSync.extractDriveFileText(ref.driveFileId, {
        accessToken: accessToken,
        fileName: ref.name,
        mimeType: ref.mimeType,
        resourceKey: ref.resourceKey || '',
      });
      if (extracted && extracted.skipped) {
        failedRefs.push(Object.assign({}, ref, {
          failReason: extracted.skipReason || 'skipped',
          mimeType: extracted.mimeType || ref.mimeType,
        }));
        console.warn(
          '[community-drive-archive] skip extract:',
          ref.name || ref.driveFileId,
          extracted.skipReason || 'skipped'
        );
        continue;
      }
      const text = String(extracted && extracted.text || '').trim();
      const mime = (extracted && extracted.mimeType) || ref.mimeType || '';
      const isPdfOrImage = Boolean(resolveMultimodalMime(mime, ref.name || (extracted && extracted.name)));

      // Empty / tiny extract → multimodal binary path (scanned PDF / image).
      if (!text || text.length < 40) {
        failedRefs.push(Object.assign({}, ref, {
          failReason: text ? 'thin_extract' : 'empty_extract',
          mimeType: mime,
          resourceKey: (extracted && extracted.resourceKey) || ref.resourceKey || '',
          driveFileId: (extracted && extracted.driveFileId) || ref.driveFileId,
        }));
        console.warn(
          '[community-drive-archive] skip thin/empty extract:',
          ref.name || ref.driveFileId,
          '| chars:',
          text.length
        );
        continue;
      }

      // Partial PDF text is often incomplete OCR — keep text AND prefer full PDF bytes.
      if (isPdfOrImage && text.length < MIN_RELIABLE_PDF_TEXT_CHARS) {
        multimodalPreferredRefs.push(Object.assign({}, ref, {
          failReason: 'unreliable_pdf_text',
          mimeType: mime,
          resourceKey: (extracted && extracted.resourceKey) || ref.resourceKey || '',
          driveFileId: (extracted && extracted.driveFileId) || ref.driveFileId,
        }));
        console.warn(
          '[community-drive-archive] unreliable PDF/image text — queue multimodal:',
          ref.name || ref.driveFileId,
          '| chars:',
          text.length
        );
      }

      const clipped = text.slice(0, Math.min(MAX_CHARS_PER_FILE, MAX_TOTAL_CHARS - totalChars));
      totalChars += clipped.length;
      bundles.push({
        name: ref.name || (extracted && extracted.name) || ref.driveFileId,
        folderPath: ref.folderPath || ref.folder || '',
        folder: ref.folder || '',
        driveFileId: (extracted && extracted.driveFileId) || ref.driveFileId,
        webViewLink: ref.fileUrl || ref.webViewLink || '',
        mimeType: mime,
        text: clipped,
        charCount: clipped.length,
      });
      console.log(
        '[community-drive-archive] extracted OK:',
        bundles[bundles.length - 1].name,
        '| chars:',
        clipped.length,
        '| mime:',
        bundles[bundles.length - 1].mimeType || '(unknown)'
      );
    } catch (extractErr) {
      failedRefs.push(Object.assign({}, ref, {
        failReason: String(extractErr && extractErr.message ? extractErr.message : extractErr),
      }));
      console.warn(
        '[community-drive-archive] extract failed:',
        ref.name || ref.driveFileId,
        extractErr.message || extractErr
      );
    }
  }
  console.log(
    '[community-drive-archive] merge ready for Gemini — files:',
    bundles.length,
    '| names:',
    bundles.map(function (b) { return b.name; }).join(' | '),
    '| totalChars:',
    totalChars,
    failedRefs.length ? ('| failed/empty: ' + failedRefs.length) : '',
    multimodalPreferredRefs.length ? ('| multimodalPreferred: ' + multimodalPreferredRefs.length) : ''
  );
  return {
    bundles: bundles,
    failedRefs: failedRefs,
    multimodalPreferredRefs: multimodalPreferredRefs,
  };
}

function emptySummaryResult(query, options) {
  return {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: COMMUNITY_SUMMARY_EMPTY,
    communityStatus: 'empty',
    fromArchive: false,
    deltaUpdated: false,
    archiveKey: buildArchiveKey(query, options),
    fileRefs: [],
    sourceFingerprint: '',
    model: null,
  };
}

function degradedNoExtractResult(fileRefs, archiveKey, fingerprint, communityError) {
  const fileList = (fileRefs || []).map(function (ref) {
    return '• ' + (ref.name || ref.driveFileId) + (ref.folderPath ? ' (' + ref.folderPath + ')' : '');
  }).join('\n');
  return {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: [
      'נמצאו חומרים במאגר הקהילתי לנושא זה, אך לא ניתן היה לחלץ מהם טקסט לסיכום (קבצים סרוקים/גדולים מדי או קיצורים שאינם נגישים).',
      '',
      'קבצים שנמצאו:',
      fileList,
    ].join('\n'),
    communityStatus: 'degraded',
    fromArchive: false,
    deltaUpdated: false,
    archiveKey: archiveKey,
    fileRefs: fileRefs,
    sourceFingerprint: fingerprint,
    model: null,
    communityError: communityError || 'Drive text extraction failed for all matched files',
  };
}

/**
 * Delta community summary for the standalone summarizer.
 *
 * Flow (must stay in this order):
 *  1) Lookup community_drive_archive (params from frontend / caller)
 *  2) If usable cache row → compare Drive file ids / modifiedTime only
 *     → Cache Hit returns archived summary (no extract, no Gemini)
 *  3) Else extract text + Gemini + upsert community_drive_archive
 *
 * Never falls back to cached_results.
 */
async function resolveCommunityDriveSummary(query, matches, options) {
  const opts = options || {};
  const q = String(query || '').trim();
  const fileRefs = normalizeFileRefsFromMatches(matches);

  if (!fileRefs.length) {
    return emptySummaryResult(q, opts);
  }

  const archiveKey = buildArchiveKey(q, opts);
  const fingerprint = buildSourceFingerprint(fileRefs);

  try {
    // Prefer an existing row already resolved by semantic/exact match (same table only).
    let existing = opts.existingArchiveRow && isUsableArchiveRow(opts.existingArchiveRow)
      ? opts.existingArchiveRow
      : null;
    if (!existing) {
      console.log(
        '[community-drive-archive] cache lookup — querying community_drive_archive',
        '| topic:',
        JSON.stringify(opts.topic || opts.catalogTopic || q),
        '| grade:',
        String(opts.gradeId || opts.currentGrade || '')
      );
      const byKey = await fetchArchiveRowByKeyCandidates(q, opts);
      if (byKey && byKey.row) existing = byKey.row;
    }
    if (!existing) {
      existing = await fetchArchiveRow(archiveKey);
    }

    if (existing && isUsableArchiveRow(existing) && opts.forceRefresh !== true && opts.refresh !== true) {
      console.log(
        '[community-drive-archive] cache record found — checking Drive file ids/modifiedTime only',
        '| key:',
        String(existing.archive_key || archiveKey).slice(0, 12),
        '| cachedFiles:',
        Array.isArray(existing.source_file_ids) ? existing.source_file_ids.length : 0,
        '| driveFiles:',
        fileRefs.length
      );
      // 1) Smart cache via new file ids / stored modifiedTime delta
      const smartHit = evaluateSmartCacheAgainstDrive(existing, matches, {
        topic: opts.topic || opts.catalogTopic || q,
        matchedTopic: opts.matchedTopic || archiveRowTopicLabel(existing),
        matchType: opts.matchType || 'exact',
        forceRefresh: opts.forceRefresh,
        refresh: opts.refresh,
      });
      if (smartHit) {
        console.log(
          '[community-drive-archive] CACHE HIT — returning archived summary (skip extract + Gemini)'
        );
        return smartHit;
      }

      // 2) Fingerprint equality still counts as a hit (unchanged corpus)
      if (existing.source_fingerprint === fingerprint) {
        console.log(
          '[community-drive-archive] CACHE HIT — source fingerprint unchanged (skip extract + Gemini)'
        );
        return formatArchivedSummaryResult(existing, existing.archive_key || archiveKey, {
          smartCacheHit: true,
          matchedTopic: opts.matchedTopic || archiveRowTopicLabel(existing),
          matchType: opts.matchType || 'exact',
        });
      }
      console.warn(
        '[community-drive-archive] CACHE MISS — relevant Drive delta; will extract + Gemini',
        '| key:',
        String(existing.archive_key || archiveKey).slice(0, 12)
      );
    } else if (existing && !isUsableArchiveRow(existing)) {
      console.warn(
        '[community-drive-archive] cache row unusable (shallow/incomplete) — regenerating',
        '| chars:',
        String(existing.summary_md || '').length
      );
    } else if (!existing) {
      console.log(
        '[community-drive-archive] CACHE MISS — no community_drive_archive row; will extract + Gemini'
      );
    }
  } catch (lookupErr) {
    console.warn('[community-drive-archive] lookup failed:', lookupErr.message || lookupErr);
  }

  if (!env.getGeminiApiKey()) {
    const fileList = fileRefs.map(function (ref) {
      return '• ' + (ref.name || ref.driveFileId) + (ref.folderPath ? ' (' + ref.folderPath + ')' : '');
    }).join('\n');
    return {
      heading: COMMUNITY_SUMMARY_HEADING,
      summary: [
        'נמצאו חומרים במאגר הקהילתי, אך לא ניתן לייצר סיכום כרגע (חסר מפתח Gemini).',
        '',
        'קבצים שנמצאו:',
        fileList,
      ].join('\n'),
      communityStatus: 'degraded',
      fromArchive: false,
      deltaUpdated: false,
      archiveKey: archiveKey,
      fileRefs: fileRefs,
      sourceFingerprint: fingerprint,
      model: null,
      communityError: 'GEMINI_API_KEY missing — community summary skipped',
    };
  }

  let accessToken;
  try {
    accessToken = await driveCatalogSync.resolveDriveAccessToken(opts);
  } catch (tokenErr) {
    return {
      heading: COMMUNITY_SUMMARY_HEADING,
      summary: COMMUNITY_SUMMARY_EMPTY,
      communityStatus: 'unavailable',
      fromArchive: false,
      deltaUpdated: false,
      archiveKey: archiveKey,
      fileRefs: fileRefs,
      sourceFingerprint: fingerprint,
      model: null,
      communityError: String(tokenErr.message || tokenErr),
    };
  }

  const extracted = await extractTextsForRefs(fileRefs, accessToken);
  const bundles = extracted.bundles || [];
  const failedRefs = extracted.failedRefs || [];
  const multimodalPreferredRefs = extracted.multimodalPreferredRefs || [];

  // When pdf-parse / standard extract yields 0 chars (scanned PDF / image), or only
  // unreliable thin PDF text, send the binary to Gemini multimodal.
  let mediaMeta = [];
  const multimodalQueue = failedRefs.concat(multimodalPreferredRefs);
  if (multimodalQueue.some(isMultimodalCandidate)) {
    try {
      mediaMeta = await prepareMultimodalMediaParts(multimodalQueue, accessToken);
    } catch (multiErr) {
      console.warn(
        '[community-drive-archive] multimodal fallback setup failed:',
        multiErr && multiErr.message ? multiErr.message : multiErr
      );
    }
  }

  if (!bundles.length && !mediaMeta.length) {
    return degradedNoExtractResult(
      fileRefs,
      archiveKey,
      fingerprint,
      failedRefs.length
        ? 'Drive text extraction failed; multimodal fallback unavailable or over size limit'
        : 'Drive text extraction failed for all matched files'
    );
  }

  console.log(
    '[community-drive-archive] sending corpus to Gemini —',
    'textFiles:',
    bundles.length,
    '| multimodalFiles:',
    mediaMeta.length,
    bundles.map(function (b) {
      return (b.name || b.driveFileId) + ' (' + (b.charCount || 0) + ' chars)';
    }).concat(mediaMeta.map(function (m) {
      return (m.ref && m.ref.name ? m.ref.name : 'media') + ' (' + (m.byteLength || 0) + ' bytes multimodal)';
    })).join('; ')
  );

  const generated = await summarizeCommunitySourcesWithGemini(q, bundles, mediaMeta, {
    gradeId: opts.gradeId || opts.currentGrade || '',
    topic: opts.topic || opts.catalogTopic || '',
  });

  const cleanedSummary = sanitizeCommunitySummaryMarkdown(generated.summary);
  const record = {
    archive_key: archiveKey,
    search_query: q,
    query_text: q,
    grade_id: String(opts.gradeId || opts.currentGrade || '').trim(),
    topic: String(opts.topic || opts.catalogTopic || '').trim(),
    summary_md: cleanedSummary,
    community_status: 'ok',
    source_fingerprint: fingerprint,
    source_file_ids: fileRefs.map(function (ref) { return ref.driveFileId; }),
    file_refs: fileRefs,
    model: generated.model,
  };

  try {
    await upsertArchiveRow(record);
  } catch (persistErr) {
    console.warn('[community-drive-archive] persist failed:', persistErr.message || persistErr);
  }

  return {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: cleanedSummary,
    communityStatus: 'ok',
    fromArchive: false,
    deltaUpdated: true,
    archiveKey: archiveKey,
    fileRefs: fileRefs,
    sourceFingerprint: fingerprint,
    model: generated.model,
    multimodalFileCount: generated.multimodalFileCount || mediaMeta.length,
  };
}

module.exports = {
  TABLE_NAME,
  COMMUNITY_SUMMARY_HEADING,
  COMMUNITY_SUMMARY_EMPTY,
  GEMINI_MODEL,
  PROMPT_VERSION,
  MAX_GEMINI_INLINE_BYTES,
  MAX_GEMINI_MULTIMODAL_BYTES,
  SEMANTIC_EQUIV_MIN_SCORE,
  PARTIAL_SUGGEST_MIN_SCORE,
  buildArchiveKey,
  buildArchiveKeyCandidates,
  buildSourceFingerprint,
  expandCommunityTopicAliases,
  resolveCanonicalCommunityTopic,
  topicsAreSemanticEquivalent,
  scoreCommunityTopicSimilarity,
  findCommunityArchiveMatch,
  suggestDriveFolderTopic,
  findNewOrChangedDriveFiles,
  areNewFilesRelevantToTopic,
  evaluateSmartCacheAgainstDrive,
  buildDidYouMeanResult,
  normalizeFileRefsFromMatches,
  normalizeEscapedNewlines,
  sanitizeCommunitySummaryMarkdown,
  shortCitationDisplayName,
  isSummaryDeepEnough,
  tryInstantArchiveRetrieval,
  resolveCommunityDriveSummary,
  emptySummaryResult,
  resolveMultimodalMime,
  isMultimodalCandidate,
};
