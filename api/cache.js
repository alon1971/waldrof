/**
 * cached_results — Supabase-backed pedagogical API cache with local fallback.
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (preferred) or SUPABASE_ANON_KEY.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('./env');
const authContext = require('./auth-context');

const hebrewTopicMatch = require('../hebrew-topic-match');
const archiveDisambiguation = require('./archive-disambiguation');
const jsonRepair = require('./json-repair');
const archiveCoerce = require('../archive-coerce');
const communitySemanticMatch = require('./community-semantic-match');
const generalSearchClassifier = require('./general-search-classifier');
const embeddings = require('./embeddings');
const catalogTopics = require('./catalog-topics');
const driveCatalogSync = require('./drive-catalog-sync');
const enrichmentLinks = require('./enrichment-links');

const TABLE_NAME = 'cached_results';
/** Phase stored in cached_results for raw Perplexity web-search payloads (hybrid pipeline). */
const RAW_PERPLEXITY_PHASE = 'perplexity_raw';
/** Unified Step B→C master payload (theory + inspiration + pedagogy + live links) keyed by grade_id + topic. */
const TOPIC_MASTER_PHASE = 'topic_master';
/** Multi-grade general search payload keyed by exact query string. */
const GENERAL_SEARCH_PHASE = 'general_search';
const HYBRID_GENERATED_VERSION = '2025-06-hybrid-v1';

function resolveFallbackPath() {
  const local = path.join(__dirname, '..', 'data', 'cached_results.json');
  try {
    const dir = path.dirname(local);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return local;
  } catch (e) {
    return path.join(require('os').tmpdir(), 'waldorf_cached_results.json');
  }
}

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServerKey(),
  };
}

function isSupabaseCacheEnabled() {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && cfg.key);
}

function stableNormalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Hebrew filler / pedagogy words stripped before topic cache-key hashing (step B). */
const HEBREW_TOPIC_STOP_WORDS = new Set([
  'לימוד', 'ללמוד', 'לימודי', 'לימודית', 'הוראת', 'הוראה', 'ללמד', 'מלמד', 'מלמדת',
  'שיעור', 'שיעורי', 'שיעורים', 'יחידת', 'יחידה', 'נושא', 'בנושא', 'בעניין', 'בנוגע', 'לנושא',
  'על', 'את', 'של', 'עם', 'או', 'גם', 'כי', 'אם', 'זה', 'זו', 'הוא', 'היא', 'הם', 'אני', 'אתה',
  'כיתה', 'שכבה', 'שכבת', 'גיל', 'לכיתה', 'בכיתה', 'בשכבה',
  'פעילות', 'פעילויות', 'עבודה', 'תרגול', 'תרגיל', 'תרגילים', 'משימה', 'משימות',
  'דרך', 'מתוך', 'איך', 'כיצד', 'מה', 'למה', 'מתי', 'איפה', 'כאן', 'שם',
  'תלמיד', 'תלמידים', 'תלמידה', 'ילדים', 'ילד', 'ילדה', 'מורה', 'המורה',
  'ב', 'ל', 'מ', 'כ', 'ו', 'ש',
]);

function isHebrewTopicStopWord(word) {
  const w = String(word || '').trim();
  if (!w) return true;
  if (HEBREW_TOPIC_STOP_WORDS.has(w)) return true;
  if (w.charAt(0) === 'ה' && w.length > 2 && HEBREW_TOPIC_STOP_WORDS.has(w.slice(1))) return true;
  return false;
}

function stripDefiniteArticle(word) {
  const w = String(word || '');
  if (w.charAt(0) === 'ה' && w.length > 2) {
    const stem = w.slice(1);
    if (stem && !isHebrewTopicStopWord(stem)) return stem;
  }
  return w;
}

function removeGradePhrasesFromTopic(text) {
  return String(text || '')
    .replace(/(?:^|\s)(?:ו|ב|ל|ש)?כיתה\s+[א-ת]['׳]?(?:\s|$)/g, ' ')
    .replace(/(?:^|\s)שכב(?:ה|ת)\s+[א-ת]['׳]?(?:\s|$)/g, ' ')
    .replace(/(?:^|\s)גיל\s+\d[\d\-]*(?:\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a topic search string to its core keyword(s) for cache-key hashing (step B).
 * e.g. "הוראת האותיות", "לימוד אותיות", "לימוד האותיות בכיתה א'" → "אותיות"
 */
function normalizeTopicQuery(raw) {
  let text = stableNormalize(raw);
  if (!text) return '';

  text = text
    .replace(/[״"'`׳\-–—_,.;:!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  text = removeGradePhrasesFromTopic(text);

  const words = [];
  text.split(/\s+/).filter(Boolean).forEach(function (word) {
    if (isHebrewTopicStopWord(word)) return;
    const cleaned = stripDefiniteArticle(word);
    if (!cleaned || isHebrewTopicStopWord(cleaned)) return;
    words.push(cleaned);
  });

  const normalized = words.join(' ').trim();
  if (normalized) return normalized;

  return text
    .replace(/[^א-תa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashString(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * Step A (grade): stable cache identity — grade id only.
 * Strips fields that must not affect the key (topic leaks, label language/geresh variants).
 */
function normalizeGradeCacheRequest(body) {
  if (!body || body.phase !== 'grade') return body;
  const gradeId = body.currentGrade ?? body.gradeId ?? null;
  body.currentGrade = gradeId;
  body.gradeId = gradeId;
  body.topic = null;
  body.archiveQuery = null;
  body.activityTitle = null;
  body.sourceTitle = null;
  return body;
}

/** Build a deterministic cache key for pedagogical API requests. */
function buildCacheKey(body) {
  if (!body || !body.phase) return null;
  if (body.phase === 'test') return null;

  if (body.phase === 'grade') {
    const gradeId = stableNormalize(body.currentGrade ?? body.gradeId ?? '');
    if (!gradeId) return null;
    return hashString(['grade', gradeId].join('|'));
  }

  if (body.phase === TOPIC_MASTER_PHASE) {
    const gradeId = stableNormalize(body.currentGrade ?? body.gradeId ?? '');
    const topic = normalizeTopicQuery(body.topic ?? '');
    if (!gradeId || !topic) return null;
    return hashString([TOPIC_MASTER_PHASE, gradeId, topic].join('|'));
  }

  if (body.phase === GENERAL_SEARCH_PHASE || body.phase === 'pure_general_search') {
    const query = normalizeGeneralSearchQuery(body.query ?? body.topic ?? body.q ?? '');
    if (!query) return null;
    const variant = body.periodBlock ? 'period15' : 'standard';
    return hashString([GENERAL_SEARCH_PHASE, query, variant].join('|'));
  }

  const gradeId = stableNormalize(body.currentGrade ?? body.gradeId ?? '');
  const gradeLabel = stableNormalize(body.gradeLabel ?? '');
  const isAgeExpansion = body.phase === 'pedagogy_deep_dive' || body.phase === RAW_PERPLEXITY_PHASE
    ? stableNormalize(body.expansionScope || '') === 'age'
    : false;
  const topic = isAgeExpansion
    ? ''
    : (body.phase === 'topic'
      ? normalizeTopicQuery(body.topic ?? '')
      : stableNormalize(body.topic ?? ''));
  const archiveQuery = stableNormalize(body.archiveQuery ?? '');
  const activityTitle = stableNormalize(body.activityTitle ?? body.sourceTitle ?? '');
  const userMessage = stableNormalize(body.userMessage ?? '');

  const parts = [body.phase, gradeId, gradeLabel, topic, archiveQuery, activityTitle];

  if (body.phase === 'chat_followup') {
    parts.push(userMessage);
  }

  if (body.phase === 'pedagogy_deep_dive' || body.phase === 'archive_summary' || body.phase === RAW_PERPLEXITY_PHASE) {
    parts.push(stableNormalize(body.activityPreview ?? body.sourceDescription ?? ''));
    if (body.phase === 'pedagogy_deep_dive' || body.phase === RAW_PERPLEXITY_PHASE) {
      parts.push(stableNormalize(body.expansionScope || 'topic'));
      parts.push(stableNormalize(body.activitySubtype ?? ''));
      parts.push(stableNormalize(body.expansionItemId ?? ''));
    }
  }

  return hashString(parts.join('|'));
}

function buildRow(cacheKey, body, resultData) {
  const isGrade = body.phase === 'grade';
  const isAgeExpansion = body.phase === 'pedagogy_deep_dive' && stableNormalize(body.expansionScope || '') === 'age';
  const userEmail = body.userEmail || (body.teacherUser && body.teacherUser.email) || null;
  let verifiedUserId = authContext.pickCachedUserId(body);
  if (!verifiedUserId) {
    const candidate = (body && body.userId)
      || (body && body.teacherUser && body.teacherUser.id)
      || null;
    const mapped = authContext.mapUserIdForSupabaseQuery(candidate, userEmail);
    if (mapped && authContext.isValidAuthUuid(mapped) && !authContext.isMockUserId(mapped)) {
      verifiedUserId = mapped;
    } else if (mapped === authContext.LOCAL_DEMO_MOCK_UUID) {
      verifiedUserId = mapped;
    }
  }
  const normalizedEmail = userEmail ? String(userEmail).trim().toLowerCase() : null;
  return {
    cache_key: cacheKey,
    phase: body.phase,
    grade_id: body.currentGrade ?? body.gradeId ?? null,
    grade_label: body.gradeLabel || null,
    topic: isGrade || isAgeExpansion ? null : (body.topic || null),
    query_text: isGrade
      ? (body.gradeLabel || null)
      : (body.userMessage || body.archiveQuery || body.topic || body.gradeLabel || null),
    result_data: resultData,
    user_id: verifiedUserId,
    user_email: normalizedEmail,
    hit_count: 0,
    last_hit_at: null,
  };
}

async function supabaseRequest(relativePath, options) {
  const cfg = getSupabaseConfig();
  const baseUrl = String(cfg.url || '').trim();
  if (!baseUrl || !cfg.key) {
    throw new Error('Supabase is not configured');
  }
  const headers = Object.assign({
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
  }, options.headers || {});

  try {
    const res = await fetch(baseUrl + relativePath, Object.assign({}, options, {
      headers: headers,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(20000)
        : undefined,
    }));
    return res;
  } catch (fetchErr) {
    const err = new Error(fetchErr instanceof Error ? fetchErr.message : String(fetchErr));
    err.networkError = true;
    throw err;
  }
}

/** Quote PostgREST filter values that contain reserved characters (e.g. emails with @). */
function postgrestFilterValue(value) {
  const s = String(value || '').trim();
  if (!s) return '""';
  if (/^[a-zA-Z0-9_-]+$/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function bumpHitCountAsync(cacheKey, currentCount) {
  if (!isSupabaseCacheEnabled() || !cacheKey) return;
  supabaseRequest(
    '/rest/v1/' + TABLE_NAME + '?cache_key=eq.' + encodeURIComponent(cacheKey),
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        hit_count: (Number(currentCount) || 0) + 1,
        last_hit_at: new Date().toISOString(),
      }),
    }
  ).catch(function (err) {
    console.warn('[cached_results] hit_count update failed:', err.message || err);
  });
}

/* ── Local file fallback (dev / Supabase unavailable) ─────────────────── */

const fallbackStore = { loaded: false, rows: new Map(), path: resolveFallbackPath() };

function loadFallbackStore() {
  if (fallbackStore.loaded) return;
  fallbackStore.loaded = true;
  try {
    if (!fs.existsSync(fallbackStore.path)) return;
    const parsed = JSON.parse(fs.readFileSync(fallbackStore.path, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed.rows || []);
    list.forEach(function (row) {
      if (row && row.cache_key) fallbackStore.rows.set(row.cache_key, row);
    });
  } catch (e) {
    console.warn('[cached_results] fallback load failed:', e.message || e);
  }
}

function persistFallbackStore() {
  try {
    fs.writeFileSync(fallbackStore.path, JSON.stringify({
      table: TABLE_NAME,
      updated_at: new Date().toISOString(),
      rows: Array.from(fallbackStore.rows.values()),
    }));
  } catch (e) {
    console.warn('[cached_results] fallback persist failed:', e.message || e);
  }
}

function getFallbackCached(cacheKey) {
  loadFallbackStore();
  const row = fallbackStore.rows.get(cacheKey);
  if (!row || !row.result_data) return null;
  row.hit_count = (row.hit_count || 0) + 1;
  row.last_hit_at = new Date().toISOString();
  fallbackStore.rows.set(cacheKey, row);
  persistFallbackStore();
  return row.result_data;
}

function setFallbackCached(cacheKey, body, resultData) {
  loadFallbackStore();
  const row = buildRow(cacheKey, body, resultData);
  row.created_at = new Date().toISOString();
  fallbackStore.rows.set(cacheKey, row);
  persistFallbackStore();
}

/* ── Public API ───────────────────────────────────────────────────────── */

function applyArchiveLinkCleanupPolicy(data, phase) {
  if (!data || typeof data !== 'object') return data;
  if (phase !== 'topic') return data;
  if (isTopicMasterPayload(data)) return data;
  const cloned = cloneJsonSafe(data);
  if (!cloned) return data;
  return enrichmentLinks.stripNonPinterestLinksFromArchiveData(cloned).data;
}

/**
 * Handles jsonb stored as a JSON string or accidental { data, meta } wrappers.
 */
function coerceCachedResultData(raw) {
  if (raw == null) return null;

  let data = raw;
  if (typeof data === 'string') {
    const text = data.trim();
    if (!text) return null;
    data = tryParseCachedJsonText(text);
    if (data == null) return null;
    if (typeof data === 'string') {
      data = tryParseCachedJsonText(data);
      if (data == null) return null;
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  if (
    data.data != null &&
    typeof data.data === 'object' &&
    !Array.isArray(data.data) &&
    !data.gradeInsights &&
    !data.blockPlan &&
    !data.chatReply &&
    !data.reply &&
    !data.pedagogyDeepDive &&
    !data.webResearch
  ) {
    data = data.data;
  }

  return data;
}

function tryParseArchiveJsonObject(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || (text.charAt(0) !== '{' && text.charAt(0) !== '[')) return null;
  return tryParseCachedJsonText(text);
}

const coerceArchiveLessonResultData = archiveCoerce.coerceArchiveLessonResultData;

async function deleteCachedRowByKey(cacheKey) {
  if (!cacheKey) return false;
  let deleted = false;
  if (isSupabaseCacheEnabled()) {
    try {
      const res = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME + '?cache_key=eq.' + encodeURIComponent(cacheKey),
        { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
      );
      if (res.ok) deleted = true;
      else {
        const errText = await res.text();
        console.warn('[cached_results] delete error', res.status, errText.slice(0, 200));
      }
    } catch (err) {
      console.warn('[cached_results] delete failed:', err.message || err);
    }
  }
  loadFallbackStore();
  if (fallbackStore.rows.has(cacheKey)) {
    fallbackStore.rows.delete(cacheKey);
    persistFallbackStore();
    deleted = true;
  }
  return deleted;
}

function normalizeArchiveLinkUrl(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

function archiveLinkItemMatchesUrl(item, targetNorm) {
  if (item == null || !targetNorm) return false;
  if (typeof item === 'string') return normalizeArchiveLinkUrl(item) === targetNorm;
  if (typeof item !== 'object') return false;
  const keys = ['url', 'link', 'href', 'readUrl', 'src', 'pinUrl'];
  for (let i = 0; i < keys.length; i++) {
    const value = item[keys[i]];
    if (value && normalizeArchiveLinkUrl(value) === targetNorm) return true;
  }
  return false;
}

function removeMatchingUrlsFromArchivePayload(value, targetNorm, depth) {
  if (value == null || !targetNorm) return false;
  if ((depth || 0) > 14) return false;
  const nextDepth = (depth || 0) + 1;
  let changed = false;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      if (archiveLinkItemMatchesUrl(value[i], targetNorm)) {
        value.splice(i, 1);
        changed = true;
      } else if (value[i] && typeof value[i] === 'object') {
        if (removeMatchingUrlsFromArchivePayload(value[i], targetNorm, nextDepth)) changed = true;
      }
    }
    return changed;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(function (key) {
      if (removeMatchingUrlsFromArchivePayload(value[key], targetNorm, nextDepth)) changed = true;
    });
  }
  return changed;
}

/**
 * Remove a broken/irrelevant link URL from a cached archive row (admin curation).
 */
async function removeArchiveLinkFromCache(cacheKey, url) {
  const key = String(cacheKey || '').trim();
  const targetNorm = normalizeArchiveLinkUrl(url);
  if (!key || !targetNorm) return { removed: false, cacheKey: key || null };

  const row = await fetchCachedRowByKey(key);
  if (!row || row.result_data == null) return { removed: false, cacheKey: key };

  let data = coerceCachedResultData(row.result_data);
  if (!data || typeof data !== 'object') return { removed: false, cacheKey: key };

  data = cloneJsonSafe(data);
  if (!data) return { removed: false, cacheKey: key };

  const changed = removeMatchingUrlsFromArchivePayload(data, targetNorm, 0);
  if (!changed) return { removed: false, cacheKey: key };

  const safeResultData = sanitizeForJsonStorage(data);
  if (!safeResultData) return { removed: false, cacheKey: key };

  let saved = false;
  if (isSupabaseCacheEnabled()) {
    try {
      const patchRes = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME + '?cache_key=eq.' + encodeURIComponent(key),
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: safeJsonStringify({ result_data: safeResultData }),
        }
      );
      if (patchRes.ok) saved = true;
      else {
        const errText = await patchRes.text();
        console.warn('[cached_results] archive link delete PATCH error', patchRes.status, errText.slice(0, 200));
      }
    } catch (err) {
      console.warn('[cached_results] archive link delete PATCH failed:', err.message || err);
    }
  }

  loadFallbackStore();
  if (fallbackStore.rows.has(key)) {
    const existing = fallbackStore.rows.get(key);
    existing.result_data = safeResultData;
    fallbackStore.rows.set(key, existing);
    persistFallbackStore();
    saved = true;
  }

  return { removed: saved, cacheKey: key };
}

function normalizeArchiveBlockValue(text) {
  return String(text == null ? '' : text)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Locate every string value whose ENTIRE (whitespace-normalized) value equals the
 * original block text and replace it with the cleaned block. This is an exact full-value
 * match — never a substring/regex surgery — so it cannot corrupt unrelated content.
 * Emptied array elements are spliced out; emptied object fields are set to ''.
 */
function applyArchiveBlockReplacement(value, originalNorm, newText, depth) {
  if (value == null || !originalNorm) return false;
  if ((depth || 0) > 18) return false;
  const nextDepth = (depth || 0) + 1;
  let changed = false;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const item = value[i];
      if (typeof item === 'string') {
        if (normalizeArchiveBlockValue(item) === originalNorm) {
          if (String(newText).trim() === '') value.splice(i, 1);
          else value[i] = newText;
          changed = true;
        }
      } else if (item && typeof item === 'object') {
        if (applyArchiveBlockReplacement(item, originalNorm, newText, nextDepth)) changed = true;
      }
    }
    return changed;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(function (key) {
      const child = value[key];
      if (typeof child === 'string') {
        if (normalizeArchiveBlockValue(child) === originalNorm) {
          value[key] = newText;
          changed = true;
        }
      } else if (child && typeof child === 'object') {
        if (applyArchiveBlockReplacement(child, originalNorm, newText, nextDepth)) changed = true;
      }
    });
  }
  return changed;
}

function parseArchiveBlockPath(path) {
  const segments = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = re.exec(String(path || ''))) !== null) {
    if (match[1] != null) segments.push(match[1]);
    else if (match[2] != null) segments.push(parseInt(match[2], 10));
  }
  return segments;
}

/**
 * Set a string field in result_data using a dot/bracket path (e.g. gradeInsights.rawContent,
 * theory.sections[0].content). Returns false when the path cannot be resolved.
 */
function setValueAtArchiveBlockPath(value, path, newText) {
  const segments = parseArchiveBlockPath(path);
  if (!segments.length || value == null || typeof value !== 'object') return false;
  let current = value;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (current == null || typeof current !== 'object') return false;
    current = current[key];
  }
  const lastKey = segments[segments.length - 1];
  if (current == null || typeof current !== 'object') return false;
  if (Array.isArray(current) && typeof lastKey === 'number') {
    if (lastKey < 0 || lastKey >= current.length) return false;
    current[lastKey] = newText;
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(current, lastKey)) return false;
  current[lastKey] = newText;
  return true;
}

/**
 * Admin curation: write a cleaned block directly to a known JSON path inside result_data.
 * Avoids risky substring matching — the client supplies cache_key + blockPath + newText.
 */
async function setArchiveBlockByPath(cacheKey, blockPath, newText) {
  const key = String(cacheKey || '').trim();
  const path = String(blockPath || '').trim();
  if (!key || !path) return { updated: false, cacheKey: key || null };
  const safeNewText = typeof newText === 'string' ? newText : String(newText == null ? '' : newText);

  const row = await fetchCachedRowByKey(key);
  if (!row || row.result_data == null) return { updated: false, cacheKey: key };

  let data = coerceCachedResultData(row.result_data);
  if (!data || typeof data !== 'object') return { updated: false, cacheKey: key };

  data = cloneJsonSafe(data);
  if (!data) return { updated: false, cacheKey: key };

  const changed = setValueAtArchiveBlockPath(data, path, safeNewText);
  if (!changed) return { updated: false, cacheKey: key };

  const safeResultData = sanitizeForJsonStorage(data);
  if (!safeResultData) return { updated: false, cacheKey: key };

  let saved = false;
  if (isSupabaseCacheEnabled()) {
    try {
      const patchRes = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME + '?cache_key=eq.' + encodeURIComponent(key),
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: safeJsonStringify({ result_data: safeResultData }),
        }
      );
      if (patchRes.ok) saved = true;
      else {
        const errText = await patchRes.text();
        console.warn('[cached_results] archive block path PATCH error', patchRes.status, errText.slice(0, 200));
      }
    } catch (err) {
      console.warn('[cached_results] archive block path PATCH failed:', err.message || err);
    }
  }

  loadFallbackStore();
  if (fallbackStore.rows.has(key)) {
    const existing = fallbackStore.rows.get(key);
    existing.result_data = safeResultData;
    fallbackStore.rows.set(key, existing);
    persistFallbackStore();
    saved = true;
  }

  return { updated: saved, cacheKey: key, blockPath: path };
}

/**
 * Admin curation: replace a whole text block (matched by its exact original value) with a
 * cleaned version supplied by the client. Returns { updated } — false when the original
 * block cannot be found, so the caller can abort/restore instead of corrupting the row.
 */
async function replaceArchiveBlockInCache(cacheKey, originalText, newText) {
  const key = String(cacheKey || '').trim();
  const originalNorm = normalizeArchiveBlockValue(originalText);
  if (!key || !originalNorm) return { updated: false, cacheKey: key || null };
  const safeNewText = typeof newText === 'string' ? newText : String(newText == null ? '' : newText);

  const row = await fetchCachedRowByKey(key);
  if (!row || row.result_data == null) return { updated: false, cacheKey: key };

  let data = coerceCachedResultData(row.result_data);
  if (!data || typeof data !== 'object') return { updated: false, cacheKey: key };

  data = cloneJsonSafe(data);
  if (!data) return { updated: false, cacheKey: key };

  const changed = applyArchiveBlockReplacement(data, originalNorm, safeNewText, 0);
  if (!changed) return { updated: false, cacheKey: key };

  const safeResultData = sanitizeForJsonStorage(data);
  if (!safeResultData) return { updated: false, cacheKey: key };

  let saved = false;
  if (isSupabaseCacheEnabled()) {
    try {
      const patchRes = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME + '?cache_key=eq.' + encodeURIComponent(key),
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: safeJsonStringify({ result_data: safeResultData }),
        }
      );
      if (patchRes.ok) saved = true;
      else {
        const errText = await patchRes.text();
        console.warn('[cached_results] archive block replace PATCH error', patchRes.status, errText.slice(0, 200));
      }
    } catch (err) {
      console.warn('[cached_results] archive block replace PATCH failed:', err.message || err);
    }
  }

  loadFallbackStore();
  if (fallbackStore.rows.has(key)) {
    const existing = fallbackStore.rows.get(key);
    existing.result_data = safeResultData;
    fallbackStore.rows.set(key, existing);
    persistFallbackStore();
    saved = true;
  }

  return { updated: saved, cacheKey: key };
}

async function deleteRawPerplexityCache(body) {
  const rawBody = buildRawPerplexityCacheBody(body);
  if (!rawBody) return false;
  const cacheKey = buildCacheKey(rawBody);
  if (!cacheKey) return false;
  const deleted = await deleteCachedRowByKey(cacheKey);
  if (deleted) {
    console.log('[cached_results] deleted perplexity_raw', cacheKey.slice(0, 12));
  }
  return deleted;
}

/** Cache metadata keys that mark hybrid/archive-upgraded rows (required for grade/topic cache hits). */
const CACHE_ENHANCEMENT_META_KEYS = ['_hybridGenerated', '_archiveUpgrade', '_perplexityOnly'];

function attachCacheEnhancementMetadata(source, target) {
  if (!source || !target || typeof source !== 'object' || typeof target !== 'object') return target;
  CACHE_ENHANCEMENT_META_KEYS.forEach(function (key) {
    const meta = source[key];
    if (meta && typeof meta === 'object' && meta.version) {
      const cloned = cloneJsonSafe(meta);
      target[key] = cloned || sanitizeForJsonStorage(meta);
    }
  });
  return target;
}

/** Normalize grade cache payloads to { gradeInsights } for save, validation, and API responses. */
function normalizeGradeResultForCache(raw) {
  const data = coerceCachedResultData(raw);
  if (!data || typeof data !== 'object') return null;

  let gi = data.gradeInsights;
  if ((!gi || typeof gi !== 'object' || Array.isArray(gi)) && data.data && typeof data.data === 'object') {
    gi = data.data.gradeInsights;
  }
  if (!gi || typeof gi !== 'object' || Array.isArray(gi)) return null;

  if (String(gi.rawContent || '').trim()) {
    const out = {
      gradeInsights: {
        rawContent: String(gi.rawContent).trim(),
        citations: Array.isArray(gi.citations) ? gi.citations.filter(Boolean) : [],
        source: gi.source || 'perplexity-sonar',
        model: gi.model || null,
        searchedAt: gi.searchedAt || null,
        gradeLabel: gi.gradeLabel || null,
      },
    };
    attachCacheEnhancementMetadata(data, out);
    return out;
  }

  const cloned = cloneJsonSafe(gi);
  if (!cloned) return null;
  const out = { gradeInsights: cloned };
  attachCacheEnhancementMetadata(data, out);
  return out;
}

function cloneJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return null;
  }
}

/** Strip bytes/surrogates that break JSON.stringify or corrupt Supabase jsonb. */
function sanitizeJsonString(text) {
  if (text == null) return text;
  return String(text)
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDFFF]/g, '');
}

/**
 * Deep-clone a value into JSON-safe plain data (no undefined, no BigInt, no cycles).
 */
function sanitizeForJsonStorage(value, depth) {
  if (depth == null) depth = 0;
  if (depth > 40) return null;
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeJsonString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return sanitizeForJsonStorage(item, depth + 1);
    });
  }
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(function (key) {
      const v = value[key];
      if (v === undefined) return;
      out[key] = sanitizeForJsonStorage(v, depth + 1);
    });
    return out;
  }
  return sanitizeJsonString(value);
}

function tryParseCachedJsonText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return jsonRepair.cleanAndParseJSON(trimmed, { fallbackOnError: false, unwrap: false });
  } catch (e) {
    return jsonRepair.safeParseJson(trimmed);
  }
}

/** JSON.stringify with sanitization — never throws. */
function safeJsonStringify(value) {
  try {
    return JSON.stringify(sanitizeForJsonStorage(value));
  } catch (e) {
    try {
      return JSON.stringify({ error: 'serialize_failed' });
    } catch (e2) {
      return '{}';
    }
  }
}

/**
 * Coerce incoming payload to a plain JSON object for Postgres jsonb — never a string.
 * Prevents double-stringify corruption (Hebrew quotes / special chars in archived rows).
 */
function ensureJsonObjectForStorage(value) {
  if (value == null) return null;
  let data = value;
  if (typeof data === 'string') {
    const text = data.trim();
    if (!text) return null;
    data = tryParseCachedJsonText(text);
    if (data == null) return null;
    if (typeof data === 'string') {
      data = tryParseCachedJsonText(data);
      if (data == null) return null;
    }
  }
  if (typeof data !== 'object' || Array.isArray(data)) return null;
  return sanitizeForJsonStorage(data);
}

async function purgeCorruptedCachedRow(cacheKey, reason) {
  if (!cacheKey) return false;
  console.warn(
    '[cached_results] purging corrupted row',
    cacheKey.slice(0, 12),
    reason || 'unparseable_result_data'
  );
  return deleteCachedRowByKey(cacheKey);
}

/**
 * Parse result_data from a DB row; delete the row when JSON is irreparably corrupt.
 */
async function readAndValidateCachedResultData(row, cacheKey) {
  if (!row || row.result_data == null) return null;
  const key = cacheKey || row.cache_key || null;
  const data = coerceCachedResultData(row.result_data);
  if (!data) {
    if (key) await purgeCorruptedCachedRow(key, 'coerce_failed');
    return null;
  }
  return data;
}

function sanitizeChatEnrichmentEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    question: sanitizeJsonString(entry.question || ''),
    answer: sanitizeJsonString(entry.answer || ''),
    answerHtml: entry.answerHtml != null ? sanitizeJsonString(entry.answerHtml) : null,
    topic: entry.topic != null ? sanitizeJsonString(entry.topic) : null,
    updatedAt: entry.updatedAt || new Date().toISOString(),
  };
}

function isPerplexityBaselineCachedPayload(phase, data) {
  const coerced = coerceCachedResultData(data);
  if (!coerced || typeof coerced !== 'object') return false;
  if (coerced._perplexityOnly && coerced._perplexityOnly.version) return true;
  if (phase === 'grade') {
    const gi = coerced.gradeInsights;
    return gi && typeof gi === 'object' && String(gi.rawContent || '').trim();
  }
  if (phase === 'topic') {
    const bp = coerced.blockPlan;
    return bp && typeof bp === 'object' && String(bp.rawContent || '').trim();
  }
  return false;
}

function isValidCachedPayload(phase, data) {
  if (!data || typeof data !== 'object') return false;
  if (phase === RAW_PERPLEXITY_PHASE) {
    return Boolean(String(data.content || '').trim());
  }
  if (phase === 'grade') return Boolean(normalizeGradeResultForCache(data));
  if (phase === TOPIC_MASTER_PHASE) return isTopicMasterPayload(data);
  if (phase === GENERAL_SEARCH_PHASE || phase === 'pure_general_search' || phase === 'general_search_period') {
    return isGeneralSearchPayload(data);
  }
  if (phase === 'topic') {
    const bp = data.blockPlan;
    if (bp && typeof bp === 'object' && String(bp.rawContent || '').trim()) return true;
    return Boolean(bp && typeof bp === 'object');
  }
  if (phase === 'chat_followup') {
    return Boolean(extractChatAnswerText(data));
  }
  if (phase === 'pedagogy_deep_dive') {
    const dive = data.pedagogyDeepDive;
    if (!dive || typeof dive !== 'object') return false;
    return Boolean(
      String(dive.rawContent || '').trim() ||
      String(dive.summaryHtml || '').trim() ||
      String(dive.contentHtml || '').trim() ||
      String(dive.classroomImplementation || '').trim() ||
      String(dive.essence || '').trim()
    );
  }
  if (phase === 'archive_summary') return Boolean(data.archiveSummary || data.pedagogyDeepDive);
  if (phase === 'drive') return Boolean(data.driveMerge);
  if (phase === 'test') return data.ok === true;
  return true;
}

/** True when a cached topic/grade row is safe to auto-serve (Perplexity or legacy rich — never Gemini-upgraded). */
function isEnhancedCachedPayload(phase, data) {
  const coerced = coerceCachedResultData(data);
  if (!coerced || typeof coerced !== 'object') return false;
  if (phase !== 'topic' && phase !== 'grade') return isValidCachedPayload(phase, coerced);
  if (!isValidCachedPayload(phase, coerced)) return false;
  if (coerced._archiveUpgrade && coerced._archiveUpgrade.version) return false;
  if (coerced._hybridGenerated && coerced._hybridGenerated.version) return false;
  if (isPerplexityBaselineCachedPayload(phase, coerced)) return true;
  if (coerced._perplexityOnly && coerced._perplexityOnly.version) return true;
  if (phase === 'grade' && normalizeGradeResultForCache(coerced)) return true;
  if (phase === 'topic') {
    const bp = coerced.blockPlan;
    if (bp && typeof bp === 'object') {
      const theory = bp.theory;
      if (theory && Array.isArray(theory.sections) && theory.sections.length) return true;
      if (String(bp.rawContent || '').trim().length > 500) return true;
    }
    if (coerced.webResearch && String(coerced.webResearch.summary || '').trim().length > 200) return true;
  }
  return false;
}

function stampHybridGeneratedMetadata(resultData) {
  const data = coerceCachedResultData(resultData);
  if (!data || typeof data !== 'object') return resultData;
  data._hybridGenerated = {
    version: HYBRID_GENERATED_VERSION,
    generatedAt: new Date().toISOString(),
    pipeline: 'perplexity-sonar+gemini-2.5-flash',
  };
  return data;
}

function stampPerplexityOnlyMetadata(resultData) {
  const data = coerceCachedResultData(resultData);
  if (!data || typeof data !== 'object') return resultData;
  data._perplexityOnly = {
    version: 1,
    generatedAt: new Date().toISOString(),
    pipeline: 'perplexity-sonar-only',
  };
  return data;
}

function buildRawPerplexityCacheBody(body) {
  if (!body || !body.phase) return null;
  return Object.assign({}, body, { phase: RAW_PERPLEXITY_PHASE });
}

/** Ready-to-send cache hit — original object only, never re-parsed through model cleaners. */
function buildCachedGeneratePayload(cached, phase) {
  if (!cached) return null;
  const data = coerceCachedResultData(cached.data);
  if (!data || !isValidCachedPayload(phase, data)) return null;
  const payload = phase === 'grade' ? normalizeGradeResultForCache(data) : cloneJsonSafe(data);
  if (!payload) return null;
  return {
    data: payload,
    meta: Object.assign({}, cached.meta || {}, { fromCache: true }),
  };
}

function extractChatAnswerText(resultData) {
  const data = coerceCachedResultData(resultData);
  if (!data || typeof data !== 'object') return '';
  if (data.reply) return String(data.reply).trim();
  const reply = data.chatReply;
  if (!reply || typeof reply !== 'object') return '';
  if (reply.answer) return String(reply.answer).trim();
  if (reply.answerHtml) {
    return String(reply.answerHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** Pack a live chat_followup API payload into a simple { reply } object for Supabase storage. */
function packChatFollowupForCache(chatResultData) {
  const text = extractChatAnswerText(chatResultData);
  if (!text) return null;
  return { reply: sanitizeJsonString(text) };
}

function stripHtmlSimple(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildGradeCacheBody(body) {
  const gradeId = body.currentGrade ?? body.gradeId;
  if (!gradeId) return null;
  return {
    phase: 'grade',
    currentGrade: gradeId,
    gradeId: gradeId,
    gradeLabel: body.gradeLabel || '',
    age: body.age || '',
  };
}

function buildTopicCacheBody(body) {
  const topic = String(body.topic || '').trim();
  const gradeId = body.currentGrade ?? body.gradeId;
  if (!topic || !gradeId) return null;
  return {
    phase: 'topic',
    currentGrade: gradeId,
    gradeId: gradeId,
    gradeLabel: body.gradeLabel || '',
    topic: topic,
    age: body.age || '',
  };
}

function extractGradeInsightsText(resultData) {
  const data = coerceCachedResultData(resultData);
  if (!data || typeof data !== 'object') return '';
  const gi = data.gradeInsights;
  if (!gi || typeof gi !== 'object') return '';
  const chunks = [];
  if (gi.part1AgePictureHtml) chunks.push(stripHtmlSimple(gi.part1AgePictureHtml));
  if (gi.archivesSynthesisHtml) chunks.push(stripHtmlSimple(gi.archivesSynthesisHtml));
  if (gi.part2ClassroomIdeasHtml) chunks.push(stripHtmlSimple(gi.part2ClassroomIdeasHtml));
  if (gi.part3CommunityExpansionsHtml) chunks.push(stripHtmlSimple(gi.part3CommunityExpansionsHtml));
  (gi.part1DevelopmentBullets || gi.developmentBullets || []).forEach(function (item) {
    if (typeof item === 'string') chunks.push(item);
    else if (item && (item.text || item.detail || item.title)) {
      chunks.push([item.title, item.text || item.detail].filter(Boolean).join(': '));
    }
  });
  (gi.chatEnrichments || []).slice(-5).forEach(function (entry) {
    if (!entry) return;
    chunks.push('שאלת מורה: ' + (entry.question || '') + '\nתשובה מעודכנת: ' + (entry.answer || stripHtmlSimple(entry.answerHtml)));
  });
  return chunks.filter(Boolean).join('\n\n').slice(0, 10000);
}

/**
 * Load cached grade insights for the current grade (step A record).
 */
async function lookupGradeCachedContext(body) {
  try {
    const gradeBody = buildGradeCacheBody(body);
    if (!gradeBody) return null;
    const cacheKey = buildCacheKey(gradeBody);
    const row = await resolveCachedRow(cacheKey);
    const data = row ? await readAndValidateCachedResultData(row, cacheKey) : null;
    if (!row || !data || !extractGradeInsightsText(data)) return null;
    bumpHitCountAsync(cacheKey, row.hit_count);
    const safeData = sanitizeForJsonStorage(data);
    return {
      cacheKey: cacheKey,
      data: safeData || data,
      matchType: 'grade',
      queryText: row.query_text || gradeBody.gradeLabel || '',
      hitCount: row.hit_count || 0,
    };
  } catch (err) {
    console.warn('[cached_results] grade context lookup failed:', err.message || err);
    return null;
  }
}

/**
 * Load cached topic lesson plan when grade + topic are set.
 */
async function lookupTopicCachedContext(body) {
  const topicBody = buildTopicCacheBody(body);
  if (!topicBody) return null;
  const cacheKey = buildCacheKey(topicBody);
  const row = await resolveCachedRow(cacheKey);
  const data = row ? await readAndValidateCachedResultData(row, cacheKey) : null;
  if (!row || !data) return null;
  bumpHitCountAsync(cacheKey, row.hit_count);
  return {
    cacheKey: cacheKey,
    data: data,
    matchType: 'topic',
    queryText: row.query_text || topicBody.topic || '',
    hitCount: row.hit_count || 0,
  };
}

/**
 * Merge an enriched chat reply back into the grade cache row (step A sync).
 */
async function mergeChatEnrichmentIntoGradeCache(body, chatResultData) {
  try {
    const gradeBody = buildGradeCacheBody(body);
    if (!gradeBody || !chatResultData) return null;

    const answer = extractChatAnswerText(chatResultData);
    const userMessage = sanitizeJsonString(String(body.userMessage || '').trim());
    if (!answer || !userMessage) return null;

    const cacheKey = buildCacheKey(gradeBody);
    const existing = await resolveCachedRow(cacheKey);
    const coerced = existing && existing.result_data
      ? coerceCachedResultData(existing.result_data)
      : null;

    if (existing && existing.result_data && !coerced) {
      console.warn('[cached_results] grade merge skipped — unreadable cached row', cacheKey.slice(0, 12));
      return null;
    }

    const resultData = coerced
      ? sanitizeForJsonStorage(cloneJsonSafe(coerced) || coerced)
      : { gradeInsights: {} };
    if (!resultData || typeof resultData !== 'object') return null;

    if (!resultData.gradeInsights || typeof resultData.gradeInsights !== 'object' || Array.isArray(resultData.gradeInsights)) {
      resultData.gradeInsights = {};
    }

    const enrichment = sanitizeChatEnrichmentEntry({
      question: userMessage,
      answer: sanitizeJsonString(answer),
      answerHtml: chatResultData.chatReply ? (chatResultData.chatReply.answerHtml || null) : null,
      topic: body.topic || null,
      updatedAt: new Date().toISOString(),
    });
    if (!enrichment) return null;

    if (!Array.isArray(resultData.gradeInsights.chatEnrichments)) {
      resultData.gradeInsights.chatEnrichments = [];
    } else {
      resultData.gradeInsights.chatEnrichments = resultData.gradeInsights.chatEnrichments
        .map(sanitizeChatEnrichmentEntry)
        .filter(Boolean);
    }

    const normQ = stableNormalize(userMessage);
    let replaced = false;
    resultData.gradeInsights.chatEnrichments = resultData.gradeInsights.chatEnrichments.filter(function (entry) {
      if (!entry) return false;
      if (stableNormalize(entry.question) === normQ) {
        replaced = true;
        return false;
      }
      return true;
    });
    resultData.gradeInsights.chatEnrichments.push(enrichment);
    if (resultData.gradeInsights.chatEnrichments.length > 24) {
      resultData.gradeInsights.chatEnrichments = resultData.gradeInsights.chatEnrichments.slice(-24);
    }
    resultData.gradeInsights.lastChatEnrichmentAt = enrichment.updatedAt;
    if (!replaced) {
      resultData.gradeInsights.chatEnrichmentCount = (Number(resultData.gradeInsights.chatEnrichmentCount) || 0) + 1;
    }

    const savedKey = await setCachedResult(gradeBody, resultData);
    if (!savedKey) return null;

    const safeInsights = sanitizeForJsonStorage(resultData.gradeInsights);
    return {
      cacheKey: cacheKey,
      gradeInsights: safeInsights || resultData.gradeInsights,
    };
  } catch (err) {
    console.warn('[cached_results] grade chat enrichment merge failed:', err.message || err);
    return null;
  }
}

function scoreChatQuestionSimilarity(questionA, questionB) {
  const a = stableNormalize(questionA);
  const b = stableNormalize(questionB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 0.88;
  const wordsA = a.split(' ').filter(function (w) { return w.length > 2; });
  const wordsB = new Set(b.split(' ').filter(function (w) { return w.length > 2; }));
  if (!wordsA.length || !wordsB.size) return 0;
  let overlap = 0;
  wordsA.forEach(function (w) {
    if (wordsB.has(w)) overlap++;
  });
  return overlap / Math.max(wordsA.length, wordsB.size);
}

function archiveTopicDisplayName(row, data, queryHint) {
  const coerced = data || coerceCachedResultData(row && row.result_data);
  const candidates = [];
  function addCandidate(val) {
    const s = String(val || '').trim();
    if (s && candidates.indexOf(s) < 0) candidates.push(s);
  }
  if (row && row.topic) addCandidate(row.topic);
  if (row && row.query_text) addCandidate(row.query_text);
  if (coerced && coerced.webResearch && coerced.webResearch.topic) {
    addCandidate(coerced.webResearch.topic);
  }
  if (!candidates.length) return '';

  const hint = String(queryHint || '').trim();
  if (hint) {
    let best = candidates[0];
    let bestScore = scoreTopicSimilarity(hint, best, '');
    candidates.forEach(function (curr) {
      const score = scoreTopicSimilarity(hint, curr, '');
      if (score > bestScore + 0.0001 || (Math.abs(score - bestScore) <= 0.0001 && curr.length < best.length)) {
        best = curr;
        bestScore = score;
      }
    });
    return best;
  }

  return candidates.reduce(function (best, curr) {
    return curr.length > best.length ? curr : best;
  }, candidates[0]);
}

/**
 * Score how closely a search query matches an archived topic label.
 * Returns 1 for equivalent topics, ~0.88 for partial/substring matches,
 * ~0.72–0.88 for Hebrew morphological / pedagogical-cluster matches.
 */
function scoreTopicSimilarity(queryRaw, candidateTopic, candidateQueryText) {
  return hebrewTopicMatch.scoreHebrewTopicSimilarity(queryRaw, candidateTopic, candidateQueryText, {
    normalizeTopicQuery: normalizeTopicQuery,
    scoreChatQuestionSimilarity: scoreChatQuestionSimilarity,
  });
}

/** Auto-serve fully enriched consolidated lesson plans from cached_results (web + Drive merge). */
const ARCHIVE_AUTO_LOAD_SIMILARITY = 0.99;
const ARCHIVE_PARTIAL_MIN_SCORE = archiveDisambiguation.ARCHIVE_PARTIAL_SUGGEST_MIN_SCORE;
const ARCHIVE_PARTIAL_MAX_SCORE = ARCHIVE_AUTO_LOAD_SIMILARITY - 0.0001;

function scoreTopicAutoLoadSimilarity(queryRaw, candidateTopic, candidateQueryText) {
  let score = scoreTopicSimilarity(queryRaw, candidateTopic, candidateQueryText);
  if (score >= ARCHIVE_AUTO_LOAD_SIMILARITY) return score;

  const queryNorm = normalizeTopicQuery(queryRaw);
  const queryStable = stableNormalize(queryRaw);
  const candidates = [candidateTopic, candidateQueryText];
  candidates.forEach(function (raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    if (normalizeTopicQuery(text) === queryNorm && queryNorm) {
      score = Math.max(score, 1);
      return;
    }
    const stable = stableNormalize(text);
    if (queryStable && stable === queryStable) {
      score = Math.max(score, 1);
      return;
    }
    // Only treat as auto-load when the archive title is the same normalized query (not a longer containing title).
    if (queryStable && stable === queryStable) {
      score = Math.max(score, 1);
    }
  });
  return score;
}

function isMisleadingArchiveAutoLoad(query, archiveTopic) {
  return archiveDisambiguation.isMisleadingArchiveSuggestion(query, archiveTopic, 0);
}

function isMisleadingPartialArchiveSuggestion(query, suggestedTopic, score) {
  return archiveDisambiguation.isMisleadingArchiveSuggestion(query, suggestedTopic, score);
}

function isBetterArchiveTopicPick(next, prev) {
  if (!prev) return true;
  if (next.score > prev.score + 0.0001) return true;
  if (Math.abs(next.score - prev.score) <= 0.0001) {
    return String(next.topic || '').length > String(prev.topic || '').length;
  }
  return false;
}

function pickBestArchiveTopicRow(rows, query, options) {
  const opts = options || {};
  const partialOnly = Boolean(opts.partialOnly);
  const strongOnly = Boolean(opts.strongOnly);
  let best = null;
  let bestScore = partialOnly
    ? ARCHIVE_PARTIAL_MIN_SCORE
    : (strongOnly ? ARCHIVE_AUTO_LOAD_SIMILARITY - 0.0001 : ARCHIVE_PARTIAL_MIN_SCORE);

  (rows || []).forEach(function (row) {
    if (!row || !row.result_data) return;
    const data = coerceCachedResultData(row.result_data);
    if (!data || !isValidCachedPayload('topic', data)) return;
    const candidateTopic = archiveTopicDisplayName(row, data, query);
    if (strongOnly && isMisleadingArchiveAutoLoad(query, candidateTopic)) return;
    const score = strongOnly
      ? scoreTopicAutoLoadSimilarity(query, candidateTopic, row.query_text || '')
      : scoreTopicSimilarity(query, candidateTopic, row.query_text || '');
    if (strongOnly && score < ARCHIVE_AUTO_LOAD_SIMILARITY) return;
    if (partialOnly && (score >= ARCHIVE_PARTIAL_MAX_SCORE || score <= ARCHIVE_PARTIAL_MIN_SCORE)) return;
    if (!strongOnly && !partialOnly && score <= bestScore) return;
    const candidate = { row: row, data: data, topic: candidateTopic, score: score };
    if (isBetterArchiveTopicPick(candidate, best)) {
      best = candidate;
      bestScore = score;
    }
  });

  return best;
}

async function findArchiveTopicByNormalizedText(topic, gradeId) {
  const topicBody = { phase: 'topic', topic: topic, currentGrade: gradeId, gradeId: gradeId };
  const wanted = normalizeTopicQuery(topic);
  if (!wanted || !gradeId) return null;

  async function scanRows(rows) {
    if (!Array.isArray(rows)) return null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.result_data) continue;
      const data = coerceCachedResultData(row.result_data);
      if (!data || !isValidCachedPayload('topic', data)) continue;
      if (!topicCacheTextsMatch(topicBody, row, data)) continue;
      return finalizeArchiveTopicMatch(formatExactArchiveTopicMatch({
        row: row,
        data: data,
        topic: archiveTopicDisplayName(row, data, topic),
        score: 1,
      }, gradeId));
    }
    return null;
  }

  if (isSupabaseCacheEnabled()) {
    try {
      let match = scanRows(await fetchArchiveTopicRowsForGrade(gradeId, topic, true));
      if (!match) match = scanRows(await fetchArchiveTopicRowsForGrade(gradeId, topic, false));
      if (match) return match;
    } catch (err) {
      console.warn('[cached_results] normalized archive topic lookup failed:', err.message || err);
    }
  }

  loadFallbackStore();
  let fallbackMatch = null;
  fallbackStore.rows.forEach(function (row) {
    if (fallbackMatch || !row || row.phase !== 'topic' || !row.result_data) return;
    if (String(row.grade_id || '').trim() !== String(gradeId || '').trim()) return;
    const data = coerceCachedResultData(row.result_data);
    if (!data || !isValidCachedPayload('topic', data)) return;
    if (!topicCacheTextsMatch(topicBody, row, data)) return;
    fallbackMatch = formatExactArchiveTopicMatch({
      row: row,
      data: data,
      topic: archiveTopicDisplayName(row, data),
      score: 1,
    }, gradeId);
  });
  if (fallbackMatch) return finalizeArchiveTopicMatch(fallbackMatch);
  return null;
}

function collectArchiveTopicRowsForGrade(gradeId, topic) {
  const rows = [];
  const seen = new Set();
  function addRows(list) {
    (list || []).forEach(function (row) {
      if (!row || !row.cache_key || seen.has(row.cache_key)) return;
      seen.add(row.cache_key);
      rows.push(row);
    });
  }

  if (isSupabaseCacheEnabled()) {
    return fetchArchiveTopicRowsForGrade(gradeId, topic, true).then(function (filtered) {
      addRows(filtered);
      if (!rows.length) {
        return fetchArchiveTopicRowsForGrade(gradeId, topic, false).then(function (allRows) {
          addRows(allRows);
          return rows;
        });
      }
      return rows;
    });
  }

  loadFallbackStore();
  fallbackStore.rows.forEach(function (row) {
    if (!row || row.phase !== 'topic' || !row.result_data) return;
    if (String(row.grade_id || '').trim() !== String(gradeId || '').trim()) return;
    addRows([row]);
  });
  return Promise.resolve(rows);
}

/**
 * User typed a keyword contained in a longer archived lesson title — suggest confirmation first.
 */
async function findArchiveTopicByQueryPrefix(topic, gradeId) {
  const queryStable = stableNormalize(topic);
  const queryNorm = normalizeTopicQuery(topic);
  if (!queryStable || queryStable.length < 3 || !gradeId) return null;

  const rows = await collectArchiveTopicRowsForGrade(gradeId, topic);
  let best = null;

  rows.forEach(function (row) {
    const data = coerceCachedResultData(row.result_data);
    if (!data || !isValidCachedPayload('topic', data)) return;
    const candidateTopic = archiveTopicDisplayName(row, data, topic);
    if (!candidateTopic || isMisleadingArchiveAutoLoad(topic, candidateTopic)) return;

    const stable = stableNormalize(candidateTopic);
    const norm = normalizeTopicQuery(candidateTopic);
    const archiveContainsQuery =
      (stable.length > queryStable.length && stable.indexOf(queryStable) >= 0) ||
      (norm && queryNorm && norm.length > queryNorm.length && norm.indexOf(queryNorm) >= 0);
    if (!archiveContainsQuery) return;

    const pick = { row: row, data: data, topic: candidateTopic, score: 0.95 };
    if (!best || isBetterArchiveTopicPick(pick, best)) best = pick;
  });

  if (!best) return null;
  return formatPartialArchiveTopicMatch(best, gradeId, { requestedTopic: topic });
}

function formatPartialArchiveTopicMatch(best, gradeId, options) {
  options = options || {};
  if (!best || !best.row) return null;
  return {
    matchType: 'partial',
    similarity: best.score,
    cacheKey: best.row.cache_key,
    topic: best.topic,
    requestedTopic: options.requestedTopic || null,
    gradeId: gradeId,
    gradeLabel: best.row.grade_label || null,
  };
}

function findArchiveTopicInFallback(query, gradeId, options) {
  loadFallbackStore();
  const rows = Array.from(fallbackStore.rows.values()).filter(function (row) {
    return row && row.phase === 'topic' && String(row.grade_id || '').trim() === String(gradeId || '').trim();
  });
  return pickBestArchiveTopicRow(rows, query, options || {});
}

function formatExactArchiveTopicMatch(best, gradeId, options) {
  options = options || {};
  if (!best || !best.row) return null;
  const payload = cloneJsonSafe(best.data) || best.data;
  if (!payload) return null;
  if (!isEnhancedCachedPayload('topic', payload)) return null;
  return {
    matchType: 'exact',
    similarity: best.score,
    cacheKey: best.row.cache_key,
    topic: best.topic,
    requestedTopic: options.requestedTopic || null,
    gradeId: gradeId,
    gradeLabel: best.row.grade_label || null,
    resultData: payload,
    _archiveRow: best.row,
    _topicBody: {
      phase: 'topic',
      topic: options.requestedTopic || best.topic || best.row.topic || '',
      currentGrade: gradeId,
      gradeId: gradeId,
      gradeLabel: best.row.grade_label || null,
    },
  };
}

async function finalizeArchiveTopicMatch(match) {
  if (!match || !match.resultData) return match;
  let data = coerceArchiveLessonResultData(match.resultData) || match.resultData;
  data = applyArchiveLinkCleanupPolicy(data, 'topic');
  const out = Object.assign({}, match, { resultData: data });
  delete out._archiveRow;
  delete out._topicBody;
  return out;
}

async function fetchArchiveTopicRowsForGrade(gradeId, topic, withTermFilter) {
  if (!isSupabaseCacheEnabled()) return [];

  const params = new URLSearchParams();
  params.set('select', LEGACY_ROW_SELECT);
  params.set('phase', 'eq.topic');
  params.set('grade_id', 'eq.' + gradeId);
  params.set('order', 'hit_count.desc,created_at.desc');
  params.set('limit', '80');

  if (withTermFilter) {
    const searchTerms = hebrewTopicMatch.expandHebrewSearchTerms(topic, 8);
    const uniqueTerms = Array.from(new Set(searchTerms)).slice(0, 6);
    if (uniqueTerms.length) {
      const orParts = uniqueTerms.map(function (term) {
        return 'topic.ilike.*' + term + '*,query_text.ilike.*' + term + '*';
      });
      params.set('or', '(' + orParts.join(',') + ')');
    }
  }

  const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), { method: 'GET' });
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/**
 * Find an archived topic with near-exact similarity (auto-load, no confirmation).
 * Runs before partial matching so short keyword rows (e.g. «רומא») cannot win over the full lesson title.
 */
async function findStrongArchiveTopicMatch(topic, gradeId) {
  if (!topic || !gradeId) return null;

  let best = null;
  if (isSupabaseCacheEnabled()) {
    try {
      let rows = await fetchArchiveTopicRowsForGrade(gradeId, topic, true);
      best = pickBestArchiveTopicRow(rows, topic, { strongOnly: true });
      if (!best) {
        rows = await fetchArchiveTopicRowsForGrade(gradeId, topic, false);
        best = pickBestArchiveTopicRow(rows, topic, { strongOnly: true });
      }
    } catch (err) {
      console.warn('[cached_results] strong archive topic match failed:', err.message || err);
    }
  }

  if (!best) {
    best = findArchiveTopicInFallback(topic, gradeId, { strongOnly: true });
  }

  return best;
}

async function fetchCanonicalGradeArchiveRow(gradeId, canonicalTopic) {
  if (!gradeId || !canonicalTopic) return null;

  if (isSupabaseCacheEnabled()) {
    try {
      const params = new URLSearchParams();
      params.set('select', LEGACY_ROW_SELECT);
      params.set('phase', 'eq.topic');
      params.set('grade_id', 'eq.' + gradeId);
      params.set('topic', 'eq.' + canonicalTopic);
      params.set('order', 'hit_count.desc,created_at.desc');
      params.set('limit', '1');

      const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), { method: 'GET' });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows[0] && rows[0].result_data) {
          const data = coerceCachedResultData(rows[0].result_data);
          if (data && isValidCachedPayload('topic', data)) return rows[0];
        }
      }
    } catch (err) {
      console.warn('[cached_results] canonical grade archive lookup failed:', err.message || err);
    }
  }

  loadFallbackStore();
  let best = null;
  fallbackStore.rows.forEach(function (row) {
    if (!row || row.phase !== 'topic' || !row.result_data) return;
    if (String(row.grade_id || '').trim() !== String(gradeId || '').trim()) return;
    if (stableNormalize(row.topic || '') !== stableNormalize(canonicalTopic)) return;
    if (!isValidCachedPayload('topic', coerceCachedResultData(row.result_data))) return;
    best = row;
  });
  return best;
}

/**
 * Strict grade-scoped redirect: partial discovery-topic queries always suggest the
 * canonical archive title (e.g. כיתה ז׳ → «תקופת מגלי עולם»).
 */
async function findCanonicalGradeArchiveSuggestion(gradeId, topic) {
  if (!hebrewTopicMatch.shouldProbeCanonicalArchiveTopic || !hebrewTopicMatch.getGradeCanonicalArchiveTopic) {
    return null;
  }
  if (!hebrewTopicMatch.shouldProbeCanonicalArchiveTopic(gradeId, topic)) return null;

  const canonicalTopic = hebrewTopicMatch.getGradeCanonicalArchiveTopic(gradeId);
  const row = await fetchCanonicalGradeArchiveRow(gradeId, canonicalTopic);
  if (!row) return null;

  const data = coerceCachedResultData(row.result_data);
  if (!data || !isValidCachedPayload('topic', data)) return null;

  return {
    matchType: 'partial',
    similarity: scoreTopicSimilarity(topic, canonicalTopic, row.query_text || ''),
    cacheKey: row.cache_key,
    topic: archiveTopicDisplayName(row, data) || canonicalTopic,
    gradeId: gradeId,
    gradeLabel: row.grade_label || null,
  };
}

/**
 * Semantic topic_master suggestion before a live Perplexity crawl.
 * Returns exact hits (same normalized topic) or partial semantic alias matches.
 */
async function findTopicMasterArchiveSuggestion(gradeId, topic) {
  const gid = String(gradeId || '').trim();
  const topicStr = String(topic || '').trim();
  if (!gid || !topicStr) return null;
  if (hebrewTopicMatch.shouldBypassSemanticArchiveSuggestion(topicStr)) return null;

  const exactBody = buildTopicMasterCacheBody(gid, null, topicStr);
  const exactCached = await getCachedResult(exactBody, { requireEnhanced: false });
  if (exactCached && exactCached.data && isTopicMasterPayload(exactCached.data)) {
    hydrateTopicMasterArchiveLinks(exactCached.data);
    return {
      matchType: 'exact',
      similarity: 1,
      cacheKey: exactCached.meta.cacheKey,
      topic: topicStr,
      suggestedTopic: topicStr,
      requestedTopic: topicStr,
      gradeId: gid,
      resultData: { purePhaseC: exactCached.data },
      archiveSource: 'topic_master',
    };
  }

  const semantic = await findSemanticTopicMasterMatch(gid, topicStr);
  if (!semantic || !semantic.data || !isTopicMasterPayload(semantic.data)) return null;
  hydrateTopicMasterArchiveLinks(semantic.data);

  const matchedTopic = String(semantic.meta && semantic.meta.matchedTopic || topicStr).trim();
  const queryNorm = stableNormalize(topicStr);
  const matchedNorm = stableNormalize(matchedTopic);
  const similarity = semantic.meta && semantic.meta.similarity != null ? semantic.meta.similarity : 1;

  if (queryNorm && matchedNorm && queryNorm === matchedNorm) {
    return {
      matchType: 'exact',
      similarity: similarity,
      cacheKey: semantic.meta.cacheKey,
      topic: matchedTopic,
      suggestedTopic: matchedTopic,
      requestedTopic: topicStr,
      gradeId: gid,
      resultData: { purePhaseC: semantic.data },
      archiveSource: 'topic_master',
    };
  }

  if (isMisleadingArchiveAutoLoad(topicStr, matchedTopic)) return null;

  return {
    matchType: 'partial',
    similarity: similarity,
    cacheKey: semantic.meta.cacheKey,
    topic: matchedTopic,
    suggestedTopic: matchedTopic,
    requestedTopic: topicStr,
    gradeId: gid,
    historicPayload: semantic.data,
    archiveSource: 'topic_master',
  };
}

/**
 * Find an exact or partial community-archive topic match before a live API search.
 * Exact matches include full resultData; partial matches return metadata only.
 */
async function findArchiveTopicSuggestion(options) {
  const topic = String(options && options.topic || '').trim();
  const gradeId = String((options && (options.gradeId || options.currentGrade)) || '').trim();
  const gradeLabel = String((options && options.gradeLabel) || '').trim();
  if (!topic || !gradeId) return null;

  const gradeMismatch = archiveDisambiguation.checkPedagogicalGradeGuardrail(gradeId, topic, gradeLabel);
  if (gradeMismatch) {
    console.log(
      '[cached_results] GRADE GUARDRAIL blocked archive probe:',
      topic,
      '—',
      gradeMismatch.currentGradeLabel,
      '≠',
      gradeMismatch.canonicalGradeLabel
    );
    return {
      matchType: 'grade_mismatch',
      gradeMismatch: gradeMismatch,
      message: archiveDisambiguation.buildGradeMismatchError(gradeMismatch),
      requestedTopic: topic,
      gradeId: gradeId,
      gradeLabel: gradeMismatch.currentGradeLabel,
    };
  }

  const topicBody = { phase: 'topic', topic: topic, currentGrade: gradeId, gradeId: gradeId };
  const cached = await getCachedResult(topicBody);
  if (cached && cached.data && isValidCachedPayload('topic', cached.data)) {
    return finalizeArchiveTopicMatch({
      matchType: 'exact',
      similarity: 1,
      cacheKey: cached.meta.cacheKey,
      topic: archiveTopicDisplayName({ topic: topic, query_text: topic }, cached.data) || topic,
      requestedTopic: topic,
      gradeId: gradeId,
      resultData: cached.data,
      _topicBody: topicBody,
    });
  }

  const normalizedMatch = await findArchiveTopicByNormalizedText(topic, gradeId);
  if (normalizedMatch) {
    normalizedMatch.requestedTopic = topic;
    return normalizedMatch;
  }

  const bypassSemanticGuess = hebrewTopicMatch.shouldBypassSemanticArchiveSuggestion(topic);

  if (!bypassSemanticGuess) {
    const prefixMatch = await findArchiveTopicByQueryPrefix(topic, gradeId);
    if (prefixMatch) return prefixMatch;
  }

  const strongBest = await findStrongArchiveTopicMatch(topic, gradeId);
  if (strongBest && strongBest.row) {
    if (isMisleadingArchiveAutoLoad(topic, strongBest.topic)) {
      console.log('[cached_results] skipped misleading strong archive match:', strongBest.topic);
    } else {
      return finalizeArchiveTopicMatch(
        formatExactArchiveTopicMatch(strongBest, gradeId, { requestedTopic: topic })
      );
    }
  }

  if (bypassSemanticGuess) {
    console.log('[cached_results] definitive Waldorf skill block — exact archive only, skipping disambiguation:', topic);
    return null;
  }

  const topicMasterSuggestion = await findTopicMasterArchiveSuggestion(gradeId, topic);
  if (topicMasterSuggestion) return topicMasterSuggestion;

  const canonicalSuggestion = await findCanonicalGradeArchiveSuggestion(gradeId, topic);
  if (canonicalSuggestion) return canonicalSuggestion;

  let best = null;

  if (isSupabaseCacheEnabled()) {
    try {
      let rows = await fetchArchiveTopicRowsForGrade(gradeId, topic, true);
      best = pickBestArchiveTopicRow(rows, topic, { partialOnly: true });
      if (!best) {
        rows = await fetchArchiveTopicRowsForGrade(gradeId, topic, false);
        best = pickBestArchiveTopicRow(rows, topic, { partialOnly: true });
      }
    } catch (err) {
      console.warn('[cached_results] archive topic suggestion failed:', err.message || err);
    }
  }

  if (!best) {
    best = findArchiveTopicInFallback(topic, gradeId, { partialOnly: true });
  }

  if (!best || !best.row) return null;

  if (!archiveDisambiguation.shouldOfferPartialArchiveSuggestion(topic, best.topic, best.score, gradeId, gradeLabel)) {
    console.log('[cached_results] skipped partial archive suggestion:', best.topic, 'score=' + (best.score || 0).toFixed(3));
    return null;
  }

  return {
    matchType: 'partial',
    similarity: best.score,
    cacheKey: best.row.cache_key,
    topic: best.topic,
    gradeId: gradeId,
    gradeLabel: best.row.grade_label || null,
  };
}

const GRADE_LABEL_BY_ID = {
  '1': 'כיתה א׳',
  '2': 'כיתה ב׳',
  '3': 'כיתה ג׳',
  '4': 'כיתה ד׳',
  '5': 'כיתה ה׳',
  '6': 'כיתה ו׳',
  '7': 'כיתה ז׳',
  '8': 'כיתה ח׳',
  general: 'כללי',
};

const LEGACY_ROW_SELECT =
  'cache_key,phase,grade_id,grade_label,topic,query_text,result_data,hit_count,created_at,last_hit_at,user_id,user_email';

function topicCacheTextsMatch(body, row, resultData) {
  if (!body || !row) return false;
  const wanted = normalizeTopicQuery(body.topic || '');
  const wantedStable = stableNormalize(body.topic || '');
  if (!wanted && !wantedStable) return false;
  const candidates = [row.topic, row.query_text];
  const data = resultData || (row.result_data ? coerceCachedResultData(row.result_data) : null);
  if (data && data.webResearch && data.webResearch.topic) {
    candidates.push(data.webResearch.topic);
  }
  for (let i = 0; i < candidates.length; i++) {
    const raw = String(candidates[i] || '').trim();
    if (!raw) continue;
    if (wanted && normalizeTopicQuery(raw) === wanted) return true;
    if (wantedStable && stableNormalize(raw) === wantedStable) return true;
  }
  return false;
}

async function fetchCachedRowByKey(cacheKey) {
  if (!cacheKey) return null;

  if (isSupabaseCacheEnabled()) {
    try {
      const res = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME +
        '?cache_key=eq.' + encodeURIComponent(cacheKey) +
        '&select=' + LEGACY_ROW_SELECT + '&limit=1',
        { method: 'GET' }
      );
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows[0]) return rows[0];
      }
    } catch (err) {
      console.warn('[cached_results] fetch by key failed:', err.message || err);
    }
  }

  loadFallbackStore();
  return fallbackStore.rows.get(cacheKey) || null;
}

/** Direct cache_key lookup only — on miss the route proceeds to live Perplexity. */
async function resolveCachedRow(cacheKey) {
  if (!cacheKey) return null;
  const row = await fetchCachedRowByKey(cacheKey);
  if (row && row.result_data) return row;
  return null;
}

/**
 * Find a prior chat_followup answer for enrichment (exact or similar) — never returns as final response.
 */
async function lookupChatPriorAnswer(body) {
  if (!body || body.phase !== 'chat_followup') return null;
  const userMessage = String(body.userMessage || '').trim();
  if (!userMessage) return null;

  const cacheKey = buildCacheKey(body);
  const exactRow = await fetchCachedRowByKey(cacheKey);
  if (exactRow && exactRow.result_data) {
    const data = coerceCachedResultData(exactRow.result_data);
    if (data && extractChatAnswerText(data)) {
      bumpHitCountAsync(cacheKey, exactRow.hit_count);
      return {
        cacheKey: cacheKey,
        data: data,
        queryText: exactRow.query_text || userMessage,
        matchType: 'exact',
        hitCount: exactRow.hit_count || 0,
      };
    }
  }

  if (!isSupabaseCacheEnabled() || userMessage.length < 4) return null;

  try {
    const params = new URLSearchParams();
    params.set('select', 'cache_key,query_text,result_data,hit_count,topic,grade_id');
    params.set('phase', 'eq.chat_followup');
    params.set('order', 'hit_count.desc,created_at.desc');
    params.set('limit', '40');
    const gradeId = body.currentGrade ?? body.gradeId;
    if (gradeId) params.set('grade_id', 'eq.' + gradeId);
    const topic = String(body.topic || '').trim();
    if (topic) params.set('topic', 'ilike.*' + topic.slice(0, 60) + '*');

    const words = stableNormalize(userMessage).split(' ').filter(function (w) { return w.length > 2; });
    if (words.length >= 2) {
      params.set('query_text', 'ilike.*' + words.slice(0, 4).join('*') + '*');
    }

    const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), { method: 'GET' });
    if (!res.ok) return null;

    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;

    let best = null;
    let bestScore = 0.55;
    rows.forEach(function (row) {
      if (!row || !row.result_data || !extractChatAnswerText(row.result_data)) return;
      const score = scoreChatQuestionSimilarity(userMessage, row.query_text || '');
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    });

    if (!best) return null;

    const bestData = coerceCachedResultData(best.result_data);
    if (!bestData) return null;

    bumpHitCountAsync(best.cache_key, best.hit_count);
    return {
      cacheKey: best.cache_key,
      data: bestData,
      queryText: best.query_text || userMessage,
      matchType: 'similar',
      similarity: bestScore,
      hitCount: best.hit_count || 0,
    };
  } catch (err) {
    console.warn('[cached_results] chat prior lookup failed:', err.message || err);
    return null;
  }
}

/**
 * Lookup cached result. Returns { data, meta } or null.
 * For topic/grade phases, only returns rows that pass isEnhancedCachedPayload when requireEnhanced is true.
 */
function isTopicMasterPayload(data) {
  const coerced = coerceCachedResultData(data);
  if (!coerced || typeof coerced !== 'object') return false;
  const hasTheory = coerced.theory && typeof coerced.theory === 'object';
  const hasPedagogy = String(coerced.core_emphases || '').trim().length > 40
    || (Array.isArray(coerced.key_points) && coerced.key_points.length > 0);
  return Boolean(hasTheory && hasPedagogy);
}

function normalizeGeneralSearchQuery(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function isGeneralSearchPayload(data) {
  if (!data || typeof data !== 'object') return false;
  return Boolean(
    String(data.developmental_axis || '').trim() ||
    String(data.core_pedagogical_emphases || '').trim() ||
    (Array.isArray(data.recommended_literature) && data.recommended_literature.length) ||
    (Array.isArray(data.relevant_links) && data.relevant_links.length) ||
    (Array.isArray(data.curriculum) && data.curriculum.length)
  );
}

function buildGeneralSearchCacheBody(query, options) {
  const q = normalizeGeneralSearchQuery(query);
  const opts = options && typeof options === 'object' ? options : {};
  const body = {
    phase: GENERAL_SEARCH_PHASE,
    query: q,
    topic: q,
    archiveQuery: q,
    periodBlock: Boolean(opts.periodBlock),
  };
  if (opts.userEmail) body.userEmail = opts.userEmail;
  if (opts.userId) body.userId = opts.userId;
  if (opts.teacherUser) body.teacherUser = opts.teacherUser;
  return body;
}

function buildTopicMasterCacheBody(gradeId, gradeLabel, topic) {
  return {
    phase: TOPIC_MASTER_PHASE,
    currentGrade: gradeId,
    gradeId: gradeId,
    gradeLabel: gradeLabel || null,
    topic: topic,
  };
}

const TOPIC_MASTER_SEMANTIC_MIN_SCORE = ARCHIVE_PARTIAL_MIN_SCORE;
const TOPIC_MASTER_EMBEDDING_MIN_SCORE = 0.82;

function topicMasterDisplayName(row, data, queryHint) {
  const coerced = data || coerceCachedResultData(row && row.result_data);
  const candidates = [];
  function addCandidate(val) {
    const s = String(val || '').trim();
    if (s && candidates.indexOf(s) < 0) candidates.push(s);
  }
  if (row && row.topic) addCandidate(row.topic);
  if (row && row.query_text) addCandidate(row.query_text);
  if (coerced && coerced._topicMaster) {
    addCandidate(coerced._topicMaster.topic);
    addCandidate(coerced._topicMaster.topicNormalized);
  }
  if (!candidates.length) return '';

  const hint = String(queryHint || '').trim();
  if (hint) {
    let best = candidates[0];
    let bestScore = scoreTopicMasterSemanticMatch(hint, best, '');
    candidates.forEach(function (curr) {
      const score = scoreTopicMasterSemanticMatch(hint, curr, '');
      if (score > bestScore + 0.0001 || (Math.abs(score - bestScore) <= 0.0001 && curr.length < best.length)) {
        best = curr;
        bestScore = score;
      }
    });
    return best;
  }

  return candidates.reduce(function (best, curr) {
    return curr.length > best.length ? curr : best;
  }, candidates[0]);
}

/** Hebrew morphological + pedagogical-alias scoring for topic_master cache rows. */
function scoreTopicMasterSemanticMatch(queryRaw, candidateTopic, candidateQueryText) {
  let score = scoreTopicSimilarity(queryRaw, candidateTopic, candidateQueryText);
  if (hebrewTopicMatch.sharesAllowedPedagogicalAlias(queryRaw, candidateTopic)) {
    score = Math.max(score, 0.88);
  }
  if (candidateQueryText && hebrewTopicMatch.sharesAllowedPedagogicalAlias(queryRaw, candidateQueryText)) {
    score = Math.max(score, 0.88);
  }
  const queryNorm = stableNormalize(queryRaw);
  const topicNorm = stableNormalize(candidateTopic || '');
  if (queryNorm && topicNorm && queryNorm === topicNorm) score = Math.max(score, 1);
  return score;
}

function pickBestTopicMasterRow(rows, query) {
  let best = null;
  let bestScore = TOPIC_MASTER_SEMANTIC_MIN_SCORE;

  (rows || []).forEach(function (row) {
    if (!row || !row.result_data) return;
    const data = coerceCachedResultData(row.result_data);
    if (!data || !isTopicMasterPayload(data)) return;
    const candidateTopic = topicMasterDisplayName(row, data, query);
    if (!candidateTopic || isMisleadingArchiveAutoLoad(query, candidateTopic)) return;
    const score = scoreTopicMasterSemanticMatch(query, candidateTopic, row.query_text || '');
    if (score <= bestScore) return;
    const candidate = { row: row, data: data, topic: candidateTopic, score: score, matchMethod: 'hebrew' };
    if (isBetterArchiveTopicPick(candidate, best)) {
      best = candidate;
      bestScore = score;
    }
  });

  return best;
}

function topicMasterEmbeddingCosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function pickTopicMasterByEmbeddingSimilarity(rows, query) {
  if (!embeddings.resolveEmbeddingApiKey()) return null;
  const viable = (rows || []).filter(function (row) {
    const data = coerceCachedResultData(row.result_data);
    return data && isTopicMasterPayload(data);
  }).slice(0, 40);
  if (!viable.length) return null;

  const queryVector = await embeddings.embedText(query);
  if (!Array.isArray(queryVector) || !queryVector.length) return null;

  const labels = viable.map(function (row) {
    return topicMasterDisplayName(row, coerceCachedResultData(row.result_data), query);
  });
  const vectors = await embeddings.embedTexts(labels);
  let best = null;
  let bestScore = TOPIC_MASTER_EMBEDDING_MIN_SCORE;

  viable.forEach(function (row, index) {
    const vector = vectors[index];
    if (!vector) return;
    const candidateTopic = labels[index];
    if (!candidateTopic || isMisleadingArchiveAutoLoad(query, candidateTopic)) return;
    const score = topicMasterEmbeddingCosine(queryVector, vector);
    if (score <= bestScore) return;
    const data = coerceCachedResultData(row.result_data);
    const candidate = { row: row, data: data, topic: candidateTopic, score: score, matchMethod: 'embedding' };
    if (isBetterArchiveTopicPick(candidate, best)) {
      best = candidate;
      bestScore = score;
    }
  });

  return best;
}

async function fetchTopicMasterRowsForGrade(gradeId, topic, withTermFilter) {
  if (!isSupabaseCacheEnabled()) return [];

  const params = new URLSearchParams();
  params.set('select', LEGACY_ROW_SELECT);
  params.set('phase', 'eq.' + TOPIC_MASTER_PHASE);
  params.set('grade_id', 'eq.' + gradeId);
  params.set('order', 'hit_count.desc,created_at.desc');
  params.set('limit', '80');

  if (withTermFilter) {
    const searchTerms = hebrewTopicMatch.expandHebrewSearchTerms(topic, 8);
    const uniqueTerms = Array.from(new Set(searchTerms)).slice(0, 6);
    if (uniqueTerms.length) {
      const orParts = uniqueTerms.map(function (term) {
        return 'topic.ilike.*' + term + '*,query_text.ilike.*' + term + '*';
      });
      params.set('or', '(' + orParts.join(',') + ')');
    }
  }

  const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), { method: 'GET' });
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

function collectTopicMasterRowsForGrade(gradeId, topic) {
  const rows = [];
  const seen = new Set();
  function addRows(list) {
    (list || []).forEach(function (row) {
      if (!row || !row.cache_key || seen.has(row.cache_key)) return;
      seen.add(row.cache_key);
      rows.push(row);
    });
  }

  if (isSupabaseCacheEnabled()) {
    return fetchTopicMasterRowsForGrade(gradeId, topic, true).then(function (filtered) {
      addRows(filtered);
      if (!rows.length) {
        return fetchTopicMasterRowsForGrade(gradeId, topic, false).then(function (allRows) {
          addRows(allRows);
          return rows;
        });
      }
      return rows;
    });
  }

  loadFallbackStore();
  fallbackStore.rows.forEach(function (row) {
    if (!row || row.phase !== TOPIC_MASTER_PHASE || !row.result_data) return;
    if (String(row.grade_id || '').trim() !== String(gradeId || '').trim()) return;
    addRows([row]);
  });
  return Promise.resolve(rows);
}

/**
 * Semantic topic_master lookup — Hebrew synonym/morphology + optional embedding vector match.
 * Serves cached Phase C payloads when queries differ by Waldorf alias (e.g. חשבון ↔ מתמטיקה).
 */
async function findSemanticTopicMasterMatch(gradeId, topic) {
  const gid = String(gradeId || '').trim();
  const topicStr = String(topic || '').trim();
  if (!gid || !topicStr) return null;
  if (hebrewTopicMatch.shouldBypassSemanticArchiveSuggestion(topicStr)) return null;

  const rows = await collectTopicMasterRowsForGrade(gid, topicStr);
  if (!rows.length) return null;

  let best = pickBestTopicMasterRow(rows, topicStr);
  if (!best) {
    try {
      best = await pickTopicMasterByEmbeddingSimilarity(rows, topicStr);
    } catch (embedErr) {
      console.warn('[cached_results] topic_master embedding match failed:', embedErr.message || embedErr);
    }
  }
  if (!best || !best.row) return null;

  bumpHitCountAsync(best.row.cache_key, best.row.hit_count);
  const payload = cloneJsonSafe(best.data) || best.data;
  if (!payload) return null;

  return {
    data: payload,
    meta: {
      fromCache: true,
      cacheKey: best.row.cache_key,
      table: TABLE_NAME,
      source: best.matchMethod === 'embedding' ? 'topic_master_embedding' : 'topic_master_semantic',
      matchedTopic: best.topic,
      similarity: best.score,
      semanticMatch: true,
      enhanced: isTopicMasterPayload(payload),
    },
  };
}

/** Lookup unified Step B→C master JSON by grade_id + exact or semantic topic (archive fast-path). */
async function getTopicMasterCache(gradeId, topic, options) {
  const gid = String(gradeId || '').trim();
  const topicStr = String(topic || '').trim();
  if (!gid || !topicStr) return null;
  const body = buildTopicMasterCacheBody(gid, null, topicStr);
  const opts = Object.assign({ requireEnhanced: false }, options || {});
  const cached = await getCachedResult(body, opts);
  if (cached && cached.data && isTopicMasterPayload(cached.data)) {
    hydrateTopicMasterArchiveLinks(cached.data);
    return cached;
  }

  const semantic = await findSemanticTopicMasterMatch(gid, topicStr);
  if (semantic && semantic.data && isTopicMasterPayload(semantic.data)) {
    hydrateTopicMasterArchiveLinks(semantic.data);
    return semantic;
  }

  return null;
}

/** Rebuild _liveCitations from every stored link field after Supabase hydration. */
function hydrateTopicMasterArchiveLinks(data) {
  if (!data || typeof data !== 'object') return data;
  try {
    const phaseC = require('./pure-phase-c');
    if (phaseC && typeof phaseC.adaptTopicMasterPayload === 'function') {
      phaseC.adaptTopicMasterPayload(data, {
        gradeId: data._topicMaster && data._topicMaster.gradeId,
        grade: data._topicMaster && (data._topicMaster.gradeLabel || data._topicMaster.gradeId),
        gradeLabel: data._topicMaster && data._topicMaster.gradeLabel,
        topic: data._topicMaster && data._topicMaster.topic,
      });
    }
    if (phaseC && typeof phaseC.stampTopicMasterArchiveLinks === 'function') {
      phaseC.stampTopicMasterArchiveLinks(data, data);
    }
  } catch (err) {
    const urls = [];
    const seen = new Set();
    function pushUrl(raw) {
      const u = String(raw || '').trim();
      if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) return;
      seen.add(u);
      urls.push(u);
    }
    function walkList(list) {
      (list || []).forEach(function (item) {
        if (!item) return;
        if (typeof item === 'string') pushUrl(item);
        else pushUrl(item.url || item.link || item.href);
      });
    }
    (data._liveCitations || []).forEach(pushUrl);
    walkList(data.relevant_links);
    walkList(data.pinterest_links);
    walkList(data.pedagogical_resources);
    walkList(data.recommended_reading);
    const bib = data.theory && data.theory.bibliography;
    if (bib) {
      walkList(bib.books);
      walkList(bib.articles);
      walkList(bib.websites);
    }
    if (urls.length) data._liveCitations = urls;
  }
  return data;
}

async function deleteTopicMasterCache(gradeId, topic) {
  const gid = String(gradeId || '').trim();
  const topicStr = String(topic || '').trim();
  if (!gid || !topicStr) return false;
  const body = buildTopicMasterCacheBody(gid, null, topicStr);
  if (!body) return false;
  const cacheKey = buildCacheKey(body);
  if (!cacheKey) return false;
  const deleted = await deleteCachedRowByKey(cacheKey);
  if (deleted) {
    console.log('[cached_results] deleted topic_master', cacheKey.slice(0, 12));
  }
  return deleted;
}

/** Phases holding Step B/C prose — grade (Step A) is intentionally excluded. */
const TOPIC_PROSE_ARCHIVE_PHASES = [
  'topic',
  TOPIC_MASTER_PHASE,
  RAW_PERPLEXITY_PHASE,
  'pedagogy_deep_dive',
  'archive_summary',
];

function topicProseRowMatchesTarget(row, topic) {
  const topicStr = String(topic || '').trim();
  if (!row || !topicStr) return false;
  const rowTopic = String(row.topic || '').trim();
  const rowQuery = String(row.query_text || '').trim();
  if (rowTopic === topicStr || rowQuery === topicStr) return true;
  const norm = normalizeTopicQuery(topicStr);
  if (norm && (rowTopic === norm || rowQuery === norm)) return true;
  return false;
}

async function fetchTopicProseArchiveRows(gradeId, topic) {
  if (!isSupabaseCacheEnabled()) return [];
  const gid = String(gradeId || '').trim();
  const topicStr = String(topic || '').trim();
  if (!gid || !topicStr) return [];

  const params = new URLSearchParams();
  params.set('select', 'cache_key,phase,grade_id,topic,query_text');
  params.set('grade_id', 'eq.' + gid);
  params.set('phase', 'in.(' + TOPIC_PROSE_ARCHIVE_PHASES.join(',') + ')');
  params.set('order', 'created_at.desc');
  params.set('limit', '120');

  const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), { method: 'GET' });
  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.filter(function (row) {
    return row && row.phase !== 'grade' && topicProseRowMatchesTarget(row, topicStr);
  });
}

function collectTopicProseCacheKeys(gradeId, topic, options) {
  const gid = String(gradeId || '').trim();
  const topicStr = String(topic || '').trim();
  const keys = new Set();
  if (!gid || !topicStr) return keys;

  const opts = options && typeof options === 'object' ? options : {};
  const gradeLabel = opts.gradeLabel || '';

  const topicBody = buildTopicCacheBody({
    gradeId: gid,
    currentGrade: gid,
    topic: topicStr,
    gradeLabel: gradeLabel,
  });
  if (topicBody) {
    const key = buildCacheKey(topicBody);
    if (key) keys.add(key);
  }

  const masterBody = buildTopicMasterCacheBody(gid, gradeLabel, topicStr);
  if (masterBody) {
    const key = buildCacheKey(masterBody);
    if (key) keys.add(key);
  }

  const rawBody = buildRawPerplexityCacheBody({
    phase: 'topic',
    gradeId: gid,
    currentGrade: gid,
    topic: topicStr,
    gradeLabel: gradeLabel,
  });
  if (rawBody) {
    const key = buildCacheKey(rawBody);
    if (key) keys.add(key);
  }

  ['pedagogy_deep_dive', 'archive_summary'].forEach(function (phase) {
    const expBody = {
      phase: phase,
      gradeId: gid,
      currentGrade: gid,
      topic: topicStr,
      gradeLabel: gradeLabel,
      expansionScope: 'topic',
    };
    const key = buildCacheKey(expBody);
    if (key) keys.add(key);
  });

  return keys;
}

/**
 * Delete global archived Step B + Step C prose for a grade/topic pair.
 * Preserves grade (Step A) cached_results rows.
 */
async function deleteTopicProseArchive(gradeId, topic, options) {
  const gid = String(gradeId || '').trim();
  const topicStr = String(topic || '').trim();
  if (!gid || !topicStr) {
    return { deleted: 0, deletedKeys: [], preservedGrade: true };
  }

  const keysToDelete = collectTopicProseCacheKeys(gid, topicStr, options);

  try {
    const rows = await fetchTopicProseArchiveRows(gid, topicStr);
    rows.forEach(function (row) {
      if (row && row.cache_key && row.phase !== 'grade') {
        keysToDelete.add(row.cache_key);
      }
    });
  } catch (sweepErr) {
    console.warn('[cached_results] topic prose archive sweep failed:', sweepErr.message || sweepErr);
  }

  const deletedKeys = [];
  for (const key of keysToDelete) {
    const ok = await deleteCachedRowByKey(key);
    if (ok) deletedKeys.push(key);
  }

  if (deletedKeys.length) {
    console.log(
      '[cached_results] deleteTopicProseArchive',
      gid,
      topicStr.slice(0, 40),
      'removed',
      deletedKeys.length,
      'key(s)'
    );
  }

  return { deleted: deletedKeys.length, deletedKeys: deletedKeys, preservedGrade: true };
}

/** Persist unified Step B→C master JSON under grade_id + normalized topic. */
async function setTopicMasterCache(gradeId, gradeLabel, topic, masterData, ownerBody) {
  const gid = String(gradeId || '').trim();
  const topicStr = String(topic || '').trim();
  if (!gid || !topicStr || !masterData) return null;
  const safe = ensureJsonObjectForStorage(masterData);
  if (!safe) return null;
  try {
    const phaseC = require('./pure-phase-c');
    if (phaseC && typeof phaseC.adaptTopicMasterPayload === 'function') {
      phaseC.adaptTopicMasterPayload(safe, {
        gradeId: gid,
        grade: gradeLabel || gid,
        gradeLabel: gradeLabel || gid,
        topic: topicStr,
      });
    }
  } catch (adaptErr) {
    console.warn('[cached_results] topic_master adapt before save failed:', adaptErr.message || adaptErr);
  }
  safe._topicMaster = {
    version: 1,
    generatedAt: new Date().toISOString(),
    gradeId: gid,
    topic: topicStr,
    topicNormalized: normalizeTopicQuery(topicStr) || topicStr,
  };
  const body = buildTopicMasterCacheBody(gid, gradeLabel, topicStr);
  if (ownerBody && typeof ownerBody === 'object') {
    if (ownerBody.teacherUser) body.teacherUser = ownerBody.teacherUser;
    if (ownerBody.userId) body.userId = ownerBody.userId;
    if (ownerBody.userEmail) body.userEmail = String(ownerBody.userEmail).trim().toLowerCase();
  }
  return setCachedResult(body, safe);
}

function generalSearchCacheVariantMatches(data, periodBlock) {
  if (!data || typeof data !== 'object') return false;
  return Boolean(data.periodBlock) === Boolean(periodBlock);
}

async function getGeneralSearchCache(query, options) {
  const q = normalizeGeneralSearchQuery(query);
  if (!q) return null;
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.skipCache) return null;
  const periodBlock = Boolean(opts.periodBlock);

  const body = buildGeneralSearchCacheBody(q, { periodBlock: periodBlock });
  const cached = await getCachedResult(body, { requireEnhanced: false });
  if (cached && cached.data && isGeneralSearchPayload(cached.data) &&
      generalSearchCacheVariantMatches(cached.data, periodBlock)) {
    return cached;
  }

  if (!isSupabaseCacheEnabled()) return null;

  try {
    const exactQuery = encodeURIComponent(q);
    const res = await supabaseRequest(
      '/rest/v1/' + TABLE_NAME + '?phase=eq.' + GENERAL_SEARCH_PHASE +
      '&query_text=eq.' + exactQuery + '&select=cache_key,result_data,hit_count&limit=1',
      { method: 'GET' }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length || !rows[0].result_data) return null;
    const data = coerceCachedResultData(rows[0].result_data);
    if (!isGeneralSearchPayload(data)) return null;
    if (!generalSearchCacheVariantMatches(data, periodBlock)) return null;
    bumpHitCountAsync(rows[0].cache_key, rows[0].hit_count);
    return {
      data: cloneJsonSafe(data),
      meta: {
        fromCache: true,
        cacheKey: rows[0].cache_key,
        table: TABLE_NAME,
        source: 'general_search_exact',
      },
    };
  } catch (lookupErr) {
    console.warn('[cached_results] general_search exact lookup failed:', lookupErr.message || lookupErr);
    return null;
  }
}

async function setGeneralSearchCache(query, payload, options) {
  const q = normalizeGeneralSearchQuery(query);
  if (!q || !payload) return null;
  const opts = options && typeof options === 'object' ? options : {};
  const periodBlock = Boolean(opts.periodBlock || (payload && payload.periodBlock));
  const safe = ensureJsonObjectForStorage(Object.assign({}, payload, {
    query: q,
    periodBlock: periodBlock,
    cachedAt: new Date().toISOString(),
    _generalSearchArchive: {
      version: 1,
      generatedAt: new Date().toISOString(),
      query: q,
      periodBlock: periodBlock,
    },
  }));
  if (!safe || !isGeneralSearchPayload(safe)) return null;
  const body = buildGeneralSearchCacheBody(q, {
    periodBlock: periodBlock,
    userEmail: opts.userEmail,
    userId: opts.userId,
    teacherUser: opts.teacherUser,
  });
  const cacheKey = await setCachedResult(body, safe);
  if (cacheKey) {
    console.log(
      '[cached_results] SAVED general_search',
      cacheKey.slice(0, 12),
      periodBlock ? '(15-day block)' : '(standard)',
      isSupabaseCacheEnabled() ? '(supabase)' : '(fallback)'
    );
  }
  return cacheKey;
}

/** Extra filler stripped for general-search concept matching only. */
const GENERAL_SEARCH_FILLER_WORDS = new Set([
  'תקופת', 'תקופה', 'לימוד', 'בניית', 'בנייה', 'מלאה', 'מלא', 'ימים', 'יום',
  'תוכנית', 'מחקר', 'כללי', 'ספציפי', 'ספציפית', 'עבור', 'בעניין', 'בקשה', 'בקש',
]);

function stripGeneralSearchFillers(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(function (word) {
      if (!word) return false;
      if (GENERAL_SEARCH_FILLER_WORDS.has(word)) return false;
      if (isHebrewTopicStopWord(word)) return false;
      return true;
    })
    .join(' ')
    .trim();
}

/** Extract a normalized grade token (e.g. "כיתה ז" → "g:ז") so the period plan stays grade-specific. */
function extractGeneralSearchGradeToken(query) {
  const text = stableNormalize(query).replace(/[״"'`׳]/g, '');
  let m = text.match(/(?:^|\s)(?:ו|ב|ל|ש)?(?:כיתה|שכבה|שכבת|תקופה|תקופת)\s+([א-ת])(?:\s|$)/);
  if (m && m[1]) return 'g:' + m[1];
  m = text.match(/(?:^|\s)גיל\s+(\d{1,2})/);
  if (m && m[1]) return 'gn:' + m[1];
  return '';
}

function generalSearchCoreTokens(query) {
  let normalized = normalizeTopicQuery(query);
  normalized = stripGeneralSearchFillers(normalized);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean).sort();
}

/**
 * True when both queries share the same grade (or one omits grade) and the shorter
 * core concept is fully contained in the longer (e.g. "רנסנס" ⊆ "רנסנס תקופת לימוד בכיתה ז").
 */
function generalSearchCoreSupersetMatch(queryA, queryB) {
  const gradeA = extractGeneralSearchGradeToken(queryA);
  const gradeB = extractGeneralSearchGradeToken(queryB);
  if (gradeA && gradeB && gradeA !== gradeB) return false;
  const tokensA = generalSearchCoreTokens(queryA);
  const tokensB = generalSearchCoreTokens(queryB);
  if (!tokensA.length || !tokensB.length) return false;
  const shorter = tokensA.length <= tokensB.length ? tokensA : tokensB;
  const longer = tokensA.length <= tokensB.length ? tokensB : tokensA;
  return shorter.every(function (tok) {
    return longer.indexOf(tok) >= 0;
  });
}

/**
 * Deterministic concept key for general search — sorts the core keywords (so pure
 * word-order variants collapse) while preserving the grade so different grades never merge.
 */
function normalizeGeneralSearchConceptKey(query) {
  const tokens = generalSearchCoreTokens(query);
  if (!tokens.length) return '';
  const core = tokens.join(' ');
  const grade = extractGeneralSearchGradeToken(query);
  return (grade ? grade + '|' : '') + core;
}

/** Load archived general_search rows (Supabase + fallback) for the requested variant. */
async function fetchGeneralSearchCandidates(periodBlock, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const wantPeriod = Boolean(periodBlock);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 60, 1), 120);
  const byKey = new Map();

  if (isSupabaseCacheEnabled()) {
    try {
      const res = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME + '?phase=eq.' + GENERAL_SEARCH_PHASE +
        '&select=cache_key,query_text,topic,result_data,hit_count,last_hit_at,created_at' +
        '&order=last_hit_at.desc.nullslast,created_at.desc&limit=' + limit,
        { method: 'GET' }
      );
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows)) {
          rows.forEach(function (row) {
            if (row && row.cache_key) byKey.set(row.cache_key, row);
          });
        }
      }
    } catch (err) {
      console.warn('[cached_results] general_search candidate fetch failed:', err.message || err);
    }
  }

  loadFallbackStore();
  fallbackStore.rows.forEach(function (row) {
    if (row && row.phase === GENERAL_SEARCH_PHASE && row.cache_key && !byKey.has(row.cache_key)) {
      byKey.set(row.cache_key, row);
    }
  });

  const candidates = [];
  byKey.forEach(function (row) {
    const data = coerceCachedResultData(row.result_data);
    if (!data || !isGeneralSearchPayload(data)) return;
    const queryText = String(row.query_text || row.topic || data.query || '').trim();
    if (!queryText) return;
    const rowPeriod = Boolean(data.periodBlock);
    candidates.push({
      key: row.cache_key,
      query: queryText,
      data: data,
      periodBlock: rowPeriod,
      variantMatch: rowPeriod === wantPeriod,
    });
  });

  // Prefer same variant (standard vs 15-day) but keep all rows for semantic matching.
  candidates.sort(function (a, b) {
    if (a.variantMatch !== b.variantMatch) return a.variantMatch ? -1 : 1;
    return 0;
  });
  return candidates;
}

/**
 * Flexible (Gemini-backed) lookup for an archived general search that means the SAME
 * concept as `query` — even when word order differs or the grade is written differently.
 * Returns { matchType: 'exact'|'partial', cacheKey, suggestedQuery, similarity, data? } or null.
 */
async function findGeneralSearchArchiveSuggestion(query, options) {
  const q = normalizeGeneralSearchQuery(query);
  if (!q) return null;
  const opts = options && typeof options === 'object' ? options : {};
  const periodBlock = Boolean(opts.periodBlock);

  const candidates = await fetchGeneralSearchCandidates(periodBlock, opts);
  if (!candidates.length) return null;

  // Cheap deterministic pass: word-order / grade-word reorders / core-concept superset.
  const conceptKey = normalizeGeneralSearchConceptKey(q);
  if (conceptKey) {
    const deterministic = candidates.find(function (c) {
      if (stableNormalize(c.query) === stableNormalize(q)) return false;
      if (normalizeGeneralSearchConceptKey(c.query) === conceptKey) return true;
      return generalSearchCoreSupersetMatch(q, c.query);
    });
    if (deterministic) {
      return {
        matchType: 'exact',
        cacheKey: deterministic.key,
        suggestedQuery: deterministic.query,
        similarity: 1,
        periodBlock: periodBlock,
        data: cloneJsonSafe(deterministic.data),
      };
    }
  }

  let verdict;
  try {
    verdict = await generalSearchClassifier.classifyGeneralSearchArchiveMatch(
      q,
      candidates.map(function (c) { return { key: c.key, query: c.query }; })
    );
  } catch (classifyErr) {
    console.warn('[cached_results] general_search classifier failed:', classifyErr.message || classifyErr);
    return null;
  }
  if (!verdict || !verdict.key) return null;

  const matched = candidates.find(function (c) { return c.key === verdict.key; });
  if (!matched) return null;
  // An identical normalized query would already be an exact cache hit upstream.
  if (stableNormalize(matched.query) === stableNormalize(q) && verdict.verdict !== 'partial') return null;

  return {
    matchType: verdict.verdict === 'exact' ? 'exact' : 'partial',
    cacheKey: matched.key,
    suggestedQuery: matched.query,
    similarity: verdict.confidence,
    reason: verdict.reason || '',
    periodBlock: periodBlock,
    data: cloneJsonSafe(matched.data),
  };
}

/** Load an archived general search payload directly by cache_key (the "כן, התכוונתי" path). */
async function getGeneralSearchByCacheKey(cacheKey, options) {
  const key = String(cacheKey || '').trim();
  if (!key) return null;
  const opts = options && typeof options === 'object' ? options : {};
  const row = await fetchCachedRowByKey(key);
  if (!row || !row.result_data) return null;
  if (row.phase && row.phase !== GENERAL_SEARCH_PHASE) return null;
  const data = coerceCachedResultData(row.result_data);
  if (!data || !isGeneralSearchPayload(data)) return null;
  bumpHitCountAsync(key, row.hit_count);
  return {
    data: cloneJsonSafe(data),
    meta: {
      fromCache: true,
      cacheKey: key,
      table: TABLE_NAME,
      source: 'general_search_confirmed',
    },
  };
}

async function getCachedResult(body, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requireEnhanced = opts.requireEnhanced !== false
    && body
    && (body.phase === 'topic' || body.phase === 'grade');

  if (opts.skipCache || (body && body.skipCache)) {
    return null;
  }

  if (body && body.phase === 'grade') {
    normalizeGradeCacheRequest(body);
  }

  const cacheKey = buildCacheKey(body);
  if (!cacheKey) return null;

  if (body && body.phase === 'chat_followup') {
    return null;
  }

  const row = await resolveCachedRow(cacheKey);
  let data = row ? await readAndValidateCachedResultData(row, cacheKey) : null;

  if (!data) {
    const fallbackRaw = getFallbackCached(cacheKey);
    data = fallbackRaw ? coerceCachedResultData(fallbackRaw) : null;
    if (!data || !isValidCachedPayload(body.phase, data)) return null;
    if (requireEnhanced && !isEnhancedCachedPayload(body.phase, data)) return null;
    const payload = body.phase === 'grade'
      ? normalizeGradeResultForCache(data)
      : cloneJsonSafe(data);
    if (!payload) return null;
    return {
      data: payload,
      meta: {
        fromCache: true,
        cacheKey: cacheKey,
        table: TABLE_NAME,
        source: 'fallback',
        enhanced: isEnhancedCachedPayload(body.phase, payload),
      },
    };
  }

  if (!isValidCachedPayload(body.phase, data)) return null;
  if (requireEnhanced && !isEnhancedCachedPayload(body.phase, data)) return null;

  bumpHitCountAsync(cacheKey, row.hit_count);
  let payload = body.phase === 'grade'
    ? normalizeGradeResultForCache(data)
    : cloneJsonSafe(data);
  if (body.phase === 'topic' && payload) {
    payload = coerceArchiveLessonResultData(payload) || payload;
  }
  if (payload && body.phase === 'topic') {
    payload = applyArchiveLinkCleanupPolicy(payload, body.phase);
  }
  if (!payload) return null;
  return {
    data: payload,
    meta: {
      fromCache: true,
      cacheKey: cacheKey,
      table: TABLE_NAME,
      source: isSupabaseCacheEnabled() ? 'supabase' : 'fallback',
      enhanced: isEnhancedCachedPayload(body.phase, payload),
    },
  };
}

/** Load raw Perplexity web-search payload from cached_results (phase perplexity_raw). */
async function getRawPerplexityCache(body) {
  const rawBody = buildRawPerplexityCacheBody(body);
  if (!rawBody) return null;
  const cached = await getCachedResult(rawBody, { requireEnhanced: false });
  if (!cached || !cached.data) return null;
  return cached.data;
}

/** Persist raw Perplexity web-search payload for future hybrid enrichment runs. */
async function setRawPerplexityCache(body, rawPayload) {
  const rawBody = buildRawPerplexityCacheBody(body);
  if (!rawBody || !rawPayload) return null;
  const safe = ensureJsonObjectForStorage(Object.assign({}, rawPayload, {
    searchedAt: rawPayload.searchedAt || new Date().toISOString(),
    topic: rawPayload.topic || body.topic || null,
    gradeId: rawPayload.gradeId || body.currentGrade || body.gradeId || null,
  }));
  return setCachedResult(rawBody, safe);
}

/**
 * Persist a fresh Perplexity result (awaitable).
 */
async function setCachedResult(body, resultData) {
  if (body && body.phase === 'grade') {
    normalizeGradeCacheRequest(body);
    resultData = normalizeGradeResultForCache(resultData);
    if (!resultData) return null;
  }

  const cacheKey = buildCacheKey(body);
  if (!cacheKey || !resultData) return null;

  const safeResultData = ensureJsonObjectForStorage(resultData);
  if (!safeResultData) {
    console.warn('[cached_results] skip save — result_data is not a JSON object', cacheKey.slice(0, 12));
    return null;
  }

  const row = buildRow(cacheKey, body, safeResultData);
  const rowBodyJson = safeJsonStringify(row);
  const existing = await fetchCachedRowByKey(cacheKey);
  if (existing && existing.hit_count != null) {
    row.hit_count = Number(existing.hit_count) || 0;
  }

  if (isSupabaseCacheEnabled()) {
    try {
      const upsertPath = '/rest/v1/' + TABLE_NAME + '?on_conflict=cache_key';
      const res = await supabaseRequest(upsertPath, {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: rowBodyJson,
      });

      if (res.ok) {
        return cacheKey;
      }

      const errText = await res.text();
      console.warn('[cached_results] Supabase upsert error', res.status, errText.slice(0, 300));

      // Fallback: update existing row by cache_key
      const patchRes = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME + '?cache_key=eq.' + encodeURIComponent(cacheKey),
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: safeJsonStringify({
            phase: row.phase,
            grade_id: row.grade_id,
            grade_label: row.grade_label,
            topic: row.topic,
            query_text: row.query_text,
            result_data: row.result_data,
            user_id: row.user_id,
            user_email: row.user_email,
          }),
        }
      );
      if (patchRes.ok) {
        console.log('[cached_results] PATCH ok for', cacheKey.slice(0, 12));
        return cacheKey;
      }
      const patchErr = await patchRes.text();
      console.warn('[cached_results] Supabase PATCH error', patchRes.status, patchErr.slice(0, 200));
    } catch (err) {
      console.warn('[cached_results] Supabase write failed:', err.message || err);
    }
  }

  setFallbackCached(cacheKey, body, safeResultData);
  return cacheKey;
}

/** Fire-and-forget cache write — does not block the HTTP response. */
function saveCachedResultAsync(body, resultData) {
  setCachedResult(body, resultData).catch(function (err) {
    console.warn('[cached_results] async save failed:', err.message || err);
  });
}

/** Dedupe key: same grade + normalized topic; falls back to cache_key when topic is empty. */
function searchHistoryDedupeKey(item) {
  if (!item) return '';
  const gradeId = stableNormalize(item.gradeId || '');
  const topicNorm = normalizeTopicQuery(item.topic || '');
  if (topicNorm) return gradeId + '|' + topicNorm;
  const cacheKey = String(item.cacheKey || '').trim();
  if (cacheKey) return 'key|' + cacheKey;
  return gradeId + '|' + stableNormalize(item.topic || '');
}

/**
 * Keep one row per dedupe key (newest createdAt wins). Topic text comes from that row.
 */
function dedupeSearchHistoryItems(items, limit) {
  const max = Math.max(Number(limit) || 20, 1);
  const seen = new Set();
  const out = [];
  const sorted = (items || []).slice().sort(function (a, b) {
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
  for (let i = 0; i < sorted.length && out.length < max; i++) {
    const item = sorted[i];
    if (!item) continue;
    const key = searchHistoryDedupeKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function searchHistoryFetchLimit(displayLimit) {
  const limit = Math.max(Number(displayLimit) || 20, 1);
  return Math.min(Math.max(limit * 5, 80), 200);
}

function listFallbackTeacherHistory(teacher, limit) {
  loadFallbackStore();
  const userId = String(teacher && teacher.id || '').trim();
  const userEmail = String(teacher && teacher.email || '').trim().toLowerCase();
  const fetchLimit = searchHistoryFetchLimit(limit);
  const rows = Array.from(fallbackStore.rows.values())
    .filter(function (row) {
      if (!row || !row.result_data) return false;
      if (row.phase !== 'topic' && row.phase !== TOPIC_MASTER_PHASE) return false;
      if (userId && row.user_id === userId) return true;
      if (userEmail && String(row.user_email || '').toLowerCase() === userEmail) return true;
      return false;
    })
    .sort(function (a, b) {
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    })
    .slice(0, fetchLimit);

  return dedupeSearchHistoryItems(
    rows
      .filter(function (row) { return row && isSearchHistoryResultData(row.result_data); })
      .map(formatHistoryItem)
      .filter(function (item) { return item && item.hasLessonPlan; }),
    limit || 20
  );
}

function teacherOwnsRow(teacher, row) {
  if (!teacher || !row) return false;
  const userId = String(teacher.id || '').trim();
  const userEmail = String(teacher.email || '').trim().toLowerCase();
  if (userId && row.user_id === userId) return true;
  if (userEmail && String(row.user_email || '').trim().toLowerCase() === userEmail) return true;
  return false;
}

function isTopicMasterHistoryData(data) {
  if (!data || typeof data !== 'object') return false;
  const d = coerceCachedResultData(data) || data;
  if (isTopicMasterPayload(d)) return true;
  if (d._topicMaster && typeof d._topicMaster === 'object') return true;
  if (d.purePhaseC && typeof d.purePhaseC === 'object') return true;
  const theory = d.theory;
  if (!theory || typeof theory !== 'object') return false;
  if (Array.isArray(theory.sections) && theory.sections.length) return true;
  return Boolean(
    String(d.core_emphases || '').trim().length > 20
    || (Array.isArray(d.key_points) && d.key_points.length > 0)
  );
}

function hasMeaningfulLessonBlockPlan(coerced) {
  if (!coerced || !coerced.blockPlan || typeof coerced.blockPlan !== 'object') return false;
  const bp = coerced.blockPlan;
  if (String(bp.rawContent || '').trim()) return true;
  const theory = bp.theory;
  if (theory && Array.isArray(theory.sections) && theory.sections.length) return true;
  if (Array.isArray(bp.curriculum) && bp.curriculum.length) return true;
  const wr = coerced.webResearch;
  if (wr && String(wr.summary || wr.overview || '').trim()) return true;
  return false;
}

function isSearchHistoryResultData(data) {
  if (!data || typeof data !== 'object') return false;
  if (isTopicMasterHistoryData(data)) return true;
  const coerced = coerceArchiveLessonResultData(data) || coerceCachedResultData(data) || data;
  if (isTopicMasterHistoryData(coerced)) return true;
  return hasMeaningfulLessonBlockPlan(coerced);
}

function buildTeacherHistoryCacheKey(teacher, sourceCacheKey) {
  const userId = authContext.mapUserIdForSupabaseQuery(teacher && teacher.id, teacher && teacher.email) || '';
  const userEmail = String(teacher && teacher.email || '').trim().toLowerCase();
  const owner = userId || userEmail;
  const sourceKey = String(sourceCacheKey || '').trim();
  if (!owner || !sourceKey) return null;
  return hashString('teacher_history|' + owner + '|' + sourceKey);
}

async function touchTeacherHistoryTimestamps(cacheKey) {
  const key = String(cacheKey || '').trim();
  if (!key) return;
  const now = new Date().toISOString();
  if (isSupabaseCacheEnabled()) {
    try {
      await supabaseRequest(
        '/rest/v1/' + TABLE_NAME + '?cache_key=eq.' + encodeURIComponent(key),
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ created_at: now, last_hit_at: now }),
        }
      );
    } catch (err) {
      console.warn('[cached_results] touchTeacherHistory failed:', err.message || err);
    }
    return;
  }
  loadFallbackStore();
  const row = fallbackStore.rows.get(key);
  if (!row) return;
  row.created_at = now;
  row.last_hit_at = now;
  fallbackStore.rows.set(key, row);
  persistFallbackStore();
}

/**
 * Link a community/archive cache row to the signed-in teacher's search history.
 * Creates a teacher-owned cached_results row (distinct cache_key) without mutating the source archive.
 */
async function linkArchiveToTeacherHistory(teacher, sourceCacheKey, options) {
  const sourceKey = String(sourceCacheKey || '').trim();
  if (!sourceKey || !teacher) return null;

  const userEmail = String(teacher.email || '').trim().toLowerCase();
  const userId = authContext.mapUserIdForSupabaseQuery(teacher.id, teacher.email) || '';
  if (!userId && !userEmail) return null;

  const opts = options && typeof options === 'object' ? options : {};
  const sourceRow = await fetchCachedRowByKey(sourceKey);

  if (sourceRow && teacherOwnsRow(teacher, sourceRow)) {
    await touchTeacherHistoryTimestamps(sourceKey);
    return { cacheKey: sourceKey, linked: false, touched: true, sourceCacheKey: sourceKey };
  }

  const historyKey = buildTeacherHistoryCacheKey(teacher, sourceKey);
  if (!historyKey) return null;

  const existingHistory = await fetchCachedRowByKey(historyKey);
  if (existingHistory && teacherOwnsRow(teacher, existingHistory)) {
    await touchTeacherHistoryTimestamps(historyKey);
    return { cacheKey: historyKey, linked: false, touched: true, sourceCacheKey: sourceKey };
  }

  let resultData = opts.resultData ? cloneJsonSafe(opts.resultData) : null;
  if (!resultData && sourceRow) {
    resultData = await readAndValidateCachedResultData(sourceRow, sourceKey);
  }
  if (resultData) {
    resultData = coerceArchiveLessonResultData(resultData) || coerceCachedResultData(resultData) || resultData;
  }
  if (!isSearchHistoryResultData(resultData)) {
    const rawSource = sourceRow && sourceRow.result_data
      ? (coerceCachedResultData(sourceRow.result_data) || sourceRow.result_data)
      : null;
    if (rawSource && isTopicMasterHistoryData(rawSource)) {
      resultData = rawSource;
    } else {
      console.warn('[cached_results] linkArchive skip — no displayable lesson data', sourceKey.slice(0, 12));
      return null;
    }
  }

  const payload = Object.assign({}, cloneJsonSafe(resultData) || resultData, {
    _teacherHistoryLink: {
      sourceCacheKey: sourceKey,
      linkedAt: new Date().toISOString(),
    },
  });
  const safeResultData = ensureJsonObjectForStorage(payload);
  if (!safeResultData) return null;

  const body = {
    phase: (sourceRow && sourceRow.phase === TOPIC_MASTER_PHASE) ? TOPIC_MASTER_PHASE : 'topic',
    currentGrade: opts.gradeId || (sourceRow && sourceRow.grade_id) || null,
    gradeId: opts.gradeId || (sourceRow && sourceRow.grade_id) || null,
    gradeLabel: opts.gradeLabel || (sourceRow && sourceRow.grade_label) || null,
    topic: String(
      opts.topic || opts.requestedTopic || (sourceRow && (sourceRow.topic || sourceRow.query_text)) || ''
    ).trim() || null,
    userEmail: userEmail || null,
    teacherUser: { id: userId, email: userEmail },
    userId: userId,
  };

  const row = buildRow(historyKey, body, safeResultData);
  row.created_at = new Date().toISOString();
  row.last_hit_at = row.created_at;
  const queryText = String(opts.queryText || opts.requestedTopic || body.topic || '').trim();
  if (queryText) row.query_text = queryText;

  if (isSupabaseCacheEnabled()) {
    try {
      const upsertPath = '/rest/v1/' + TABLE_NAME + '?on_conflict=cache_key';
      const res = await supabaseRequest(upsertPath, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: safeJsonStringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.warn('[cached_results] linkArchive upsert error', res.status, errText.slice(0, 200));
      }
    } catch (err) {
      console.warn('[cached_results] linkArchive failed:', err.message || err);
      return null;
    }
  } else {
    setFallbackCached(historyKey, body, safeResultData);
  }

  console.log(
    '[cached_results] linked archive to teacher history',
    historyKey.slice(0, 12),
    '←',
    sourceKey.slice(0, 12)
  );
  return { cacheKey: historyKey, linked: true, sourceCacheKey: sourceKey };
}

function formatHistoryItem(row, options) {
  const opts = options || {};
  const rawData = coerceCachedResultData(row.result_data) || row.result_data || {};
  const data = coerceArchiveLessonResultData(rawData) || rawData;
  const hasPlan = isSearchHistoryResultData(data);
  const includeResult = opts.includeResultData !== false;
  return {
    cacheKey: row.cache_key,
    phase: row.phase,
    gradeId: row.grade_id || null,
    gradeLabel: row.grade_label || null,
    topic: archiveTopicDisplayName(row, data) || row.query_text || '',
    createdAt: row.created_at || null,
    lastHitAt: row.last_hit_at || null,
    hitCount: row.hit_count || 0,
    hasLessonPlan: hasPlan,
    resultData: includeResult && hasPlan ? data : null,
  };
}

/**
 * List cached topic lesson plans for a teacher (newest first).
 */
async function queryTeacherHistoryRows(filterParams, fetchLimit) {
  const params = new URLSearchParams();
  params.set(
    'select',
    'cache_key,phase,grade_id,grade_label,topic,query_text,result_data,hit_count,created_at,last_hit_at,user_id,user_email'
  );
  params.set('phase', 'in.(topic,topic_master)');
  params.set('order', 'created_at.desc');
  params.set('limit', String(fetchLimit));
  Object.keys(filterParams || {}).forEach(function (key) {
    params.set(key, filterParams[key]);
  });

  const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
    method: 'GET',
  });
  if (!res.ok) {
    const errText = await res.text();
    console.warn(
      '[search-history][debug] supabase query failed',
      res.status,
      filterParams,
      errText.slice(0, 240)
    );
    return [];
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function listTeacherSearchHistory(teacher, options) {
  const limit = (options && options.limit) || 20;
  const fetchLimit = searchHistoryFetchLimit(limit);
  const userEmail = String(teacher && teacher.email || '').trim().toLowerCase();
  const userId = authContext.mapUserIdForSupabaseQuery(teacher && teacher.id, teacher && teacher.email) || '';

  if (!userId && !userEmail) {
    console.warn('[search-history][debug] missing teacher identity — empty history');
    return [];
  }

  if (isSupabaseCacheEnabled()) {
    try {
      const seenKeys = new Set();
      const allRows = [];

      function mergeRows(rows) {
        (rows || []).forEach(function (row) {
          if (!row || !row.cache_key || seenKeys.has(row.cache_key)) return;
          seenKeys.add(row.cache_key);
          allRows.push(row);
        });
      }

      if (userId) {
        mergeRows(await queryTeacherHistoryRows({
          user_id: 'eq.' + postgrestFilterValue(userId),
        }, fetchLimit));
      }
      if (userEmail) {
        mergeRows(await queryTeacherHistoryRows({
          user_email: 'ilike.' + postgrestFilterValue(userEmail),
        }, fetchLimit));
      }

      console.log('[search-history][debug] supabase raw rows', {
        userId: userId || null,
        userEmail: userEmail || null,
        rawCount: allRows.length,
        phases: allRows.slice(0, 8).map(function (row) {
          return {
            phase: row.phase,
            cacheKey: row.cache_key ? row.cache_key.slice(0, 12) : null,
            userId: row.user_id || null,
            userEmail: row.user_email || null,
          };
        }),
      });

      const items = allRows
        .filter(function (row) { return row && row.result_data && isSearchHistoryResultData(row.result_data); })
        .map(formatHistoryItem);

      console.log('[search-history][debug] after lesson filter', {
        userId: userId || null,
        userEmail: userEmail || null,
        itemCount: items.length,
      });

      return dedupeSearchHistoryItems(items, limit);
    } catch (err) {
      console.warn('[cached_results] history read failed:', err.message || err);
    }
  } else {
    console.warn('[search-history][debug] supabase cache disabled — using local fallback only');
  }

  return listFallbackTeacherHistory(teacher, limit);
}

function formatChatHistoryItem(row) {
  const data = coerceCachedResultData(row && row.result_data);
  const answer = extractChatAnswerText(data);
  if (!answer && !(data && (data.chatReply || data.reply))) return null;
  return {
    cacheKey: row.cache_key,
    phase: row.phase,
    gradeId: row.grade_id || null,
    gradeLabel: row.grade_label || null,
    topic: row.topic || null,
    question: row.query_text || '',
    createdAt: row.created_at || null,
    lastHitAt: row.last_hit_at || null,
    hitCount: row.hit_count || 0,
    answerPreview: answer.slice(0, 280),
    answerHtml: data && data.chatReply ? (data.chatReply.answerHtml || null) : null,
  };
}

function listFallbackTeacherChatHistory(teacher, limit, filters) {
  loadFallbackStore();
  const userId = String(teacher && teacher.id || '').trim();
  const userEmail = String(teacher && teacher.email || '').trim().toLowerCase();
  const gradeId = filters && filters.gradeId ? String(filters.gradeId) : '';
  const topic = filters && filters.topic ? stableNormalize(filters.topic) : '';

  const rows = Array.from(fallbackStore.rows.values())
    .filter(function (row) {
      if (!row || row.phase !== 'chat_followup' || !row.result_data) return false;
      if (!teacherOwnsRow(teacher, row)) return false;
      if (gradeId && String(row.grade_id || '') !== gradeId) return false;
      if (topic && stableNormalize(row.topic || '') !== topic) return false;
      return Boolean(formatChatHistoryItem(row));
    })
    .sort(function (a, b) {
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    })
    .slice(0, limit || 30);

  return rows.map(formatChatHistoryItem).filter(Boolean);
}

/**
 * List cached chat_followup Q&A for a teacher (newest first).
 */
async function listTeacherChatHistory(teacher, options) {
  const opts = options || {};
  const limit = Math.min(Number(opts.limit) || 30, 50);
  const userEmail = String(teacher && teacher.email || '').trim().toLowerCase();
  const userId = authContext.mapUserIdForSupabaseQuery(teacher && teacher.id, teacher && teacher.email) || '';
  const gradeId = opts.gradeId ? String(opts.gradeId) : '';
  const topic = opts.topic ? String(opts.topic).trim() : '';

  if (!userId && !userEmail) return [];

  if (isSupabaseCacheEnabled()) {
    try {
      const params = new URLSearchParams();
      params.set('select', 'cache_key,phase,grade_id,grade_label,topic,query_text,result_data,hit_count,created_at,last_hit_at');
      params.set('phase', 'eq.chat_followup');
      params.set('order', 'created_at.desc');
      params.set('limit', String(limit));

      if (userId && userEmail) {
        params.set(
          'or',
          '(user_id.eq.' + postgrestFilterValue(userId) + ',user_email.eq.' + postgrestFilterValue(userEmail) + ')'
        );
      } else if (userId) {
        params.set('user_id', 'eq.' + postgrestFilterValue(userId));
      } else {
        params.set('user_email', 'eq.' + postgrestFilterValue(userEmail));
      }
      if (gradeId) params.set('grade_id', 'eq.' + gradeId);
      if (topic) params.set('topic', 'ilike.*' + topic.slice(0, 60) + '*');

      const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
        method: 'GET',
      });

      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows)) {
          return rows.map(formatChatHistoryItem).filter(Boolean);
        }
      } else {
        const errText = await res.text();
        console.warn('[cached_results] chat history read error', res.status, errText.slice(0, 200));
      }
    } catch (err) {
      console.warn('[cached_results] chat history read failed:', err.message || err);
    }
  }

  return listFallbackTeacherChatHistory(teacher, limit, { gradeId: gradeId, topic: topic });
}

/**
 * Load a community-archive lesson plan by cache key (any teacher).
 */
async function getCommunityLessonByCacheKey(cacheKey) {
  const row = await fetchCachedRowByKey(cacheKey);
  if (!row || (row.phase !== 'topic' && row.phase !== TOPIC_MASTER_PHASE)) return null;
  const coerced = await readAndValidateCachedResultData(row, cacheKey);
  if (!coerced) return null;
  const data = coerceArchiveLessonResultData(coerced) || coerceCachedResultData(coerced) || coerced;
  if (!isSearchHistoryResultData(data)) return null;
  const cleanupPhase = row.phase === TOPIC_MASTER_PHASE ? TOPIC_MASTER_PHASE : 'topic';
  const cleaned = applyArchiveLinkCleanupPolicy(data, cleanupPhase);
  bumpHitCountAsync(cacheKey, row.hit_count);
  return formatHistoryItem(Object.assign({}, row, { result_data: cleaned }));
}

/**
 * Load a single saved lesson plan by cache key (teacher-scoped).
 */
async function getTeacherLessonByCacheKey(teacher, cacheKey) {
  const row = await fetchCachedRowByKey(cacheKey);
  if (!row || (row.phase !== 'topic' && row.phase !== TOPIC_MASTER_PHASE)) return null;
  if (!teacherOwnsRow(teacher, row)) return null;
  const coerced = await readAndValidateCachedResultData(row, cacheKey);
  if (!coerced) return null;
  const data = coerceArchiveLessonResultData(coerced) || coerceCachedResultData(coerced) || coerced;
  if (!isSearchHistoryResultData(data)) return null;
  const cleanupPhase = row.phase === TOPIC_MASTER_PHASE ? TOPIC_MASTER_PHASE : 'topic';
  const cleaned = applyArchiveLinkCleanupPolicy(data, cleanupPhase);
  bumpHitCountAsync(cacheKey, row.hit_count);
  return formatHistoryItem(Object.assign({}, row, { result_data: cleaned }));
}

/**
 * Merge chat session fields into a topic cache row's result_data.
 */
async function saveTopicChatSession(teacher, cacheKey, session) {
  const row = await fetchCachedRowByKey(cacheKey);
  if (!row || row.phase !== 'topic') return false;
  if (!teacherOwnsRow(teacher, row)) return false;

  const baseData = await readAndValidateCachedResultData(row, cacheKey);
  if (!baseData) return false;
  const data = Object.assign({}, baseData);
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  data.chatHistory = messages.slice(-40).map(function (m) {
    return {
      role: m.role || 'user',
      text: m.text || m.content || '',
      html: m.html || null,
    };
  });
  if (session && session.ragContext) data.chatRagContext = String(session.ragContext).slice(0, 14000);
  if (session && Array.isArray(session.ragChunkIds)) {
    data.chatRagChunkIds = session.ragChunkIds.slice(0, 32).map(String);
  }
  // READ-ONLY: never overwrite structured lesson fields from chat/session snapshots.

  if (isSupabaseCacheEnabled()) {
    try {
      const res = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME + '?cache_key=eq.' + encodeURIComponent(cacheKey),
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: safeJsonStringify({ result_data: ensureJsonObjectForStorage(data) }),
        }
      );
      if (res.ok) return true;
      const errText = await res.text();
      console.warn('[cached_results] chat session save error', res.status, errText.slice(0, 200));
    } catch (err) {
      console.warn('[cached_results] chat session save failed:', err.message || err);
    }
  }

  loadFallbackStore();
  const stored = fallbackStore.rows.get(cacheKey);
  if (stored) {
    stored.result_data = data;
    fallbackStore.rows.set(cacheKey, stored);
    persistFallbackStore();
    return true;
  }
  return false;
}

const COMMUNITY_MATERIALS_TABLE = 'community_materials';
const COMMUNITY_KB_TABLE = 'community_knowledge_base';
const COMMUNITY_STORAGE_BUCKET = 'community-uploads';

function buildCommunitySearchQuery(options) {
  const parts = [];
  if (options && options.userMessage) parts.push(String(options.userMessage).trim());
  if (options && options.topic) parts.push(String(options.topic).trim());
  if (options && options.query) parts.push(String(options.query).trim());
  return parts.filter(Boolean).join(' ').trim();
}

function sanitizeCommunitySearchTerm(term) {
  return String(term || '')
    .replace(/[״"'`׳\-–—_,.;:!?؟()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCommunitySearchTerms(query) {
  const q = String(query || '').trim();
  if (!q) return [];

  const terms = new Set();
  const normalized = sanitizeCommunitySearchTerm(normalizeTopicQuery(q));
  if (normalized && normalized.length >= 2 && !looksLikeUserChatQuestion(normalized)) {
    terms.add(normalized);
  }

  hebrewTopicMatch.expandHebrewSearchTerms(q, 10).forEach(function (term) {
    const cleaned = sanitizeCommunitySearchTerm(term);
    if (cleaned && cleaned.length >= 2) terms.add(cleaned);
  });

  q.replace(/[״"'`׳\-–—_,.;:!?؟()[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(function (word) { return word.length >= 2; })
    .forEach(function (word) {
      const cleaned = sanitizeCommunitySearchTerm(word);
      if (!cleaned || cleaned.length < 2) return;
      terms.add(cleaned);
      if (cleaned.charAt(0) === 'ה' && cleaned.length > 2) terms.add(cleaned.slice(1));
    });

  catalogTopics.expandCatalogTopicAliases(Array.from(terms)).forEach(function (alias) {
    const cleaned = sanitizeCommunitySearchTerm(alias);
    if (cleaned && cleaned.length >= 2) terms.add(cleaned);
  });

  return Array.from(terms)
    .filter(function (term) { return term && term.length >= 2; })
    .sort(function (a, b) { return b.length - a.length; })
    .slice(0, 12);
}

function resolveCommunityFileUrlFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  const gdocs = String(row.google_docs_url || '').trim();
  if (/^https?:\/\//i.test(gdocs)) return gdocs;
  const filePath = String(row.file_path || '').trim();
  if (/^https?:\/\//i.test(filePath)) return filePath;
  if (!filePath) return '';
  const baseUrl = env.getSupabaseUrl();
  if (!baseUrl) return '';
  return baseUrl + '/storage/v1/object/public/' + COMMUNITY_STORAGE_BUCKET + '/' + encodeURIComponent(filePath);
}

function parseCommunityTitleFromNotes(rawNotes) {
  const notes = String(rawNotes || '');
  const titleMatch = notes.match(/\[title:([^\]]+)\]/);
  if (titleMatch) return titleMatch[1].trim();
  const descMatch = notes.match(/\[desc:([^\]]+)\]/);
  if (descMatch) return descMatch[1].trim();
  return '';
}

function resolveInheritedCatalogTopicFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  const notes = row.notes || row.description || '';
  const fromNotes = catalogTopics.parseCatalogTopicFromNotes(notes);
  if (fromNotes) return fromNotes;
  const rowTopic = String(row.topic || '').trim();
  if (rowTopic) return catalogTopics.resolveCatalogTopicFromFolderName(rowTopic);
  return '';
}

function parseTaggedCommunityNote(notes, tag) {
  const m = String(notes || '').match(new RegExp('\\[' + tag + ':([^\\]]+)\\]'));
  return m ? m[1].trim() : '';
}

function extractNestedCommunityPathLabels(row) {
  const parts = [];
  const filePath = String((row && row.file_path) || '').trim();
  if (filePath) {
    filePath.split('/').forEach(function (seg) {
      const cleaned = String(seg || '').trim();
      if (cleaned && cleaned !== 'community') parts.push(cleaned);
    });
  }
  const notes = (row && (row.notes || row.description)) || '';
  const drivePath = parseTaggedCommunityNote(notes, 'drivePath');
  if (drivePath) {
    drivePath.split('/').forEach(function (seg) {
      const cleaned = String(seg || '').trim();
      if (cleaned) parts.push(cleaned);
    });
  }
  const subfolder = parseTaggedCommunityNote(notes, 'subfolder');
  if (subfolder) parts.push(subfolder);
  const catalogTopic = parseTaggedCommunityNote(notes, 'catalogTopic');
  if (catalogTopic) parts.push(catalogTopic);
  return parts.filter(Boolean).join(' ');
}

function formatCommunityMaterialRow(row) {
  const notes = row.notes || row.description || '';
  const parsedTitle = parseCommunityTitleFromNotes(notes);
  const description = parseCommunityDescriptionFromNotes(notes);
  const rowTopic = String(row.topic || '').trim();
  const inheritedTopic = resolveInheritedCatalogTopicFromRow(row);
  const catalogTopic = inheritedTopic || rowTopic;
  const topic = catalogTopic || rowTopic;
  const filePath = String(row.file_path || '').trim();
  const pathLabels = extractNestedCommunityPathLabels(row);
  return {
    id: row.id || null,
    source: 'catalog',
    title: parsedTitle || row.file_name || topic || 'חומר קהילתי',
    topic: topic,
    subject: topic,
    catalogTopic: catalogTopic,
    bundleTopic: catalogTopic,
    subfolderTopic: catalogTopics.parseCatalogTopicFromNotes(notes) || '',
    description: description,
    gradeId: row.grade_level != null ? String(row.grade_level) : (row.grade != null ? String(row.grade) : null),
    fileName: row.file_name || '',
    filePath: filePath,
    pathLabels: pathLabels,
    drivePath: parseTaggedCommunityNote(notes, 'drivePath'),
    fileUrl: resolveCommunityFileUrlFromRow(row),
    similarity: 0,
  };
}

function parseCommunityRowMetadata(row) {
  if (!row || !row.metadata) return {};
  if (typeof row.metadata === 'object') return row.metadata;
  try {
    return JSON.parse(String(row.metadata));
  } catch (e) {
    return {};
  }
}

function formatCommunityKnowledgeRow(row) {
  const meta = parseCommunityRowMetadata(row);
  const bundleMaterial = row._bundle_material || null;
  const bundleTopic = String(
    meta.bundle_topic || bundleMaterial && bundleMaterial.topic || row.topic || ''
  ).trim();
  const inheritedFromMaterial = bundleMaterial ? resolveInheritedCatalogTopicFromRow(bundleMaterial) : '';
  const internalFileName = String(
    meta.internal_file_name || row.file_name || row.title || ''
  ).trim();
  const rowTopic = String(row.topic || '').trim();
  const catalogTopic = String(
    inheritedFromMaterial ||
    (bundleMaterial && bundleMaterial.topic) ||
    (bundleTopic && !looksLikeUserChatQuestion(bundleTopic) ? bundleTopic : '') ||
    (rowTopic && !looksLikeUserChatQuestion(rowTopic) ? rowTopic : '')
  ).trim();
  const resolvedTopic = catalogTopic || rowTopic || bundleTopic;

  return {
    id: row.id || null,
    sourceMaterialId: row.source_material_id || null,
    source: 'knowledge_base',
    title: row.title || bundleTopic || 'חומר קהילתי',
    topic: resolvedTopic,
    subject: resolvedTopic,
    catalogTopic: catalogTopic,
    description: String(row.content || '').slice(0, 300),
    bundleTopic: bundleTopic,
    internalFileName: internalFileName,
    gradeId: row.grade_id != null ? String(row.grade_id) : null,
    fileName: row.file_name || internalFileName || '',
    fileUrl: resolveCommunityFileUrlFromRow(row),
    contributorName: row.contributor_name || null,
    contentPreview: String(row.content || '').slice(0, 240),
    pathLabels: bundleMaterial ? extractNestedCommunityPathLabels(bundleMaterial) : '',
    drivePath: bundleMaterial
      ? parseTaggedCommunityNote(bundleMaterial.notes || bundleMaterial.description || '', 'drivePath')
      : '',
    similarity: 0,
    matchedInBundle: false,
    matchType: 'direct',
    alertText: '',
  };
}

function scoreCommunityKnowledgeHit(query, row) {
  const hit = formatCommunityKnowledgeRow(row);
  let best = 0;

  [
    hit.title,
    hit.topic,
    hit.subject,
    hit.description,
    hit.bundleTopic,
    hit.contentPreview,
  ].filter(Boolean).forEach(function (candidate) {
    const score = scoreTopicSimilarity(query, candidate, '');
    if (score > best) best = score;
  });

  if (row.content) {
    best = Math.max(best, scoreTopicSimilarity(query, String(row.content).slice(0, 1200), ''));
  }

  const bundleTopicScore = scoreTopicSimilarity(query, hit.bundleTopic || hit.topic, '');
  const titleScore = Math.max(
    scoreTopicSimilarity(query, hit.title, ''),
    row.content ? scoreTopicSimilarity(query, String(row.content).slice(0, 1200), '') : 0
  );

  hit.similarity = best;

  if (titleScore >= 0.45 && bundleTopicScore < 0.45 && (hit.bundleTopic || hit.catalogTopic || hit.topic)) {
    const folderName = hit.catalogTopic || hit.bundleTopic || hit.topic;
    hit.matchedInBundle = true;
    hit.matchType = 'nested_in_bundle';
    hit.displayTitle = hit.title;
    hit.alertText = 'נמצא חומר רלוונטי בתוך התיקייה «' + folderName + '» במאגר הקהילתי!';
    hit.topic = folderName;
    hit.catalogTopic = folderName;
  }

  return hit;
}

function scoreCommunityHitSimilarity(query, hit) {
  const candidates = [
    hit.title,
    hit.displayTitle,
    hit.topic,
    hit.subject,
    hit.description,
    hit.contentPreview,
    hit.fileName,
    hit.filePath,
    hit.pathLabels,
    hit.drivePath,
    hit.subfolderTopic,
    hit.catalogTopic,
    hit.bundleTopic,
  ].filter(Boolean);
  let best = 0;
  candidates.forEach(function (candidate) {
    const score = scoreTopicSimilarity(query, candidate, '');
    if (score > best) best = score;
  });
  return best;
}

async function recursiveDeepScanCommunityRows(gradeId) {
  const broad = await Promise.all([
    fetchCommunityMaterialRows(gradeId, '', false, { limit: 300 }),
    fetchCommunityKnowledgeRows(gradeId, '', false, { limit: 300 }),
  ]);
  return {
    materialRows: broad[0],
    kbRows: broad[1],
  };
}

function attachCommunityFolderBriefToResult(result, opts) {
  if (!result || !opts || opts.includeFolderBrief !== true) return result;
  const query = String(opts.userMessage || opts.query || result.query || '').trim();
  if (!query || !result.count) return result;
  try {
    const communityFolderBrief = require('./community-folder-brief');
    const brief = communityFolderBrief.tryBuildCommunityFolderBrief(
      {
        userMessage: query,
        phase: opts.phase || '',
        repositorySearch: opts.repositorySearch === true,
      },
      result
    );
    if (brief) {
      result.folderBrief = brief;
      result.matchMethod = result.matchMethod || 'folder_brief';
    }
  } catch (briefErr) {
    console.warn('[community] folder brief skipped:', briefErr.message || briefErr);
  }
  return result;
}

function dedupeCommunityHits(hits) {
  const seen = new Set();
  const out = [];
  (hits || []).forEach(function (hit) {
    if (!hit) return;
    const key = hit.matchedInBundle
      ? 'bundle:' + stableNormalize(hit.bundleTopic || hit.topic) + '|' + stableNormalize(hit.internalFileName || hit.title)
      : String(hit.sourceMaterialId || hit.id || '') + '|' + stableNormalize(hit.title) + '|' + stableNormalize(hit.topic);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(hit);
  });
  return out;
}

function buildCommunityHitHaystack(hit, row) {
  const aliasTerms = catalogTopics.expandCatalogTopicAliases([
    hit.catalogTopic,
    hit.bundleTopic,
    hit.topic,
    hit.subfolderTopic,
    hit.fileName,
    hit.pathLabels,
  ]);
  const pathBits = [];
  if (hit.filePath) pathBits.push(hit.filePath);
  if (hit.drivePath) pathBits.push(hit.drivePath);
  if (hit.pathLabels) pathBits.push(hit.pathLabels);
  if (hit.internalFileName) pathBits.push(hit.internalFileName);
  if (row && row.content) pathBits.push(String(row.content).slice(0, 4000));
  return [
    hit.displayTitle,
    hit.title,
    hit.topic,
    hit.subject,
    hit.catalogTopic,
    hit.bundleTopic,
    hit.subfolderTopic,
    hit.fileName,
    aliasTerms.join(' '),
    hit.description,
    hit.contentPreview,
    pathBits.join(' '),
  ].filter(Boolean).join(' ');
}

function keywordSubstringMatchCommunity(query, materialRows, kbRows, options) {
  const opts = options || {};
  const limit = opts.limit || 8;
  const terms = buildCommunitySearchTerms(query);
  if (!terms.length) return [];

  const hits = [];

  (materialRows || []).forEach(function (row) {
    const hit = formatCommunityMaterialRow(row);
    const haystack = stableNormalize([
      buildCommunityHitHaystack(hit, row),
      row.file_name,
      row.file_path,
      row.topic,
      row.notes,
    ].filter(Boolean).join(' '));
    if (!haystack) return;
    const matched = terms.some(function (term) {
      const normalizedTerm = stableNormalize(term);
      return normalizedTerm.length >= 2 && haystack.indexOf(normalizedTerm) >= 0;
    });
    if (matched) {
      hit.similarity = 0.88;
      const pathHit = terms.some(function (term) {
        const normalizedTerm = stableNormalize(term);
        return normalizedTerm.length >= 2
          && stableNormalize(hit.pathLabels || '').indexOf(normalizedTerm) >= 0;
      });
      hit.matchType = pathHit ? 'nested_path_match' : 'keyword_substring';
      if (pathHit && hit.catalogTopic) {
        hit.matchedInBundle = true;
        hit.alertText = 'נמצא חומר רלוונטי בתוך התיקייה «' + hit.catalogTopic + '» במאגר הקהילתי!';
      }
      hits.push(hit);
    }
  });

  (kbRows || []).forEach(function (row) {
    const hit = scoreCommunityKnowledgeHit(query, row);
    const haystack = stableNormalize([
      buildCommunityHitHaystack(hit, row),
      row.file_name,
      row.file_path,
      row.topic,
      row.title,
      row.content,
    ].filter(Boolean).join(' '));
    if (!haystack) return;
    const matched = terms.some(function (term) {
      const normalizedTerm = stableNormalize(term);
      return normalizedTerm.length >= 2 && haystack.indexOf(normalizedTerm) >= 0;
    });
    if (matched) {
      hit.similarity = Math.max(hit.similarity || 0, 0.88);
      hit.matchType = hit.matchedInBundle ? 'nested_in_bundle' : 'keyword_substring';
      hits.push(hit);
    }
  });

  return dedupeCommunityHits(hits)
    .sort(function (a, b) { return (b.similarity || 0) - (a.similarity || 0); })
    .slice(0, limit);
}

function parseCommunityDescriptionFromNotes(rawNotes) {
  const notes = String(rawNotes || '');
  const descMatch = notes.match(/\[desc:([^\]]+)\]/);
  if (descMatch) return descMatch[1].trim();
  const clean = notes.replace(/\[title:[^\]]+\]/g, '').replace(/\[desc:[^\]]+\]/g, '').trim();
  return clean.slice(0, 200);
}

/** Detect raw chat questions — only for catalog navigation targets, not search matching. */
function looksLikeUserChatQuestion(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/[?؟]/.test(s)) return true;
  if (/^(האם|מהו?|איפה|היכן|למה|מדוע|איך|האם יש|תוכל|תוכלי)\b/u.test(s)) return true;
  if (s.split(/\s+/).filter(Boolean).length >= 10) return true;
  return false;
}

function stableNormalizeCommunityText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Canonical community_materials.topic folder name for catalog navigation.
 * Never returns the user's raw chat question.
 */
function resolveCommunityCatalogTopic(hit) {
  if (!hit || typeof hit !== 'object') return '';

  const explicit = String(hit.catalogTopic || '').trim();
  if (explicit && !looksLikeUserChatQuestion(explicit)) return explicit;

  const subfolder = String(hit.subfolderTopic || '').trim();
  if (subfolder && !looksLikeUserChatQuestion(subfolder)) {
    return catalogTopics.resolveCatalogTopicFromFolderName(subfolder);
  }

  const bundleTopic = String(hit.bundleTopic || '').trim();
  if (bundleTopic && !looksLikeUserChatQuestion(bundleTopic)) return bundleTopic;

  const topic = String(hit.topic || '').trim();
  if (topic && !looksLikeUserChatQuestion(topic)) return topic;

  return '';
}

function withCatalogNavigationFields(hit, query) {
  if (!hit || typeof hit !== 'object') return hit;
  const folderTopic = String(
    hit.catalogTopic || hit.bundleTopic || hit.subfolderTopic || hit.topic || ''
  ).trim();
  const safeTopic = folderTopic && !looksLikeUserChatQuestion(folderTopic)
    ? folderTopic
    : String(hit.topic || '').trim();
  const gradeId = hit.gradeId != null ? String(hit.gradeId) : '';
  const gradeLabel = hit.gradeLabel || resolveGradeLabelFromId(gradeId, null) || null;
  return Object.assign({}, hit, {
    catalogTopic: safeTopic,
    parentCatalogTopic: safeTopic,
    fileTopic: safeTopic,
    gradeId: gradeId,
    gradeLabel: gradeLabel,
    materialId: hit.sourceMaterialId || hit.id || hit.materialId || null,
  });
}

function buildSemanticCatalogEntries(materialRows, kbRows) {
  const entries = [];

  (materialRows || []).forEach(function (row) {
    const hit = formatCommunityMaterialRow(row);
    if (!hit.id) return;
    entries.push({
      key: 'catalog:' + hit.id,
      id: hit.id,
      title: hit.title,
      topic: hit.topic,
      description: hit.description || parseCommunityDescriptionFromNotes(row.notes || row.description || ''),
      hit: hit,
    });
  });

  (kbRows || []).forEach(function (row) {
    const hit = formatCommunityKnowledgeRow(row);
    if (!hit.id) return;
    entries.push({
      key: 'kb:' + hit.id,
      id: hit.id,
      title: hit.displayTitle || hit.title,
      topic: hit.topic || hit.bundleTopic,
      description: hit.contentPreview || '',
      hit: hit,
    });
  });

  return entries;
}

async function fetchGradeCommunityRows(gradeId) {
  const scoped = await Promise.all([
    fetchCommunityMaterialRows(gradeId, '', false),
    fetchCommunityKnowledgeRows(gradeId, '', false),
  ]);
  return {
    materialRows: scoped[0],
    kbRows: scoped[1],
  };
}

function pickBestCommunityHits(materialRows, kbRows, query, options) {
  const opts = options || {};
  const limit = opts.limit || 8;
  const minScore = opts.minScore != null ? opts.minScore : 0.45;
  const hits = [];

  (materialRows || []).forEach(function (row) {
    const hit = formatCommunityMaterialRow(row);
    hit.similarity = scoreCommunityHitSimilarity(query, hit);
    if (hit.similarity >= minScore) hits.push(hit);
  });

  (kbRows || []).forEach(function (row) {
    const hit = scoreCommunityKnowledgeHit(query, row);
    if (hit.similarity >= minScore) hits.push(hit);
  });

  return dedupeCommunityHits(hits)
    .sort(function (a, b) { return (b.similarity || 0) - (a.similarity || 0); })
    .slice(0, limit);
}

function buildCommunitySearchOrClause(terms, fieldNames) {
  const orParts = [];
  (terms || []).forEach(function (term) {
    (fieldNames || []).forEach(function (field) {
      orParts.push(field + '.ilike.*' + term + '*');
    });
  });
  return orParts.length ? 'or(' + orParts.join(',') + ')' : '';
}

function applyCommunityMaterialQueryFilters(params, gradeId, query, withTermFilter) {
  const gid = String(gradeId || '').trim();
  const terms = withTermFilter ? buildCommunitySearchTerms(query) : [];
  const termClause = terms.length
    ? buildCommunitySearchOrClause(terms, ['topic', 'file_name', 'notes', 'file_path'])
    : '';

  if (gid === 'general') {
    const gradeClause = 'or(grade_level.eq.general,grade_level.is.null)';
    if (termClause) {
      params.set('and', '(' + gradeClause + ',' + termClause + ')');
    } else {
      params.set('or', '(grade_level.eq.general,grade_level.is.null)');
    }
    return;
  }

  if (gid) params.set('grade_level', 'eq.' + gid);
  if (termClause) params.set('or', '(' + termClause.slice(3, -1) + ')');
}

function applyCommunityKnowledgeQueryFilters(params, gradeId, query, withTermFilter) {
  const gid = String(gradeId || '').trim();
  const terms = withTermFilter ? buildCommunitySearchTerms(query) : [];
  const termClause = terms.length
    ? buildCommunitySearchOrClause(terms, ['title', 'topic', 'content', 'file_path', 'file_name'])
    : '';

  if (gid === 'general') {
    const gradeClause = 'or(grade_id.eq.general,grade_id.is.null)';
    if (termClause) {
      params.set('and', '(' + gradeClause + ',' + termClause + ')');
    } else {
      params.set('or', '(grade_id.eq.general,grade_id.is.null)');
    }
    return;
  }

  if (gid) params.set('grade_id', 'eq.' + gid);
  if (termClause) params.set('or', '(' + termClause.slice(3, -1) + ')');
}

async function fetchCommunityMaterialRows(gradeId, query, withTermFilter, options) {
  if (!isSupabaseCacheEnabled()) return [];
  const opts = options || {};

  const params = new URLSearchParams();
  params.set('select', 'id,grade_level,topic,file_path,file_name,notes,created_at');
  params.set('order', 'created_at.desc');
  params.set('limit', String(opts.limit || (withTermFilter ? 48 : 200)));
  applyCommunityMaterialQueryFilters(params, gradeId, query, withTermFilter);

  const res = await supabaseRequest('/rest/v1/' + COMMUNITY_MATERIALS_TABLE + '?' + params.toString(), {
    method: 'GET',
  });
  if (!res.ok) {
    const errText = await res.text().catch(function () { return ''; });
    console.warn('[community] materials fetch failed:', res.status, errText.slice(0, 200));
    return [];
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function enrichKnowledgeRowsWithBundleMaterials(rows) {
  if (!Array.isArray(rows) || !rows.length || !isSupabaseCacheEnabled()) return rows || [];

  const ids = Array.from(new Set(
    rows.map(function (row) { return row && row.source_material_id; }).filter(Boolean)
  ));
  if (!ids.length) return rows;

  const params = new URLSearchParams();
  params.set('select', 'id,topic,grade_level,file_name,file_path,notes');
  params.set('id', 'in.(' + ids.join(',') + ')');

  const res = await supabaseRequest('/rest/v1/' + COMMUNITY_MATERIALS_TABLE + '?' + params.toString(), {
    method: 'GET',
  });
  if (!res.ok) return rows;

  const materials = await res.json();
  if (!Array.isArray(materials)) return rows;

  const byId = {};
  materials.forEach(function (material) {
    if (material && material.id) byId[String(material.id)] = material;
  });

  return rows.map(function (row) {
    if (!row || !row.source_material_id) return row;
    const linked = byId[String(row.source_material_id)];
    if (!linked) return row;
    return Object.assign({}, row, { _bundle_material: linked });
  });
}

async function fetchCommunityKnowledgeRows(gradeId, query, withTermFilter, options) {
  if (!isSupabaseCacheEnabled()) return [];
  const opts = options || {};

  const params = new URLSearchParams();
  params.set(
    'select',
    'id,title,topic,content,file_path,file_name,source_material_id,contributor_name,grade_id,metadata,created_at'
  );
  params.set('order', 'created_at.desc');
  params.set('limit', String(opts.limit || (withTermFilter ? 64 : 200)));
  applyCommunityKnowledgeQueryFilters(params, gradeId, query, withTermFilter);

  const res = await supabaseRequest('/rest/v1/' + COMMUNITY_KB_TABLE + '?' + params.toString(), {
    method: 'GET',
  });
  if (!res.ok) {
    const errText = await res.text().catch(function () { return ''; });
    console.warn('[community] knowledge fetch failed:', res.status, errText.slice(0, 200));
    return [];
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  if (opts.skipBundleEnrichment) return rows;
  return enrichKnowledgeRowsWithBundleMaterials(rows);
}

async function fetchCommunityCatalogRows(gradeId, options) {
  const opts = options || {};
  const limit = opts.limit || 300;
  const scopedGrade = gradeId || '';
  const materialRows = await fetchCommunityMaterialRows(scopedGrade, '', false, { limit: limit });
  const kbRows = await fetchCommunityKnowledgeRows(scopedGrade, '', false, {
    limit: limit,
    skipBundleEnrichment: true,
  });
  return { materialRows: materialRows, kbRows: kbRows };
}

/**
 * Unified hybrid community probe — keyword fuzzy + substring + semantic (LLM/embeddings).
 */
function resolveGradeLabelFromId(gradeId, gradeLabel) {
  const label = String(gradeLabel || '').trim();
  if (label) return label;
  const id = String(gradeId || '').trim();
  if (id && GRADE_LABEL_BY_ID[id]) return GRADE_LABEL_BY_ID[id];
  if (id === 'general') return GRADE_LABEL_BY_ID.general;
  if (id) return 'כיתה ' + id;
  return '';
}

function formatCachedArchiveAsCommunityMatch(row, query) {
  if (!row) return null;
  const topic = String(row.topic || '').trim();
  const gradeId = row.grade_id != null ? String(row.grade_id) : '';
  const gradeLabel = resolveGradeLabelFromId(gradeId, row.grade_label);
  let title = topic || String(row.query_text || '').trim() || 'ארכיון מחקר';
  if (row.phase === GENERAL_SEARCH_PHASE) {
    const data = coerceCachedResultData(row.result_data);
    if (data && data.periodBlock) {
      title = title + ' · תקופת לימוד 15 ימים';
    }
  }
  return {
    id: row.cache_key || null,
    source: 'cached_archive',
    title: title,
    topic: topic,
    catalogTopic: topic,
    gradeId: gradeId || null,
    gradeLabel: gradeLabel || null,
    fileName: '',
    fileUrl: '',
    contentPreview: String(row.query_text || topic || '').slice(0, 240),
    similarity: scoreTopicSimilarity(query, topic, row.query_text || ''),
    matchType: 'cached_archive',
    cacheKey: row.cache_key || null,
    phase: row.phase || null,
  };
}

/**
 * Global cached_results scan for pedagogical chat — ignores UI grade/topic filters.
 */
async function findCachedResultsGlobalMatch(query, options) {
  const opts = options || {};
  const limit = opts.limit || 5;
  const q = String(query || '').trim();
  if (!q || !isSupabaseCacheEnabled()) {
    return { matches: [], count: 0, query: q, matchMethod: 'none' };
  }

  const terms = buildCommunitySearchTerms(q);
  if (!terms.length) {
    return { matches: [], count: 0, query: q, matchMethod: 'none' };
  }

  try {
    const params = new URLSearchParams();
    params.set('select', LEGACY_ROW_SELECT);
    params.set('order', 'hit_count.desc,created_at.desc');
    params.set('limit', '80');
    params.set('phase', 'in.(topic,grade,chat_followup,general_search)');

    const orParts = [];
    terms.forEach(function (term) {
      orParts.push('topic.ilike.*' + term + '*');
      orParts.push('query_text.ilike.*' + term + '*');
      orParts.push('grade_label.ilike.*' + term + '*');
    });
    params.set('or', '(' + orParts.join(',') + ')');

    const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
      method: 'GET',
    });
    if (!res.ok) {
      return { matches: [], count: 0, query: q, matchMethod: 'none' };
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) {
      return { matches: [], count: 0, query: q, matchMethod: 'none' };
    }

    const hits = rows.map(function (row) {
      return formatCachedArchiveAsCommunityMatch(row, q);
    }).filter(function (hit) {
      return hit && (hit.similarity || 0) >= 0.35;
    }).sort(function (a, b) {
      return (b.similarity || 0) - (a.similarity || 0);
    }).slice(0, limit);

    return {
      matches: hits,
      count: hits.length,
      query: q,
      matchMethod: hits.length ? 'cached_archive_global' : 'none',
    };
  } catch (err) {
    console.warn('[community] cached_results global probe failed:', err.message || err);
    return { matches: [], count: 0, query: q, matchMethod: 'none' };
  }
}

async function findCommunityMaterials(options) {
  const opts = options || {};
  const query = opts.globalScan === true
    ? String(opts.userMessage || opts.query || '').trim()
    : buildCommunitySearchQuery(opts);
  const gradeId = opts.globalScan === true
    ? ''
    : String(opts.gradeId || opts.currentGrade || '').trim();
  const semanticQuery = String(opts.userMessage || opts.query || query).trim();
  if (!query) return { matches: [], count: 0, query: '', matchMethod: 'none' };

  let materialRows = [];
  let kbRows = [];
  let matchMethod = 'keyword_substring';

  if (isSupabaseCacheEnabled()) {
    try {
      const catalogRows = await fetchCommunityCatalogRows(gradeId, { limit: 300 });
      materialRows = catalogRows.materialRows;
      kbRows = catalogRows.kbRows;
      if (!materialRows.length && !kbRows.length && gradeId && !opts.globalScan) {
        const globalRows = await fetchCommunityCatalogRows('', { limit: 300 });
        materialRows = globalRows.materialRows;
        kbRows = globalRows.kbRows;
      }
    } catch (err) {
      console.warn('[community] catalog fetch failed:', err.message || err);
    }
  }

  let matches = keywordSubstringMatchCommunity(query, materialRows, kbRows, {
    limit: opts.limit || 8,
  });

  if (!matches.length && (materialRows.length || kbRows.length)) {
    matches = pickBestCommunityHits(materialRows, kbRows, query, {
      limit: opts.limit || 8,
      minScore: 0.35,
    });
    if (matches.length) matchMethod = 'keyword_fuzzy';
  }

  if (!matches.length && (materialRows.length || kbRows.length)) {
    const terms = buildCommunitySearchTerms(query);
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      if (!term || term.length < 2) continue;
      const termHits = keywordSubstringMatchCommunity(term, materialRows, kbRows, {
        limit: opts.limit || 8,
      });
      if (termHits.length) {
        matches = termHits;
        matchMethod = 'keyword_term';
        break;
      }
    }
  }

  if (!matches.length && opts.semanticFallback !== false && semanticQuery) {
    try {
      const enrichedKb = await enrichKnowledgeRowsWithBundleMaterials(kbRows);
      const catalog = buildSemanticCatalogEntries(materialRows, enrichedKb);
      if (catalog.length) {
        const semanticHits = await communitySemanticMatch.findSemanticCommunityMatches(semanticQuery, catalog);
        if (semanticHits.length) {
          matches = semanticHits.slice(0, opts.limit || 8);
          matchMethod = semanticHits[0].matchType || 'semantic';
        }
      }
    } catch (semanticErr) {
      console.warn('[community] semantic probe failed:', semanticErr.message || semanticErr);
    }
  }

  const navQuery = String(opts.userMessage || opts.query || query || '').trim();
  const result = {
    matches: matches.map(function (hit) { return withCatalogNavigationFields(hit, navQuery); }),
    count: matches.length,
    query: query,
    matchMethod: matches.length ? matchMethod : 'none',
  };
  return attachCommunityFolderBriefToResult(result, opts);
}

/**
 * Global community probe — same hybrid keyword + semantic path as pedagogical chat.
 * Ignores UI grade/topic scope so partial terms and synonyms (e.g. אודיסאוס → מסעות אודיסאוס) resolve.
 */
async function probeCommunityGlobalSearch(query, options) {
  const opts = options || {};
  const userMessage = String(opts.userMessage || query || '').trim();
  if (!userMessage) {
    return { matches: [], count: 0, query: '', matchMethod: 'none' };
  }

  const scopedGrade = String(opts.gradeId || opts.currentGrade || '').trim();
  const useGlobalScan = opts.globalScan === true || (!scopedGrade && opts.globalScan !== false);

  const baseOpts = {
    query: userMessage,
    userMessage: userMessage,
    topic: opts.topic || null,
    gradeId: useGlobalScan ? '' : scopedGrade,
    currentGrade: useGlobalScan ? '' : scopedGrade,
    globalScan: useGlobalScan,
    semanticFallback: true,
    includeFolderBrief: opts.includeFolderBrief !== false,
    repositorySearch: opts.repositorySearch === true,
    phase: opts.phase || 'topic',
    limit: opts.limit || 8,
  };

  let result = await findCommunityMaterials(baseOpts);

  if (!result.count) {
    const terms = buildCommunitySearchTerms(userMessage);
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      if (!term || term.length < 2) continue;
      const termProbe = await findCommunityMaterials(Object.assign({}, baseOpts, {
        query: term,
        userMessage: term,
      }));
      if (termProbe.count > 0) {
        result = termProbe;
        break;
      }
    }
  }

  if (!result.count) {
    try {
      const archiveHits = await findCachedResultsGlobalMatch(userMessage, { limit: baseOpts.limit || 8 });
      if (archiveHits.count > 0) {
        result = Object.assign({}, archiveHits, {
          query: userMessage,
          matchMethod: archiveHits.matchMethod || 'cached_archive_global',
        });
      }
    } catch (archiveErr) {
      console.warn('[community] general_search archive probe failed:', archiveErr.message || archiveErr);
    }
  }

  return result;
}

module.exports = {
  TABLE_NAME,
  RAW_PERPLEXITY_PHASE,
  TOPIC_MASTER_PHASE,
  HYBRID_GENERATED_VERSION,
  buildCacheKey,
  normalizeGradeCacheRequest,
  normalizeTopicQuery,
  normalizeGradeResultForCache,
  coerceCachedResultData,
  deleteCachedRowByKey,
  deleteRawPerplexityCache,
  deleteTopicMasterCache,
  deleteTopicProseArchive,
  removeArchiveLinkFromCache,
  replaceArchiveBlockInCache,
  setArchiveBlockByPath,
  TOPIC_PROSE_ARCHIVE_PHASES,
  purgeCorruptedCachedRow,
  ensureJsonObjectForStorage,
  readAndValidateCachedResultData,
  coerceArchiveLessonResultData,
  sanitizeForJsonStorage,
  safeJsonStringify,
  buildCachedGeneratePayload,
  isEnhancedCachedPayload,
  stampHybridGeneratedMetadata,
  stampPerplexityOnlyMetadata,
  getCachedResult,
  getTopicMasterCache,
  setTopicMasterCache,
  getGeneralSearchCache,
  setGeneralSearchCache,
  buildGeneralSearchCacheBody,
  normalizeGeneralSearchQuery,
  normalizeGeneralSearchConceptKey,
  findGeneralSearchArchiveSuggestion,
  getGeneralSearchByCacheKey,
  isGeneralSearchPayload,
  hydrateTopicMasterArchiveLinks,
  findSemanticTopicMasterMatch,
  scoreTopicMasterSemanticMatch,
  isTopicMasterPayload,
  buildTopicMasterCacheBody,
  getRawPerplexityCache,
  setRawPerplexityCache,
  lookupChatPriorAnswer,
  lookupGradeCachedContext,
  lookupTopicCachedContext,
  extractChatAnswerText,
  extractGradeInsightsText,
  packChatFollowupForCache,
  mergeChatEnrichmentIntoGradeCache,
  setCachedResult,
  saveCachedResultAsync,
  isSupabaseCacheEnabled,
  listTeacherSearchHistory,
  listTeacherChatHistory,
  linkArchiveToTeacherHistory,
  isSearchHistoryResultData,
  getTeacherLessonByCacheKey,
  getCommunityLessonByCacheKey,
  saveTopicChatSession,
  scoreTopicSimilarity,
  findArchiveTopicSuggestion,
  findCommunityMaterials,
  probeCommunityGlobalSearch,
  findCachedResultsGlobalMatch,
  resolveGradeLabelFromId,
  buildSemanticCatalogEntries,
  keywordSubstringMatchCommunity,
  buildCommunitySearchTerms,
  looksLikeUserChatQuestion,
  resolveCommunityCatalogTopic,
  withCatalogNavigationFields,
  resolveInheritedCatalogTopicFromRow,
  backgroundFetchDriveCatalog: driveCatalogSync.backgroundFetchDriveCatalogAsync,
  syncCommunityDriveCatalog: driveCatalogSync.syncCommunityDriveCatalog,
  isDriveCatalogSyncConfigured: driveCatalogSync.isDriveCatalogSyncConfigured,
  COMMUNITY_MATERIALS_TABLE,
  COMMUNITY_KB_TABLE,
};
