/**
 * Parse, chunk, and index teacher community uploads into community_knowledge_base.
 * Supports PDF, Word (.docx), and plain text. Optional OpenAI embeddings on insert.
 */
const chunks = require('./knowledge-chunks');
const embeddings = require('./embeddings');
const env = require('./env');

const TABLE_NAME = 'community_knowledge_base';
const STORAGE_BUCKET = 'community-uploads';
const MIN_TEXT_LENGTH = 80;
const BATCH_SIZE = 20;

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
    if (m.metadata) row.metadata = m.metadata;
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

async function ingestCommunityUpload(payload) {
  if (!isIngestEnabled()) {
    const err = new Error('Community knowledge base not configured (Supabase missing)');
    err.statusCode = 503;
    throw err;
  }

  const p = payload || {};
  const gradeId = String(p.gradeId || p.grade_level || '').trim();
  const topic = String(p.topic || '').trim();
  const title = String(p.title || p.fileName || topic || 'חומר קהילתי').trim();
  const author = String(p.author || p.contributorName || '').trim() || null;
  const filePath = String(p.filePath || p.file_path || '').trim();
  const fileName = String(p.fileName || p.file_name || '').trim();
  const fileType = String(p.fileType || p.file_type || '').trim();
  const inlineText = String(p.text || '').trim();
  const isLink = /^https?:\/\//i.test(filePath);

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

  const result = await insertCommunityText(text, {
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
    metadata: {
      origin: p.origin || 'community_upload',
      ingested_at: new Date().toISOString(),
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
  STORAGE_BUCKET,
  isIngestEnabled,
  parseFileBuffer,
  fetchStorageFile,
  insertCommunityText,
  ingestCommunityUpload,
  ingestCommunityUploadAsync,
};
