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
const catalogTopics = require('./catalog-topics');
const communityFolderBrief = require('./community-folder-brief');
const driveCatalogSync = require('./drive-catalog-sync');
const enrichmentLinks = require('./enrichment-links');

const TABLE_NAME = 'cached_results';
/** Phase stored in cached_results for raw Perplexity web-search payloads (hybrid pipeline). */
const RAW_PERPLEXITY_PHASE = 'perplexity_raw';
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

  if (body.phase === 'phase_c' || body.cTab) {
    parts.push(stableNormalize(body.cTab || body.productTab || body.phaseCTab || ''));
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
    if (mapped === authContext.LOCAL_DEMO_MOCK_UUID) {
      verifiedUserId = mapped;
    }
  }
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
    user_email: userEmail,
    hit_count: 0,
    last_hit_at: null,
  };
}

async function supabaseRequest(relativePath, options) {
  const cfg = getSupabaseConfig();
  const headers = Object.assign({
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
  }, options.headers || {});

  const res = await fetch(cfg.url + relativePath, Object.assign({}, options, { headers }));
  return res;
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
  if (phase !== 'topic' && phase !== 'phase_c') return data;
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
    !data.webResearch &&
    !data.archiveSearch
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

const archiveSectionText = archiveCoerce.archiveSectionText;
const coerceCurriculumRows = archiveCoerce.coerceCurriculumRows;
const extractCurriculumFromArchivePlan = archiveCoerce.extractCurriculumFromArchivePlan;
const liftArchivePhaseCFields = archiveCoerce.liftArchivePhaseCFields;
const coerceArchiveLessonResultData = archiveCoerce.coerceArchiveLessonResultData;
const hasMeaningfulCurriculumRows = archiveCoerce.hasMeaningfulCurriculumRows;
const isMeaningfulInspiration = archiveCoerce.isMeaningfulInspiration;
const preserveCurriculumRowForStorage = archiveCoerce.preserveCurriculumRowForStorage;
const preparePhaseCCurriculumForStorage = archiveCoerce.preparePhaseCCurriculumForStorage;

/** phase_c curriculum cache fail-safe — fewer valid days ⇒ corrupt row, delete + live regen. */
const PHASE_C_CURRICULUM_MIN_VALID_DAYS = 5;
const PHASE_C_CURRICULUM_DASH_FIELD_RE = /^[-–—_.\s]+$/;

function resolvePhaseCTabFromBody(body) {
  if (!body) return '';
  return stableNormalize(body.cTab || body.productTab || body.phaseCTab || '');
}

function isPhaseCCurriculumContentCorrupt(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (PHASE_C_CURRICULUM_DASH_FIELD_RE.test(s)) return true;
  if (s === '<div class="prose-ai"></div>') return true;
  return false;
}

function countValidPhaseCCurriculumDays(data) {
  const bp = data && data.blockPlan;
  const rows = bp && Array.isArray(bp.curriculum) ? bp.curriculum : [];
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const content = row.content != null ? row.content : row['תוכן וסיפור'];
    if (!isPhaseCCurriculumContentCorrupt(content)) count++;
  }
  return count;
}

function isPhaseCCurriculumCacheCorrupt(body, data) {
  if (!body || body.phase !== 'phase_c') return false;
  if (resolvePhaseCTabFromBody(body) !== 'curriculum') return false;
  return countValidPhaseCCurriculumDays(data) < PHASE_C_CURRICULUM_MIN_VALID_DAYS;
}

function buildPhaseCCacheBody(cTab, context) {
  const gradeId = String(
    (context && (context.grade_id || context.gradeId || context.currentGrade)) || ''
  ).trim();
  const topic = String((context && (context.topic || context.query_text)) || '').trim();
  const gradeLabel = (context && (context.grade_label || context.gradeLabel)) || null;
  if (!gradeId || !topic) return null;
  return {
    phase: 'phase_c',
    cTab: cTab,
    topic: topic,
    currentGrade: gradeId,
    gradeId: gradeId,
    gradeLabel: gradeLabel,
  };
}

/** Load phase_c inspiration/curriculum row directly (no topic enrichment recursion). */
async function fetchPhaseCCachePayload(cTab, context) {
  const body = buildPhaseCCacheBody(cTab, context);
  if (!body) return null;
  const cacheKey = buildCacheKey(body);
  if (!cacheKey) return null;

  const row = await fetchCachedRowByKey(cacheKey);
  let data = row && row.result_data ? coerceCachedResultData(row.result_data) : null;
  if (!data) {
    const fallbackRaw = getFallbackCached(cacheKey);
    data = fallbackRaw ? coerceCachedResultData(fallbackRaw) : null;
  }
  if (!data) return null;
  if (cTab === 'curriculum' && isPhaseCCurriculumCacheCorrupt(body, data)) return null;
  return data;
}

/**
 * Topic archive rows store Phase B theory; phase_c curriculum/inspiration live in sibling cache keys.
 * Merge those sibling rows when hydrating history or serving cached topic payloads.
 */
async function enrichArchiveLessonWithPhaseCCaches(data, context) {
  if (!data || typeof data !== 'object') return data;
  data = coerceArchiveLessonResultData(data) || data;
  if (!data.blockPlan || typeof data.blockPlan !== 'object') return data;

  let blockPlan = data.blockPlan;
  const existingCurr = extractCurriculumFromArchivePlan(blockPlan, data);
  if (!hasMeaningfulCurriculumRows(existingCurr)) {
    const phaseCCurr = await fetchPhaseCCachePayload('curriculum', context);
    if (phaseCCurr && phaseCCurr.blockPlan) {
      const currRows = extractCurriculumFromArchivePlan(phaseCCurr.blockPlan, phaseCCurr);
      if (hasMeaningfulCurriculumRows(currRows)) {
        blockPlan.curriculum = currRows.map(preserveCurriculumRowForStorage).filter(Boolean);
        blockPlan.days = blockPlan.curriculum.slice();
        blockPlan = liftArchivePhaseCFields(blockPlan, Object.assign({}, data, phaseCCurr));
        data.blockPlan = blockPlan;
      }
    }
  }

  if (!isMeaningfulInspiration(blockPlan.inspiration)) {
    const phaseCInsp = await fetchPhaseCCachePayload('inspiration', context);
    if (phaseCInsp && phaseCInsp.blockPlan && isMeaningfulInspiration(phaseCInsp.blockPlan.inspiration)) {
      blockPlan = data.blockPlan;
      blockPlan.inspiration = phaseCInsp.blockPlan.inspiration;
      if (phaseCInsp.gallery && !data.gallery) {
        data.gallery = cloneJsonSafe(phaseCInsp.gallery);
      }
      data.blockPlan = liftArchivePhaseCFields(blockPlan, Object.assign({}, data, phaseCInsp));
    }
  }

  return data;
}

/** After phase_c save, patch the parent topic row so history reload includes curriculum/inspiration. */
async function patchTopicCacheWithPhaseC(phaseCBody, phaseCData) {
  if (!phaseCBody || phaseCBody.phase !== 'phase_c' || !phaseCData) return false;
  const cTab = resolvePhaseCTabFromBody(phaseCBody);
  if (!cTab) return false;

  const gradeId = phaseCBody.currentGrade ?? phaseCBody.gradeId ?? null;
  const topic = phaseCBody.topic ?? null;
  if (!gradeId || !topic) return false;

  const topicBody = {
    phase: 'topic',
    topic: topic,
    currentGrade: gradeId,
    gradeId: gradeId,
    gradeLabel: phaseCBody.gradeLabel ?? null,
  };
  const topicKey = buildCacheKey(topicBody);
  if (!topicKey) return false;

  const row = await fetchCachedRowByKey(topicKey);
  if (!row || row.phase !== 'topic') return false;

  let data = coerceCachedResultData(row.result_data);
  if (!data || typeof data !== 'object') data = {};
  if (!data.blockPlan || typeof data.blockPlan !== 'object') data.blockPlan = {};

  let changed = false;
  if (cTab === 'curriculum') {
    const existing = extractCurriculumFromArchivePlan(data.blockPlan, data);
    if (!hasMeaningfulCurriculumRows(existing)) {
      const rows = extractCurriculumFromArchivePlan(phaseCData.blockPlan, phaseCData);
      if (hasMeaningfulCurriculumRows(rows)) {
        data.blockPlan.curriculum = rows.map(preserveCurriculumRowForStorage).filter(Boolean);
        data.blockPlan.days = data.blockPlan.curriculum.slice();
        data.blockPlan = liftArchivePhaseCFields(data.blockPlan, Object.assign({}, data, phaseCData));
        changed = true;
      }
    }
  } else if (cTab === 'inspiration') {
    if (!isMeaningfulInspiration(data.blockPlan.inspiration)) {
      const bp = phaseCData.blockPlan;
      if (bp && isMeaningfulInspiration(bp.inspiration)) {
        data.blockPlan.inspiration = bp.inspiration;
        data.blockPlan = liftArchivePhaseCFields(data.blockPlan, Object.assign({}, data, phaseCData));
        if (phaseCData.gallery && !data.gallery) {
          data.gallery = cloneJsonSafe(phaseCData.gallery);
        }
        changed = true;
      }
    }
  }

  if (!changed) return false;
  data = coerceArchiveLessonResultData(data) || data;

  if (isSupabaseCacheEnabled()) {
    try {
      const res = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME + '?cache_key=eq.' + encodeURIComponent(topicKey),
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ result_data: data }),
        }
      );
      if (!res.ok) {
        const errText = await res.text();
        console.warn('[cached_results] topic patch from phase_c failed', res.status, errText.slice(0, 200));
        return false;
      }
    } catch (err) {
      console.warn('[cached_results] topic patch from phase_c error:', err.message || err);
      return false;
    }
  }

  loadFallbackStore();
  const stored = fallbackStore.rows.get(topicKey);
  if (stored) {
    stored.result_data = data;
    fallbackStore.rows.set(topicKey, stored);
    persistFallbackStore();
  }
  return true;
}

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
  if (phase === 'topic') {
    const bp = data.blockPlan;
    if (bp && typeof bp === 'object' && String(bp.rawContent || '').trim()) return true;
    return Boolean(bp && typeof bp === 'object');
  }
  if (phase === 'phase_c') {
    const bp = data.blockPlan;
    if (!bp || typeof bp !== 'object') return false;
    if (bp.inspiration && typeof bp.inspiration === 'object') return true;
    const rows = extractCurriculumFromArchivePlan(bp, data);
    if (rows.length >= 1) return true;
    if (Array.isArray(bp.curriculum) && bp.curriculum.length >= 1) return true;
    if (String(bp.rawContent || '').trim()) return true;
    return false;
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
  if (phase === 'archive_search') return Boolean(data.archiveSearch);
  if (phase === 'archive_summary') return Boolean(data.archiveSummary || data.pedagogyDeepDive);
  if (phase === 'drive') return Boolean(data.driveMerge);
  if (phase === 'test') return data.ok === true;
  return true;
}

/** True when a cached topic/grade/phase_c row is safe to auto-serve (Perplexity or legacy rich — never Gemini-upgraded). */
function isEnhancedCachedPayload(phase, data) {
  const coerced = coerceCachedResultData(data);
  if (!coerced || typeof coerced !== 'object') return false;
  if (phase !== 'topic' && phase !== 'grade' && phase !== 'phase_c') return isValidCachedPayload(phase, coerced);
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
  if (phase === 'phase_c') return true;
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
    const row = await resolveCachedRowWithLegacyFallback(gradeBody, cacheKey);
    const data = coerceCachedResultData(row && row.result_data);
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
  const row = await resolveCachedRowWithLegacyFallback(topicBody, cacheKey);
  const data = coerceCachedResultData(row && row.result_data);
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
    const existing = await resolveCachedRowWithLegacyFallback(gradeBody, cacheKey);
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

  function scanRows(rows) {
    if (!Array.isArray(rows)) return null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.result_data) continue;
      const data = coerceCachedResultData(row.result_data);
      if (!data || !isValidCachedPayload('topic', data)) continue;
      if (!topicCacheTextsMatch(topicBody, row, data)) continue;
      return formatExactArchiveTopicMatch({
        row: row,
        data: data,
        topic: archiveTopicDisplayName(row, data, topic),
        score: 1,
      }, gradeId);
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
  return fallbackMatch;
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
  };
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
    return {
      matchType: 'exact',
      similarity: 1,
      cacheKey: cached.meta.cacheKey,
      topic: archiveTopicDisplayName({ topic: topic, query_text: topic }, cached.data) || topic,
      requestedTopic: topic,
      gradeId: gradeId,
      resultData: cached.data,
    };
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
      return formatExactArchiveTopicMatch(strongBest, gradeId, { requestedTopic: topic });
    }
  }

  if (bypassSemanticGuess) {
    console.log('[cached_results] definitive Waldorf skill block — exact archive only, skipping disambiguation:', topic);
    return null;
  }

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
};

const LEGACY_ROW_SELECT =
  'cache_key,phase,grade_id,grade_label,topic,query_text,result_data,hit_count,created_at,last_hit_at,user_id,user_email';

function gradeLabelSearchVariants(gradeId, gradeLabel) {
  const variants = [];
  const seen = new Set();
  function add(value) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    variants.push(text);
  }
  const id = String(gradeId || '').trim();
  if (id && GRADE_LABEL_BY_ID[id]) add(GRADE_LABEL_BY_ID[id]);
  add(gradeLabel);
  return variants;
}

function pickValidLegacyGradeRow(rows, newCacheKey) {
  if (!Array.isArray(rows)) return null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.result_data || row.cache_key === newCacheKey) continue;
    if (normalizeGradeResultForCache(coerceCachedResultData(row.result_data))) return row;
  }
  return null;
}

function lookupLegacyGradeInFallback(body, newCacheKey) {
  const gradeId = String(body.currentGrade ?? body.gradeId ?? '').trim();
  if (!gradeId) return null;
  const labels = gradeLabelSearchVariants(gradeId, body.gradeLabel);
  loadFallbackStore();
  let best = null;
  fallbackStore.rows.forEach(function (row) {
    if (!row || row.phase !== 'grade' || !row.result_data || row.cache_key === newCacheKey) return;
    const rowGradeId = String(row.grade_id || '').trim();
    const matchesId = rowGradeId === gradeId;
    const matchesText = labels.some(function (lbl) {
      const qt = String(row.query_text || '');
      const gl = String(row.grade_label || '');
      return qt.indexOf(lbl) >= 0 || gl.indexOf(lbl) >= 0;
    });
    if (!matchesId && !matchesText) return;
    if (!normalizeGradeResultForCache(coerceCachedResultData(row.result_data))) return;
    best = row;
  });
  return best;
}

/**
 * Fallback for rows saved under the old cache-key scheme (or keyed only by Hebrew label text).
 */
async function lookupLegacyGradeCachedRow(body, newCacheKey) {
  console.log('[CACHE_DEBUG] lookupLegacyGradeCachedRow called, newCacheKey:', newCacheKey);
  console.log('[CACHE_DEBUG] lookupLegacyGradeCachedRow body:', JSON.stringify(body));
  console.log('[CACHE_DEBUG] Supabase cache enabled:', isSupabaseCacheEnabled());

  if (!body || body.phase !== 'grade' || !newCacheKey) {
    console.log('[CACHE_DEBUG] Legacy lookup skipped — invalid body/phase/newCacheKey');
    return null;
  }
  const gradeId = String(body.currentGrade ?? body.gradeId ?? '').trim();
  if (!gradeId) {
    console.log('[CACHE_DEBUG] Legacy lookup skipped — empty gradeId');
    return null;
  }
  console.log('[CACHE_DEBUG] Legacy lookup gradeId:', gradeId, 'gradeLabel:', body.gradeLabel);

  if (isSupabaseCacheEnabled()) {
    try {
      const byIdParams = new URLSearchParams();
      byIdParams.set('select', LEGACY_ROW_SELECT);
      byIdParams.set('phase', 'eq.grade');
      byIdParams.set('grade_id', 'eq.' + gradeId);
      byIdParams.set('order', 'hit_count.desc,created_at.desc');
      byIdParams.set('limit', '8');

      const byIdUrl = '/rest/v1/' + TABLE_NAME + '?' + byIdParams.toString();
      console.log('[CACHE_DEBUG] Legacy byId query URL:', byIdUrl);
      const byIdRes = await supabaseRequest(byIdUrl, { method: 'GET' });
      console.log('[CACHE_DEBUG] Legacy byId response status:', byIdRes.status, byIdRes.ok);
      if (!byIdRes.ok) {
        const errText = await byIdRes.text();
        console.log('[CACHE_DEBUG] Supabase error (byId):', errText.slice(0, 500));
      } else {
        const legacyRows = await byIdRes.json();
        console.log('[CACHE_DEBUG] Legacy query results count (byId):', legacyRows?.length);
        if (legacyRows?.length) {
          legacyRows.forEach(function (r, idx) {
            console.log('[CACHE_DEBUG] Legacy byId row[' + idx + ']:', JSON.stringify({
              cache_key: r.cache_key ? r.cache_key.slice(0, 16) : null,
              phase: r.phase,
              grade_id: r.grade_id,
              grade_label: r.grade_label,
              query_text: r.query_text,
              has_result_data: Boolean(r.result_data),
            }));
          });
        }
        const match = pickValidLegacyGradeRow(legacyRows, newCacheKey);
        console.log('[CACHE_DEBUG] Legacy byId valid match:', match ? match.cache_key.slice(0, 16) : null);
        if (match) return match;
      }

      const labels = gradeLabelSearchVariants(gradeId, body.gradeLabel);
      console.log('[CACHE_DEBUG] Legacy label search variants:', labels);
      for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        const textParams = new URLSearchParams();
        textParams.set('select', LEGACY_ROW_SELECT);
        textParams.set('phase', 'eq.grade');
        textParams.set('or', '(query_text.ilike.*' + label + '*,grade_label.ilike.*' + label + '*)');
        textParams.set('order', 'hit_count.desc,created_at.desc');
        textParams.set('limit', '8');

        const textUrl = '/rest/v1/' + TABLE_NAME + '?' + textParams.toString();
        console.log('[CACHE_DEBUG] Legacy byLabel query URL:', textUrl);
        const textRes = await supabaseRequest(textUrl, { method: 'GET' });
        console.log('[CACHE_DEBUG] Legacy byLabel response status:', textRes.status, 'label:', label);
        if (!textRes.ok) {
          const errText = await textRes.text();
          console.log('[CACHE_DEBUG] Supabase error (byLabel):', errText.slice(0, 500));
          continue;
        }
        const labelRows = await textRes.json();
        console.log('[CACHE_DEBUG] Legacy query results count (byLabel):', labelRows?.length);
        if (labelRows?.length) {
          labelRows.forEach(function (r, idx) {
            console.log('[CACHE_DEBUG] Legacy byLabel row[' + idx + ']:', JSON.stringify({
              cache_key: r.cache_key ? r.cache_key.slice(0, 16) : null,
              phase: r.phase,
              grade_id: r.grade_id,
              grade_label: r.grade_label,
              query_text: r.query_text,
              has_result_data: Boolean(r.result_data),
            }));
          });
        }
        const textMatch = pickValidLegacyGradeRow(labelRows, newCacheKey);
        console.log('[CACHE_DEBUG] Legacy byLabel valid match:', textMatch ? textMatch.cache_key.slice(0, 16) : null);
        if (textMatch) return textMatch;
      }
    } catch (err) {
      console.log('[CACHE_DEBUG] Supabase error:', err);
      console.warn('[cached_results] legacy grade lookup failed:', err.message || err);
    }
  } else {
    console.log('[CACHE_DEBUG] Supabase disabled — trying local fallback only');
  }

  const fallbackRow = lookupLegacyGradeInFallback(body, newCacheKey);
  console.log('[CACHE_DEBUG] Local fallback legacy match:', fallbackRow ? fallbackRow.cache_key.slice(0, 16) : null);
  return fallbackRow;
}

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

function pickValidLegacyTopicRow(rows, body, newCacheKey) {
  if (!Array.isArray(rows)) return null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.result_data || row.cache_key === newCacheKey) continue;
    if (!isValidCachedPayload('topic', coerceCachedResultData(row.result_data))) continue;
    if (!topicCacheTextsMatch(body, row)) continue;
    return row;
  }
  return null;
}

function lookupLegacyTopicInFallback(body, newCacheKey) {
  const gradeId = String(body.currentGrade ?? body.gradeId ?? '').trim();
  if (!gradeId) return null;
  loadFallbackStore();
  let best = null;
  fallbackStore.rows.forEach(function (row) {
    if (!row || row.phase !== 'topic' || !row.result_data || row.cache_key === newCacheKey) return;
    if (String(row.grade_id || '').trim() !== gradeId) return;
    if (!topicCacheTextsMatch(body, row)) return;
    if (!isValidCachedPayload('topic', coerceCachedResultData(row.result_data))) return;
    best = row;
  });
  return best;
}

/**
 * Fallback for topic rows saved under the old (non-normalized) cache-key scheme.
 */
async function lookupLegacyTopicCachedRow(body, newCacheKey) {
  if (!body || body.phase !== 'topic' || !newCacheKey) return null;
  const gradeId = String(body.currentGrade ?? body.gradeId ?? '').trim();
  const wanted = normalizeTopicQuery(body.topic || '');
  if (!gradeId || !wanted) return null;

  if (isSupabaseCacheEnabled()) {
    try {
      const params = new URLSearchParams();
      params.set('select', LEGACY_ROW_SELECT);
      params.set('phase', 'eq.topic');
      params.set('grade_id', 'eq.' + gradeId);
      params.set('order', 'hit_count.desc,created_at.desc');
      params.set('limit', '20');

      const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), { method: 'GET' });
      if (res.ok) {
        const rows = await res.json();
        const match = pickValidLegacyTopicRow(rows, body, newCacheKey);
        if (match) return match;
      }
    } catch (err) {
      console.warn('[cached_results] legacy topic lookup failed:', err.message || err);
    }
  }

  return lookupLegacyTopicInFallback(body, newCacheKey);
}

async function migrateLegacyTopicRowCacheKey(legacyRow, body, newCacheKey) {
  if (!legacyRow || !newCacheKey || legacyRow.cache_key === newCacheKey) return false;

  const data = coerceCachedResultData(legacyRow.result_data);
  if (!data || !isValidCachedPayload('topic', data)) return false;

  const existingNew = await fetchCachedRowByKey(newCacheKey);
  if (existingNew && existingNew.result_data && isValidCachedPayload('topic', coerceCachedResultData(existingNew.result_data))) {
    return false;
  }

  const row = buildRow(newCacheKey, body, cloneJsonSafe(data) || data);
  row.hit_count = Number(legacyRow.hit_count) || 0;
  if (legacyRow.user_id && authContext.isValidAuthUuid(legacyRow.user_id) && !authContext.isMockUserId(legacyRow.user_id)) {
    row.user_id = legacyRow.user_id;
  }
  if (legacyRow.user_email) row.user_email = legacyRow.user_email;

  if (isSupabaseCacheEnabled()) {
    try {
      const upsertRes = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?on_conflict=cache_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
      if (upsertRes.ok) {
        console.log(
          '[cached_results] LEGACY TOPIC MIGRATE',
          String(legacyRow.cache_key).slice(0, 12),
          '->',
          newCacheKey.slice(0, 12)
        );
        return true;
      }
    } catch (err) {
      console.warn('[cached_results] legacy topic migrate failed:', err.message || err);
    }
  }

  setFallbackCached(newCacheKey, body, data);
  return true;
}

/**
 * Re-key a legacy row to the simplified cache_key (upsert). Never deletes the legacy row's data.
 */
async function migrateLegacyRowCacheKey(legacyRow, body, newCacheKey) {
  if (!legacyRow || !newCacheKey || legacyRow.cache_key === newCacheKey) return false;

  const data = normalizeGradeResultForCache(coerceCachedResultData(legacyRow.result_data));
  if (!data) return false;

  const existingNew = await fetchCachedRowByKey(newCacheKey);
  if (existingNew && existingNew.result_data && normalizeGradeResultForCache(coerceCachedResultData(existingNew.result_data))) {
    return false;
  }

  const row = buildRow(newCacheKey, body, data);
  row.hit_count = Number(legacyRow.hit_count) || 0;
  if (legacyRow.user_id && authContext.isValidAuthUuid(legacyRow.user_id) && !authContext.isMockUserId(legacyRow.user_id)) {
    row.user_id = legacyRow.user_id;
  }
  if (legacyRow.user_email) row.user_email = legacyRow.user_email;

  if (isSupabaseCacheEnabled()) {
    try {
      const upsertRes = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?on_conflict=cache_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
      if (upsertRes.ok) {
        console.log(
          '[cached_results] LEGACY MIGRATE',
          String(legacyRow.cache_key).slice(0, 12),
          '->',
          newCacheKey.slice(0, 12)
        );
        return true;
      }
      const errText = await upsertRes.text();
      console.warn('[cached_results] legacy migrate upsert error', upsertRes.status, errText.slice(0, 200));
    } catch (err) {
      console.warn('[cached_results] legacy migrate failed:', err.message || err);
    }
  }

  loadFallbackStore();
  row.created_at = legacyRow.created_at || new Date().toISOString();
  fallbackStore.rows.set(newCacheKey, row);
  persistFallbackStore();
  return true;
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

async function resolveCachedRowWithLegacyFallback(body, cacheKey) {
  console.log('[CACHE_DEBUG] Checking new key:', cacheKey);
  console.log('[CACHE_DEBUG] Body data received:', JSON.stringify(body));

  const row = await fetchCachedRowByKey(cacheKey);
  console.log('[CACHE_DEBUG] Direct key lookup result:', row
    ? { cache_key: row.cache_key ? row.cache_key.slice(0, 16) : null, has_result_data: Boolean(row.result_data) }
    : null);

  if (row && row.result_data) {
    console.log('[CACHE_DEBUG] Cache HIT on new key');
    return row;
  }

  console.log('[CACHE_DEBUG] Cache MISS on new key — trying legacy fallback');
  if (body && body.phase === 'grade') {
    const legacyRow = await lookupLegacyGradeCachedRow(body, cacheKey);
    console.log('[CACHE_DEBUG] Legacy fallback result:', legacyRow
      ? { cache_key: legacyRow.cache_key ? legacyRow.cache_key.slice(0, 16) : null, has_result_data: Boolean(legacyRow.result_data) }
      : null);
    if (legacyRow && legacyRow.result_data) {
      const migrated = await migrateLegacyRowCacheKey(legacyRow, body, cacheKey);
      console.log('[CACHE_DEBUG] Legacy migration attempted:', migrated);
      return legacyRow;
    }
  }

  if (body && body.phase === 'topic') {
    const legacyTopicRow = await lookupLegacyTopicCachedRow(body, cacheKey);
    if (legacyTopicRow && legacyTopicRow.result_data) {
      await migrateLegacyTopicRowCacheKey(legacyTopicRow, body, cacheKey);
      return legacyTopicRow;
    }
  }

  console.log('[CACHE_DEBUG] No cache row found (new key + legacy)');
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
async function getCachedResult(body, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requireEnhanced = opts.requireEnhanced !== false
    && body
    && (body.phase === 'topic' || body.phase === 'grade');

  if (body && body.phase === 'grade') {
    normalizeGradeCacheRequest(body);
  }

  const cacheKey = buildCacheKey(body);
  if (!cacheKey) return null;

  if (body && body.phase === 'chat_followup') {
    return null;
  }

  const row = await resolveCachedRowWithLegacyFallback(body, cacheKey);
  let data = row && row.result_data ? coerceCachedResultData(row.result_data) : null;

  if (!data) {
    const fallbackRaw = getFallbackCached(cacheKey);
    data = fallbackRaw ? coerceCachedResultData(fallbackRaw) : null;
    if (!data || !isValidCachedPayload(body.phase, data)) return null;
    if (requireEnhanced && !isEnhancedCachedPayload(body.phase, data)) return null;
    const payload = body.phase === 'grade'
      ? normalizeGradeResultForCache(data)
      : cloneJsonSafe(data);
    if (!payload) return null;
    if (isPhaseCCurriculumCacheCorrupt(body, payload)) {
      console.warn(
        '[cached_results] phase_c curriculum CORRUPT (fallback) — deleting',
        cacheKey.slice(0, 12),
        'validDays=' + countValidPhaseCCurriculumDays(payload)
      );
      await deleteCachedRowByKey(cacheKey);
      return null;
    }
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
    payload = await enrichArchiveLessonWithPhaseCCaches(payload, body);
  } else if (payload && body.phase === 'phase_c' && resolvePhaseCTabFromBody(body) === 'inspiration') {
    payload = applyArchiveLinkCleanupPolicy(payload, body.phase);
  }
  if (!payload) return null;
  if (isPhaseCCurriculumCacheCorrupt(body, payload)) {
    console.warn(
      '[cached_results] phase_c curriculum CORRUPT — deleting cache, forcing live regen',
      cacheKey.slice(0, 12),
      'validDays=' + countValidPhaseCCurriculumDays(payload)
    );
    await deleteCachedRowByKey(cacheKey);
    return null;
  }
  return {
    data: payload,
    meta: {
      fromCache: true,
      cacheKey: cacheKey,
      table: TABLE_NAME,
      source: isSupabaseCacheEnabled() ? 'supabase' : 'fallback',
      legacyMigrated: row.cache_key !== cacheKey,
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
  const safe = sanitizeForJsonStorage(Object.assign({}, rawPayload, {
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

  // phase_c: verbatim JSON from the live generator — no regex, row mapping, or curriculum coercion.
  let safeResultData = (body && body.phase === 'phase_c')
    ? cloneJsonSafe(resultData)
    : sanitizeForJsonStorage(resultData);
  if (!safeResultData) return null;
  if (body && body.phase === 'phase_c' && resolvePhaseCTabFromBody(body) === 'curriculum') {
    safeResultData = preparePhaseCCurriculumForStorage(safeResultData) || safeResultData;
  }

  const row = buildRow(cacheKey, body, safeResultData);
  const rowBodyJson = (body && body.phase === 'phase_c')
    ? (function () {
      try { return JSON.stringify(row); } catch (e) { return safeJsonStringify(row); }
    })()
    : safeJsonStringify(row);
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
        if (body.phase === 'phase_c') {
          patchTopicCacheWithPhaseC(body, safeResultData).catch(function (patchErr) {
            console.warn('[cached_results] topic patch from phase_c failed:', patchErr.message || patchErr);
          });
        }
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
          body: (body && body.phase === 'phase_c' ? JSON.stringify({
            phase: row.phase,
            grade_id: row.grade_id,
            grade_label: row.grade_label,
            topic: row.topic,
            query_text: row.query_text,
            result_data: row.result_data,
            user_id: row.user_id,
            user_email: row.user_email,
          }) : safeJsonStringify({
            phase: row.phase,
            grade_id: row.grade_id,
            grade_label: row.grade_label,
            topic: row.topic,
            query_text: row.query_text,
            result_data: row.result_data,
            user_id: row.user_id,
            user_email: row.user_email,
          })),
        }
      );
      if (patchRes.ok) {
        console.log('[cached_results] PATCH ok for', cacheKey.slice(0, 12));
        if (body.phase === 'phase_c') {
          patchTopicCacheWithPhaseC(body, safeResultData).catch(function (patchErr) {
            console.warn('[cached_results] topic patch from phase_c failed:', patchErr.message || patchErr);
          });
        }
        return cacheKey;
      }
      const patchErr = await patchRes.text();
      console.warn('[cached_results] Supabase PATCH error', patchRes.status, patchErr.slice(0, 200));
    } catch (err) {
      console.warn('[cached_results] Supabase write failed:', err.message || err);
    }
  }

  setFallbackCached(cacheKey, body, safeResultData);
  if (body && body.phase === 'phase_c') {
    patchTopicCacheWithPhaseC(body, safeResultData).catch(function (patchErr) {
      console.warn('[cached_results] topic patch from phase_c failed:', patchErr.message || patchErr);
    });
  }
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
      if (!row || row.phase !== 'topic' || !row.result_data) return false;
      if (userId && row.user_id === userId) return true;
      if (userEmail && String(row.user_email || '').toLowerCase() === userEmail) return true;
      return false;
    })
    .sort(function (a, b) {
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    })
    .slice(0, fetchLimit);

  return dedupeSearchHistoryItems(rows.map(formatHistoryItem), limit || 20);
}

function teacherOwnsRow(teacher, row) {
  if (!teacher || !row) return false;
  const userId = String(teacher.id || '').trim();
  const userEmail = String(teacher.email || '').trim().toLowerCase();
  if (userId && row.user_id === userId) return true;
  if (userEmail && String(row.user_email || '').trim().toLowerCase() === userEmail) return true;
  return false;
}

function formatHistoryItem(row, options) {
  const opts = options || {};
  const rawData = coerceCachedResultData(row.result_data) || row.result_data || {};
  const data = coerceArchiveLessonResultData(rawData) || rawData;
  const hasPlan = Boolean(data && data.blockPlan);
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
async function listTeacherSearchHistory(teacher, options) {
  const limit = (options && options.limit) || 20;
  const fetchLimit = searchHistoryFetchLimit(limit);
  const userEmail = String(teacher && teacher.email || '').trim().toLowerCase();
  const userId = authContext.mapUserIdForSupabaseQuery(teacher && teacher.id, teacher && teacher.email) || '';

  if (!userId && !userEmail) return [];

  if (isSupabaseCacheEnabled()) {
    try {
      const params = new URLSearchParams();
      params.set('select', 'cache_key,phase,grade_id,grade_label,topic,query_text,result_data,hit_count,created_at,last_hit_at');
      params.set('phase', 'eq.topic');
      params.set('order', 'created_at.desc');
      params.set('limit', String(fetchLimit));

      if (userId && userEmail) {
        params.set('or', '(user_id.eq.' + userId + ',user_email.eq.' + userEmail + ')');
      } else if (userId) {
        params.set('user_id', 'eq.' + userId);
      } else {
        params.set('user_email', 'eq.' + userEmail);
      }

      const res = await supabaseRequest('/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
        method: 'GET',
      });

      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows)) {
          const items = rows
            .filter(function (row) { return row && row.result_data && row.result_data.blockPlan; })
            .map(formatHistoryItem);
          return dedupeSearchHistoryItems(items, limit);
        }
      } else {
        const errText = await res.text();
        console.warn('[cached_results] history read error', res.status, errText.slice(0, 200));
      }
    } catch (err) {
      console.warn('[cached_results] history read failed:', err.message || err);
    }
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
        params.set('or', '(user_id.eq.' + userId + ',user_email.eq.' + userEmail + ')');
      } else if (userId) {
        params.set('user_id', 'eq.' + userId);
      } else {
        params.set('user_email', 'eq.' + userEmail);
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
  if (!row || row.phase !== 'topic') return null;
  let data = coerceArchiveLessonResultData(coerceCachedResultData(row.result_data));
  if (!data || !data.blockPlan) return null;
  data = await enrichArchiveLessonWithPhaseCCaches(data, row);
  bumpHitCountAsync(cacheKey, row.hit_count);
  return formatHistoryItem(Object.assign({}, row, { result_data: data }));
}

/**
 * Load a single saved lesson plan by cache key (teacher-scoped).
 */
async function getTeacherLessonByCacheKey(teacher, cacheKey) {
  const row = await fetchCachedRowByKey(cacheKey);
  if (!row || row.phase !== 'topic') return null;
  if (!teacherOwnsRow(teacher, row)) return null;
  let data = coerceArchiveLessonResultData(coerceCachedResultData(row.result_data));
  if (!data || !data.blockPlan) return null;
  data = await enrichArchiveLessonWithPhaseCCaches(data, row);
  bumpHitCountAsync(cacheKey, row.hit_count);
  return formatHistoryItem(Object.assign({}, row, { result_data: data }));
}

/**
 * Merge chat session fields into a topic cache row's result_data.
 */
async function saveTopicChatSession(teacher, cacheKey, session) {
  const row = await fetchCachedRowByKey(cacheKey);
  if (!row || row.phase !== 'topic') return false;
  if (!teacherOwnsRow(teacher, row)) return false;

  const data = Object.assign({}, coerceCachedResultData(row.result_data) || {});
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
          body: JSON.stringify({ result_data: data }),
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
  if (!result || opts.includeFolderBrief === false) return result;
  const query = String(opts.userMessage || opts.query || result.query || '').trim();
  if (!query || !result.count) return result;
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
 * Parent topic folder for a nested community file (e.g. יוון for מסעות אודיסאוס).
 */
function resolveParentCommunityFolderTopic(hit, query) {
  if (!hit || typeof hit !== 'object') return '';

  const title = String(hit.displayTitle || hit.title || hit.fileName || hit.internalFileName || '').trim();
  const titleNorm = stableNormalizeCommunityText(title);
  const segments = [];

  function pushSegment(value) {
    const cleaned = String(value || '').trim();
    if (!cleaned) return;
    segments.push(cleaned);
  }

  pushSegment(hit.bundleTopic);
  pushSegment(hit.subfolderTopic);
  if (hit.pathLabels) {
    String(hit.pathLabels).split(/\s+/).forEach(pushSegment);
  }
  if (hit.drivePath) {
    String(hit.drivePath).split('/').forEach(pushSegment);
  }

  const catalogTopic = String(resolveCommunityCatalogTopic(hit) || '').trim();
  const rowTopic = String(hit.topic || '').trim();
  [catalogTopic, rowTopic].forEach(pushSegment);

  const seen = new Set();
  const candidates = segments.filter(function (candidate) {
    const key = stableNormalizeCommunityText(candidate);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const queryText = String(query || '').trim();
  if (queryText) {
    const queryNorms = catalogTopics.expandCatalogTopicAliases([queryText])
      .map(stableNormalizeCommunityText)
      .filter(Boolean);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const candidateNorm = stableNormalizeCommunityText(candidate);
      if (!candidateNorm) continue;
      if (titleNorm && candidateNorm === titleNorm) continue;
      const matchesQuery = queryNorms.some(function (qNorm) {
        return qNorm === candidateNorm
          || (qNorm.length >= 2 && candidateNorm.indexOf(qNorm) >= 0)
          || (candidateNorm.length >= 2 && qNorm.indexOf(candidateNorm) >= 0);
      });
      if (matchesQuery) {
        return catalogTopics.resolveCatalogTopicFromFolderName(candidate);
      }
    }
  }

  for (let j = 0; j < candidates.length; j++) {
    const candidate = candidates[j];
    const candidateNorm = stableNormalizeCommunityText(candidate);
    if (!candidateNorm) continue;
    if (titleNorm && candidateNorm === titleNorm) continue;
    return catalogTopics.resolveCatalogTopicFromFolderName(candidate);
  }

  return catalogTopic || String(hit.bundleTopic || '').trim() || rowTopic || '';
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

async function fetchCommunityMaterialRows(gradeId, query, withTermFilter, options) {
  if (!isSupabaseCacheEnabled()) return [];
  const opts = options || {};

  const params = new URLSearchParams();
  params.set('select', 'id,grade_level,topic,file_path,file_name,notes,created_at');
  params.set('order', 'created_at.desc');
  params.set('limit', String(opts.limit || (withTermFilter ? 48 : 200)));
  if (gradeId) params.set('grade_level', 'eq.' + gradeId);

  if (withTermFilter) {
    const terms = buildCommunitySearchTerms(query);
    if (terms.length) {
      const orParts = [];
      terms.forEach(function (term) {
        orParts.push('topic.ilike.*' + term + '*');
        orParts.push('file_name.ilike.*' + term + '*');
        orParts.push('notes.ilike.*' + term + '*');
        orParts.push('file_path.ilike.*' + term + '*');
      });
      params.set('or', '(' + orParts.join(',') + ')');
    }
  }

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
  if (gradeId) params.set('grade_id', 'eq.' + gradeId);

  if (withTermFilter) {
    const terms = buildCommunitySearchTerms(query);
    if (terms.length) {
      const orParts = [];
      terms.forEach(function (term) {
        orParts.push('title.ilike.*' + term + '*');
        orParts.push('topic.ilike.*' + term + '*');
        orParts.push('content.ilike.*' + term + '*');
        orParts.push('file_path.ilike.*' + term + '*');
        orParts.push('file_name.ilike.*' + term + '*');
      });
      params.set('or', '(' + orParts.join(',') + ')');
    }
  }

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
  if (id) return 'כיתה ' + id;
  return '';
}

function formatCachedArchiveAsCommunityMatch(row, query) {
  if (!row) return null;
  const topic = String(row.topic || '').trim();
  const gradeId = row.grade_id != null ? String(row.grade_id) : '';
  const gradeLabel = resolveGradeLabelFromId(gradeId, row.grade_label);
  const title = topic || String(row.query_text || '').trim() || 'ארכיון מחקר';
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
    params.set('phase', 'in.(topic,grade,chat_followup)');

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

  const baseOpts = {
    query: userMessage,
    userMessage: userMessage,
    topic: opts.topic || null,
    globalScan: true,
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

  return result;
}

module.exports = {
  TABLE_NAME,
  RAW_PERPLEXITY_PHASE,
  HYBRID_GENERATED_VERSION,
  buildCacheKey,
  normalizeGradeCacheRequest,
  normalizeTopicQuery,
  normalizeGradeResultForCache,
  coerceCachedResultData,
  isPhaseCCurriculumCacheCorrupt,
  countValidPhaseCCurriculumDays,
  deleteCachedRowByKey,
  PHASE_C_CURRICULUM_MIN_VALID_DAYS,
  coerceArchiveLessonResultData,
  enrichArchiveLessonWithPhaseCCaches,
  patchTopicCacheWithPhaseC,
  sanitizeForJsonStorage,
  safeJsonStringify,
  buildCachedGeneratePayload,
  isEnhancedCachedPayload,
  stampHybridGeneratedMetadata,
  stampPerplexityOnlyMetadata,
  getCachedResult,
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
  resolveParentCommunityFolderTopic,
  withCatalogNavigationFields,
  resolveInheritedCatalogTopicFromRow,
  backgroundFetchDriveCatalog: driveCatalogSync.backgroundFetchDriveCatalogAsync,
  syncCommunityDriveCatalog: driveCatalogSync.syncCommunityDriveCatalog,
  isDriveCatalogSyncConfigured: driveCatalogSync.isDriveCatalogSyncConfigured,
  COMMUNITY_MATERIALS_TABLE,
  COMMUNITY_KB_TABLE,
};
