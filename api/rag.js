/**
 * knowledge_base RAG retrieval — keyword search via search_knowledge_base_keywords RPC.
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)
 */
const crypto = require('crypto');
const knowledgeIngest = require('./knowledge-ingest');
const env = require('./env');

const TABLE_NAME = 'knowledge_base';
const DEFAULT_MATCH_COUNT = 6;
const CACHE_MATCH_COUNT = 3;

const SOURCE_PRIORITY = {
  community_teacher: 0,
  ai_learned: 1,
};

const RAG_PHASES = new Set([
  'grade',
  'topic',
  'pedagogy_deep_dive',
  'archive_search',
  'archive_summary',
  'chat_followup',
]);

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServerKey(),
  };
}

function isRagEnabled() {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && cfg.key);
}

function shouldRetrieveForPhase(phase) {
  return RAG_PHASES.has(phase);
}

function buildQueryFromBody(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  if (body.userMessage) parts.push(body.userMessage);
  if (body.topic) parts.push(body.topic);
  if (body.archiveQuery) parts.push(body.archiveQuery);
  if (body.gradeLabel) parts.push(body.gradeLabel);
  if (body.activityTitle) parts.push(body.activityTitle);
  if (body.sourceTitle) parts.push(body.sourceTitle);
  if (body.sourceDescription) parts.push(String(body.sourceDescription).slice(0, 400));
  if (body.activityPreview) parts.push(String(body.activityPreview).slice(0, 400));
  if (body.gradePrompt) parts.push(String(body.gradePrompt).slice(0, 300));
  return parts.filter(Boolean).join(' — ').trim();
}

function chunkFingerprint(chunk) {
  const id = chunk && chunk.id ? String(chunk.id) : '';
  if (id) return 'id:' + id;
  return 'h:' + crypto.createHash('sha256')
    .update(String(chunk.content || '').slice(0, 500), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function dedupeChunks(chunks) {
  const seen = new Set();
  const out = [];
  (chunks || []).forEach(function (chunk) {
    if (!chunk || !chunk.content) return;
    const fp = chunkFingerprint(chunk);
    if (seen.has(fp)) return;
    seen.add(fp);
    out.push(chunk);
  });
  return out;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function inferSourceType(row) {
  if (row.contributor_email) return 'community_teacher';
  if (row.author === 'Waldrof AI' || row.author === 'Waldrof') return 'ai_learned';
  if (row.source_type) return row.source_type;
  return 'article';
}

function normalizeChunk(row, overrides) {
  const o = overrides || {};
  const title = row.title || row.document_title || 'ללא כותרת';
  const author = row.author || row.source_author || null;
  const chunk = {
    id: row.id,
    title: title,
    document_title: title,
    author: author,
    source_author: author,
    contributor_email: row.contributor_email || null,
    content: row.content,
    source_type: o.source_type || inferSourceType(row),
    topic: row.topic || null,
    grade_id: row.grade_id || null,
    score: o.score !== undefined ? o.score : Number(row.rank ?? row.score ?? row.similarity ?? 0),
  };
  return chunk;
}

function sortChunksForRag(chunks, body) {
  const topicKey = body && normalizeKey(body.topic);

  return (chunks || []).slice().map(function (chunk) {
    let score = Number(chunk.score) || 0;
    if (chunk.source_type === 'community_teacher') score += 3;
    if (chunk.source_type === 'ai_learned') score += 1;
    if (topicKey && chunk.title && normalizeKey(chunk.title).indexOf(topicKey) >= 0) score += 1.5;
    return Object.assign({}, chunk, { score: score });
  }).sort(function (a, b) {
    const pa = SOURCE_PRIORITY[a.source_type];
    const pb = SOURCE_PRIORITY[b.source_type];
    const aPri = pa !== undefined ? pa : 5;
    const bPri = pb !== undefined ? pb : 5;
    if (aPri !== bPri) return aPri - bPri;
    return (b.score || 0) - (a.score || 0);
  });
}

function formatChunk(chunk, index) {
  const title = chunk.title || chunk.document_title || 'ללא כותרת';
  const author = (chunk.author || chunk.source_author) ? ' — ' + (chunk.author || chunk.source_author) : '';
  let badge = '';
  if (chunk.source_type === 'community_teacher') {
    badge = ' [חומר מורה מהקהילה]';
  } else if (chunk.source_type === 'ai_learned') {
    badge = ' [תובנות ממחקרים קודמים]';
  } else if (chunk.source_type) {
    badge = ' [' + chunk.source_type + ']';
  }
  if (chunk.topic) badge += ' · נושא: ' + chunk.topic;
  return (
    '[' + index + '] «' + title + '»' + author + badge + '\n' +
    String(chunk.content || '').trim()
  );
}

function formatRagContext(chunks) {
  const list = dedupeChunks(chunks);
  if (!list.length) return '';
  return list.map(function (chunk, i) { return formatChunk(chunk, i + 1); }).join('\n\n');
}

function mergeRagContexts(priorContext, newChunks, maxChars) {
  const limit = maxChars || 14000;
  const prior = String(priorContext || '').trim();
  const fresh = formatRagContext(newChunks);
  if (!prior) return fresh.slice(0, limit);
  if (!fresh) return prior.slice(0, limit);
  const merged = prior + '\n\n--- ADDITIONAL RELEVANT EXCERPTS ---\n\n' + fresh;
  if (merged.length <= limit) return merged;
  return merged.slice(merged.length - limit);
}

async function supabaseRpc(functionName, payload) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    const err = new Error('Supabase not configured for RAG');
    err.code = 'NO_SUPABASE';
    throw err;
  }

  const res = await fetch(cfg.url + '/rest/v1/rpc/' + functionName, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error('Supabase RPC ' + functionName + ' failed (' + res.status + '): ' + text.slice(0, 240));
    err.statusCode = res.status;
    throw err;
  }

  if (!text || !text.trim()) return [];
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    throw new Error('Supabase RPC returned non-JSON');
  }
}

async function searchByKeywords(query, matchCount) {
  const rows = await supabaseRpc('search_knowledge_base_keywords', {
    search_query: query,
    match_count: matchCount || DEFAULT_MATCH_COUNT,
  });

  return (rows || []).map(function (row) {
    return normalizeChunk(row);
  });
}

async function searchCachedPedagogy(body, matchCount) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return [];

  const topic = String(body.topic || '').trim();
  const gradeId = String(body.currentGrade || body.gradeId || '').trim();
  if (!topic && !gradeId) return [];

  const params = new URLSearchParams();
  params.set('select', 'cache_key,phase,topic,grade_id,query_text,result_data,hit_count');
  params.set('order', 'hit_count.desc,created_at.desc');
  params.set('limit', String(matchCount || CACHE_MATCH_COUNT));
  if (topic) params.set('topic', 'ilike.*' + topic.slice(0, 80) + '*');
  if (gradeId) params.set('grade_id', 'eq.' + gradeId);

  const res = await fetch(cfg.url + '/rest/v1/cached_results?' + params.toString(), {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });

  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];

  return rows.map(function (row) {
    const content = knowledgeIngest.extractLearnableText(row.phase, row.result_data);
    if (!content || content.length < 80) return null;
    return normalizeChunk({
      id: 'cache:' + row.cache_key,
      title: 'מחקר קודם: ' + (row.topic || row.query_text || row.phase || 'כללי'),
      author: 'Waldrof',
      content: content.slice(0, 2200),
      rank: Number(row.hit_count) || 0,
    }, { source_type: 'ai_learned' });
  }).filter(Boolean);
}

async function searchCommunityByTopic(body, matchCount) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return [];

  const topic = String(body.topic || '').trim();
  if (!topic) return [];

  const params = new URLSearchParams();
  params.set('select', 'id,title,author,content,contributor_email,created_at');
  params.set('contributor_email', 'not.is.null');
  params.set('order', 'created_at.desc');
  params.set('limit', String(matchCount || 4));
  params.set('or', '(title.ilike.*' + topic.slice(0, 80) + '*,content.ilike.*' + topic.slice(0, 80) + '*)');

  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });

  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];

  return rows.map(function (row, index) {
    return normalizeChunk(row, {
      source_type: 'community_teacher',
      score: 10 - index * 0.1,
    });
  });
}

async function searchKnowledgeBase(query, options) {
  const q = String(query || '').trim();
  if (!q) return { chunks: [], method: 'none' };

  const matchCount = (options && options.matchCount) || DEFAULT_MATCH_COUNT;

  try {
    const keywordChunks = await searchByKeywords(q, matchCount);
    if (keywordChunks.length) {
      return { chunks: keywordChunks, method: 'keywords' };
    }
  } catch (textErr) {
    console.warn('[rag] keyword search failed:', textErr.message || textErr);
    if (textErr.code === 'NO_SUPABASE') throw textErr;
  }

  return { chunks: [], method: 'none' };
}

async function retrieveForRequest(body) {
  const phase = body && body.phase;
  if (!shouldRetrieveForPhase(phase)) {
    return {
      context: String(body && body.ragContext || '').trim(),
      chunks: [],
      meta: { enabled: false, phase: phase, method: 'skipped_phase', chunkCount: 0 },
    };
  }

  if (!isRagEnabled()) {
    return {
      context: String(body && body.ragContext || '').trim(),
      chunks: [],
      meta: { enabled: false, phase: phase, method: 'no_supabase', chunkCount: 0 },
    };
  }

  const query = buildQueryFromBody(body);
  if (!query) {
    return {
      context: String(body && body.ragContext || '').trim(),
      chunks: [],
      meta: { enabled: true, phase: phase, method: 'empty_query', chunkCount: 0 },
    };
  }

  const priorContext = String(body.ragContext || '').trim();
  const priorIds = Array.isArray(body.ragChunkIds) ? body.ragChunkIds.map(String) : [];

  let searchResult;
  let communityChunks = [];
  let cacheChunks = [];

  try {
    const parallel = await Promise.all([
      searchKnowledgeBase(query, { matchCount: DEFAULT_MATCH_COUNT }),
      searchCommunityByTopic(body, 4).catch(function () { return []; }),
      searchCachedPedagogy(body, CACHE_MATCH_COUNT).catch(function () { return []; }),
    ]);
    searchResult = parallel[0];
    communityChunks = parallel[1];
    cacheChunks = parallel[2];
  } catch (searchErr) {
    return {
      context: priorContext,
      chunks: [],
      meta: {
        enabled: true,
        phase: phase,
        method: 'error',
        chunkCount: 0,
        error: searchErr.message || String(searchErr),
      },
    };
  }

  const combined = sortChunksForRag(
    dedupeChunks(
      (searchResult.chunks || []).concat(communityChunks, cacheChunks)
    ),
    body
  ).slice(0, DEFAULT_MATCH_COUNT + CACHE_MATCH_COUNT);

  const freshChunks = combined.filter(function (chunk) {
    if (!chunk || !chunk.id) return true;
    return priorIds.indexOf(String(chunk.id)) < 0;
  });

  const mergedContext = mergeRagContexts(priorContext, freshChunks);
  const allIds = priorIds.slice();
  freshChunks.forEach(function (chunk) {
    if (chunk.id && allIds.indexOf(String(chunk.id)) < 0) allIds.push(String(chunk.id));
  });

  return {
    context: mergedContext,
    chunks: dedupeChunks(freshChunks),
    chunkIds: allIds,
    meta: {
      enabled: true,
      phase: phase,
      method: searchResult.method,
      chunkCount: freshChunks.length,
      communityCount: communityChunks.length,
      cacheCount: cacheChunks.length,
      totalContextChars: mergedContext.length,
      queryPreview: query.slice(0, 160),
    },
  };
}

module.exports = {
  TABLE_NAME,
  RAG_PHASES,
  isRagEnabled,
  shouldRetrieveForPhase,
  buildQueryFromBody,
  formatRagContext,
  mergeRagContexts,
  searchKnowledgeBase,
  retrieveForRequest,
};
