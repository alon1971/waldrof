/**
 * GET    /api/community-materials — list community_materials (service role)
 * PATCH  /api/community-materials — update topic / description / author metadata
 * DELETE /api/community-materials — delete row + storage object when applicable
 */
const env = require('./env');

const STORAGE_BUCKET = 'community-uploads';
const MATERIALS_TABLE = 'community_materials';
const COMMUNITY_META_FIELD = 'notes';

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

function encodeStorageObjectPath(path) {
  return String(path || '').split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

const MATERIAL_PK_COLUMN = 'id';

function extractMaterialId(body) {
  if (!body || typeof body !== 'object') return '';
  const raw = body.id != null
    ? body.id
    : (body.material_id != null ? body.material_id : body.materialId);
  return raw != null ? String(raw).trim() : '';
}

/** Primary key column + value from a Supabase row (community_materials.id). */
function resolveRowPrimaryKey(row) {
  if (!row || typeof row !== 'object') return { column: MATERIAL_PK_COLUMN, value: '' };
  const value = row[MATERIAL_PK_COLUMN] != null ? String(row[MATERIAL_PK_COLUMN]).trim() : '';
  return { column: MATERIAL_PK_COLUMN, value: value };
}

function materialFilterQuery(column, value) {
  return column + '=eq.' + encodeURIComponent(String(value));
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

function parseCommunityNotes(rawNotes) {
  let rest = String(rawNotes || '');
  const out = { title: '', author: '', description: '', fileSize: null, fileType: '' };
  const tagDefs = [
    { field: 'title', re: /^\[title:([^\]]+)\]\s*/ },
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

async function supabaseRequest(relativePath, options) {
  const cfg = getSupabaseConfig();
  const res = await fetch(cfg.url + relativePath, Object.assign({
    headers: Object.assign({
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    }, (options && options.headers) || {}),
  }, options || {}));
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = text; }
  }
  return { ok: res.ok, status: res.status, body: body, text: text };
}

async function supabaseRequestWithKeyFallback(relativePath, options, preferAnon) {
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
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
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
  const pk = String(id || '').trim();
  if (!pk) return null;
  const result = await supabaseRequestWithKeyFallback(
    '/rest/v1/' + MATERIALS_TABLE + '?select=*&' + materialFilterQuery(MATERIAL_PK_COLUMN, pk) + '&limit=1',
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    true
  );
  if (result.ok && Array.isArray(result.body) && result.body.length) return result.body[0];
  return null;
}

async function deleteStorageObject(filePath) {
  const path = String(filePath || '').trim();
  if (!path || isHttpUrl(path) || path.indexOf('community/') !== 0) return false;
  const url = env.getSupabaseUrl();
  const keys = [env.getSupabaseServiceRoleKey(), env.getSupabaseAnonKey()].filter(Boolean);
  const enc = encodeStorageObjectPath(path);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key || !url) continue;
    const res = await fetch(url + '/storage/v1/object/' + STORAGE_BUCKET + '/' + enc, {
      method: 'DELETE',
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
      },
    });
    if (res.ok) return true;
    if (res.status !== 401 && res.status !== 403) return false;
  }
  return false;
}

async function patchCommunityMaterial(body) {
  const id = extractMaterialId(body || {});
  if (!id) {
    const err = new Error('id is required');
    err.statusCode = 400;
    throw err;
  }

  const current = await fetchMaterialById(id);
  if (!current) {
    const err = new Error('Material not found');
    err.statusCode = 404;
    throw err;
  }

  const payload = {};
  if (body.topic != null && String(body.topic).trim()) {
    payload.topic = String(body.topic).trim();
  }

  const parsed = parseCommunityNotes(current[COMMUNITY_META_FIELD] || current.notes || '');
  const hasMetaUpdate = body.description != null || body.author != null || body.title != null;
  if (hasMetaUpdate) {
    const notes = packCommunityExtras({
      title: body.title != null ? String(body.title).trim() : parsed.title,
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

  const pk = resolveRowPrimaryKey(current);
  const result = await supabaseRequestWithKeyFallback(
    '/rest/v1/' + MATERIALS_TABLE + '?' + materialFilterQuery(pk.column, pk.value),
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    },
    false
  );
  if (!result.ok) {
    const err = new Error('Update failed (' + result.status + ')');
    err.statusCode = result.status;
    err.responseText = result.text;
    throw err;
  }
  const rows = Array.isArray(result.body) ? result.body : [];
  if (rows.length) return rows[0];
  const refreshed = await fetchMaterialById(pk.value);
  if (refreshed) return refreshed;
  return Object.assign({}, current, payload);
}

async function deleteCommunityMaterial(body) {
  const id = extractMaterialId(body || {});
  if (!id) {
    const err = new Error('id is required');
    err.statusCode = 400;
    throw err;
  }

  const current = await fetchMaterialById(id);
  if (!current) {
    const err = new Error('Material not found');
    err.statusCode = 404;
    throw err;
  }

  const filePath = (current.file_path || '').trim();
  let storageDeleted = false;
  if (filePath && !isHttpUrl(filePath)) {
    try {
      storageDeleted = await deleteStorageObject(filePath);
    } catch (storageErr) {
      console.warn('[community-materials] storage delete failed:', storageErr.message || storageErr);
    }
  }

  const pk = resolveRowPrimaryKey(current);
  const result = await supabaseRequestWithKeyFallback(
    '/rest/v1/' + MATERIALS_TABLE + '?' + materialFilterQuery(pk.column, pk.value),
    { method: 'DELETE', headers: { Prefer: 'return=representation' } },
    false
  );
  if (!result.ok) {
    const err = new Error('Delete failed (' + result.status + ')');
    err.statusCode = result.status;
    err.responseText = result.text;
    throw err;
  }
  return { id: pk.value, storageDeleted: storageDeleted };
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
      const row = await patchCommunityMaterial(body || {});
      return sendJson(res, 200, { data: row });
    }

    if (req.method === 'DELETE') {
      const body = parseRequestBody(req);
      const result = await deleteCommunityMaterial(body || {});
      return sendJson(res, 200, { data: result });
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
