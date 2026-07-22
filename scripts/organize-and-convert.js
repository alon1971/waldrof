#!/usr/bin/env node
'use strict';

/**
 * Sync community materials into the Drive catalog root, organize by grade/topic,
 * and convert PDF/DOC/DOCX to Google Docs copies (originals are never deleted).
 *
 * Usage:
 *   npm run organize-drive                 # dry-run (default, safe)
 *   npm run organize-drive:apply           # apply sync + moves + conversions
 *   node scripts/organize-and-convert.js --apply --from-community --default-grade=7
 *   node scripts/organize-and-convert.js --default-grade=7 --default-topic=כללי
 *
 * Pipeline:
 *   1) Optional --from-community: pull Supabase community_materials into Drive root
 *      (storage files uploaded; Drive/Docs links become shortcuts when accessible)
 *      plus community_drive_archive file_refs (keyed by archive_key / search_query)
 *   2) Ensure כיתה א׳–ח׳ (+ root כללי) folders exist under catalog root
 *   3) Move loose root files into grade/topic (unknown topic → כללי)
 *   4) Convert PDF/DOC/DOCX → Google Docs copies for Gemini text extraction
 *
 * Requirements:
 *   - GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID (or DRIVE_ROOT_FOLDER_ID)
 *   - Auth for writes into personal My Drive (SA has no storage quota):
 *       GOOGLE_DRIVE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN
 *       (run: node scripts/google-drive-oauth-setup.js --write-env)
 *     OR Workspace domain-wide delegation: GOOGLE_DRIVE_DELEGATE_EMAIL + SA
 *     OR catalog root inside a Shared Drive with SA as Content Manager
 *   - SA alone (Editor on a personal folder) is enough for list/move/shortcut,
 *     but NOT for binary upload / PDF→Docs conversion
 *   - SUPABASE_* for --from-community (community_materials + community_drive_archive)
 *
 * Safety:
 *   - Dry-run by default (pass --apply to write)
 *   - Never deletes source files / shortcuts
 *   - Conversion creates a NEW Google Docs copy only
 */

require('../api/env');

// Alias used by ops docs / Render: DRIVE_ROOT_FOLDER_ID → catalog root
if (
  String(process.env.DRIVE_ROOT_FOLDER_ID || '').trim()
  && !String(process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID || '').trim()
) {
  process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID = String(process.env.DRIVE_ROOT_FOLDER_ID).trim();
}

const drive = require('../api/drive-catalog-sync');
const catalogTopics = require('../api/catalog-topics');
const pedagogicalScope = require('../api/pedagogical-scope');
const env = require('../api/env');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = drive.FOLDER_MIME || 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = drive.SHORTCUT_MIME || 'application/vnd.google-apps.shortcut';
const DOCS_MIME = 'application/vnd.google-apps.document';
const PDF_MIME = 'application/pdf';
const STORAGE_BUCKET = 'community-uploads';

/** Convert all PDFs by default (Gemini Docs path); override with --min-pdf-bytes=N */
const DEFAULT_MIN_PDF_BYTES = 0;
const MAX_CONVERT_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_TOPIC_FOLDER = 'כללי';
const GENERAL_GRADE_FOLDER = 'כללי';

function parseArgs(argv) {
  const args = {
    apply: false,
    convertPdfs: true,
    fromCommunity: false,
    defaultGrade: '',
    defaultTopic: DEFAULT_TOPIC_FOLDER,
    minPdfBytes: DEFAULT_MIN_PDF_BYTES,
    limit: 0,
    createMissingTopics: true,
    createMissingGrades: true,
  };
  (argv || []).forEach(function (raw) {
    const a = String(raw || '').trim();
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--from-community') args.fromCommunity = true;
    else if (a === '--no-from-community') args.fromCommunity = false;
    else if (a === '--no-convert' || a === '--skip-convert') args.convertPdfs = false;
    else if (a === '--convert-pdfs') args.convertPdfs = true;
    else if (a === '--no-create-topics') args.createMissingTopics = false;
    else if (a === '--no-create-grades') args.createMissingGrades = false;
    else if (a.indexOf('--default-grade=') === 0) {
      args.defaultGrade = String(a.slice('--default-grade='.length)).trim();
    } else if (a.indexOf('--default-topic=') === 0) {
      args.defaultTopic = String(a.slice('--default-topic='.length)).trim() || DEFAULT_TOPIC_FOLDER;
    } else if (a.indexOf('--min-pdf-bytes=') === 0) {
      const n = Number(a.slice('--min-pdf-bytes='.length));
      if (Number.isFinite(n) && n >= 0) args.minPdfBytes = n;
    } else if (a.indexOf('--limit=') === 0) {
      const n = Number(a.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
    }
  });
  return args;
}

function driveHeaders(accessToken, resourceKeyByFileId) {
  if (typeof drive.buildDriveRequestHeaders === 'function') {
    return drive.buildDriveRequestHeaders(accessToken, resourceKeyByFileId || {});
  }
  return { Authorization: 'Bearer ' + accessToken };
}

function isPdfFile(file) {
  const mime = String((file && file.mimeType) || '').toLowerCase();
  const name = String((file && file.name) || '');
  return mime === PDF_MIME || /\.pdf$/i.test(name);
}

function isDocFile(file) {
  const mime = String((file && file.mimeType) || '').toLowerCase();
  const name = String((file && file.name) || '');
  return (
    mime === 'application/msword'
    || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || /\.docx?$/i.test(name)
  );
}

/** PDF / Word sources that should get a Google Docs copy. */
function isConvertibleFile(file) {
  return isPdfFile(file) || isDocFile(file);
}

function mediaContentType(file) {
  if (isPdfFile(file)) return 'application/pdf';
  const mime = String((file && file.mimeType) || '').toLowerCase();
  if (mime === 'application/msword' || /\.doc$/i.test(file && file.name || '')) {
    return 'application/msword';
  }
  return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

function stripConvertibleExtension(name) {
  return String(name || '').replace(/\.(pdf|docx?)$/i, '').trim() || 'מסמך';
}

function docsCopyName(sourceName) {
  return stripConvertibleExtension(sourceName) + ' (Google Docs)';
}

async function listRootItemsRaw(folderId, accessToken) {
  // Do NOT expand shortcuts — we want to move the shortcut shells sitting at root.
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams();
    params.set('q', "'" + folderId + "' in parents and trashed=false");
    params.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,webViewLink,trashed,modifiedTime,size,parents,resourceKey,'
      + 'shortcutDetails(targetId,targetMimeType,targetResourceKey))'
    );
    params.set('pageSize', '200');
    params.set('supportsAllDrives', 'true');
    params.set('includeItemsFromAllDrives', 'true');
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(DRIVE_API + '/files?' + params.toString(), {
      headers: driveHeaders(accessToken),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error('list root failed (' + res.status + '): ' + text.slice(0, 300));
    }
    const data = JSON.parse(text);
    if (Array.isArray(data.files)) items.push.apply(items, data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return items;
}

/**
 * Infer gradeId + canonical topic from a root file/shortcut name.
 * Uses longest alias substring match (no weak morphology) to avoid
 * «עולם» bridging אדם-עולם ↔ מגלי-עולם ↔ מסעות.
 */
function inferPlacement(fileName, options) {
  const opts = options || {};
  const name = String(fileName || '').trim();
  const nameNorm = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\u05F3\u05F4׳״`'"]/g, '')
    .replace(/[-–—_/]+/g, ' ')
    .replace(/\s+/g, ' ');

  const gradeFromName = typeof catalogTopics.extractGradeIdFromQuery === 'function'
    ? catalogTopics.extractGradeIdFromQuery(name)
    : '';

  // Extra organize-only topics that exist as classroom folders but are not
  // always first-class catalog alias clusters (e.g. מגלי עולם / רנסנס).
  const extraTopics = [
    ['מגלי עולם', ['מגלי עולם', 'מגלי-עולם', 'מגלים', 'גילוי העולם', 'explorers']],
    ['רנסנס', ['רנסנס', 'רנסאנס', 'renaissance']],
    ['אסטרונומיה', ['אסטרונומיה', 'astronomy']],
    ['פיזיקה', ['פיזיקה', 'physics']],
    ['כימיה', ['כימיה', 'chemistry']],
  ];

  const clusters = (catalogTopics.CATALOG_TOPIC_ALIAS_CLUSTERS || []).map(function (cluster) {
    return [cluster[0], cluster.slice()];
  }).concat(extraTopics);

  let bestTopic = '';
  let bestLen = 0;
  clusters.forEach(function (entry) {
    const canon = entry[0];
    const aliases = entry[1] || [];
    aliases.forEach(function (alias) {
      const a = String(alias || '')
        .trim()
        .toLowerCase()
        .replace(/[\u05F3\u05F4׳״`'"]/g, '')
        .replace(/[-–—_/]+/g, ' ')
        .replace(/\s+/g, ' ');
      if (!a || a.length < 3) return;
      // Require solid substring / equality — never bare-token morphology.
      let hit = nameNorm === a
        || nameNorm.indexOf(a) >= 0
        || (a.indexOf(nameNorm) >= 0 && nameNorm.length >= 4);
      // Hebrew construct: תזונת… ↔ תזונה
      if (!hit && a.length >= 4 && a.charAt(a.length - 1) === 'ה') {
        const stem = a.slice(0, -1);
        if (stem.length >= 3 && nameNorm.indexOf(stem) >= 0) hit = true;
      }
      if (hit && a.length > bestLen) {
        bestLen = a.length;
        bestTopic = canon;
      }
    });
  });

  let gradeId = gradeFromName || '';
  if (!gradeId && bestTopic === 'מגלי עולם') gradeId = '7';
  if (!gradeId && bestTopic === 'רנסנס') gradeId = '7';
  if (!gradeId && bestTopic && typeof pedagogicalScope.inferTopicCurriculumBlock === 'function') {
    const block = pedagogicalScope.inferTopicCurriculumBlock(bestTopic)
      || pedagogicalScope.inferTopicCurriculumBlock(name);
    if (block && block.gradeId) gradeId = String(block.gradeId);
  }
  if (!gradeId && opts.defaultGrade) gradeId = String(opts.defaultGrade).trim();

  return {
    gradeId: gradeId,
    topic: bestTopic,
    gradeFromName: Boolean(gradeFromName),
    usedDefaultGrade: Boolean(
      !gradeFromName && opts.defaultGrade && gradeId === String(opts.defaultGrade).trim()
    ),
  };
}

async function ensureTopicFolder(gradeFolderId, topicName, accessToken, dryRun, cache) {
  const key = gradeFolderId + '|' + String(topicName || '').trim();
  if (cache[key]) return cache[key];

  if (dryRun || String(gradeFolderId || '').indexOf('dry-run-') === 0) {
    console.log('  [dry-run] would create topic folder:', topicName, 'under', gradeFolderId);
    cache[key] = 'dry-run-topic:' + topicName;
    return cache[key];
  }

  const children = await drive.listDriveChildren(gradeFolderId, accessToken);
  const existing = (children || []).find(function (child) {
    return child
      && child.mimeType === FOLDER_MIME
      && catalogTopics.resolveCatalogTopicFromFolderName(child.name) === topicName;
  }) || (children || []).find(function (child) {
    return child
      && child.mimeType === FOLDER_MIME
      && String(child.name || '').trim() === topicName;
  });
  if (existing) {
    cache[key] = existing.id;
    return existing.id;
  }

  const res = await fetch(DRIVE_API + '/files?supportsAllDrives=true', {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, driveHeaders(accessToken)),
    body: JSON.stringify({
      name: topicName,
      mimeType: FOLDER_MIME,
      parents: [gradeFolderId],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('create topic folder failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const created = JSON.parse(text);
  console.log('  created topic folder:', topicName, '→', created.id);
  cache[key] = created.id;
  return created.id;
}

async function moveFileToFolder(fileId, fromParentId, toParentId, accessToken, dryRun, resourceKey) {
  if (fromParentId === toParentId) return { moved: false, reason: 'already_there' };
  if (dryRun) {
    console.log('  [dry-run] would move', fileId, 'from', fromParentId, '→', toParentId);
    return { moved: true, dryRun: true };
  }
  const params = new URLSearchParams();
  params.set('supportsAllDrives', 'true');
  params.set('addParents', toParentId);
  params.set('removeParents', fromParentId);
  params.set('fields', 'id,name,parents');
  const resourceKeys = {};
  if (resourceKey) resourceKeys[fileId] = resourceKey;
  const res = await fetch(
    DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?' + params.toString(),
    {
      method: 'PATCH',
      headers: driveHeaders(accessToken, resourceKeys),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error('move failed (' + res.status + '): ' + text.slice(0, 300));
  }
  return { moved: true, file: text ? JSON.parse(text) : null };
}

async function findExistingDocsCopy(parentId, desiredName, accessToken) {
  const children = await drive.listDriveChildren(parentId, accessToken);
  const want = String(desiredName || '').trim().toLowerCase();
  const base = stripConvertibleExtension(desiredName).toLowerCase();
  return (children || []).find(function (child) {
    if (!child || child.mimeType !== DOCS_MIME) return false;
    const n = String(child.name || '').trim().toLowerCase();
    return n === want || n === base || n.indexOf(base) === 0;
  }) || null;
}

/**
 * Create a Google Docs copy of a PDF/DOC/DOCX. Never modifies/deletes the source.
 * Tries files.copy conversion first; falls back to download + multipart upload.
 */
async function convertFileToGoogleDocs(file, destParentId, accessToken, dryRun, options) {
  const opts = options || {};
  const sourceName = String(file.name || 'document');
  const targetName = docsCopyName(sourceName);

  if (String(destParentId || '').indexOf('dry-run-') === 0 || dryRun) {
    console.log('  [dry-run] would convert → Docs:', sourceName, '→', targetName);
    return { converted: true, dryRun: true, name: targetName };
  }

  const existing = await findExistingDocsCopy(destParentId, targetName, accessToken);
  if (existing) {
    console.log('  Docs copy already exists, skip convert:', existing.name, existing.id);
    return { converted: false, reason: 'already_exists', file: existing };
  }

  // 1) Prefer server-side copy+convert (no download).
  try {
    const params = new URLSearchParams();
    params.set('supportsAllDrives', 'true');
    params.set('fields', 'id,name,mimeType,parents,webViewLink');
    const resourceKeys = {};
    if (file.resourceKey) resourceKeys[file.id] = file.resourceKey;
    const res = await fetch(
      DRIVE_API + '/files/' + encodeURIComponent(file.id) + '/copy?' + params.toString(),
      {
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json; charset=utf-8',
        }, driveHeaders(accessToken, resourceKeys)),
        body: JSON.stringify({
          name: targetName,
          mimeType: DOCS_MIME,
          parents: [destParentId],
        }),
      }
    );
    const text = await res.text();
    if (res.ok) {
      const created = JSON.parse(text);
      console.log('  converted via copy → Docs:', created.name, created.id);
      return { converted: true, method: 'copy', file: created };
    }
    console.warn('  copy-convert failed, will try upload fallback:', res.status, text.slice(0, 160));
  } catch (copyErr) {
    console.warn(
      '  copy-convert error, will try upload fallback:',
      copyErr && copyErr.message ? copyErr.message : copyErr
    );
  }

  // 2) Download bytes and re-upload as Google Docs (Drive OCR/convert).
  const maxBytes = opts.maxBytes || MAX_CONVERT_DOWNLOAD_BYTES;
  const buffer = await drive.downloadDriveFileBuffer(file.id, accessToken, {
    resourceKey: file.resourceKey || '',
    maxBytes: maxBytes,
  });
  const boundary = 'waldorf_' + Date.now().toString(36);
  const meta = JSON.stringify({
    name: targetName,
    mimeType: DOCS_MIME,
    parents: [destParentId],
  });
  const contentType = mediaContentType(file);
  const preamble = Buffer.from(
    '--' + boundary + '\r\n'
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + meta + '\r\n'
    + '--' + boundary + '\r\n'
    + 'Content-Type: ' + contentType + '\r\n\r\n',
    'utf8'
  );
  const closing = Buffer.from('\r\n--' + boundary + '--', 'utf8');
  const body = Buffer.concat([preamble, buffer, closing]);

  const uploadRes = await fetch(
    DRIVE_UPLOAD_API + '/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,parents,webViewLink',
    {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'multipart/related; boundary=' + boundary,
        'Content-Length': String(body.length),
      }, driveHeaders(accessToken)),
      body: body,
    }
  );
  const uploadText = await uploadRes.text();
  if (!uploadRes.ok) {
    const quotaHint = /storage quota|Service Accounts do not have storage quota/i.test(uploadText)
      ? ' — use user OAuth (scripts/google-drive-oauth-setup.js) or a Shared Drive'
      : '';
    throw new Error(
      '→Docs upload convert failed (' + uploadRes.status + ')' + quotaHint + ': '
      + uploadText.slice(0, 300)
    );
  }
  const created = JSON.parse(uploadText);
  console.log('  converted via upload → Docs:', created.name, created.id);
  return { converted: true, method: 'upload', file: created };
}

/**
 * Convert when:
 * - PDF at/above min size (or unknown size)
 * - DOC/DOCX always (Office → Docs is cheap and useful regardless of size)
 */
function shouldConvertFile(file, minPdfBytes) {
  if (isDocFile(file)) return true;
  if (!isPdfFile(file)) return false;
  const size = Number(file.size || 0);
  if (!size) return true;
  return size >= minPdfBytes;
}

function gradeLabelForId(gradeId) {
  if (gradeId === 'general') return GENERAL_GRADE_FOLDER;
  return (pedagogicalScope.GRADE_LABEL_BY_ID || {})[gradeId] || ('כיתה ' + gradeId);
}

function normalizeCommunityGradeId(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'general' || s === 'כללי') return 'general';
  if (/^[1-8]$/.test(s)) return s;
  const fromName = drive.parseGradeIdFromFolderName(s);
  return fromName || '';
}

function extractDriveIdFromUrl(rawUrl) {
  const u = String(rawUrl || '').trim();
  if (!u) return null;
  let m = u.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'folder' };
  m = u.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'file' };
  m = u.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'document' };
  m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'spreadsheet' };
  m = u.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'presentation' };
  m = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'unknown' };
  return null;
}

function isSupabaseStorageUrl(rawUrl) {
  const u = String(rawUrl || '');
  return /\/storage\/v1\/object\//i.test(u) || u.indexOf(STORAGE_BUCKET) >= 0;
}

function guessMimeFromName(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return PDF_MIME;
  if (n.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (n.endsWith('.doc')) return 'application/msword';
  if (n.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

async function createDriveFolder(name, parentId, accessToken, dryRun) {
  if (dryRun) {
    console.log('  [dry-run] would create folder:', name, 'under', parentId);
    return { id: 'dry-run-folder:' + name, name: name, mimeType: FOLDER_MIME };
  }
  const res = await fetch(DRIVE_API + '/files?supportsAllDrives=true', {
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
  console.log('  created folder:', name, '→', created.id);
  return created;
}

/**
 * Discover grade folders under root; optionally create missing כיתה א׳–ח׳ + כללי.
 */
async function ensureGradeRoots(rootFolderId, accessToken, dryRun, createMissing) {
  const rootItems = await listRootItemsRaw(rootFolderId, accessToken);
  const gradeRoots = {};
  let generalRootId = '';

  function rememberGrade(gid, folderId, source) {
    if (!gid || !folderId) return;
    if (gid === 'general') {
      if (!generalRootId) {
        generalRootId = folderId;
        console.log('[organize-and-convert] general folder ←', source);
      }
      return;
    }
    if (gradeRoots[gid]) return;
    gradeRoots[gid] = folderId;
    console.log('[organize-and-convert] grade', gid, '←', source);
  }

  for (let i = 0; i < (rootItems || []).length; i++) {
    const item = rootItems[i];
    if (!item || item.mimeType !== FOLDER_MIME) continue;
    const name = String(item.name || '').trim();
    if (name === GENERAL_GRADE_FOLDER || name === 'כללי (כל הכיתות)') {
      rememberGrade('general', item.id, name);
      continue;
    }
    rememberGrade(drive.parseGradeIdFromFolderName(name), item.id, name);
  }

  for (let i = 0; i < (rootItems || []).length; i++) {
    const item = rootItems[i];
    if (!item || item.mimeType !== SHORTCUT_MIME) continue;
    const gidHint = drive.parseGradeIdFromFolderName(item.name);
    if (!gidHint || gradeRoots[gidHint]) continue;
    try {
      const target = await drive.resolveShortcutTarget(item, accessToken);
      if (target && target.mimeType === FOLDER_MIME && target.id) {
        rememberGrade(gidHint, target.id, item.name + ' (shortcut→folder)');
      }
    } catch (e) {
      /* ignore broken grade shortcuts */
    }
  }

  if (createMissing) {
    const needed = ['1', '2', '3', '4', '5', '6', '7', '8'];
    for (let i = 0; i < needed.length; i++) {
      const gid = needed[i];
      if (gradeRoots[gid]) continue;
      const label = gradeLabelForId(gid);
      const created = await createDriveFolder(label, rootFolderId, accessToken, dryRun);
      rememberGrade(gid, created.id, label + (dryRun ? ' (dry-run)' : ' (created)'));
    }
    if (!generalRootId) {
      const created = await createDriveFolder(
        GENERAL_GRADE_FOLDER,
        rootFolderId,
        accessToken,
        dryRun
      );
      generalRootId = created.id;
      console.log(
        '[organize-and-convert] general folder ←',
        GENERAL_GRADE_FOLDER + (dryRun ? ' (dry-run)' : ' (created)')
      );
    }
  }

  gradeRoots.general = generalRootId || gradeRoots.general || '';
  return { gradeRoots: gradeRoots, rootItems: rootItems };
}

async function findChildByName(parentId, name, accessToken) {
  const children = await drive.listDriveChildren(parentId, accessToken);
  const want = String(name || '').trim().toLowerCase();
  return (children || []).find(function (child) {
    return child && String(child.name || '').trim().toLowerCase() === want;
  }) || null;
}

async function uploadBufferToDrive(buffer, fileName, mimeType, parentId, accessToken, dryRun) {
  if (dryRun || String(parentId || '').indexOf('dry-run-') === 0) {
    console.log('  [dry-run] would upload:', fileName, '(' + buffer.length + ' bytes)');
    return { id: 'dry-run-file:' + fileName, name: fileName, mimeType: mimeType };
  }
  const existing = await findChildByName(parentId, fileName, accessToken);
  if (existing) {
    console.log('  already in Drive, skip upload:', existing.name, existing.id);
    return existing;
  }

  const boundary = 'waldorf_up_' + Date.now().toString(36);
  const meta = JSON.stringify({
    name: fileName,
    mimeType: mimeType || 'application/octet-stream',
    parents: [parentId],
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
  const body = Buffer.concat([preamble, Buffer.from(buffer), closing]);

  const uploadRes = await fetch(
    DRIVE_UPLOAD_API + '/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,parents,webViewLink,size',
    {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'multipart/related; boundary=' + boundary,
        'Content-Length': String(body.length),
      }, driveHeaders(accessToken)),
      body: body,
    }
  );
  const uploadText = await uploadRes.text();
  if (!uploadRes.ok) {
    const quotaHint = /storage quota|Service Accounts do not have storage quota/i.test(uploadText)
      ? ' — Service Account has no My Drive quota. Use user OAuth '
        + '(node scripts/google-drive-oauth-setup.js --write-env) or put the catalog '
        + 'in a Shared Drive with the SA as Content Manager.'
      : '';
    throw new Error(
      'Drive upload failed (' + uploadRes.status + ')' + quotaHint + ': ' + uploadText.slice(0, 220)
    );
  }
  const created = JSON.parse(uploadText);
  console.log('  uploaded to Drive:', created.name, created.id);
  return created;
}

async function createShortcutToTarget(targetId, shortcutName, parentId, accessToken, dryRun) {
  if (dryRun || String(parentId || '').indexOf('dry-run-') === 0) {
    console.log('  [dry-run] would shortcut:', shortcutName, '→', targetId);
    return { id: 'dry-run-shortcut:' + shortcutName, name: shortcutName, mimeType: SHORTCUT_MIME };
  }
  const existing = await findChildByName(parentId, shortcutName, accessToken);
  if (existing) {
    console.log('  shortcut/name already exists, skip:', existing.name, existing.id);
    return existing;
  }
  const res = await fetch(DRIVE_API + '/files?supportsAllDrives=true&fields=id,name,mimeType,webViewLink', {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, driveHeaders(accessToken)),
    body: JSON.stringify({
      name: shortcutName,
      mimeType: SHORTCUT_MIME,
      parents: [parentId],
      shortcutDetails: { targetId: targetId },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('shortcut create failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const created = JSON.parse(text);
  console.log('  created shortcut:', created.name, '→', targetId);
  return created;
}

function getSupabaseRestConfig() {
  const url = String(env.getSupabaseUrl() || '').replace(/\/$/, '');
  const key = env.getSupabaseServiceRoleKey();
  if (!url || !key) {
    const err = new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required for --from-community');
    err.statusCode = 503;
    throw err;
  }
  return { url: url, key: key };
}

async function fetchCommunityMaterials() {
  const cfg = getSupabaseRestConfig();
  const res = await fetch(
    cfg.url + '/rest/v1/community_materials?select=*&order=created_at.asc&limit=500',
    { headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key } }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error('community_materials fetch failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const rows = JSON.parse(text);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Fetch Gemini community Drive archive rows (archive_key + search_query + file_refs).
 * Tolerates missing table / older schemas that still expose query_text only.
 */
async function fetchCommunityDriveArchiveRows() {
  const cfg = getSupabaseRestConfig();
  const select =
    'archive_key,search_query,query_text,grade_id,topic,file_refs,source_file_ids,community_status,updated_at';
  const res = await fetch(
    cfg.url
      + '/rest/v1/community_drive_archive?select='
      + encodeURIComponent(select)
      + '&order=updated_at.desc&limit=500',
    { headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key } }
  );
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404 || /relation|does not exist|PGRST205/i.test(text)) {
      console.warn(
        '[organize-and-convert] community_drive_archive missing — run supabase/community_drive_archive.sql'
      );
      return [];
    }
    // Older schema without search_query: retry with query_text only.
    if (/search_query|PGRST204/i.test(text)) {
      const fallback = await fetch(
        cfg.url
          + '/rest/v1/community_drive_archive?select='
          + encodeURIComponent(
            'archive_key,query_text,grade_id,topic,file_refs,source_file_ids,community_status,updated_at'
          )
          + '&order=updated_at.desc&limit=500',
        { headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key } }
      );
      const fallbackText = await fallback.text();
      if (!fallback.ok) {
        console.warn(
          '[organize-and-convert] community_drive_archive fetch failed:',
          fallback.status,
          fallbackText.slice(0, 200)
        );
        return [];
      }
      const fallbackRows = JSON.parse(fallbackText);
      return Array.isArray(fallbackRows) ? fallbackRows : [];
    }
    console.warn(
      '[organize-and-convert] community_drive_archive fetch failed:',
      res.status,
      text.slice(0, 200)
    );
    return [];
  }
  const rows = JSON.parse(text);
  return Array.isArray(rows) ? rows : [];
}

function archiveSearchQuery(row) {
  return String((row && (row.search_query || row.query_text || row.topic)) || '').trim();
}

function archiveFileRefs(row) {
  const refs = row && row.file_refs;
  if (Array.isArray(refs)) return refs;
  if (typeof refs === 'string') {
    try {
      const parsed = JSON.parse(refs);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
  return [];
}

/**
 * Place Drive shortcuts from community_drive_archive.file_refs under grade/topic.
 * Uses archive_key for logging/dedup and search_query (fallback: query_text) for placement.
 */
async function syncCommunityDriveArchiveIntoDrive(options) {
  const opts = options || {};
  const accessToken = opts.accessToken;
  const gradeRoots = opts.gradeRoots || {};
  const dryRun = Boolean(opts.dryRun);
  const topicFolderCache = opts.topicFolderCache || {};
  const defaultTopic = opts.defaultTopic || DEFAULT_TOPIC_FOLDER;
  const defaultGrade = opts.defaultGrade || '';
  const seenDriveIds = opts.seenDriveIds || new Set();
  const stats = {
    rows: 0,
    shortcuts: 0,
    skipped: 0,
    errors: 0,
  };

  const rows = await fetchCommunityDriveArchiveRows();
  stats.rows = rows.length;
  console.log('[organize-and-convert] community_drive_archive rows:', rows.length);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const archiveKey = String((row && row.archive_key) || '').trim();
    const searchQuery = archiveSearchQuery(row);
    const gradeId = normalizeCommunityGradeId(row.grade_id)
      || normalizeCommunityGradeId(defaultGrade)
      || 'general';
    const topicRaw = String((row && row.topic) || '').trim();
    const topicFromQuery = searchQuery
      ? inferPlacement(searchQuery, { defaultGrade: defaultGrade || gradeId }).topic
      : '';
    const topic = topicRaw || topicFromQuery || defaultTopic;
    const refs = archiveFileRefs(row);

    if (!archiveKey) {
      console.log('- archive skip (missing archive_key):', searchQuery || '(empty query)');
      stats.skipped += 1;
      continue;
    }
    if (!refs.length) {
      console.log('- archive skip (no file_refs):', archiveKey.slice(0, 12), searchQuery || '');
      stats.skipped += 1;
      continue;
    }

    const parentGradeId = gradeRoots[gradeId] ? gradeId : (gradeRoots.general ? 'general' : '');
    const gradeFolderId = parentGradeId ? gradeRoots[parentGradeId] : '';
    if (!gradeFolderId) {
      console.log(
        '- archive skip (no grade folder):',
        archiveKey.slice(0, 12),
        'grade=',
        gradeId || '?',
        'q=',
        searchQuery || ''
      );
      stats.skipped += 1;
      continue;
    }

    const topicFolderId = await ensureTopicFolder(
      gradeFolderId,
      topic,
      accessToken,
      dryRun,
      topicFolderCache
    );

    console.log(
      '\n↔ archive',
      archiveKey.slice(0, 12),
      '| q:',
      searchQuery || '(none)',
      '| grade:',
      gradeLabelForId(parentGradeId),
      '| topic:',
      topic,
      '| refs:',
      refs.length
    );

    for (let r = 0; r < refs.length; r++) {
      const ref = refs[r] || {};
      const driveId = String(ref.driveFileId || ref.id || '').trim();
      if (!driveId) {
        stats.skipped += 1;
        continue;
      }
      if (seenDriveIds.has(driveId)) {
        stats.skipped += 1;
        continue;
      }
      seenDriveIds.add(driveId);

      const shortcutName = String(ref.name || ref.fileName || searchQuery || driveId)
        .trim()
        .slice(0, 120) || driveId;
      try {
        await createShortcutToTarget(
          driveId,
          shortcutName,
          topicFolderId,
          accessToken,
          dryRun
        );
        stats.shortcuts += 1;
      } catch (err) {
        stats.errors += 1;
        console.error(
          '  ERROR archive shortcut:',
          archiveKey.slice(0, 12),
          shortcutName,
          err && err.message ? err.message : err
        );
      }
    }
  }

  return stats;
}

/**
 * Pull community catalog rows into Drive under grade/topic folders.
 */
async function syncCommunityMaterialsIntoDrive(options) {
  const opts = options || {};
  const accessToken = opts.accessToken;
  const gradeRoots = opts.gradeRoots || {};
  const dryRun = Boolean(opts.dryRun);
  const topicFolderCache = opts.topicFolderCache || {};
  const defaultTopic = opts.defaultTopic || DEFAULT_TOPIC_FOLDER;
  const defaultGrade = opts.defaultGrade || '';
  const convertPdfs = opts.convertPdfs !== false;
  const minPdfBytes = opts.minPdfBytes != null ? opts.minPdfBytes : DEFAULT_MIN_PDF_BYTES;
  const seenDriveIds = new Set();
  const stats = {
    rows: 0,
    uploaded: 0,
    shortcuts: 0,
    converted: 0,
    skipped: 0,
    errors: 0,
    archive: null,
  };

  const rows = await fetchCommunityMaterials();
  stats.rows = rows.length;
  console.log('[organize-and-convert] community_materials rows:', rows.length);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const gradeId = normalizeCommunityGradeId(row.grade_level || row.grade);
    const topicRaw = String(row.topic || '').trim();
    const topic = topicRaw || defaultTopic;
    const fileName = String(row.file_name || '').trim() || ('material-' + (row.id || i));
    const filePath = String(row.file_path || '').trim();

    const parentGradeId = gradeRoots[gradeId] ? gradeId : (gradeRoots.general ? 'general' : '');
    const gradeFolderId = parentGradeId ? gradeRoots[parentGradeId] : '';
    if (!gradeFolderId) {
      console.log('- community skip (no grade folder):', fileName, 'grade=', gradeId || '?');
      stats.skipped += 1;
      continue;
    }

    const topicFolderId = await ensureTopicFolder(
      gradeFolderId,
      topic,
      accessToken,
      dryRun,
      topicFolderCache
    );

    console.log(
      '\n↔ community',
      fileName,
      '| grade:',
      gradeLabelForId(parentGradeId),
      '| topic:',
      topic
    );

    try {
      if (isSupabaseStorageUrl(filePath) || /\.(pdf|docx?|txt)$/i.test(fileName)) {
        if (!filePath || !/^https?:\/\//i.test(filePath)) {
          console.log('  skip — no downloadable URL');
          stats.skipped += 1;
          continue;
        }
        if (!isSupabaseStorageUrl(filePath) && !/\.(pdf|docx?)$/i.test(filePath)) {
          // Likely an external non-Drive link (benyehuda, folkmasa, …)
          const driveRef = extractDriveIdFromUrl(filePath);
          if (!driveRef) {
            console.log('  skip — external non-Drive URL');
            stats.skipped += 1;
            continue;
          }
        }

        if (isSupabaseStorageUrl(filePath)) {
          const dl = await fetch(filePath);
          if (!dl.ok) {
            throw new Error('download community file failed (' + dl.status + ')');
          }
          const ab = await dl.arrayBuffer();
          const buffer = Buffer.from(ab);
          const mime = guessMimeFromName(fileName);
          const uploaded = await uploadBufferToDrive(
            buffer,
            fileName,
            mime,
            topicFolderId,
            accessToken,
            dryRun
          );
          stats.uploaded += 1;
          if (uploaded && uploaded.id) seenDriveIds.add(String(uploaded.id));

          if (convertPdfs && shouldConvertFile(
            { name: fileName, mimeType: mime, size: buffer.length },
            minPdfBytes
          )) {
            const converted = await convertFileToGoogleDocs(
              Object.assign({}, uploaded, { name: fileName, mimeType: mime, size: buffer.length }),
              topicFolderId,
              accessToken,
              dryRun,
              { maxBytes: MAX_CONVERT_DOWNLOAD_BYTES }
            );
            if (converted.converted) stats.converted += 1;
          }
          continue;
        }
      }

      const driveRef = extractDriveIdFromUrl(filePath);
      if (driveRef && driveRef.id) {
        const shortcutName = fileName.indexOf('קישור') === 0 || fileName.indexOf('http') === 0
          ? (topic + (driveRef.kind === 'folder' ? ' (תיקייה)' : ''))
          : fileName;
        await createShortcutToTarget(
          driveRef.id,
          shortcutName.slice(0, 120),
          topicFolderId,
          accessToken,
          dryRun
        );
        seenDriveIds.add(driveRef.id);
        stats.shortcuts += 1;
        continue;
      }

      console.log('  skip — unsupported source:', filePath.slice(0, 80));
      stats.skipped += 1;
    } catch (err) {
      stats.errors += 1;
      console.error('  ERROR community:', fileName, err && err.message ? err.message : err);
    }
  }

  stats.archive = await syncCommunityDriveArchiveIntoDrive({
    accessToken: accessToken,
    gradeRoots: gradeRoots,
    dryRun: dryRun,
    topicFolderCache: topicFolderCache,
    defaultTopic: defaultTopic,
    defaultGrade: defaultGrade,
    seenDriveIds: seenDriveIds,
  });

  return stats;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !args.apply;

  console.log('[organize-and-convert] mode =', dryRun ? 'DRY-RUN (no writes)' : 'APPLY');
  console.log('[organize-and-convert] convertPdfs =', args.convertPdfs);
  console.log('[organize-and-convert] fromCommunity =', args.fromCommunity);
  console.log('[organize-and-convert] defaultGrade =', args.defaultGrade || '(none)');
  console.log('[organize-and-convert] defaultTopic =', args.defaultTopic || DEFAULT_TOPIC_FOLDER);
  console.log('[organize-and-convert] minPdfBytes =', args.minPdfBytes);
  console.log('[organize-and-convert] createMissingGrades =', args.createMissingGrades);

  if (!drive.isDriveCatalogSyncConfigured()) {
    console.error('Drive is not configured. Set GOOGLE_DRIVE_* in .env (see docs/google-drive-setup.md).');
    process.exit(2);
  }

  if (!dryRun && typeof drive.hasDriveUserWriteAuth === 'function' && !drive.hasDriveUserWriteAuth()) {
    // Probe whether the catalog root is already inside a Shared Drive.
    let sharedDriveOk = false;
    try {
      const probeToken = await drive.resolveDriveAccessToken({ write: false });
      const meta = await drive.fetchDriveFileMeta(
        drive.getCatalogRootFolderId(),
        probeToken,
        'id,name,driveId,teamDriveId'
      );
      sharedDriveOk = Boolean(meta && (meta.driveId || meta.teamDriveId));
    } catch (probeErr) {
      /* fall through to warning */
    }
    if (!sharedDriveOk) {
      console.warn(
        '[organize-and-convert] WARNING: no GOOGLE_DRIVE_OAUTH_* / DELEGATE_EMAIL and catalog '
          + 'is not a Shared Drive. Uploads/PDF→Docs will likely hit storageQuotaExceeded.\n'
          + '  Fix: node scripts/google-drive-oauth-setup.js --write-env'
      );
    }
  }

  const accessToken = await drive.resolveDriveAccessToken({ write: !dryRun });
  const authMode = typeof drive.describeDriveAuthMode === 'function'
    ? drive.describeDriveAuthMode({ write: !dryRun })
    : (dryRun ? 'readonly' : 'write');
  console.log('[organize-and-convert] auth =', authMode);
  const rootFolderId = drive.getCatalogRootFolderId();
  console.log('[organize-and-convert] root =', rootFolderId);

  const ensured = await ensureGradeRoots(
    rootFolderId,
    accessToken,
    dryRun,
    args.createMissingGrades
  );
  const gradeRoots = ensured.gradeRoots;
  console.log(
    '[organize-and-convert] grade folders:',
    Object.keys(gradeRoots).filter(function (k) { return k !== 'general'; }).sort().join(', ')
      || '(none)',
    '| general=',
    gradeRoots.general ? 'yes' : 'no'
  );

  const topicFolderCache = {};
  let communityStats = null;
  if (args.fromCommunity) {
    communityStats = await syncCommunityMaterialsIntoDrive({
      accessToken: accessToken,
      gradeRoots: gradeRoots,
      dryRun: dryRun,
      topicFolderCache: topicFolderCache,
      defaultTopic: args.defaultTopic || DEFAULT_TOPIC_FOLDER,
      defaultGrade: args.defaultGrade || '',
      convertPdfs: args.convertPdfs,
      minPdfBytes: args.minPdfBytes,
    });
    console.log('\n[organize-and-convert] community sync stats:', JSON.stringify(communityStats));
  }

  // Re-list root after community sync / grade creation (loose files still at root).
  const rootFolders = await listRootItemsRaw(rootFolderId, accessToken);

  const candidates = (rootFolders || []).filter(function (item) {
    if (!item || !item.id) return false;
    if (item.mimeType === FOLDER_MIME) return false;
    if (item.mimeType === SHORTCUT_MIME && drive.parseGradeIdFromFolderName(item.name)) {
      return false;
    }
    return true;
  });

  console.log('[organize-and-convert] root files/shortcuts:', candidates.length);

  const stats = {
    scanned: candidates.length,
    planned: 0,
    moved: 0,
    converted: 0,
    defaultTopic: 0,
    skipped: 0,
    errors: 0,
  };
  let processed = 0;
  const fallbackTopic = String(args.defaultTopic || DEFAULT_TOPIC_FOLDER).trim() || DEFAULT_TOPIC_FOLDER;

  for (let i = 0; i < candidates.length; i++) {
    if (args.limit && processed >= args.limit) break;
    const item = candidates[i];
    const name = String(item.name || '').trim() || item.id;
    const placement = inferPlacement(name, { defaultGrade: args.defaultGrade });

    // No known topic → still process: move into default topic folder (כללי) and convert if PDF/DOC.
    if (!placement.topic) {
      placement.topic = fallbackTopic;
      placement.usedDefaultTopic = true;
    }
    if (!placement.gradeId && args.defaultGrade) {
      placement.gradeId = String(args.defaultGrade).trim();
      placement.usedDefaultGrade = true;
    }
    if (!placement.gradeId || !gradeRoots[placement.gradeId]) {
      if (gradeRoots.general) {
        placement.gradeId = 'general';
        placement.usedDefaultGrade = true;
      } else {
        console.log(
          '- skip (no grade folder for',
          placement.gradeId || '?',
          '— set --default-grade=N):',
          name
        );
        stats.skipped += 1;
        continue;
      }
    }

    processed += 1;
    stats.planned += 1;
    if (placement.usedDefaultTopic) stats.defaultTopic += 1;
    const gradeFolderId = gradeRoots[placement.gradeId];
    const gradeLabel = gradeLabelForId(placement.gradeId);

    console.log(
      '\n→',
      name,
      '| grade:',
      gradeLabel,
      placement.usedDefaultGrade ? '(default)' : '',
      '| topic:',
      placement.topic,
      placement.usedDefaultTopic ? '(default)' : '',
      item.mimeType === SHORTCUT_MIME ? '| shortcut' : ''
    );

    try {
      let topicFolderId;
      if (args.createMissingTopics) {
        topicFolderId = await ensureTopicFolder(
          gradeFolderId,
          placement.topic,
          accessToken,
          dryRun,
          topicFolderCache
        );
      } else {
        // Without create: require an existing topic folder under the grade.
        const gradeChildren = await drive.listDriveChildren(gradeFolderId, accessToken);
        const hit = (gradeChildren || []).find(function (child) {
          return child
            && child.mimeType === FOLDER_MIME
            && (
              catalogTopics.resolveCatalogTopicFromFolderName(child.name) === placement.topic
              || String(child.name || '').trim() === placement.topic
            );
        });
        topicFolderId = hit ? hit.id : null;
        if (!topicFolderId) {
          console.log('  skip — topic folder missing and --no-create-topics');
          stats.skipped += 1;
          continue;
        }
      }

      const parents = Array.isArray(item.parents) ? item.parents : [rootFolderId];
      const fromParent = parents.indexOf(rootFolderId) >= 0 ? rootFolderId : parents[0];
      const moveResult = await moveFileToFolder(
        item.id,
        fromParent,
        topicFolderId,
        accessToken,
        dryRun,
        item.resourceKey || ''
      );
      if (moveResult.moved) stats.moved += 1;

      // Resolve shortcut target for conversion when the root item is a shortcut.
      let convertSource = item;
      if (item.mimeType === SHORTCUT_MIME && args.convertPdfs) {
        try {
          const target = await drive.resolveShortcutTarget(item, accessToken);
          if (target && target.id) {
            convertSource = Object.assign({}, target, {
              name: item.name || target.name,
              resourceKey: target.resourceKey || '',
            });
          }
        } catch (shortcutErr) {
          console.warn(
            '  shortcut resolve for convert failed:',
            shortcutErr && shortcutErr.message ? shortcutErr.message : shortcutErr
          );
        }
      }

      // Conversion is independent of topic match — any suitable PDF/DOC under the
      // destination folder (known topic or כללי) gets a Google Docs copy.
      if (args.convertPdfs && shouldConvertFile(convertSource, args.minPdfBytes)) {
        const converted = await convertFileToGoogleDocs(
          convertSource,
          topicFolderId,
          accessToken,
          dryRun,
          { maxBytes: MAX_CONVERT_DOWNLOAD_BYTES }
        );
        if (converted.converted) stats.converted += 1;
      } else if (args.convertPdfs && isConvertibleFile(convertSource)) {
        console.log(
          '  skip convert — PDF below min size (',
          convertSource.size || '?',
          '<',
          args.minPdfBytes,
          ')'
        );
      }
    } catch (err) {
      stats.errors += 1;
      console.error('  ERROR:', name, err && err.message ? err.message : err);
    }
  }

  console.log('\n[organize-and-convert] done');
  console.log(JSON.stringify({ rootOrganize: stats, community: communityStats }, null, 2));
  if (dryRun) {
    console.log('\nDry-run only. Re-run with --apply --from-community (or npm run organize-drive:apply) to write.');
    console.log(
      'For uploads into personal My Drive, configure user OAuth '
        + '(node scripts/google-drive-oauth-setup.js --write-env) — SA Editor alone is not enough.'
    );
  }
  const communityErrors = communityStats && communityStats.errors ? communityStats.errors : 0;
  const archiveErrors = communityStats && communityStats.archive && communityStats.archive.errors
    ? communityStats.archive.errors
    : 0;
  process.exit((stats.errors || communityErrors || archiveErrors) ? 1 : 0);
}

main().catch(function (err) {
  console.error('[organize-and-convert] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
