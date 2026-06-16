/**
 * Mock cached_results table — in-memory store with optional file persistence.
 * Ready to swap for Supabase/Postgres `cached_results` later.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TABLE_NAME = 'cached_results';
const CACHE_VERSION = 1;

function resolveStorePath() {
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
  }

  if (body.phase === 'pedagogy_deep_dive' || body.phase === 'archive_summary') {
    parts.push(stableNormalize(body.activityPreview ?? body.sourceDescription ?? ''));
  }

  return hashString(parts.join('|'));
}

class CachedResultsStore {
  constructor() {
    this.tableName = TABLE_NAME;
    this.storePath = resolveStorePath();
    /** @type {Map<string, object>} */
    this.rows = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.storePath)) return;
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : (parsed.rows || []);
      list.forEach(function (row) {
        if (row && row.cache_key) this.rows.set(row.cache_key, row);
      }, this);
    } catch (e) {
      console.warn('[cached_results] load failed:', e.message || e);
    }
  }

  persist() {
    try {
      const rows = Array.from(this.rows.values());
      fs.writeFileSync(this.storePath, JSON.stringify({
        table: TABLE_NAME,
        version: CACHE_VERSION,
        updated_at: new Date().toISOString(),
        rows: rows,
      }, null, 0));
    } catch (e) {
      console.warn('[cached_results] persist failed:', e.message || e);
    }
  }

  findByKey(cacheKey) {
    this.load();
    if (!cacheKey) return null;
    const row = this.rows.get(cacheKey);
    if (!row) return null;
    row.hit_count = (row.hit_count || 0) + 1;
    row.last_hit_at = new Date().toISOString();
    this.rows.set(cacheKey, row);
    this.persist();
    return row;
  }

  insert(cacheKey, body, resultData) {
    this.load();
    if (!cacheKey || !resultData) return;
    const row = {
      cache_key: cacheKey,
      phase: body.phase,
      grade_id: body.currentGrade ?? body.gradeId ?? null,
      topic: body.topic || null,
      query_text: body.userMessage || body.archiveQuery || body.topic || body.gradeLabel || null,
      result_data: resultData,
      created_at: new Date().toISOString(),
      last_hit_at: null,
      hit_count: 0,
    };
    this.rows.set(cacheKey, row);
    this.persist();
  }

  stats() {
    this.load();
    return { table: TABLE_NAME, count: this.rows.size, storePath: this.storePath };
  }
}

const store = new CachedResultsStore();

/**
 * Lookup cached pedagogical result. Returns { data, fromCache: true } or null.
 */
function getCachedResult(body) {
  const cacheKey = buildCacheKey(body);
  if (!cacheKey) return null;
  const row = store.findByKey(cacheKey);
  if (!row || !row.result_data) return null;
  return {
    data: row.result_data,
    meta: { fromCache: true, cacheKey: cacheKey, table: TABLE_NAME },
  };
}

/**
 * Save fresh Perplexity result to cached_results.
 */
function setCachedResult(body, resultData) {
  const cacheKey = buildCacheKey(body);
  if (!cacheKey || !resultData) return null;
  store.insert(cacheKey, body, resultData);
  return cacheKey;
}

module.exports = {
  TABLE_NAME,
  buildCacheKey,
  getCachedResult,
  setCachedResult,
  CachedResultsStore,
  _store: store,
};
