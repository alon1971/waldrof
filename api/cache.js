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
    parts.push(hashString(String(body.researchContext || '').slice(0, 8000)));
    parts.push(hashString(String(body.ragContext || '').slice(0, 4000)));
    if (Array.isArray(body.ragChunkIds) && body.ragChunkIds.length) {
      parts.push(body.ragChunkIds.slice(0, 24).join(','));
    }
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
 * Lookup cached result. Returns { data, meta } or null.
 */
async function getCachedResult(body) {
  const cacheKey = buildCacheKey(body);
  if (!cacheKey) return null;

  if (isSupabaseCacheEnabled()) {
    try {
      const res = await supabaseRequest(
        '/rest/v1/' + TABLE_NAME +
        '?cache_key=eq.' + encodeURIComponent(cacheKey) +
        '&select=cache_key,result_data,hit_count&limit=1',
        { method: 'GET' }
      );

      if (res.status === 404 || res.status === 406) {
        /* table may not exist yet — fall through */
      } else if (!res.ok) {
        const errText = await res.text();
        console.warn('[cached_results] Supabase read error', res.status, errText.slice(0, 200));
      } else {
        const rows = await res.json();
        const row = Array.isArray(rows) ? rows[0] : null;
        if (row && row.result_data) {
          bumpHitCountAsync(cacheKey, row.hit_count);
          return {
            data: row.result_data,
            meta: {
              fromCache: true,
              cacheKey: cacheKey,
              table: TABLE_NAME,
              source: 'supabase',
            },
          };
        }
      }
    } catch (err) {
      console.warn('[cached_results] Supabase read failed:', err.message || err);
    }
  }

  const fallbackData = getFallbackCached(cacheKey);
  if (!fallbackData) return null;

  return {
    data: fallbackData,
    meta: {
      fromCache: true,
      cacheKey: cacheKey,
      table: TABLE_NAME,
      source: 'fallback',
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
  getCachedResult,
  setCachedResult,
  saveCachedResultAsync,
  isSupabaseCacheEnabled,
  listTeacherSearchHistory,
  getTeacherLessonByCacheKey,
  saveTopicChatSession,
};
