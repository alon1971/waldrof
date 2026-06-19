/**
 * Parse, chunk, and index teacher community uploads into community_knowledge_base.
 * Supports PDF, Word (.docx), and plain text. Optional OpenAI embeddings on insert.
 */
const chunks = require('./knowledge-chunks');
const embeddings = require('./embeddings');
const env = require('./env');

const TABLE_NAME = 'community_knowledge_base';
const MATERIALS_TABLE = 'community_materials';
const STORAGE_BUCKET = 'community-uploads';
const MIN_TEXT_LENGTH = 80;
const BATCH_SIZE = 20;
const INDEXABLE_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.txt', '.md']);

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServerKey(),
  };
}

function isIngestEnabled() {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && cfg.key);
}

function extensionFromName(fileName) {
  const name = String(fileName || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

function isIndexableFileName(fileName) {
  const ext = extensionFromName(fileName);
  return INDEXABLE_EXTENSIONS.has(ext);
}

function parseCommunityNotesTitle(rawNotes) {
  const notes = String(rawNotes || '');
  const titleMatch = notes.match(/\[title:([^\]]+)\]/);
  if (titleMatch) return titleMatch[1].trim();
  const descMatch = notes.match(/\[desc:([^\]]+)\]/);
  if (descMatch) return descMatch[1].trim();
  return '';
}

function materialDisplayTitle(material) {
  if (!material) return 'חומר קהילתי';
  const notes = material.notes || material.description || '';
  return parseCommunityNotesTitle(notes) || material.file_name || material.topic || 'חומר קהילתי';
}

async function parseFileBuffer(buffer, fileName, mimeType) {
  const ext = extensionFromName(fileName);
  const type = String(mimeType || '').toLowerCase();

  if (ext === '.txt' || ext === '.md' || type === 'text/plain' || type === 'text/markdown') {
    return chunks.normalizeText(buffer.toString('utf8'));
  }

  if (ext === '.pdf' || type === 'application/pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const result = await pdfParse(buffer);
      return chunks.normalizeText(result && result.text ? result.text : '');
    } catch (pdfErr) {
      throw new Error('PDF parsing failed: ' + (pdfErr.message || pdfErr));
    }
  }

  if (ext === '.docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: buffer });
      return chunks.normalizeText(result && result.value ? result.value : '');
    } catch (docErr) {
      throw new Error('Word document parsing failed: ' + (docErr.message || docErr));
    }
  }

  if (ext === '.doc' || type === 'application/msword') {
    const plain = chunks.normalizeText(buffer.toString('utf8'));
    if (plain.length >= MIN_TEXT_LENGTH && /[\u0590-\u05FFa-zA-Z]{4,}/.test(plain)) {
      return plain;
    }
    throw new Error('Legacy .doc format is not supported — please upload .docx, PDF, or plain text');
  }

  const fallback = chunks.normalizeText(buffer.toString('utf8'));
  if (fallback.length >= MIN_TEXT_LENGTH) return fallback;
  throw new Error('Unsupported file type for community indexing: ' + (ext || type || 'unknown'));
}

async function fetchStorageFile(filePath) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key || !filePath) {
    throw new Error('Supabase storage not configured');
  }

  const enc = encodeURIComponent(String(filePath).replace(/^\/+/, ''));
  const publicUrl = cfg.url + '/storage/v1/object/public/' + STORAGE_BUCKET + '/' + enc;
  let res = await fetch(publicUrl);
  if (!res.ok) {
    res = await fetch(cfg.url + '/storage/v1/object/' + STORAGE_BUCKET + '/' + enc, {
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
      },
    });
  }
  if (!res.ok) {
    throw new Error('Storage download failed (' + res.status + ')');
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function supabaseGet(relativePath) {
  const cfg = getSupabaseConfig();
  const res = await fetch(cfg.url + relativePath, {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

/** All catalog rows for a community topic folder (grade + topic). */
async function fetchCommunityMaterialsByTopic(gradeId, topic) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key || !gradeId || !topic) return [];

  const params = new URLSearchParams();
  params.set('select', 'id,grade_level,topic,file_path,file_name,notes,created_at');
  params.set('grade_level', 'eq.' + String(gradeId));
  params.set('topic', 'eq.' + String(topic));
  params.set('order', 'created_at.asc');
  params.set('limit', '100');

  const rows = await supabaseGet('/rest/v1/' + MATERIALS_TABLE + '?' + params.toString());
  return Array.isArray(rows) ? rows : [];
}

/** List objects in community-uploads under a storage prefix (nested bundle files). */
async function listStorageObjects(prefix, limit) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key || !prefix) return [];

  const res = await fetch(cfg.url + '/storage/v1/object/list/' + STORAGE_BUCKET, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
    body: JSON.stringify({
      prefix: String(prefix).replace(/^\/+/, ''),
      limit: limit || 200,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
    }),
  });

  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(function (row) { return row && row.name && !row.name.endsWith('/'); })
    .map(function (row) {
      const base = String(prefix).replace(/^\/+|\/+$/g, '');
      return base ? base + '/' + row.name : row.name;
    });
}

async function discoverBundleStoragePaths(gradeId, topic, knownPaths) {
  const paths = new Set((knownPaths || []).filter(Boolean));
  const gradePrefix = 'community/' + String(gradeId) + '/';
  const listed = await listStorageObjects(gradePrefix, 300);
  listed.forEach(function (path) { paths.add(path); });

  const topicKey = String(topic || '').trim().toLowerCase();
  if (topicKey) {
    listed.forEach(function (path) {
      const segments = String(path).split('/');
      const fileName = segments[segments.length - 1] || '';
      if (fileName && fileName.toLowerCase().indexOf(topicKey.slice(0, Math.min(8, topicKey.length))) >= 0) {
        paths.add(path);
      }
    });
  }

  return Array.from(paths);
}

async function embedRowsIfPossible(rows) {
  if (!embeddings.resolveEmbeddingApiKey()) return rows;
  const texts = rows.map(function (row) { return row.content; });
  try {
    const vectors = await embeddings.embedTexts(texts);
    return rows.map(function (row, index) {
      if (vectors[index]) row.embedding = vectors[index];
      return row;
    });
  } catch (embedErr) {
    console.warn('[community-ingest] embedding skipped:', embedErr.message || embedErr);
    return rows;
  }
}

async function supabaseInsertRows(rows) {
  const cfg = getSupabaseConfig();
  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(TABLE_NAME + ' insert failed (' + res.status + '): ' + text.slice(0, 300));
    err.statusCode = res.status;
    err.responseText = text;
    throw err;
  }
  return text ? JSON.parse(text) : [];
}

async function deleteBySourceMaterialId(materialId) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key || !materialId) return;
  await fetch(
    cfg.url + '/rest/v1/' + TABLE_NAME + '?source_material_id=eq.' + encodeURIComponent(materialId),
    {
      method: 'DELETE',
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
      },
    }
  ).catch(function () { /* non-fatal */ });
}

function buildChunkRows(text, meta) {
  const m = meta || {};
  const title = m.title || 'חומר קהילתי';
  const author = m.author || m.contributorName || null;
  const chunkList = chunks.chunkText(text, m.chunkOptions || { minChars: 100, maxChars: 1400 });
  if (!chunkList.length) return [];

  return chunkList.map(function (content, index) {
    const row = {
      content: content,
      title: title,
      author: author,
      chunk_index: index,
    };
    if (m.contributorEmail) row.contributor_email = m.contributorEmail;
    if (m.contributorName) row.contributor_name = m.contributorName;
    if (m.gradeId) row.grade_id = String(m.gradeId);
    if (m.topic) row.topic = m.topic;
    if (m.sourceMaterialId) row.source_material_id = m.sourceMaterialId;
    if (m.fileName) row.file_name = m.fileName;
    if (m.filePath) row.file_path = m.filePath;
    if (m.fileType) row.file_type = m.fileType;
    const metadata = Object.assign({}, m.metadata || {});
    if (m.bundleTopic) metadata.bundle_topic = m.bundleTopic;
    if (m.internalFileName) metadata.internal_file_name = m.internalFileName;
    if (m.indexOrigin) metadata.index_origin = m.indexOrigin;
    if (Object.keys(metadata).length) row.metadata = metadata;
    return row;
  });
}

async function insertCommunityText(text, meta) {
  const normalized = chunks.normalizeText(text);
  if (normalized.length < MIN_TEXT_LENGTH) {
    return { inserted: 0, chunks: 0, reason: 'too_short' };
  }

  if (meta && meta.sourceMaterialId) {
    await deleteBySourceMaterialId(meta.sourceMaterialId);
  }

  const rows = buildChunkRows(normalized, meta);
  if (!rows.length) return { inserted: 0, chunks: 0, reason: 'no_chunks' };

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = await embedRowsIfPossible(rows.slice(i, i + BATCH_SIZE));
    const saved = await supabaseInsertRows(batch);
    inserted += Array.isArray(saved) ? saved.length : 0;
  }

  return { inserted: inserted, chunks: rows.length };
}

async function ingestMaterialRecord(material, options) {
  const opts = options || {};
  const gradeId = String(material.grade_level || opts.gradeId || '').trim();
  const bundleTopic = String(material.topic || opts.bundleTopic || '').trim();
  const filePath = String(material.file_path || '').trim();
  const fileName = String(material.file_name || '').trim();
  const fileType = String(material.file_type || '').trim();
  const isLink = /^https?:\/\//i.test(filePath);

  if (!filePath || isLink) {
    return { skipped: true, reason: isLink ? 'external_link_not_indexed' : 'missing_path', materialId: material.id };
  }
  if (!isIndexableFileName(fileName || filePath)) {
    return { skipped: true, reason: 'unsupported_type', materialId: material.id };
  }

  let text = '';
  try {
    const buffer = await fetchStorageFile(filePath);
    text = await parseFileBuffer(buffer, fileName || filePath, fileType);
  } catch (parseErr) {
    return { skipped: true, reason: 'parse_failed', materialId: material.id, error: parseErr.message || String(parseErr) };
  }

  if (!text || text.length < MIN_TEXT_LENGTH) {
    return { skipped: true, reason: 'insufficient_text', materialId: material.id };
  }

  const displayTitle = materialDisplayTitle(material);
  const internalFileName = fileName || displayTitle;
  const fileNameHeader = internalFileName ? ('[קובץ: ' + internalFileName + ']\n') : '';
  const indexedText = fileNameHeader + text;

  const result = await insertCommunityText(indexedText, {
    title: displayTitle,
    author: opts.author || null,
    contributorEmail: opts.contributorEmail || null,
    contributorName: opts.contributorName || opts.author || null,
    gradeId: gradeId || null,
    topic: bundleTopic || null,
    sourceMaterialId: material.id || null,
    fileName: internalFileName || null,
    filePath: filePath || null,
    fileType: fileType || null,
    bundleTopic: bundleTopic || null,
    internalFileName: internalFileName || null,
    indexOrigin: 'bundle_file',
    metadata: {
      origin: opts.origin || 'community_bundle',
      ingested_at: new Date().toISOString(),
      bundle_topic: bundleTopic || null,
      internal_file_name: internalFileName || null,
      catalog_material_id: material.id || null,
    },
    chunkOptions: { minChars: 100, maxChars: 1400 },
  });

  return Object.assign({ ok: true, skipped: false, materialId: material.id, fileName: internalFileName }, result);
}

async function ingestStoragePathRecord(filePath, options) {
  const opts = options || {};
  const path = String(filePath || '').trim();
  if (!path || /^https?:\/\//i.test(path)) {
    return { skipped: true, reason: 'invalid_path' };
  }

  const segments = path.split('/');
  const fileName = opts.fileName || segments[segments.length - 1] || path;
  if (!isIndexableFileName(fileName)) {
    return { skipped: true, reason: 'unsupported_type', filePath: path };
  }

  let text = '';
  try {
    const buffer = await fetchStorageFile(path);
    text = await parseFileBuffer(buffer, fileName, opts.fileType || '');
  } catch (parseErr) {
    return { skipped: true, reason: 'parse_failed', filePath: path, error: parseErr.message || String(parseErr) };
  }

  if (!text || text.length < MIN_TEXT_LENGTH) {
    return { skipped: true, reason: 'insufficient_text', filePath: path };
  }

  const bundleTopic = String(opts.bundleTopic || opts.topic || '').trim();
  const internalFileName = fileName;
  const indexedText = '[קובץ: ' + internalFileName + ']\n' + text;

  const result = await insertCommunityText(indexedText, {
    title: opts.title || internalFileName,
    author: opts.author || null,
    contributorEmail: opts.contributorEmail || null,
    contributorName: opts.contributorName || opts.author || null,
    gradeId: opts.gradeId || null,
    topic: bundleTopic || null,
    sourceMaterialId: opts.sourceMaterialId || null,
    fileName: internalFileName,
    filePath: path,
    fileType: opts.fileType || null,
    bundleTopic: bundleTopic || null,
    internalFileName: internalFileName,
    indexOrigin: 'storage_bundle',
    metadata: {
      origin: 'community_storage_bundle',
      ingested_at: new Date().toISOString(),
      bundle_topic: bundleTopic || null,
      internal_file_name: internalFileName,
    },
    chunkOptions: { minChars: 100, maxChars: 1400 },
  });

  return Object.assign({ ok: true, skipped: false, filePath: path, fileName: internalFileName }, result);
}

/**
 * Deep-index every file in a community topic folder (catalog rows + storage paths).
 */
async function ingestCommunityTopicBundle(payload) {
  if (!isIngestEnabled()) {
    const err = new Error('Community knowledge base not configured (Supabase missing)');
    err.statusCode = 503;
    throw err;
  }

  const p = payload || {};
  const gradeId = String(p.gradeId || p.grade_level || '').trim();
  const topic = String(p.topic || '').trim();
  if (!gradeId || !topic) {
    return { skipped: true, reason: 'missing_grade_or_topic', filesIndexed: 0, chunksInserted: 0 };
  }

  const materials = await fetchCommunityMaterialsByTopic(gradeId, topic);
  const knownPaths = materials.map(function (m) { return m.file_path; }).filter(Boolean);
  const storagePaths = await discoverBundleStoragePaths(gradeId, topic, knownPaths);

  const share = {
    contributorEmail: p.contributorEmail || null,
    contributorName: p.contributorName || p.author || null,
    author: p.author || null,
    gradeId: gradeId,
    bundleTopic: topic,
    origin: p.origin || 'community_bundle',
  };

  let filesIndexed = 0;
  let chunksInserted = 0;
  const indexedMaterialIds = new Set();
  const errors = [];

  for (let i = 0; i < materials.length; i++) {
    const material = materials[i];
    try {
      const result = await ingestMaterialRecord(material, share);
      if (result && result.skipped) continue;
      filesIndexed += 1;
      chunksInserted += Number(result.inserted) || 0;
      if (material.id) indexedMaterialIds.add(String(material.id));
    } catch (err) {
      errors.push({ materialId: material.id, error: err.message || String(err) });
    }
  }

  for (let j = 0; j < storagePaths.length; j++) {
    const storagePath = storagePaths[j];
    const linked = materials.some(function (m) { return String(m.file_path || '') === String(storagePath); });
    if (linked) continue;
    try {
      const result = await ingestStoragePathRecord(storagePath, Object.assign({}, share, {
        topic: topic,
        title: storagePath.split('/').pop() || topic,
      }));
      if (result && result.skipped) continue;
      filesIndexed += 1;
      chunksInserted += Number(result.inserted) || 0;
    } catch (err) {
      errors.push({ filePath: storagePath, error: err.message || String(err) });
    }
  }

  return {
    ok: true,
    skipped: false,
    bundleTopic: topic,
    gradeId: gradeId,
    materialsScanned: materials.length,
    storagePathsScanned: storagePaths.length,
    filesIndexed: filesIndexed,
    chunksInserted: chunksInserted,
    errors: errors.length ? errors : undefined,
  };
}

async function ingestCommunityUpload(payload) {
  if (!isIngestEnabled()) {
    const err = new Error('Community knowledge base not configured (Supabase missing)');
    err.statusCode = 503;
    throw err;
  }

  const p = payload || {};
  const gradeId = String(p.gradeId || p.grade_level || '').trim();
  const topic = String(p.topic || '').trim();
  const indexBundle = p.indexBundle !== false;

  if (indexBundle && gradeId && topic) {
    const bundleResult = await ingestCommunityTopicBundle(p);
    if (!p.filePath && !p.text) {
      return bundleResult;
    }
    return Object.assign({ bundle: bundleResult }, bundleResult);
  }

  const title = String(p.title || p.fileName || topic || 'חומר קהילתי').trim();
  const author = String(p.author || p.contributorName || '').trim() || null;
  const filePath = String(p.filePath || p.file_path || '').trim();
  const fileName = String(p.fileName || p.file_name || '').trim();
  const fileType = String(p.fileType || p.file_type || '').trim();
  const inlineText = String(p.text || '').trim();
  const isLink = /^https?:\/\//i.test(filePath);

  if (p.materialId && filePath && !isLink && !inlineText) {
    const materials = await fetchCommunityMaterialsByTopic(gradeId, topic);
    const material = materials.find(function (m) { return String(m.id) === String(p.materialId); }) || {
      id: p.materialId,
      grade_level: gradeId,
      topic: topic,
      file_path: filePath,
      file_name: fileName,
      notes: '',
    };
    return ingestMaterialRecord(material, {
      contributorEmail: p.contributorEmail || null,
      contributorName: p.contributorName || author,
      author: author,
      gradeId: gradeId,
      bundleTopic: topic,
    });
  }

  let text = inlineText;
  if (!text && filePath && !isLink) {
    const buffer = await fetchStorageFile(filePath);
    text = await parseFileBuffer(buffer, fileName || filePath, fileType);
  }

  if (!text || text.length < MIN_TEXT_LENGTH) {
    return {
      skipped: true,
      reason: isLink ? 'external_link_not_indexed' : 'insufficient_text',
      inserted: 0,
      chunks: 0,
    };
  }

  const internalFileName = fileName || title;
  const indexedText = internalFileName ? ('[קובץ: ' + internalFileName + ']\n' + text) : text;

  const result = await insertCommunityText(indexedText, {
    title: title,
    author: author,
    contributorEmail: p.contributorEmail || null,
    contributorName: p.contributorName || author,
    gradeId: gradeId || null,
    topic: topic || null,
    sourceMaterialId: p.materialId || p.sourceMaterialId || null,
    fileName: fileName || null,
    filePath: filePath || null,
    fileType: fileType || null,
    bundleTopic: topic || null,
    internalFileName: internalFileName || null,
    indexOrigin: 'single_upload',
    metadata: {
      origin: p.origin || 'community_upload',
      ingested_at: new Date().toISOString(),
      bundle_topic: topic || null,
      internal_file_name: internalFileName || null,
    },
    chunkOptions: { minChars: 100, maxChars: 1400 },
  });

  return Object.assign({ ok: true, skipped: false }, result);
}

function ingestCommunityUploadAsync(payload) {
  ingestCommunityUpload(payload).catch(function (err) {
    console.warn('[community-ingest] background index failed:', err.message || err);
  });
}

module.exports = {
  TABLE_NAME,
  MATERIALS_TABLE,
  STORAGE_BUCKET,
  isIngestEnabled,
  parseFileBuffer,
  fetchStorageFile,
  fetchCommunityMaterialsByTopic,
  listStorageObjects,
  insertCommunityText,
  ingestMaterialRecord,
  ingestCommunityTopicBundle,
  ingestCommunityUpload,
  ingestCommunityUploadAsync,
};
