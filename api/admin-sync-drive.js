/**
 * Admin Supabase → Google Drive full-history backfill.
 *
 * For every community_materials row:
 *   1) Resolve grade folder (כיתה א׳–ח׳ / כללי) under the catalog root
 *   2) Resolve topic subfolder
 *   3) Create a readable content document (title + grade + description + source URL)
 *      and set Drive file/shortcut description metadata (avoids empty previews)
 *   4) For Drive/Docs links: also create a shortcut into the grade/topic folder
 *      with the same description metadata
 *   5) For physical uploads (Supabase storage), also upload the binary file
 *
 * Dedup: notes tags [driveContentDocId] / [driveSyncedFileId] / [driveShortcutId]
 * + Drive appProperties (waldorfMaterialId + waldorfRole) + same-name checks.
 *
 * Routes: GET|POST /api/admin/sync-drive (CRON_SECRET)
 * Optional boot: DRIVE_SUPABASE_SYNC_ON_BOOT=1
 */
'use strict';

const drive = require('./drive-catalog-sync');
const catalogTopics = require('./catalog-topics');
const pedagogicalScope = require('./pedagogical-scope');
const env = require('./env');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = drive.FOLDER_MIME || 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = drive.SHORTCUT_MIME || 'application/vnd.google-apps.shortcut';
const DOCS_MIME = 'application/vnd.google-apps.document';
const MATERIALS_TABLE = 'community_materials';
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 8000;
const CONTENT_DOC_SUFFIX = ' — תוכן מאגר';
const CONTENT_TXT_SUFFIX = ' — תוכן מאגר.txt';
const APP_PROP_MATERIAL = 'waldorfMaterialId';
const APP_PROP_ROLE = 'waldorfRole';
const ROLE_CONTENT = 'content';
const ROLE_CONTENT_TXT = 'content_txt';
const ROLE_FILE = 'file';
const ROLE_SHORTCUT = 'shortcut';
const SYNC_TAG_CONTENT = 'driveContentDocId';
const SYNC_TAG_FILE = 'driveSyncedFileId';
const SYNC_TAG_SHORTCUT = 'driveShortcutId';

let _running = null;

function driveHeaders(accessToken) {
  if (typeof drive.buildDriveRequestHeaders === 'function') {
    return drive.buildDriveRequestHeaders(accessToken, {});
  }
  return { Authorization: 'Bearer ' + accessToken };
}

function gradeFolderLabel(gradeId) {
  const gid = String(gradeId || '').trim() || 'general';
  if (gid === 'general') return 'כללי';
  return (pedagogicalScope.GRADE_LABEL_BY_ID || {})[gid] || ('כיתה ' + gid);
}

function normalizeGradeId(raw) {
  const value = String(raw || '').trim();
  if (!value) return 'general';
  if (value === 'general' || value === 'כללי') return 'general';
  if (/^[1-8]$/.test(value)) return value;
  if (typeof drive.parseGradeIdFromFolderName === 'function') {
    const parsed = drive.parseGradeIdFromFolderName(value);
    if (parsed) return parsed;
  }
  return value;
}

function classifyFilePath(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return { kind: 'empty', value: '' };
  if (
    /supabase\.co\/storage\/v1\/object\/public\/community-uploads\//i.test(p)
    || /\/storage\/v1\/object\/public\/community-uploads\//i.test(p)
  ) {
    return { kind: 'storage', value: p };
  }
  const driveFile = p.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i);
  if (driveFile) return { kind: 'drive_file', value: p, driveId: driveFile[1] };
  const driveFolder = p.match(/drive\.google\.com\/(?:drive\/)?folders\/([^/?#]+)/i);
  if (driveFolder) return { kind: 'drive_folder', value: p, driveId: driveFolder[1] };
  const docs = p.match(/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([^/?#]+)/i);
  if (docs) return { kind: 'docs', value: p, driveId: docs[1] };
  if (/^https?:\/\//i.test(p)) return { kind: 'external_url', value: p };
  return { kind: 'unknown', value: p };
}

function guessMimeFromName(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (n.endsWith('.doc')) return 'application/msword';
  if (n.endsWith('.pptx')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  if (n.endsWith('.txt') || n.endsWith('.md')) return 'text/plain';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function safeDriveFileName(name, fallback) {
  const raw = String(name || '').trim() || String(fallback || 'קובץ').trim();
  return raw.replace(/[\\/]+/g, ' - ').replace(/\s+/g, ' ').slice(0, 160) || 'קובץ';
}

function parseMaterialMeta(row) {
  const notes = String(row && row.notes || '');
  const titleTag = catalogTopics.readNotesTag(notes, 'title');
  const descTag = catalogTopics.readNotesTag(notes, 'desc');
  const authorTag = catalogTopics.readNotesTag(notes, 'author');
  const freeText = notes
    .replace(/\[[a-zA-Z_]+:[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fileName = String(row && row.file_name || '').trim();
  const topic = String(row && row.topic || '').trim() || 'כללי';
  const title = titleTag || fileName || topic || 'חומר קהילתי';
  const description = [descTag, freeText].filter(Boolean).join('\n\n').trim();
  return {
    title: title,
    description: description,
    author: authorTag || '',
    topic: topic,
    fileName: fileName,
    contentDocId: catalogTopics.readNotesTag(notes, SYNC_TAG_CONTENT),
    syncedFileId: catalogTopics.readNotesTag(notes, SYNC_TAG_FILE),
    shortcutId: catalogTopics.readNotesTag(notes, SYNC_TAG_SHORTCUT),
    driveFileId: catalogTopics.readNotesTag(notes, 'driveFileId'),
    notes: notes,
  };
}

function setNotesTag(notes, key, value) {
  const k = String(key || '').trim();
  const v = String(value || '').trim();
  if (!k || !v) return String(notes || '');
  const re = new RegExp('\\[' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':[^\\]]*\\]', 'gi');
  const cleaned = String(notes || '').replace(re, '').replace(/\s+/g, ' ').trim();
  return ('[' + k + ':' + v + ']' + (cleaned ? ' ' + cleaned : '')).trim();
}

function buildContentBody(meta, gradeLabel, sourceUrl, materialId) {
  const lines = [
    'כותרת: ' + meta.title,
    'כיתה: ' + gradeLabel,
    'נושא: ' + meta.topic,
  ];
  if (meta.author) lines.push('מחבר/מורה: ' + meta.author);
  if (materialId) lines.push('מזהה מאגר: ' + materialId);
  lines.push(
    '',
    'תיאור ותוכן מלא:',
    meta.description || '(אין תיאור שמור במאגר)',
    '',
    'קישור ישיר למקור:',
    sourceUrl || '(אין קישור)'
  );
  return lines.join('\n');
}

/**
 * Drive file/shortcut description — shown in Drive details pane and searchable.
 * Includes summary, grade, topic, and source so previews are never empty.
 */
function buildDriveDescription(meta, gradeLabel, sourceUrl, materialId) {
  const parts = [];
  if (meta.title) parts.push(meta.title);
  parts.push('כיתה: ' + gradeLabel);
  if (meta.topic) parts.push('נושא: ' + meta.topic);
  if (meta.author) parts.push('מחבר/מורה: ' + meta.author);
  if (meta.description) parts.push(meta.description);
  else parts.push('(אין תיאור שמור במאגר — נוצר מרשומת המאגר הקהילתי)');
  if (sourceUrl) parts.push('מקור: ' + sourceUrl);
  if (materialId) parts.push('materialId: ' + materialId);
  return parts.join('\n\n').slice(0, MAX_DESCRIPTION_CHARS);
}

function getSupabaseConfig() {
  const url = String(env.getSupabaseUrl() || '').replace(/\/$/, '');
  const key = String(env.getSupabaseServiceRoleKey() || env.getSupabaseServerKey() || '').trim();
  if (!url || !key) return null;
  return { url: url, key: key };
}

async function fetchAllMaterials(limit) {
  const cfg = getSupabaseConfig();
  if (!cfg) throw new Error('SUPABASE_URL and service role key are required');
  const headers = {
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    Accept: 'application/json',
  };
  const all = [];
  let offset = 0;
  const pageSize = 1000;
  const hardLimit = Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
  while (true) {
    const res = await fetch(
      cfg.url + '/rest/v1/' + MATERIALS_TABLE
      + '?select=id,grade_level,topic,file_name,file_path,notes,created_at'
      + '&order=grade_level.asc,topic.asc,created_at.asc'
      + '&limit=' + pageSize + '&offset=' + offset,
      { headers: headers }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error('community_materials fetch failed (' + res.status + '): ' + text.slice(0, 400));
    }
    const rows = text ? JSON.parse(text) : [];
    if (!Array.isArray(rows) || !rows.length) break;
    all.push.apply(all, rows);
    if (hardLimit && all.length >= hardLimit) {
      return all.slice(0, hardLimit);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function patchMaterialNotes(materialId, notes) {
  const cfg = getSupabaseConfig();
  if (!cfg || !materialId) return false;
  const res = await fetch(
    cfg.url + '/rest/v1/' + MATERIALS_TABLE + '?id=eq.' + encodeURIComponent(materialId),
    {
      method: 'PATCH',
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ notes: notes }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(function () { return ''; });
    console.warn(
      '[admin-sync-drive] notes patch failed:',
      materialId,
      res.status,
      String(text || '').slice(0, 200)
    );
    return false;
  }
  return true;
}

async function downloadHttpBuffer(url, maxBytes) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('download failed (' + res.status + '): ' + String(url || '').slice(0, 120));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > (maxBytes || MAX_DOWNLOAD_BYTES)) {
    throw new Error('file too large (' + buf.length + ' bytes)');
  }
  return {
    buffer: buf,
    contentType: String(res.headers.get('content-type') || '').split(';')[0].trim(),
  };
}

async function findChildByName(parentId, name, mimeType, accessToken, cache) {
  const key = parentId + '|' + (mimeType || '*') + '|' + String(name || '').trim().toLowerCase();
  if (cache[key]) return cache[key];
  const children = await drive.listDriveChildren(parentId, accessToken);
  const want = String(name || '').trim().toLowerCase();
  const hit = (children || []).find(function (child) {
    if (!child || !child.id) return false;
    if (mimeType && child.mimeType !== mimeType) return false;
    return String(child.name || '').trim().toLowerCase() === want;
  });
  if (hit) {
    cache[key] = hit;
    return hit;
  }
  return null;
}

async function findGradeFolderId(rootFolderId, gradeId, accessToken, cache) {
  const label = gradeFolderLabel(gradeId);
  const exact = await findChildByName(rootFolderId, label, FOLDER_MIME, accessToken, cache);
  if (exact) return exact.id;

  const children = await drive.listDriveChildren(rootFolderId, accessToken);
  const gid = normalizeGradeId(gradeId);
  const match = (children || []).find(function (child) {
    if (!child || child.mimeType !== FOLDER_MIME) return false;
    const parsed = drive.parseGradeIdFromFolderName(child.name);
    return parsed && String(parsed) === String(gid);
  });
  if (match) {
    const cacheKey = rootFolderId + '|' + FOLDER_MIME + '|' + String(match.name || '').trim().toLowerCase();
    cache[cacheKey] = match;
    return match.id;
  }
  return null;
}

async function ensureFolder(parentId, name, accessToken, dryRun, cache) {
  const existing = await findChildByName(parentId, name, FOLDER_MIME, accessToken, cache);
  if (existing) return existing.id;

  const cacheKey = parentId + '|' + FOLDER_MIME + '|' + String(name || '').trim().toLowerCase();
  if (dryRun) {
    const fakeId = 'dry-run-folder:' + parentId + ':' + name;
    cache[cacheKey] = { id: fakeId, name: name, mimeType: FOLDER_MIME };
    return fakeId;
  }

  const res = await fetch(DRIVE_API + '/files?supportsAllDrives=true&fields=id,name,mimeType,webViewLink', {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, driveHeaders(accessToken)),
    body: JSON.stringify({
      name: name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('create folder failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const created = JSON.parse(text);
  cache[cacheKey] = created;
  console.log('[admin-sync-drive] created folder:', name, '→', created.id);
  return created.id;
}

async function ensureGradeFolder(rootFolderId, gradeId, accessToken, dryRun, cache) {
  const existingId = await findGradeFolderId(rootFolderId, gradeId, accessToken, cache);
  if (existingId) return existingId;
  return ensureFolder(rootFolderId, gradeFolderLabel(gradeId), accessToken, dryRun, cache);
}

async function findByAppProperties(materialId, role, accessToken) {
  const mid = String(materialId || '').trim();
  if (!mid || String(accessToken || '').indexOf('dry-run') === 0) return null;
  const q = [
    'appProperties has { key=\'' + APP_PROP_MATERIAL + '\' and value=\'' + mid.replace(/'/g, "\\'") + '\' }',
    'appProperties has { key=\'' + APP_PROP_ROLE + '\' and value=\'' + role + '\' }',
    'trashed = false',
  ].join(' and ');
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('spaces', 'drive');
  params.set('pageSize', '5');
  params.set('supportsAllDrives', 'true');
  params.set('includeItemsFromAllDrives', 'true');
  params.set('fields', 'files(id,name,mimeType,webViewLink,description,appProperties,parents)');
  const res = await fetch(DRIVE_API + '/files?' + params.toString(), {
    headers: driveHeaders(accessToken),
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn('[admin-sync-drive] appProperties lookup failed:', res.status, text.slice(0, 160));
    return null;
  }
  const payload = text ? JSON.parse(text) : {};
  const files = Array.isArray(payload.files) ? payload.files : [];
  return files[0] || null;
}

async function patchFileDescription(fileId, description, accessToken) {
  if (!fileId || String(fileId).indexOf('dry-run') === 0) return false;
  const res = await fetch(
    DRIVE_API + '/files/' + encodeURIComponent(fileId)
    + '?supportsAllDrives=true&fields=id,description',
    {
      method: 'PATCH',
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
      }, driveHeaders(accessToken)),
      body: JSON.stringify({ description: String(description || '').slice(0, MAX_DESCRIPTION_CHARS) }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(function () { return ''; });
    console.warn('[admin-sync-drive] description patch failed:', fileId, res.status, text.slice(0, 160));
    return false;
  }
  return true;
}

/**
 * Create (or reuse) a Drive shortcut into the grade/topic folder and stamp description.
 */
async function createShortcutWithMetadata(parentId, shortcutName, targetId, description, materialId, accessToken, dryRun) {
  if (!targetId) return null;
  if (String(parentId || '').indexOf('dry-run') === 0 || dryRun) {
    return {
      id: 'dry-run-shortcut:' + materialId,
      name: shortcutName,
      dryRun: true,
      skipped: false,
    };
  }

  const byProp = await findByAppProperties(materialId, ROLE_SHORTCUT, accessToken);
  if (byProp) {
    await patchFileDescription(byProp.id, description, accessToken);
    return Object.assign({}, byProp, { skipped: true });
  }

  const existing = await findChildByName(parentId, shortcutName, SHORTCUT_MIME, accessToken, {});
  if (existing) {
    await patchFileDescription(existing.id, description, accessToken);
    return Object.assign({}, existing, { skipped: true });
  }

  const res = await fetch(
    DRIVE_API + '/files?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,description,appProperties',
    {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
      }, driveHeaders(accessToken)),
      body: JSON.stringify({
        name: shortcutName,
        mimeType: SHORTCUT_MIME,
        parents: [parentId],
        description: String(description || '').slice(0, MAX_DESCRIPTION_CHARS),
        shortcutDetails: { targetId: String(targetId) },
        appProperties: {
          [APP_PROP_MATERIAL]: String(materialId || ''),
          [APP_PROP_ROLE]: ROLE_SHORTCUT,
        },
      }),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error('create shortcut failed (' + res.status + '): ' + text.slice(0, 300));
  }
  return Object.assign({}, JSON.parse(text), { skipped: false });
}

/**
 * Lightweight plain-text record when Google Docs conversion is unavailable
 * or as a readable companion for external links without Drive preview.
 */
async function createPlainTextRecord(parentId, fileName, bodyText, description, materialId, accessToken, dryRun) {
  if (String(parentId || '').indexOf('dry-run') === 0 || dryRun) {
    return { id: 'dry-run-txt:' + materialId, name: fileName, dryRun: true, skipped: false };
  }

  const byProp = await findByAppProperties(materialId, ROLE_CONTENT_TXT, accessToken);
  if (byProp) {
    await patchFileDescription(byProp.id, description, accessToken);
    return Object.assign({}, byProp, { skipped: true });
  }

  const existing = await findChildByName(parentId, fileName, 'text/plain', accessToken, {});
  if (existing) {
    await patchFileDescription(existing.id, description, accessToken);
    return Object.assign({}, existing, { skipped: true });
  }

  const boundary = 'waldorf_txt_' + Date.now().toString(36);
  const meta = JSON.stringify({
    name: fileName,
    mimeType: 'text/plain',
    parents: [parentId],
    description: String(description || '').slice(0, MAX_DESCRIPTION_CHARS),
    appProperties: {
      [APP_PROP_MATERIAL]: String(materialId || ''),
      [APP_PROP_ROLE]: ROLE_CONTENT_TXT,
    },
  });
  const media = Buffer.from(String(bodyText || ''), 'utf8');
  const preamble = Buffer.from(
    '--' + boundary + '\r\n'
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + meta + '\r\n'
    + '--' + boundary + '\r\n'
    + 'Content-Type: text/plain; charset=UTF-8\r\n\r\n',
    'utf8'
  );
  const closing = Buffer.from('\r\n--' + boundary + '--', 'utf8');
  const body = Buffer.concat([preamble, media, closing]);

  const res = await fetch(
    DRIVE_UPLOAD_API + '/files?uploadType=multipart&supportsAllDrives=true'
    + '&fields=id,name,mimeType,webViewLink,description,appProperties',
    {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'multipart/related; boundary=' + boundary,
        'Content-Length': String(body.length),
      }, driveHeaders(accessToken)),
      body: body,
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error('create text record failed (' + res.status + '): ' + text.slice(0, 300));
  }
  return Object.assign({}, JSON.parse(text), { skipped: false });
}

async function createContentDocument(parentId, docName, bodyText, description, materialId, accessToken, dryRun) {
  if (String(parentId || '').indexOf('dry-run') === 0 || dryRun) {
    return { id: 'dry-run-content:' + materialId, name: docName, dryRun: true, skipped: false };
  }

  const byProp = await findByAppProperties(materialId, ROLE_CONTENT, accessToken);
  if (byProp) {
    await patchFileDescription(byProp.id, description, accessToken);
    return Object.assign({}, byProp, { skipped: true });
  }

  const existing = await findChildByName(parentId, docName, DOCS_MIME, accessToken, {});
  if (existing) {
    await patchFileDescription(existing.id, description, accessToken);
    return Object.assign({}, existing, { skipped: true });
  }

  const boundary = 'waldorf_content_' + Date.now().toString(36);
  const meta = JSON.stringify({
    name: docName,
    mimeType: DOCS_MIME,
    parents: [parentId],
    description: String(description || '').slice(0, MAX_DESCRIPTION_CHARS),
    appProperties: {
      [APP_PROP_MATERIAL]: String(materialId || ''),
      [APP_PROP_ROLE]: ROLE_CONTENT,
    },
  });
  const media = Buffer.from(String(bodyText || ''), 'utf8');
  const preamble = Buffer.from(
    '--' + boundary + '\r\n'
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + meta + '\r\n'
    + '--' + boundary + '\r\n'
    + 'Content-Type: text/plain; charset=UTF-8\r\n\r\n',
    'utf8'
  );
  const closing = Buffer.from('\r\n--' + boundary + '--', 'utf8');
  const body = Buffer.concat([preamble, media, closing]);

  const res = await fetch(
    DRIVE_UPLOAD_API + '/files?uploadType=multipart&supportsAllDrives=true'
    + '&fields=id,name,mimeType,webViewLink,description,appProperties',
    {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'multipart/related; boundary=' + boundary,
        'Content-Length': String(body.length),
      }, driveHeaders(accessToken)),
      body: body,
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error('create content doc failed (' + res.status + '): ' + text.slice(0, 300));
  }
  return Object.assign({}, JSON.parse(text), { skipped: false });
}

async function uploadBinaryFile(parentId, fileName, mimeType, buffer, description, materialId, accessToken, dryRun) {
  if (String(parentId || '').indexOf('dry-run') === 0 || dryRun) {
    return { id: 'dry-run-file:' + materialId, name: fileName, dryRun: true, skipped: false };
  }

  const byProp = await findByAppProperties(materialId, ROLE_FILE, accessToken);
  if (byProp) {
    await patchFileDescription(byProp.id, description, accessToken);
    return Object.assign({}, byProp, { skipped: true });
  }

  const existing = await findChildByName(parentId, fileName, null, accessToken, {});
  if (existing && existing.mimeType !== FOLDER_MIME) {
    await patchFileDescription(existing.id, description, accessToken);
    return Object.assign({}, existing, { skipped: true });
  }

  const boundary = 'waldorf_file_' + Date.now().toString(36);
  const meta = JSON.stringify({
    name: fileName,
    parents: [parentId],
    description: String(description || '').slice(0, MAX_DESCRIPTION_CHARS),
    appProperties: {
      [APP_PROP_MATERIAL]: String(materialId || ''),
      [APP_PROP_ROLE]: ROLE_FILE,
    },
  });
  const preamble = Buffer.from(
    '--' + boundary + '\r\n'
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + meta + '\r\n'
    + '--' + boundary + '\r\n'
    + 'Content-Type: ' + (mimeType || 'application/octet-stream') + '\r\n\r\n',
    'utf8'
  );
  const closing = Buffer.from('\r\n--' + boundary + '--', 'utf8');
  const body = Buffer.concat([preamble, buffer, closing]);

  const res = await fetch(
    DRIVE_UPLOAD_API + '/files?uploadType=multipart&supportsAllDrives=true'
    + '&fields=id,name,mimeType,webViewLink,description,appProperties',
    {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'multipart/related; boundary=' + boundary,
        'Content-Length': String(body.length),
      }, driveHeaders(accessToken)),
      body: body,
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error('upload binary failed (' + res.status + '): ' + text.slice(0, 300));
  }
  return Object.assign({}, JSON.parse(text), { skipped: false });
}

async function processMaterial(row, ctx) {
  const gradeId = normalizeGradeId(row.grade_level);
  const meta = parseMaterialMeta(row);
  const topic = meta.topic;
  const classified = classifyFilePath(row.file_path);
  const gradeLabel = gradeFolderLabel(gradeId);
  const sourceUrl = String(row.file_path || '').trim();
  const description = buildDriveDescription(meta, gradeLabel, sourceUrl, row.id);
  const contentBody = buildContentBody(meta, gradeLabel, sourceUrl, row.id);
  const contentDocName = safeDriveFileName(meta.title + CONTENT_DOC_SUFFIX, topic + CONTENT_DOC_SUFFIX);
  const contentTxtName = safeDriveFileName(meta.title + CONTENT_TXT_SUFFIX, topic + CONTENT_TXT_SUFFIX);

  const gradeFolderId = await ensureGradeFolder(
    ctx.rootFolderId,
    gradeId,
    ctx.accessToken,
    ctx.dryRun,
    ctx.folderCache
  );
  const topicFolderId = await ensureFolder(
    gradeFolderId,
    topic,
    ctx.accessToken,
    ctx.dryRun,
    ctx.folderCache
  );

  let notes = meta.notes;
  let contentResult = null;
  let textResult = null;
  let fileResult = null;
  let shortcutResult = null;

  // Always create/refresh a readable content Doc so Drive previews are never empty.
  const skipContent = ctx.skipExisting && meta.contentDocId && !ctx.force;
  if (skipContent) {
    ctx.stats.skippedExisting += 1;
    contentResult = { id: meta.contentDocId, skipped: true, reason: 'notes_tag' };
    await patchFileDescription(meta.contentDocId, description, ctx.accessToken);
  } else {
    try {
      contentResult = await createContentDocument(
        topicFolderId,
        contentDocName,
        contentBody,
        description,
        row.id,
        ctx.accessToken,
        ctx.dryRun
      );
      if (contentResult.skipped) ctx.stats.skippedExisting += 1;
      else ctx.stats.contentDocsCreated += 1;
      if (contentResult.id && String(contentResult.id).indexOf('dry-run') !== 0) {
        notes = setNotesTag(notes, SYNC_TAG_CONTENT, contentResult.id);
      }
    } catch (docErr) {
      console.warn(
        '[admin-sync-drive] content Doc failed, falling back to .txt:',
        row.id,
        docErr && docErr.message ? docErr.message : docErr
      );
      textResult = await createPlainTextRecord(
        topicFolderId,
        contentTxtName,
        contentBody,
        description,
        row.id,
        ctx.accessToken,
        ctx.dryRun
      );
      if (textResult.skipped) ctx.stats.skippedExisting += 1;
      else ctx.stats.textRecordsCreated += 1;
      if (textResult.id && String(textResult.id).indexOf('dry-run') !== 0) {
        notes = setNotesTag(notes, SYNC_TAG_CONTENT, textResult.id);
      }
      contentResult = textResult;
    }
  }

  // External / Docs links: also keep a plain-text twin so AI + teachers can open
  // title + full description + URL without relying on Drive preview of the target.
  const needsLinkTextTwin = (
    classified.kind === 'external_url'
    || classified.kind === 'docs'
    || classified.kind === 'drive_file'
    || classified.kind === 'drive_folder'
    || classified.kind === 'empty'
    || classified.kind === 'unknown'
  );
  if (needsLinkTextTwin && !textResult) {
    try {
      textResult = await createPlainTextRecord(
        topicFolderId,
        contentTxtName,
        contentBody,
        description,
        row.id,
        ctx.accessToken,
        ctx.dryRun
      );
      if (textResult.skipped) ctx.stats.skippedExisting += 1;
      else ctx.stats.textRecordsCreated += 1;
    } catch (txtErr) {
      console.warn(
        '[admin-sync-drive] text record failed:',
        row.id,
        txtErr && txtErr.message ? txtErr.message : txtErr
      );
    }
  }

  if (classified.kind === 'storage') {
    const skipFile = ctx.skipExisting && meta.syncedFileId && !ctx.force;
    if (skipFile) {
      ctx.stats.skippedExisting += 1;
      fileResult = { id: meta.syncedFileId, skipped: true, reason: 'notes_tag' };
      await patchFileDescription(meta.syncedFileId, description, ctx.accessToken);
    } else {
      const downloaded = await downloadHttpBuffer(classified.value);
      const mime = downloaded.contentType || guessMimeFromName(meta.fileName || meta.title);
      const binaryName = safeDriveFileName(meta.fileName || meta.title, topic);
      fileResult = await uploadBinaryFile(
        topicFolderId,
        binaryName,
        mime,
        downloaded.buffer,
        description,
        row.id,
        ctx.accessToken,
        ctx.dryRun
      );
      if (fileResult.skipped) ctx.stats.skippedExisting += 1;
      else ctx.stats.filesUploaded += 1;
      if (fileResult.id && String(fileResult.id).indexOf('dry-run') !== 0) {
        notes = setNotesTag(notes, SYNC_TAG_FILE, fileResult.id);
        // Keep driveFileId pointing at the physical copy when not already set.
        if (!meta.driveFileId) {
          notes = setNotesTag(notes, 'driveFileId', fileResult.id);
        }
      }
    }
  } else if (
    classified.kind === 'drive_file'
    || classified.kind === 'docs'
    || classified.kind === 'drive_folder'
  ) {
    ctx.stats.linkMaterials += 1;
    const targetId = String(classified.driveId || meta.driveFileId || '').trim();
    if (targetId) {
      const shortcutName = safeDriveFileName(
        meta.fileName || meta.title || topic,
        topic + (classified.kind === 'drive_folder' ? ' (תיקייה)' : ' (קיצור)')
      );
      const skipShortcut = ctx.skipExisting && meta.shortcutId && !ctx.force;
      if (skipShortcut) {
        ctx.stats.skippedExisting += 1;
        shortcutResult = { id: meta.shortcutId, skipped: true, reason: 'notes_tag' };
        await patchFileDescription(meta.shortcutId, description, ctx.accessToken);
      } else {
        shortcutResult = await createShortcutWithMetadata(
          topicFolderId,
          shortcutName,
          targetId,
          description,
          row.id,
          ctx.accessToken,
          ctx.dryRun
        );
        if (shortcutResult && shortcutResult.skipped) ctx.stats.skippedExisting += 1;
        else if (shortcutResult) ctx.stats.shortcutsCreated += 1;
        if (shortcutResult && shortcutResult.id && String(shortcutResult.id).indexOf('dry-run') !== 0) {
          notes = setNotesTag(notes, SYNC_TAG_SHORTCUT, shortcutResult.id);
          if (!meta.driveFileId) {
            notes = setNotesTag(notes, 'driveFileId', shortcutResult.id);
          }
        }
      }
      // Best-effort: stamp description on the original Drive/Docs target too.
      try {
        await patchFileDescription(targetId, description, ctx.accessToken);
      } catch (targetDescErr) {
        /* ignore — may lack write access on external targets */
      }
    }
  } else {
    ctx.stats.linkMaterials += 1;
  }

  if (!ctx.dryRun && notes !== meta.notes) {
    const ok = await patchMaterialNotes(row.id, notes);
    if (ok) ctx.stats.notesUpdated += 1;
  }

  return {
    materialId: row.id,
    gradeId: gradeId,
    gradeLabel: gradeLabel,
    topic: topic,
    kind: classified.kind,
    contentDocId: contentResult && contentResult.id,
    contentSkipped: Boolean(contentResult && contentResult.skipped),
    textRecordId: textResult && textResult.id,
    fileId: fileResult && fileResult.id,
    fileSkipped: Boolean(fileResult && fileResult.skipped),
    shortcutId: shortcutResult && shortcutResult.id,
    shortcutSkipped: Boolean(shortcutResult && shortcutResult.skipped),
  };
}

/**
 * Run full Supabase → Drive content backfill.
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.force=false] Re-check / refresh even when tags exist
 * @param {number} [options.limit] Cap materials processed
 * @param {string} [options.rootFolderId]
 * @param {boolean} [options.skipExisting=true]
 */
async function syncSupabaseMaterialsToDrive(options) {
  const opts = options || {};
  if (_running) {
    return {
      ok: false,
      running: true,
      message: 'Supabase→Drive sync already in progress',
      startedAt: _running.startedAt,
    };
  }

  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const skipExisting = opts.skipExisting !== false;

  if (!drive.isDriveCatalogSyncConfigured()) {
    const err = new Error('Google Drive is not configured (see docs/google-drive-setup.md)');
    err.statusCode = 503;
    throw err;
  }
  if (!getSupabaseConfig()) {
    const err = new Error('Supabase is not configured');
    err.statusCode = 503;
    throw err;
  }

  const startedAt = new Date().toISOString();
  _running = { startedAt: startedAt };

  const stats = {
    scanned: 0,
    processed: 0,
    contentDocsCreated: 0,
    textRecordsCreated: 0,
    filesUploaded: 0,
    shortcutsCreated: 0,
    linkMaterials: 0,
    skippedExisting: 0,
    notesUpdated: 0,
    errors: 0,
  };
  const results = [];
  const errors = [];

  try {
    const rootFolderId = drive.getCatalogRootFolderId({ rootFolderId: opts.rootFolderId });
    const materials = await fetchAllMaterials(opts.limit);
    stats.scanned = materials.length;

    const accessToken = dryRun
      ? 'dry-run-token'
      : await drive.resolveDriveAccessToken({ write: true, preferOauth: true });

    const ctx = {
      rootFolderId: rootFolderId,
      accessToken: accessToken,
      dryRun: dryRun,
      force: force,
      skipExisting: skipExisting,
      folderCache: {},
      stats: stats,
    };

    console.log(
      '[admin-sync-drive] starting',
      '| materials:',
      materials.length,
      '| dryRun:',
      dryRun,
      '| force:',
      force,
      '| root:',
      rootFolderId
    );

    for (let i = 0; i < materials.length; i++) {
      const row = materials[i];
      try {
        const entry = await processMaterial(row, ctx);
        stats.processed += 1;
        results.push(entry);
      } catch (err) {
        stats.errors += 1;
        const message = err && err.message ? err.message : String(err);
        errors.push({ materialId: row && row.id, error: message });
        console.error('[admin-sync-drive] material failed:', row && row.id, message);
      }
    }

    const summary = {
      ok: true,
      dryRun: dryRun,
      force: force,
      rootFolderId: rootFolderId,
      startedAt: startedAt,
      finishedAt: new Date().toISOString(),
      stats: stats,
      errors: errors.slice(0, 50),
      sample: results.slice(0, 20),
    };
    console.log('[admin-sync-drive] done', JSON.stringify(stats));
    return summary;
  } finally {
    _running = null;
  }
}

function isSyncRunning() {
  return Boolean(_running);
}

function scheduleBackgroundSync(options) {
  if (_running) {
    console.log('[admin-sync-drive] skip background — already running');
    return false;
  }
  setImmediate(function () {
    syncSupabaseMaterialsToDrive(options || {}).catch(function (err) {
      console.error(
        '[admin-sync-drive] background sync failed:',
        err && err.message ? err.message : err
      );
    });
  });
  return true;
}

async function handleAdminSyncDriveRequest(req, res, query, writeJson) {
  const q = query || {};
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const dryRun = String(q.dryRun || q.dry_run || '').trim() === '1'
    || String(q.dryRun || '').toLowerCase() === 'true';
  const force = String(q.force || '').trim() === '1'
    || String(q.force || '').toLowerCase() === 'true';
  const background = String(q.background || '').trim() === '1'
    || String(q.async || '').trim() === '1';
  const limit = Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : 0;

  if (background) {
    const started = scheduleBackgroundSync({
      dryRun: dryRun,
      force: force,
      limit: limit || undefined,
      rootFolderId: q.rootFolderId || undefined,
    });
    writeJson(res, 202, {
      ok: true,
      accepted: started,
      running: isSyncRunning(),
      message: started
        ? 'Supabase→Drive sync started in background'
        : 'Sync already in progress',
    });
    return;
  }

  const result = await syncSupabaseMaterialsToDrive({
    dryRun: dryRun,
    force: force,
    limit: limit || undefined,
    rootFolderId: q.rootFolderId || undefined,
  });
  writeJson(res, result.running ? 409 : 200, result);
}

module.exports = {
  syncSupabaseMaterialsToDrive,
  scheduleBackgroundSync,
  isSyncRunning,
  handleAdminSyncDriveRequest,
  fetchAllMaterials,
  gradeFolderLabel,
  classifyFilePath,
  parseMaterialMeta,
  buildDriveDescription,
  buildContentBody,
  createShortcutWithMetadata,
  createPlainTextRecord,
  SYNC_TAG_CONTENT,
  SYNC_TAG_FILE,
  SYNC_TAG_SHORTCUT,
};
