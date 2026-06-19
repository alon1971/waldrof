/**
 * POST /api/community-upload — upload a community file to Supabase Storage and catalog.
 * Body: { gradeId, topic, description?, author?, title?, fileName, mimeType, fileDataBase64 }
 * Uses service role on the server so uploads work without client storage RLS.
 */
const communityIngest = require('./community-ingest');
const authContext = require('./auth-context');
const env = require('./env');

const STORAGE_BUCKET = 'community-uploads';
const MATERIALS_TABLE = 'community_materials';
const COMMUNITY_META_FIELD = 'notes';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(statusCode).json(payload);
}

function parseRequestBody(req) {
  const rawBody = req.body;
  if (rawBody === undefined || rawBody === null) return null;
  if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return rawBody.trim() ? JSON.parse(rawBody) : null;
  if (Buffer.isBuffer(rawBody)) {
    const text = rawBody.toString('utf8');
    return text.trim() ? JSON.parse(text) : null;
  }
  return rawBody;
}

function encodeStorageObjectPath(path) {
  return String(path || '').split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
}

function getStorageFileExtension(originalFileName) {
  const name = String(originalFileName || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

function slugifyStorageSegment(text) {
  const s = String(text || '').trim();
  if (!s) return 'general';
  const ascii = s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (ascii.length >= 2) return ascii;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 't' + Math.abs(h).toString(36).slice(0, 10);
}

function buildCommunityStoragePath(gradeId, topic, originalFileName) {
  const grade = String(gradeId || '').trim();
  const subject = slugifyStorageSegment(topic);
  const ext = getStorageFileExtension(originalFileName);
  const baseName = String(originalFileName || 'upload')
    .replace(/\.[^/.]+$/, '')
    .replace(/[^\w.\-]+/g, '_')
    .slice(0, 48) || 'file';
  return 'community/' + grade + '/' + subject + '/' + Date.now() + '_' + baseName + ext;
}

function packCommunityExtras(extras) {
  const e = extras || {};
  const parts = [];
  if ((e.title || '').trim()) parts.push('[title:' + String(e.title).trim() + ']');
  if ((e.author || '').trim()) parts.push('[author:' + String(e.author).trim() + ']');
  if ((e.description || '').trim()) parts.push('[desc:' + String(e.description).trim() + ']');
  if (e.fileSize != null && e.fileSize !== '') parts.push('[size:' + e.fileSize + ']');
  if ((e.fileType || '').trim()) parts.push('[type:' + String(e.fileType).trim() + ']');
  return parts.length ? parts.join(' ') : null;
}

function getSupabaseConfig() {
  const url = env.getSupabaseUrl();
  const key = env.getSupabaseServerKey();
  if (!url || !key) {
    const err = new Error('Supabase is not configured on the server');
    err.statusCode = 503;
    throw err;
  }
  return { url: url, key: key };
}

async function uploadBufferToStorage(buffer, storagePath, contentType) {
  const cfg = getSupabaseConfig();
  const enc = encodeStorageObjectPath(storagePath);
  const res = await fetch(cfg.url + '/storage/v1/object/' + STORAGE_BUCKET + '/' + enc, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: buffer,
  });
  const errText = await res.text();
  if (!res.ok) {
    const err = new Error('Storage upload failed (' + res.status + '): ' + errText.slice(0, 400));
    err.statusCode = res.status;
    err.responseText = errText;
    throw err;
  }
  return {
    storagePath: storagePath,
    publicUrl: cfg.url + '/storage/v1/object/public/' + STORAGE_BUCKET + '/' + enc,
  };
}

async function insertCommunityMaterial(gradeId, topic, filePath, fileName, extras, userId) {
  const cfg = getSupabaseConfig();
  const payload = {
    grade_level: String(gradeId),
    topic: String(topic || '').trim(),
    file_path: filePath || null,
    file_name: fileName || null,
  };
  const notes = packCommunityExtras(extras);
  if (notes) payload[COMMUNITY_META_FIELD] = notes;
  if (userId) payload.user_id = userId;

  async function postInsert(rec) {
    const res = await fetch(cfg.url + '/rest/v1/' + MATERIALS_TABLE, {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(rec),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error('community_materials insert failed (' + res.status + '): ' + text.slice(0, 400));
      err.statusCode = res.status;
      err.responseText = text;
      throw err;
    }
    const data = text ? JSON.parse(text) : [];
    return Array.isArray(data) ? data[0] : data;
  }

  try {
    return await postInsert(payload);
  } catch (err) {
    if (payload.user_id && /user_id|column|schema cache/i.test(String(err.message || ''))) {
      const retry = Object.assign({}, payload);
      delete retry.user_id;
      return await postInsert(retry);
    }
    throw err;
  }
}

async function executeCommunityUpload(req) {
  const body = parseRequestBody(req);
  if (!body || typeof body !== 'object') {
    const err = new Error('Request body is missing');
    err.statusCode = 400;
    throw err;
  }

  const gradeId = String(body.gradeId || '').trim();
  const topic = String(body.topic || '').trim();
  const fileName = String(body.fileName || '').trim();
  const mimeType = String(body.mimeType || body.fileType || 'application/octet-stream').trim();
  const description = String(body.description || '').trim();
  const author = String(body.author || '').trim();
  const title = String(body.title || description || fileName || topic).trim();
  const base64 = String(body.fileDataBase64 || '').trim();

  if (!gradeId) {
    const err = new Error('gradeId is required');
    err.statusCode = 400;
    throw err;
  }
  if (!topic) {
    const err = new Error('topic is required');
    err.statusCode = 400;
    throw err;
  }
  if (!fileName) {
    const err = new Error('fileName is required');
    err.statusCode = 400;
    throw err;
  }
  if (!base64) {
    const err = new Error('fileDataBase64 is required');
    err.statusCode = 400;
    throw err;
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (decodeErr) {
    const err = new Error('Invalid fileDataBase64 payload');
    err.statusCode = 400;
    throw err;
  }
  if (!buffer.length) {
    const err = new Error('Uploaded file is empty');
    err.statusCode = 400;
    throw err;
  }
  if (buffer.length > MAX_FILE_BYTES) {
    const err = new Error('File exceeds 5MB limit');
    err.statusCode = 400;
    throw err;
  }

  const storagePath = buildCommunityStoragePath(gradeId, topic, fileName);
  const uploaded = await uploadBufferToStorage(buffer, storagePath, mimeType);
  const verifiedUser = await authContext.resolveVerifiedUser(req, body);
  const material = await insertCommunityMaterial(gradeId, topic, uploaded.storagePath, fileName, {
    title: title,
    author: author,
    description: description,
    fileSize: buffer.length,
    fileType: mimeType,
  }, verifiedUser && verifiedUser.id ? verifiedUser.id : null);

  let indexResult = null;
  if (communityIngest.isIngestEnabled() && material && material.id) {
    try {
      indexResult = await communityIngest.ingestCommunityUpload({
        gradeId: gradeId,
        topic: topic,
        title: title,
        author: author,
        filePath: uploaded.storagePath,
        fileName: fileName,
        fileType: mimeType,
        materialId: material.id,
        indexBundle: false,
      });
    } catch (indexErr) {
      console.warn('[community-upload] ingest failed:', indexErr.message || indexErr);
    }
  }

  return {
    ok: true,
    storagePath: uploaded.storagePath,
    publicUrl: uploaded.publicUrl,
    fileName: fileName,
    material: material,
    indexResult: indexResult,
  };
}

async function legacyHandler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const data = await executeCommunityUpload(req);
    return sendJson(res, 200, { data: data });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[community-upload]', status, err.message || err, err.responseText || '');
    return sendJson(res, status, { error: err.message || String(err) });
  }
}

module.exports = {
  legacyHandler,
  executeCommunityUpload,
  buildCommunityStoragePath,
  encodeStorageObjectPath,
};
