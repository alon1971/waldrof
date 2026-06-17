/**
 * cached_results — Supabase-backed pedagogical API cache with local fallback.
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (preferred) or SUPABASE_ANON_KEY.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('./env');

const TABLE_NAME = 'cached_results';

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

function hashString(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** Build a deterministic cache key for pedagogical API requests. */
function buildCacheKey(body) {
  if (!body || !body.phase) return null;
  if (body.phase === 'test') return null;

  const gradeId = stableNormalize(body.currentGrade ?? body.gradeId ?? '');
  const gradeLabel = stableNormalize(body.gradeLabel ?? '');
  const topic = stableNormalize(body.topic ?? '');
  const archiveQuery = stableNormalize(body.archiveQuery ?? '');
  const activityTitle = stableNormalize(body.activityTitle ?? body.sourceTitle ?? '');
  const userMessage = stableNormalize(body.userMessage ?? '');

  const parts = [body.phase, gradeId, gradeLabel, topic, archiveQuery, activityTitle];

  if (body.phase === 'chat_followup') {
    parts.push(userMessage);
  }

  if (body.phase === 'pedagogy_deep_dive' || body.phase === 'archive_summary') {
    parts.push(stableNormalize(body.activityPreview ?? body.sourceDescription ?? ''));
  }

  return hashString(parts.join('|'));
}

function buildRow(cacheKey, body, resultData) {
  return {
    cache_key: cacheKey,
    phase: body.phase,
    grade_id: body.currentGrade ?? body.gradeId ?? null,
    grade_label: body.gradeLabel || null,
    topic: body.topic || null,
    query_text: body.userMessage || body.archiveQuery || body.topic || body.gradeLabel || null,
    result_data: resultData,
    user_id: body.userId || (body.teacherUser && body.teacherUser.id) || null,
    user_email: body.userEmail || (body.teacherUser && body.teacherUser.email) || null,
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

/**
 * Parse cached result_data from Supabase without markdown/JSON repair heuristics.
 * Handles jsonb stored as a JSON string or accidental { data, meta } wrappers.
 */
function coerceCachedResultData(raw) {
  if (raw == null) return null;

  let data = raw;
  if (typeof data === 'string') {
    const text = data.trim();
    if (!text) return null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data.trim());
      } catch (e2) {
        return null;
      }
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
    !data.pedagogyDeepDive &&
    !data.webResearch &&
    !data.archiveSearch
  ) {
    data = data.data;
  }

  return data;
}

function cloneJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return null;
  }
}

function isValidCachedPayload(phase, data) {
  if (!data || typeof data !== 'object') return false;
  if (phase === 'grade') return Boolean(data.gradeInsights && typeof data.gradeInsights === 'object');
  if (phase === 'topic') return Boolean(data.blockPlan && typeof data.blockPlan === 'object');
  if (phase === 'chat_followup') {
    return Boolean(
      data.chatReply &&
      typeof data.chatReply === 'object' &&
      (data.chatReply.answer || data.chatReply.answerHtml)
    );
  }
  if (phase === 'pedagogy_deep_dive') return Boolean(data.pedagogyDeepDive);
  if (phase === 'archive_search') return Boolean(data.archiveSearch);
  if (phase === 'archive_summary') return Boolean(data.archiveSummary || data.pedagogyDeepDive);
  if (phase === 'drive') return Boolean(data.driveMerge);
  if (phase === 'test') return data.ok === true;
  return true;
}

/** Ready-to-send cache hit — original object only, never re-parsed through model cleaners. */
function buildCachedGeneratePayload(cached, phase) {
  if (!cached) return null;
  const data = coerceCachedResultData(cached.data);
  if (!data || !isValidCachedPayload(phase, data)) return null;
  const cloned = cloneJsonSafe(data);
  if (!cloned) return null;
  return {
    data: cloned,
    meta: Object.assign({}, cached.meta || {}, { fromCache: true }),
  };
}

function extractChatAnswerText(resultData) {
  const data = coerceCachedResultData(resultData);
  if (!data || typeof data !== 'object') return '';
  const reply = data.chatReply;
  if (!reply || typeof reply !== 'object') return '';
  if (reply.answer) return String(reply.answer).trim();
  if (reply.answerHtml) {
    return String(reply.answerHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
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
  const gradeBody = buildGradeCacheBody(body);
  if (!gradeBody) return null;
  const cacheKey = buildCacheKey(gradeBody);
  const row = await fetchCachedRowByKey(cacheKey);
  const data = coerceCachedResultData(row && row.result_data);
  if (!row || !data || !extractGradeInsightsText(data)) return null;
  bumpHitCountAsync(cacheKey, row.hit_count);
  return {
    cacheKey: cacheKey,
    data: data,
    matchType: 'grade',
    queryText: row.query_text || gradeBody.gradeLabel || '',
    hitCount: row.hit_count || 0,
  };
}

/**
 * Load cached topic lesson plan when grade + topic are set.
 */
async function lookupTopicCachedContext(body) {
  const topicBody = buildTopicCacheBody(body);
  if (!topicBody) return null;
  const cacheKey = buildCacheKey(topicBody);
  const row = await fetchCachedRowByKey(cacheKey);
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
  const gradeBody = buildGradeCacheBody(body);
  if (!gradeBody || !chatResultData || !chatResultData.chatReply) return null;

  const answer = extractChatAnswerText(chatResultData);
  const userMessage = String(body.userMessage || '').trim();
  if (!answer || !userMessage) return null;

  const cacheKey = buildCacheKey(gradeBody);
  const existing = await fetchCachedRowByKey(cacheKey);
  const coerced = existing && existing.result_data
    ? coerceCachedResultData(existing.result_data)
    : null;
  const resultData = coerced
    ? cloneJsonSafe(coerced) || coerced
    : { gradeInsights: {} };

  if (!resultData.gradeInsights || typeof resultData.gradeInsights !== 'object') {
    resultData.gradeInsights = {};
  }

  const enrichment = {
    question: userMessage,
    answer: answer,
    answerHtml: chatResultData.chatReply.answerHtml || null,
    topic: body.topic || null,
    updatedAt: new Date().toISOString(),
  };

  if (!Array.isArray(resultData.gradeInsights.chatEnrichments)) {
    resultData.gradeInsights.chatEnrichments = [];
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

  await setCachedResult(gradeBody, resultData);
  return {
    cacheKey: cacheKey,
    gradeInsights: resultData.gradeInsights,
  };
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

async function fetchCachedRowByKey(cacheKey) {
  if (!cacheKey) return null;

  if (isSupabaseCacheEnabled()) {
    try {
      const res = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME +
        '?cache_key=eq.' + encodeURIComponent(cacheKey) +
        '&select=cache_key,query_text,result_data,hit_count,phase,topic,grade_id&limit=1',
        { method: 'GET' }
      );
      if (res.ok) {
        const rows = await res.json();
        const row = Array.isArray(rows) ? rows[0] : null;
        if (row && row.result_data) return row;
      }
    } catch (err) {
      console.warn('[cached_results] row fetch failed:', err.message || err);
    }
  }

  loadFallbackStore();
  const fallback = fallbackStore.rows.get(cacheKey);
  if (fallback && fallback.result_data) return fallback;
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
 */
async function getCachedResult(body) {
  const cacheKey = buildCacheKey(body);
  if (!cacheKey) return null;

  if (body && body.phase === 'chat_followup') {
    return null;
  }

  const row = await fetchCachedRowByKey(cacheKey);
  let data = row && row.result_data ? coerceCachedResultData(row.result_data) : null;

  if (!data) {
    const fallbackRaw = getFallbackCached(cacheKey);
    data = fallbackRaw ? coerceCachedResultData(fallbackRaw) : null;
    if (!data || !isValidCachedPayload(body.phase, data)) return null;
    const cloned = cloneJsonSafe(data);
    if (!cloned) return null;
    return {
      data: cloned,
      meta: {
        fromCache: true,
        cacheKey: cacheKey,
        table: TABLE_NAME,
        source: 'fallback',
      },
    };
  }

  if (!isValidCachedPayload(body.phase, data)) return null;

  bumpHitCountAsync(cacheKey, row.hit_count);
  const cloned = cloneJsonSafe(data);
  if (!cloned) return null;
  return {
    data: cloned,
    meta: {
      fromCache: true,
      cacheKey: cacheKey,
      table: TABLE_NAME,
      source: isSupabaseCacheEnabled() ? 'supabase' : 'fallback',
    },
  };
}

/**
 * Persist a fresh Perplexity result (awaitable).
 */
async function setCachedResult(body, resultData) {
  const cacheKey = buildCacheKey(body);
  if (!cacheKey || !resultData) return null;

  const row = buildRow(cacheKey, body, resultData);
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
        body: JSON.stringify(row),
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
          body: JSON.stringify({
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

  setFallbackCached(cacheKey, body, resultData);
  return cacheKey;
}

/** Fire-and-forget cache write — does not block the HTTP response. */
function saveCachedResultAsync(body, resultData) {
  setCachedResult(body, resultData).catch(function (err) {
    console.warn('[cached_results] async save failed:', err.message || err);
  });
}

function listFallbackTeacherHistory(teacher, limit) {
  loadFallbackStore();
  const userId = String(teacher && teacher.id || '').trim();
  const userEmail = String(teacher && teacher.email || '').trim().toLowerCase();
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
    .slice(0, limit || 20);

  return rows.map(formatHistoryItem);
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
  const data = row.result_data || {};
  const hasPlan = Boolean(data.blockPlan);
  const includeResult = opts.includeResultData !== false;
  return {
    cacheKey: row.cache_key,
    phase: row.phase,
    gradeId: row.grade_id || null,
    gradeLabel: row.grade_label || null,
    topic: row.topic || data.webResearch?.topic || row.query_text || '',
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
  const userId = String(teacher && teacher.id || '').trim();
  const userEmail = String(teacher && teacher.email || '').trim().toLowerCase();

  if (!userId && !userEmail) return [];

  if (isSupabaseCacheEnabled()) {
    try {
      const params = new URLSearchParams();
      params.set('select', 'cache_key,phase,grade_id,grade_label,topic,query_text,result_data,hit_count,created_at,last_hit_at');
      params.set('phase', 'eq.topic');
      params.set('order', 'created_at.desc');
      params.set('limit', String(limit));

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
          return rows
            .filter(function (row) { return row && row.result_data && row.result_data.blockPlan; })
            .map(formatHistoryItem);
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

async function fetchCachedRowByKey(cacheKey) {
  if (!cacheKey) return null;

  if (isSupabaseCacheEnabled()) {
    try {
      const res = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME +
        '?cache_key=eq.' + encodeURIComponent(cacheKey) +
        '&select=cache_key,phase,grade_id,grade_label,topic,query_text,result_data,hit_count,created_at,last_hit_at,user_id,user_email&limit=1',
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

/**
 * Load a single saved lesson plan by cache key (teacher-scoped).
 */
async function getTeacherLessonByCacheKey(teacher, cacheKey) {
  const row = await fetchCachedRowByKey(cacheKey);
  if (!row || row.phase !== 'topic') return null;
  if (!teacherOwnsRow(teacher, row)) return null;
  if (!row.result_data || !row.result_data.blockPlan) return null;
  bumpHitCountAsync(cacheKey, row.hit_count);
  return formatHistoryItem(row);
}

/**
 * Merge chat session fields into a topic cache row's result_data.
 */
async function saveTopicChatSession(teacher, cacheKey, session) {
  const row = await fetchCachedRowByKey(cacheKey);
  if (!row || row.phase !== 'topic') return false;
  if (!teacherOwnsRow(teacher, row)) return false;

  const data = Object.assign({}, row.result_data || {});
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
  if (session && session.lessonSnapshot && typeof session.lessonSnapshot === 'object') {
    var snap = session.lessonSnapshot;
    if (snap.blockPlan) data.blockPlan = snap.blockPlan;
    if (snap.webResearch) data.webResearch = snap.webResearch;
    if (snap.gallery) data.gallery = snap.gallery;
  }

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

module.exports = {
  TABLE_NAME,
  buildCacheKey,
  coerceCachedResultData,
  buildCachedGeneratePayload,
  getCachedResult,
  lookupChatPriorAnswer,
  lookupGradeCachedContext,
  lookupTopicCachedContext,
  extractChatAnswerText,
  extractGradeInsightsText,
  mergeChatEnrichmentIntoGradeCache,
  setCachedResult,
  saveCachedResultAsync,
  isSupabaseCacheEnabled,
  listTeacherSearchHistory,
  getTeacherLessonByCacheKey,
  saveTopicChatSession,
};
