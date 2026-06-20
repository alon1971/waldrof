/**
 * knowledge_base RAG retrieval — keyword + semantic search for Drive archive enrichment.
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)
 * Optional: OPENAI_API_KEY for vector semantic matching via match_knowledge_base RPC.
 */
const crypto = require('crypto');
const knowledgeIngest = require('./knowledge-ingest');
const embeddings = require('./embeddings');
const env = require('./env');
const hebrewTopicMatch = require('../hebrew-topic-match');
const cacheDb = require('./cache');

const TABLE_NAME = 'knowledge_base';
const COMMUNITY_TABLE_NAME = 'community_knowledge_base';
const DEFAULT_MATCH_COUNT = 6;
const COMMUNITY_MATCH_COUNT = 6;
const CACHE_MATCH_COUNT = 3;
const RECENT_COMMUNITY_UPLOAD_LIMIT = 8;

/** Ingested Google Drive archive folders — supplementary enrichment only (web search is primary). */
const DRIVE_ARCHIVE_FOLDERS = [
  'חינוך',
  'קורס',
  'כיתה',
  'מחזור ראשון',
  'מחזור שני',
  'הרצאות',
  'waldorf',
  'waldorf project',
  'waldrof project',
  'שטיינר',
];

/** Broad pedagogical mesh — expands topic queries beyond literal folder-name matches. */
const PEDAGOGICAL_SEARCH_MESH = [
  'מערך',
  'שיעור',
  'פדגוגיה',
  'תקופה',
  'אנתרופוסופיה',
  'תקופת לימוד',
  'שיעור ראשי',
  'חינוך ולדורף',
  'ולדורף',
  'שטיינר',
  'כיתה',
  'תוכנית לימודים',
];

const DRIVE_PROJECT_FOLDER_KEYS = ['waldrof project', 'waldorf project'];
const SEMANTIC_MATCH_THRESHOLD = 0.22;
const RECENT_PROJECT_UPLOAD_LIMIT = 8;

const DRIVE_ENRICHMENT_PHASES = new Set([
  'grade',
  'topic',
  'pedagogy_deep_dive',
  'archive_search',
  'archive_summary',
]);

const SOURCE_PRIORITY = {
  community_archive: 0,
  community_teacher: 0,
  drive_archive: 2,
  ai_learned: 3,
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
  if (!body.chatGlobalScan) {
    if (body.topic) parts.push(body.topic);
    if (body.archiveQuery) parts.push(body.archiveQuery);
    if (body.gradeLabel) parts.push(body.gradeLabel);
  }
  if (body.archiveQuery && body.chatGlobalScan) parts.push(body.archiveQuery);
  if (body.activityTitle) parts.push(body.activityTitle);
  if (body.sourceTitle) parts.push(body.sourceTitle);
  if (body.sourceDescription) parts.push(String(body.sourceDescription).slice(0, 400));
  if (body.activityPreview) parts.push(String(body.activityPreview).slice(0, 400));
  if (!body.chatGlobalScan && body.gradePrompt) parts.push(String(body.gradePrompt).slice(0, 300));
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

/** Typo-tolerant folder key — treats waldrof / waldorf as equivalent. */
function normalizeFolderKey(value) {
  return normalizeKey(value)
    .replace(/\s+/g, ' ')
    .replace(/waldrof/g, 'waldorf');
}

function folderKeysEquivalent(a, b) {
  const left = normalizeFolderKey(a);
  const right = normalizeFolderKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.indexOf(right) >= 0 || right.indexOf(left) >= 0;
}

function buildExpandedSearchQuery(query, body) {
  const parts = [String(query || '').trim()];
  const mesh = PEDAGOGICAL_SEARCH_MESH.slice();
  if (body && !body.chatGlobalScan) {
    if (body.topic) parts.push(body.topic);
    if (body.gradeLabel) parts.push(body.gradeLabel);
  }
  if (body && body.archiveQuery) parts.push(body.archiveQuery);
  mesh.forEach(function (term) { parts.push(term); });
  return Array.from(new Set(
    parts.join(' ').split(/\s+/).filter(function (word) { return word.length > 1; })
  )).join(' ').trim();
}

function buildExpandedDriveSearchQuery(query, body) {
  return buildExpandedSearchQuery(query, body);
}

function buildExpandedCommunitySearchQuery(query, body) {
  const coreTerms = extractCoreSubjectTerms(query, body);
  const expanded = buildExpandedSearchQuery(query, body);
  const parts = [expanded].concat(coreTerms);
  return Array.from(new Set(
    parts.join(' ').split(/\s+/).filter(function (word) { return word.length > 1; })
  )).join(' ').trim();
}

/** Strip grade phrases and expand Hebrew core keywords for community fuzzy matching. */
function extractCoreSubjectTerms(query, body) {
  const parts = [];
  if (body && !body.chatGlobalScan && body.topic) parts.push(String(body.topic).trim());
  if (body && body.userMessage) parts.push(String(body.userMessage).trim());
  if (query) parts.push(String(query).trim());
  const combined = parts.filter(Boolean).join(' ').trim();
  if (!combined) return [];

  const terms = new Set();
  const normalized = typeof cacheDb.normalizeTopicQuery === 'function'
    ? cacheDb.normalizeTopicQuery(combined)
    : '';
  if (normalized) terms.add(normalized);

  hebrewTopicMatch.expandHebrewSearchTerms(combined, 10).forEach(function (term) {
    if (term && term.length >= 2) terms.add(term);
  });

  combined
    .replace(/[״"'`׳\-–—_,.;:!?()[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(function (word) { return word.length >= 2; })
    .forEach(function (word) { terms.add(word); });

  return Array.from(terms)
    .filter(function (term) { return term && term.length >= 2; })
    .sort(function (a, b) { return b.length - a.length; })
    .slice(0, 8);
}

function extractRowFolderHints(row) {
  const meta = rowMetadataObject(row);
  const hints = [];
  const metaKeys = [
    'drive_folder', 'folder', 'source_folder', 'driveFolder', 'parent_folder',
    'file_path', 'path', 'source_path', 'drive_path',
  ];
  metaKeys.forEach(function (key) {
    const val = String(meta[key] || '').trim();
    if (val) hints.push(val);
  });
  hints.push(String(row.title || row.document_title || ''));
  hints.push(String(row.author || row.source_author || ''));
  hints.push(String(row.content || '').slice(0, 240));
  return hints;
}

function inferSourceType(row) {
  if (matchesDriveArchiveFolder(row)) return 'drive_archive';
  if (row.contributor_email) return 'community_teacher';
  if (row.author === 'Waldrof AI' || row.author === 'Waldrof') return 'ai_learned';
  if (row.source_type) return row.source_type;
  return 'article';
}

function rowMetadataObject(row) {
  if (!row || !row.metadata) return {};
  if (typeof row.metadata === 'object') return row.metadata;
  try {
    return JSON.parse(String(row.metadata));
  } catch (e) {
    return {};
  }
}

function matchesDriveArchiveFolder(row) {
  if (!row) return false;
  const hints = extractRowFolderHints(row);
  return DRIVE_ARCHIVE_FOLDERS.some(function (folder) {
    const key = normalizeFolderKey(folder);
    if (!key) return false;
    return hints.some(function (hint) {
      const normalized = normalizeFolderKey(hint);
      if (!normalized) return false;
      if (folderKeysEquivalent(normalized, key)) return true;
      if (normalized.indexOf(key) >= 0 || key.indexOf(normalized) >= 0) return true;
      return false;
    });
  });
}

function isDriveProjectFolderRow(row) {
  if (!row) return false;
  return DRIVE_PROJECT_FOLDER_KEYS.some(function (folder) {
    return matchesDriveArchiveFolder(row) && extractRowFolderHints(row).some(function (hint) {
      return folderKeysEquivalent(hint, folder);
    });
  });
}

function scoreDriveChunkRelevance(chunk, query, body) {
  let score = Number(chunk && chunk.score) || 0;
  const queryKey = normalizeFolderKey(query);
  const topicKey = normalizeFolderKey(body && body.topic);
  const title = normalizeFolderKey(chunk && chunk.title);
  const content = normalizeFolderKey(chunk && chunk.content && chunk.content.slice(0, 600));

  if (topicKey && title.indexOf(topicKey) >= 0) score += 4;
  if (topicKey && content.indexOf(topicKey) >= 0) score += 2.5;
  if (queryKey && content.indexOf(queryKey) >= 0) score += 1.5;
  if (chunk && chunk.source_type === 'drive_archive') score += 1;
  if (chunk && isDriveProjectFolderRow(chunk)) score += 2;
  PEDAGOGICAL_SEARCH_MESH.forEach(function (term, index) {
    const key = normalizeFolderKey(term);
    if (!key) return;
    if (title.indexOf(key) >= 0 || content.indexOf(key) >= 0) {
      score += Math.max(0.35, 1.2 - index * 0.05);
    }
  });
  return score;
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
    metadata: rowMetadataObject(row),
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
    if (chunk.source_type === 'community_archive' || chunk.source_type === 'community_teacher') score += 3;
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
  if (chunk.source_type === 'drive_archive') {
    badge = ' [ארכיון Drive פרטי — העשרה משלימה]';
  } else if (chunk.source_type === 'community_archive') {
    badge = ' [ארכיון קהילה משותף — העשרה משלימה]';
  } else if (chunk.source_type === 'community_teacher') {
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

function formatSeparatedRagContext(driveChunks, communityChunks) {
  const sections = [];
  const drive = formatRagContext(driveChunks);
  const community = formatRagContext(communityChunks);

  if (drive) {
    sections.push(
      '--- PRIVATE DRIVE ARCHIVE (Alon — ingested Google Drive folders) ---\n' + drive
    );
  }
  if (community) {
    sections.push(
      '--- SHARED COMMUNITY ARCHIVE (teacher uploads — community_knowledge_base) ---\n' + community
    );
  }
  return sections.join('\n\n');
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

  const globalScan = Boolean(body && body.chatGlobalScan);
  const topic = globalScan
    ? String(body.userMessage || body.topic || '').trim()
    : String(body.topic || '').trim();
  const gradeId = globalScan
    ? ''
    : String(body.currentGrade || body.gradeId || '').trim();
  if (!topic && !gradeId) return [];

  const params = new URLSearchParams();
  params.set('select', 'cache_key,phase,topic,grade_id,query_text,result_data,hit_count');
  params.set('order', 'hit_count.desc,created_at.desc');
  params.set('limit', String(matchCount || CACHE_MATCH_COUNT));
  if (topic) {
    params.set('or', '(topic.ilike.*' + topic.slice(0, 80) + '*,query_text.ilike.*' + topic.slice(0, 80) + '*)');
  }
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

  const topic = String(body.topic || body.userMessage || '').trim();
  if (!topic) return [];

  const terms = extractCoreSubjectTerms(topic, body);
  if (!terms.length) terms.push(topic.slice(0, 80));

  const orParts = terms.map(function (term) {
    return 'title.ilike.*' + term + '*,topic.ilike.*' + term + '*,content.ilike.*' + term + '*';
  });

  const params = new URLSearchParams();
  params.set(
    'select',
    'id,title,author,content,contributor_email,contributor_name,grade_id,topic,file_path,file_name,created_at'
  );
  params.set('order', 'created_at.desc');
  params.set('limit', String(matchCount || 4));
  params.set('or', '(' + orParts.join(',') + ')');

  const gradeId = String((body && (body.currentGrade || body.gradeId)) || '').trim();
  if (gradeId && !(body && body.chatGlobalScan)) params.set('grade_id', 'eq.' + gradeId);

  const res = await fetch(cfg.url + '/rest/v1/' + COMMUNITY_TABLE_NAME + '?' + params.toString(), {
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

async function searchDriveArchiveSemantic(query, matchCount) {
  if (!embeddings.resolveEmbeddingApiKey()) return [];

  let vector;
  try {
    vector = await embeddings.embedText(query);
  } catch (embedErr) {
    console.warn('[rag] drive semantic embed failed:', embedErr.message || embedErr);
    return [];
  }
  if (!Array.isArray(vector) || !vector.length) return [];

  let rows;
  try {
    rows = await supabaseRpc('match_knowledge_base', {
      query_embedding: vector,
      match_count: (matchCount || DEFAULT_MATCH_COUNT) * 4,
      match_threshold: SEMANTIC_MATCH_THRESHOLD,
    });
  } catch (rpcErr) {
    console.warn('[rag] match_knowledge_base failed:', rpcErr.message || rpcErr);
    return [];
  }

  return (rows || [])
    .map(function (row, index) {
      return normalizeChunk(row, {
        source_type: matchesDriveArchiveFolder(row) ? 'drive_archive' : inferSourceType(row),
        score: Number(row.similarity || 0) * 10 + (8 - index * 0.1),
      });
    })
    .filter(matchesDriveArchiveFolder)
    .slice(0, matchCount || DEFAULT_MATCH_COUNT);
}

async function searchRecentDriveProjectUploads(matchCount) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return [];

  const orParts = DRIVE_PROJECT_FOLDER_KEYS.flatMap(function (folder) {
    return [
      'title.ilike.*' + folder + '*',
      'content.ilike.*' + folder + '*',
    ];
  });

  const params = new URLSearchParams();
  params.set(
    'select',
    'id,title,author,content,metadata,contributor_email,source_type,grade_id,topic,document_title,source_author,created_at'
  );
  params.set('order', 'created_at.desc');
  params.set('limit', String((matchCount || RECENT_PROJECT_UPLOAD_LIMIT) * 3));
  params.set('or', '(' + orParts.join(',') + ')');

  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });

  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];

  return rows
    .filter(function (row) { return matchesDriveArchiveFolder(row); })
    .map(function (row, index) {
      return normalizeChunk(row, {
        source_type: 'drive_archive',
        score: 14 - index * 0.15,
      });
    })
    .slice(0, matchCount || RECENT_PROJECT_UPLOAD_LIMIT);
}

async function searchDriveArchiveEnrichment(query, body, matchCount) {
  const expandedQuery = buildExpandedDriveSearchQuery(query, body);
  const methods = [];

  const parallel = await Promise.all([
    searchDriveArchiveSemantic(expandedQuery, matchCount).catch(function () { return []; }),
    searchByKeywords(expandedQuery, matchCount * 4).catch(function () { return []; }),
    searchDriveArchiveByContent(expandedQuery, matchCount).catch(function () { return []; }),
    searchRecentDriveProjectUploads(RECENT_PROJECT_UPLOAD_LIMIT).catch(function () { return []; }),
  ]);

  const semanticChunks = parallel[0];
  const keywordChunks = (parallel[1] || []).filter(matchesDriveArchiveFolder);
  const contentChunks = parallel[2] || [];
  const recentProjectChunks = parallel[3] || [];

  if (semanticChunks.length) methods.push('semantic');
  if (keywordChunks.length) methods.push('keywords');
  if (contentChunks.length) methods.push('content');
  if (recentProjectChunks.length) methods.push('recent_project');

  const ranked = dedupeChunks(
    semanticChunks.concat(keywordChunks, contentChunks, recentProjectChunks)
  )
    .map(function (chunk) {
      return Object.assign({}, chunk, {
        score: scoreDriveChunkRelevance(chunk, expandedQuery, body),
      });
    })
    .sort(function (a, b) { return (b.score || 0) - (a.score || 0); })
    .slice(0, matchCount || DEFAULT_MATCH_COUNT);

  return {
    chunks: ranked,
    method: methods.length ? ('drive_' + methods.join('+')) : 'none',
    expandedQuery: expandedQuery,
  };
}

async function searchKnowledgeBase(query, options) {
  const q = String(query || '').trim();
  if (!q) return { chunks: [], method: 'none' };

  const matchCount = (options && options.matchCount) || DEFAULT_MATCH_COUNT;
  const driveArchiveOnly = Boolean(options && options.driveArchiveOnly);
  const body = (options && options.body) || null;

  if (driveArchiveOnly) {
    const driveResult = await searchDriveArchiveEnrichment(q, body, matchCount);
    if (driveResult.chunks.length) {
      return {
        chunks: driveResult.chunks,
        method: driveResult.method,
        expandedQuery: driveResult.expandedQuery,
      };
    }
    return { chunks: [], method: 'none', expandedQuery: driveResult.expandedQuery };
  }

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

async function searchCommunityKeywords(query, matchCount) {
  const rows = await supabaseRpc('search_community_knowledge_base_keywords', {
    search_query: query,
    match_count: matchCount || COMMUNITY_MATCH_COUNT,
  });

  return (rows || []).map(function (row) {
    return normalizeChunk(row, { source_type: 'community_archive' });
  });
}

async function searchCommunitySemantic(query, matchCount) {
  if (!embeddings.resolveEmbeddingApiKey()) return [];

  let vector;
  try {
    vector = await embeddings.embedText(query);
  } catch (embedErr) {
    console.warn('[rag] community semantic embed failed:', embedErr.message || embedErr);
    return [];
  }
  if (!Array.isArray(vector) || !vector.length) return [];

  let rows;
  try {
    rows = await supabaseRpc('match_community_knowledge_base', {
      query_embedding: vector,
      match_count: (matchCount || COMMUNITY_MATCH_COUNT) * 3,
      match_threshold: SEMANTIC_MATCH_THRESHOLD,
    });
  } catch (rpcErr) {
    console.warn('[rag] match_community_knowledge_base failed:', rpcErr.message || rpcErr);
    return [];
  }

  return (rows || []).map(function (row, index) {
    return normalizeChunk(row, {
      source_type: 'community_archive',
      score: Number(row.similarity || 0) * 10 + (8 - index * 0.1),
    });
  }).slice(0, matchCount || COMMUNITY_MATCH_COUNT);
}

async function searchCommunityByContent(query, body, matchCount) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return [];

  const q = String(query || '').trim();
  if (!q) return [];

  const coreTerms = extractCoreSubjectTerms(q, body);
  const terms = coreTerms.length
    ? coreTerms
    : q
      .replace(/[״"'`׳\-–—_,.;:!?()[\]{}]/g, ' ')
      .split(/\s+/)
      .filter(function (word) { return word.length > 2; })
      .slice(0, 4);
  if (!terms.length) terms.push(q.slice(0, 80));

  const meshTerms = PEDAGOGICAL_SEARCH_MESH.slice(0, 8);
  const titleOrParts = terms.concat(meshTerms).map(function (term) {
    return 'title.ilike.*' + term + '*';
  });
  const subjectOrParts = terms.concat(meshTerms).map(function (term) {
    return 'topic.ilike.*' + term + '*';
  });
  const contentOrParts = terms.concat(meshTerms).map(function (term) {
    return 'content.ilike.*' + term + '*';
  });

  const params = new URLSearchParams();
  params.set(
    'select',
    'id,title,author,content,contributor_email,contributor_name,grade_id,topic,created_at'
  );
  params.set('order', 'created_at.desc');
  params.set('limit', String((matchCount || COMMUNITY_MATCH_COUNT) * 6));
  params.set('or', '(' + titleOrParts.concat(subjectOrParts, contentOrParts).join(',') + ')');

  const gradeId = String((body && (body.currentGrade || body.gradeId)) || '').trim();
  if (gradeId && !(body && body.chatGlobalScan)) params.set('grade_id', 'eq.' + gradeId);

  const res = await fetch(cfg.url + '/rest/v1/' + COMMUNITY_TABLE_NAME + '?' + params.toString(), {
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
      source_type: 'community_archive',
      score: 12 - index * 0.1,
    });
  }).slice(0, matchCount || COMMUNITY_MATCH_COUNT);
}

async function searchRecentCommunityUploads(matchCount) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return [];

  const params = new URLSearchParams();
  params.set(
    'select',
    'id,title,author,content,contributor_email,contributor_name,grade_id,topic,created_at'
  );
  params.set('order', 'created_at.desc');
  params.set('limit', String(matchCount || RECENT_COMMUNITY_UPLOAD_LIMIT));

  const res = await fetch(cfg.url + '/rest/v1/' + COMMUNITY_TABLE_NAME + '?' + params.toString(), {
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
      source_type: 'community_archive',
      score: 14 - index * 0.15,
    });
  });
}

function scoreCommunityChunkRelevance(chunk, query, body) {
  let score = Number(chunk && chunk.score) || 0;
  const queryKey = normalizeFolderKey(query);
  const topicKey = normalizeFolderKey(body && body.topic);
  const title = normalizeFolderKey(chunk && chunk.title);
  const content = normalizeFolderKey(chunk && chunk.content && chunk.content.slice(0, 600));

  if (topicKey && title.indexOf(topicKey) >= 0) score += 4;
  if (topicKey && content.indexOf(topicKey) >= 0) score += 2.5;
  if (queryKey && content.indexOf(queryKey) >= 0) score += 1.5;
  if (chunk && chunk.source_type === 'community_archive') score += 1;
  if (chunk && chunk.contributor_email) score += 0.5;
  PEDAGOGICAL_SEARCH_MESH.forEach(function (term, index) {
    const key = normalizeFolderKey(term);
    if (!key) return;
    if (title.indexOf(key) >= 0 || content.indexOf(key) >= 0) {
      score += Math.max(0.35, 1.2 - index * 0.05);
    }
  });
  return score;
}

async function searchCommunityKnowledgeEnrichment(query, body, matchCount) {
  const expandedQuery = buildExpandedCommunitySearchQuery(query, body);
  const methods = [];

  const parallel = await Promise.all([
    searchCommunitySemantic(expandedQuery, matchCount).catch(function () { return []; }),
    searchCommunityKeywords(expandedQuery, matchCount * 3).catch(function () { return []; }),
    searchCommunityByContent(expandedQuery, body, matchCount).catch(function () { return []; }),
    searchRecentCommunityUploads(RECENT_COMMUNITY_UPLOAD_LIMIT).catch(function () { return []; }),
  ]);

  const semanticChunks = parallel[0];
  const keywordChunks = parallel[1] || [];
  const contentChunks = parallel[2] || [];
  const recentChunks = parallel[3] || [];

  if (semanticChunks.length) methods.push('semantic');
  if (keywordChunks.length) methods.push('keywords');
  if (contentChunks.length) methods.push('content');
  if (recentChunks.length) methods.push('recent');

  const ranked = dedupeChunks(
    semanticChunks.concat(keywordChunks, contentChunks, recentChunks)
  )
    .map(function (chunk) {
      return Object.assign({}, chunk, {
        score: scoreCommunityChunkRelevance(chunk, expandedQuery, body),
      });
    })
    .sort(function (a, b) { return (b.score || 0) - (a.score || 0); })
    .slice(0, matchCount || COMMUNITY_MATCH_COUNT);

  return {
    chunks: ranked,
    method: methods.length ? ('community_' + methods.join('+')) : 'none',
    expandedQuery: expandedQuery,
  };
}

async function searchDriveArchiveByContent(query, matchCount) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return [];

  const q = String(query || '').trim();
  if (!q) return [];

  const terms = q
    .replace(/[״"'`׳\-–—_,.;:!?()[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(function (word) { return word.length > 2; })
    .slice(0, 4);
  if (!terms.length) terms.push(q.slice(0, 80));

  const meshTerms = PEDAGOGICAL_SEARCH_MESH.slice(0, 6);
  const folderOrParts = DRIVE_ARCHIVE_FOLDERS.map(function (folder) {
    return 'title.ilike.*' + folder + '*';
  });
  const contentOrParts = terms.concat(meshTerms).map(function (term) {
    return 'content.ilike.*' + term + '*';
  });

  const params = new URLSearchParams();
  params.set('select', 'id,title,author,content,metadata,contributor_email,source_type,grade_id,topic,document_title,source_author');
  params.set('order', 'created_at.desc');
  params.set('limit', String((matchCount || DEFAULT_MATCH_COUNT) * 6));
  params.set('or', '(' + folderOrParts.concat(contentOrParts).join(',') + ')');

  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });

  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];

  return rows
    .filter(matchesDriveArchiveFolder)
    .map(function (row, index) {
      return normalizeChunk(row, {
        source_type: 'drive_archive',
        score: 12 - index * 0.1,
      });
    })
    .slice(0, matchCount || DEFAULT_MATCH_COUNT);
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

  const chatCommunityOnly = phase === 'chat_followup' || body.chatCommunityRagOnly === true;
  const driveArchiveEnrichment = !chatCommunityOnly && DRIVE_ENRICHMENT_PHASES.has(phase);
  let driveResult = { chunks: [], method: 'none' };
  let communityResult = { chunks: [], method: 'none' };
  let legacyKeywordChunks = [];
  let communityLegacyChunks = [];
  let cacheChunks = [];

  try {
    if (chatCommunityOnly) {
      communityResult = await searchCommunityKnowledgeEnrichment(query, body, COMMUNITY_MATCH_COUNT)
        .catch(function () { return { chunks: [], method: 'none' }; });
      communityLegacyChunks = await searchCommunityByTopic(body, 4).catch(function () { return []; });
    } else if (driveArchiveEnrichment) {
      const parallel = await Promise.all([
        searchDriveArchiveEnrichment(query, body, DEFAULT_MATCH_COUNT).catch(function () { return { chunks: [], method: 'none' }; }),
        searchCommunityKnowledgeEnrichment(query, body, COMMUNITY_MATCH_COUNT).catch(function () { return { chunks: [], method: 'none' }; }),
      ]);
      driveResult = parallel[0];
      communityResult = parallel[1];
    } else {
      const parallel = await Promise.all([
        searchKnowledgeBase(query, { matchCount: DEFAULT_MATCH_COUNT }),
        searchCommunityKnowledgeEnrichment(query, body, COMMUNITY_MATCH_COUNT).catch(function () { return { chunks: [], method: 'none' }; }),
        searchCommunityByTopic(body, 4).catch(function () { return []; }),
        searchCachedPedagogy(body, CACHE_MATCH_COUNT).catch(function () { return []; }),
      ]);
      legacyKeywordChunks = (parallel[0] && parallel[0].chunks) || [];
      communityResult = parallel[1];
      communityLegacyChunks = parallel[2];
      cacheChunks = parallel[3];
    }
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

  const driveChunks = sortChunksForRag(driveResult.chunks || [], body);
  const communityChunks = sortChunksForRag(
    dedupeChunks(
      chatCommunityOnly
        ? (communityResult.chunks || []).concat(communityLegacyChunks)
        : (communityResult.chunks || []).concat(communityLegacyChunks, legacyKeywordChunks)
    ),
    body
  ).slice(0, COMMUNITY_MATCH_COUNT + 2);

  const combinedForIds = dedupeChunks(
    chatCommunityOnly
      ? communityChunks
      : driveChunks.concat(communityChunks, cacheChunks)
  ).slice(0, DEFAULT_MATCH_COUNT + COMMUNITY_MATCH_COUNT + CACHE_MATCH_COUNT);

  const freshChunks = combinedForIds.filter(function (chunk) {
    if (!chunk || !chunk.id) return true;
    return priorIds.indexOf(String(chunk.id)) < 0;
  });

  const freshDrive = freshChunks.filter(function (c) { return c.source_type === 'drive_archive'; });
  const freshCommunity = freshChunks.filter(function (c) {
    return c.source_type === 'community_archive' || c.source_type === 'community_teacher';
  });
  const freshOther = freshChunks.filter(function (c) {
    return c.source_type !== 'drive_archive' &&
      c.source_type !== 'community_archive' &&
      c.source_type !== 'community_teacher';
  });

  const separatedFresh = formatSeparatedRagContext(freshDrive, freshCommunity);
  const otherContext = formatRagContext(freshOther);
  let mergedContext = priorContext;
  const freshParts = [];
  if (separatedFresh) freshParts.push(separatedFresh);
  if (otherContext) freshParts.push(otherContext);

  if (freshParts.length) {
    const freshBlock = freshParts.join('\n\n');
    if (!mergedContext) {
      mergedContext = freshBlock;
    } else {
      mergedContext = mergedContext + '\n\n--- ADDITIONAL RELEVANT EXCERPTS ---\n\n' + freshBlock;
    }
    if (mergedContext.length > 14000) mergedContext = mergedContext.slice(mergedContext.length - 14000);
  }

  const allIds = priorIds.slice();
  freshChunks.forEach(function (chunk) {
    if (chunk.id && allIds.indexOf(String(chunk.id)) < 0) allIds.push(String(chunk.id));
  });

  const methodParts = [];
  if (driveResult.method && driveResult.method !== 'none') methodParts.push(driveResult.method);
  if (communityResult.method && communityResult.method !== 'none') methodParts.push(communityResult.method);

  return {
    context: mergedContext,
    driveContext: formatRagContext(freshDrive),
    communityContext: formatRagContext(freshCommunity),
    chunks: dedupeChunks(freshChunks),
    chunkIds: allIds,
    meta: {
      enabled: true,
      phase: phase,
      method: methodParts.length ? methodParts.join(' | ') : 'none',
      driveMethod: driveResult.method,
      communityMethod: communityResult.method,
      driveArchiveEnrichment: driveArchiveEnrichment,
      chunkCount: freshChunks.length,
      driveCount: freshDrive.length,
      communityCount: freshCommunity.length,
      cacheCount: cacheChunks.length,
      totalContextChars: mergedContext.length,
      queryPreview: query.slice(0, 160),
      expandedQueryPreview: driveResult.expandedQuery
        ? String(driveResult.expandedQuery).slice(0, 200)
        : (communityResult.expandedQuery ? String(communityResult.expandedQuery).slice(0, 200) : undefined),
      liveRefresh: true,
      threeWayRetrieval: true,
    },
  };
}

module.exports = {
  TABLE_NAME,
  COMMUNITY_TABLE_NAME,
  RAG_PHASES,
  DRIVE_ARCHIVE_FOLDERS,
  DRIVE_PROJECT_FOLDER_KEYS,
  PEDAGOGICAL_SEARCH_MESH,
  DRIVE_ENRICHMENT_PHASES,
  isRagEnabled,
  shouldRetrieveForPhase,
  buildQueryFromBody,
  buildExpandedDriveSearchQuery,
  buildExpandedCommunitySearchQuery,
  extractCoreSubjectTerms,
  formatRagContext,
  formatSeparatedRagContext,
  mergeRagContexts,
  matchesDriveArchiveFolder,
  searchKnowledgeBase,
  searchDriveArchiveEnrichment,
  searchCommunityKnowledgeEnrichment,
  retrieveForRequest,
};
