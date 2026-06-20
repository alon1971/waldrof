/**
 * GET    /api/community-materials — list community_materials
 * PATCH  /api/community-materials?id=<uuid> — update grade / topic / description / author
 * DELETE /api/community-materials?id=<uuid> — delete row + storage object
 */
const communityIngest = require('./community-ingest');
const env = require('./env');

const STORAGE_BUCKET = 'community-uploads';
const MATERIALS_TABLE = 'community_materials';
const COMMUNITY_META_FIELD = 'notes';
const MATERIAL_PK_COLUMN = 'id';
const VALID_GRADE_LEVELS = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);

function normalizeGradeLevel(body) {
  if (!body || typeof body !== 'object') return '';
  if (body.grade_level != null && String(body.grade_level).trim()) {
    return String(body.grade_level).trim();
  }
  if (body.grade != null && String(body.grade).trim()) {
    return String(body.grade).trim();
  }
  return '';
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
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

function hasServiceRoleKey() {
  return env.hasRealServiceRoleKey();
}

function getServiceRoleConfig() {
  const url = env.getSupabaseUrl();
  const key = env.getSupabaseServiceRoleKey();
  if (!url || !key) {
    const err = new Error('SUPABASE_SERVICE_ROLE_KEY is required for community material mutations');
    err.statusCode = 503;
    throw err;
  }
  return { url: url, key: key };
}

function extractBearerToken(req) {
  if (!req || !req.headers) return '';
  const raw = req.headers.authorization || req.headers.Authorization || '';
  return String(raw).replace(/^Bearer\s+/i, '').trim();
}

function encodeStorageObjectPath(path) {
  return String(path || '').split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

/** Resolve storage object path from a DB file_path (storage path or public URL). */
function resolveStorageObjectPath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  if (raw.indexOf('community/') === 0) return raw;
  const marker = '/storage/v1/object/public/' + STORAGE_BUCKET + '/';
  const idx = raw.indexOf(marker);
  if (idx >= 0) {
    return decodeURIComponent(raw.slice(idx + marker.length));
  }
  return raw;
}

function extractMaterialId(body, req) {
  let id = '';
  if (req && req.url) {
    try {
      const host = (req.headers && req.headers.host) || 'localhost';
      const url = new URL(req.url, 'http://' + host);
      const fromQuery = url.searchParams.get('id');
      if (fromQuery) id = fromQuery.trim();
    } catch (e) { /* ignore malformed URL */ }
  }
  if (!id && req && req.query && req.query.id != null) {
    id = String(req.query.id).trim();
  }
  if (!id && body && body.id != null) {
    id = String(body.id).trim();
  }
  return normalizeMaterialUuid(id);
}

const MATERIAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeMaterialUuid(raw) {
  const id = String(raw || '').trim().replace(/^["'{]+|["'}]+$/g, '');
  if (!id) return '';
  return MATERIAL_UUID_RE.test(id) ? id.toLowerCase() : id;
}

function isValidMaterialUuid(id) {
  return MATERIAL_UUID_RE.test(String(id || '').trim());
}

function resolveCanonicalMaterialId(row, fallbackId) {
  const fromRow = row && row[MATERIAL_PK_COLUMN] != null ? row[MATERIAL_PK_COLUMN] : (row && row.id);
  const canonical = normalizeMaterialUuid(fromRow || fallbackId);
  return canonical || '';
}

function materialFilterQuery(value) {
  const pk = normalizeMaterialUuid(value);
  if (!pk) return MATERIAL_PK_COLUMN + '=is.null';
  return MATERIAL_PK_COLUMN + '=eq.' + encodeURIComponent(pk);
}

function requireValidMaterialId(id, label) {
  const pk = normalizeMaterialUuid(id);
  if (!pk) {
    const err = new Error('Missing material ID in both query and body');
    err.statusCode = 400;
    throw err;
  }
  if (!isValidMaterialUuid(pk)) {
    const err = new Error((label || 'Material') + ' ID must be a valid UUID');
    err.statusCode = 400;
    throw err;
  }
  return pk;
}

function packCommunityExtras(extras) {
  const e = extras || {};
  const parts = [];
  if ((e.author || '').trim()) parts.push('[author:' + String(e.author).trim() + ']');
  if ((e.description || '').trim()) parts.push('[desc:' + String(e.description).trim() + ']');
  if (e.fileSize != null && e.fileSize !== '') parts.push('[size:' + e.fileSize + ']');
  if ((e.fileType || '').trim()) parts.push('[type:' + String(e.fileType).trim() + ']');
  return parts.length ? parts.join(' ') : null;
}

function parseCommunityNotes(rawNotes) {
  let rest = String(rawNotes || '');
  const out = { author: '', description: '', fileSize: null, fileType: '' };
  const tagDefs = [
    { field: 'author', re: /^\[author:([^\]]+)\]\s*/ },
    { field: 'description', re: /^\[desc:([^\]]+)\]\s*/ },
    { field: 'fileSize', re: /^\[size:([^\]]+)\]\s*/, parse: function (v) { return parseInt(v, 10) || null; } },
    { field: 'fileType', re: /^\[type:([^\]]+)\]\s*/ },
  ];
  let matched = true;
  while (matched) {
    matched = false;
    for (let i = 0; i < tagDefs.length; i++) {
      const def = tagDefs[i];
      const m = rest.match(def.re);
      if (!m) continue;
      out[def.field] = def.parse ? def.parse(m[1]) : m[1];
      rest = rest.slice(m[0].length);
      matched = true;
      break;
    }
  }
  return out;
}

async function supabaseFetch(url, relativePath, options, apiKey, bearerToken) {
  const res = await fetch(url + relativePath, Object.assign({
    headers: Object.assign({
      apikey: apiKey,
      Authorization: 'Bearer ' + bearerToken,
      Accept: 'application/json',
    }, (options && options.headers) || {}),
  }, options || {}));
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = text; }
  }
  return { ok: res.ok, status: res.status, body: body, text: text };
}

async function supabaseServiceRequest(relativePath, options) {
  const cfg = getServiceRoleConfig();
  return supabaseFetch(cfg.url, relativePath, options, cfg.key, cfg.key);
}

async function supabaseUserRequest(relativePath, options, userToken) {
  const url = env.getSupabaseUrl();
  const anonKey = env.getSupabaseAnonKey();
  const token = String(userToken || '').trim();
  if (!url || !anonKey || !token) {
    return { ok: false, status: 401, body: null, text: 'Missing user auth' };
  }
  return supabaseFetch(url, relativePath, options, anonKey, token);
}

async function supabaseMutateWithFallback(relativePath, options, req) {
  const userToken = extractBearerToken(req);
  let lastResult = { ok: false, status: 503, body: null, text: '' };

  if (userToken) {
    const userResult = await supabaseUserRequest(relativePath, options, userToken);
    if (userResult.ok) return userResult;
    lastResult = userResult;
  }

  if (hasServiceRoleKey()) {
    try {
      const serviceResult = await supabaseServiceRequest(relativePath, options);
      if (serviceResult.ok) return serviceResult;
      lastResult = serviceResult;
    } catch (serviceErr) {
      lastResult = { ok: false, status: serviceErr.statusCode || 503, body: null, text: serviceErr.message || '' };
    }
  } else if (!userToken) {
    const err = new Error('Sign in required or configure SUPABASE_SERVICE_ROLE_KEY on the server');
    err.statusCode = 401;
    throw err;
  }

  return lastResult;
}

async function supabaseRequestWithKeyFallback(relativePath, options, preferAnon) {
  if (!preferAnon && env.getSupabaseServiceRoleKey()) {
    return supabaseServiceRequest(relativePath, options);
  }
  const keys = preferAnon
    ? [env.getSupabaseAnonKey(), env.getSupabaseServiceRoleKey()].filter(Boolean)
    : [env.getSupabaseServiceRoleKey(), env.getSupabaseAnonKey()].filter(Boolean);
  const seen = new Set();
  let lastResult = null;
  const url = env.getSupabaseUrl();
  if (!url) return { ok: false, status: 503, body: null, text: '' };
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const res = await fetch(url + relativePath, Object.assign({
      headers: Object.assign({
        apikey: key,
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
      }, (options && options.headers) || {}),
    }, options || {}));
    const text = await res.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = text; }
    }
    lastResult = { ok: res.ok, status: res.status, body: body, text: text };
    if (res.ok) return lastResult;
    if (res.status !== 401 && res.status !== 403) break;
  }
  return lastResult || { ok: false, status: 503, body: null, text: '' };
}

async function listCommunityMaterials() {
  const result = await supabaseRequestWithKeyFallback(
    '/rest/v1/' + MATERIALS_TABLE + '?select=*&order=created_at.desc',
    { method: 'GET' },
    true
  );
  if (!result.ok) {
    const err = new Error('Failed to list community materials (' + result.status + ')');
    err.statusCode = result.status;
    err.responseText = result.text;
    throw err;
  }
  return Array.isArray(result.body) ? result.body : [];
}

async function fetchMaterialById(id) {
  const pk = normalizeMaterialUuid(id);
  if (!pk || !isValidMaterialUuid(pk)) return null;
  const path = '/rest/v1/' + MATERIALS_TABLE + '?select=*&' + materialFilterQuery(pk) + '&limit=1';
  if (hasServiceRoleKey()) {
    try {
      const serviceResult = await supabaseServiceRequest(path, { method: 'GET' });
      if (serviceResult.ok && Array.isArray(serviceResult.body) && serviceResult.body.length) {
        return serviceResult.body[0];
      }
    } catch (e) { /* fall through to public read */ }
  }
  const result = await supabaseRequestWithKeyFallback(path, { method: 'GET' }, true);
  if (result.ok && Array.isArray(result.body) && result.body.length) {
    return result.body[0];
  }
  return null;
}

async function deleteStorageObject(filePath) {
  const path = resolveStorageObjectPath(filePath);
  if (!path || isHttpUrl(path) || path.indexOf('community/') !== 0) return false;
  if (!hasServiceRoleKey()) return false;
  const cfg = getServiceRoleConfig();
  const enc = encodeStorageObjectPath(path);
  const res = await fetch(cfg.url + '/storage/v1/object/' + STORAGE_BUCKET + '/' + enc, {
    method: 'DELETE',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });
  return res.ok;
}

async function patchCommunityMaterial(body, req) {
  const id = requireValidMaterialId(extractMaterialId(body || {}, req));
  console.log('[community-materials] Backend patch triggered for ID:', id);

  if (!hasServiceRoleKey()) {
    const err = new Error('SUPABASE_SERVICE_ROLE_KEY is required for community material mutations');
    err.statusCode = 503;
    throw err;
  }

  const current = await fetchMaterialById(id);
  if (!current) {
    const err = new Error('Material not found');
    err.statusCode = 404;
    throw err;
  }
  const canonicalId = resolveCanonicalMaterialId(current, id);

  const payload = {};
  const gradeLevel = normalizeGradeLevel(body);
  if (gradeLevel) {
    if (!VALID_GRADE_LEVELS.has(gradeLevel)) {
      const err = new Error('Invalid grade');
      err.statusCode = 400;
      throw err;
    }
    payload.grade_level = gradeLevel;
  }
  if (body.topic != null && String(body.topic).trim()) {
    payload.topic = String(body.topic).trim();
  }

  const parsed = parseCommunityNotes(current[COMMUNITY_META_FIELD] || '');
  const hasMetaUpdate = body.description != null || body.author != null;
  if (hasMetaUpdate) {
    const notes = packCommunityExtras({
      author: body.author != null ? String(body.author).trim() : parsed.author,
      description: body.description != null ? String(body.description).trim() : parsed.description,
      fileSize: parsed.fileSize,
      fileType: parsed.fileType,
    });
    payload[COMMUNITY_META_FIELD] = notes || null;
  }

  if (!Object.keys(payload).length) {
    const err = new Error('Nothing to update');
    err.statusCode = 400;
    throw err;
  }

  const patchPath = '/rest/v1/' + MATERIALS_TABLE + '?' + materialFilterQuery(canonicalId);
  const patchOptions = {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  };
  const result = await supabaseServiceRequest(patchPath, patchOptions);
  console.log('[community-materials] Supabase patch response:', result.body, result.text || '');
  if (!result.ok) {
    const err = new Error('Update failed (' + result.status + ')');
    err.statusCode = result.status;
    err.responseText = result.text;
    throw err;
  }
  const rows = Array.isArray(result.body) ? result.body : [];
  if (!rows.length) {
    const err = new Error('Update failed: no rows updated');
    err.statusCode = 500;
    err.responseText = result.text;
    throw err;
  }
  return rows[0];
}

async function deleteCommunityMaterial(body, req) {
  const id = requireValidMaterialId(extractMaterialId(body || {}, req));
  console.log('[community-materials] Backend delete triggered for ID:', id);

  if (!hasServiceRoleKey()) {
    const err = new Error('SUPABASE_SERVICE_ROLE_KEY is required for community material mutations');
    err.statusCode = 503;
    throw err;
  }

  const current = await fetchMaterialById(id);
  if (!current) {
    const err = new Error('Material not found');
    err.statusCode = 404;
    throw err;
  }
  const canonicalId = resolveCanonicalMaterialId(current, id);
  console.log('[community-materials] Canonical delete ID:', canonicalId);

  let kbDeleted = false;
  try {
    await communityIngest.deleteBySourceMaterialId(canonicalId);
    kbDeleted = true;
  } catch (kbErr) {
    console.warn('[community-materials] knowledge base delete failed:', kbErr.message || kbErr);
  }

  const filePath = (current.file_path || '').trim();
  let storageDeleted = false;
  if (filePath) {
    try {
      storageDeleted = await deleteStorageObject(filePath);
    } catch (storageErr) {
      console.warn('[community-materials] storage delete failed:', storageErr.message || storageErr);
    }
  }

  const deletePath = '/rest/v1/' + MATERIALS_TABLE + '?' + materialFilterQuery(canonicalId);
  const deleteOptions = { method: 'DELETE', headers: { Prefer: 'return=representation' } };
  let result;
  try {
    result = await supabaseServiceRequest(deletePath, deleteOptions);
  } catch (serviceErr) {
    console.error('[community-materials] Supabase delete error:', serviceErr.message || serviceErr);
    const err = new Error(serviceErr.message || 'Delete failed');
    err.statusCode = serviceErr.statusCode || 503;
    throw err;
  }
  console.log('[community-materials] Supabase delete response:', result.body, result.text || '');
  const deletedRows = Array.isArray(result.body) ? result.body : [];
  if (!result.ok || !deletedRows.length) {
    const err = new Error(
      deletedRows.length ? 'Delete failed (' + result.status + ')' : 'Delete failed: no rows removed'
    );
    err.statusCode = result.ok ? 500 : (result.status || 500);
    err.responseText = result.text;
    throw err;
  }
  return { id: canonicalId, deletedCount: deletedRows.length, storageDeleted: storageDeleted, kbDeleted: kbDeleted };
}

async function legacyHandler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  try {
    if (req.method === 'GET') {
      const rows = await listCommunityMaterials();
      return sendJson(res, 200, { data: rows });
    }

    if (req.method === 'PATCH') {
      const body = parseRequestBody(req);
      const row = await patchCommunityMaterial(body || {}, req);
      return sendJson(res, 200, { success: true, data: row });
    }

    if (req.method === 'DELETE') {
      const body = parseRequestBody(req);
      const result = await deleteCommunityMaterial(body || {}, req);
      return sendJson(res, 200, { success: true, data: result });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[community-materials]', status, err.message || err, err.responseText || '');
    return sendJson(res, status, { error: err.message || String(err) });
  }
}

module.exports = {
  legacyHandler,
  listCommunityMaterials,
  patchCommunityMaterial,
  deleteCommunityMaterial,
};
