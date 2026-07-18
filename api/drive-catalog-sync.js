/**
 * Google Drive → community_materials catalog sync with recursive subfolder traversal.
 * Also powers live community search via Drive files.list (name + fullText).
 * Env: GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID, GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON (inline JSON)
 * Optional: DRIVE_CATALOG_SYNC_ON_BOOT=1, CRON_SECRET for /api/cron/drive-catalog-sync
 */
const crypto = require('crypto');
const catalogTopics = require('./catalog-topics');
const communityIngest = require('./community-ingest');
const pedagogicalScope = require('./pedagogical-scope');
const env = require('./env');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const MATERIALS_TABLE = 'community_materials';
const MAX_FOLDER_DEPTH = 12;
const LIST_PAGE_SIZE = 200;
const SEARCH_PAGE_SIZE = 50;
const FOLDER_INDEX_TTL_MS = 5 * 60 * 1000;
const MAX_DRIVE_SEARCH_RESULTS = 40;

/** In-memory Drive folder tree cache (grade/topic → folder ids). */
let driveFolderIndexCache = {
  key: '',
  expiresAt: 0,
  index: null,
};

const HEBREW_GRADE_TO_ID = {
  'א': '1', 'ב': '2', 'ג': '3', 'ד': '4', 'ה': '5', 'ו': '6', 'ז': '7', 'ח': '8',
};

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function parseServiceAccountJson() {
  const raw = String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[drive-catalog-sync] invalid GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON:', e.message || e);
    return null;
  }
}

function createServiceAccountJwt(sa) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: DRIVE_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const segments = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claim));
  const sign = crypto.createSign('RSA-SHA256').update(segments).sign(sa.private_key, 'base64');
  const signature = sign.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return segments + '.' + signature;
}

async function resolveDriveAccessToken(options) {
  const opts = options || {};
  if (opts.accessToken) return String(opts.accessToken).trim();

  const sa = parseServiceAccountJson();
  if (!sa || !sa.client_email || !sa.private_key) {
    const err = new Error('Drive catalog sync requires accessToken or GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON');
    err.statusCode = 503;
    throw err;
  }

  const jwt = createServiceAccountJwt(sa);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('Drive token exchange failed (' + res.status + '): ' + text.slice(0, 300));
    err.statusCode = res.status;
    throw err;
  }
  const data = JSON.parse(text);
  if (!data.access_token) {
    throw new Error('Drive token exchange returned no access_token');
  }
  return data.access_token;
}

function parseGradeIdFromFolderName(name) {
  const s = String(name || '').trim();
  if (!s) return '';

  const digit = s.match(/(?:^|\s)(\d)(?:\s|$)/) || s.match(/^(\d)$/);
  if (digit) return digit[1];

  const heb = s.match(/כיתה\s*([א-ח]['׳]?)/);
  if (heb) return HEBREW_GRADE_TO_ID[heb[1].charAt(0)] || '';

  if (/^כיתה\s*[א-ח]['׳]?$/i.test(s)) {
    return HEBREW_GRADE_TO_ID[s.replace(/כיתה\s*/i, '').charAt(0)] || '';
  }

  return '';
}

function buildDriveFileUrl(file) {
  const id = file && file.id;
  if (!id) return '';
  const mime = String(file.mimeType || '');
  if (mime === 'application/vnd.google-apps.document') {
    return 'https://docs.google.com/document/d/' + id + '/edit';
  }
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    return 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
  }
  if (mime === 'application/vnd.google-apps.presentation') {
    return 'https://docs.google.com/presentation/d/' + id + '/edit';
  }
  return 'https://drive.google.com/file/d/' + id + '/view';
}

function isSyncableDriveFile(file) {
  if (!file || !file.id) return false;
  if (file.mimeType === FOLDER_MIME) return false;
  if (file.trashed === true) return false;
  return true;
}

async function listDriveChildren(folderId, accessToken) {
  const items = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams();
    params.set('q', "'" + folderId + "' in parents and trashed=false");
    params.set('fields', 'nextPageToken,files(id,name,mimeType,webViewLink,trashed)');
    params.set('pageSize', String(LIST_PAGE_SIZE));
    params.set('supportsAllDrives', 'true');
    params.set('includeItemsFromAllDrives', 'true');
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(DRIVE_API + '/files?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error('Drive files.list failed (' + res.status + '): ' + text.slice(0, 300));
    }
    const data = JSON.parse(text);
    if (Array.isArray(data.files)) items.push.apply(items, data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items;
}

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServiceRoleKey() || env.getSupabaseServerKey(),
  };
}

async function fetchExistingDriveMaterialRows() {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return [];

  const params = new URLSearchParams();
  params.set('select', 'id,grade_level,topic,file_path,file_name,notes');
  params.set('limit', '500');
  params.set('order', 'created_at.desc');

  const res = await fetch(cfg.url + '/rest/v1/' + MATERIALS_TABLE + '?' + params.toString(), {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

function driveFileIdFromRow(row) {
  const notes = String(row && row.notes || '');
  const noteMatch = notes.match(/\[driveFileId:([^\]]+)\]/);
  if (noteMatch) return noteMatch[1].trim();
  const path = String(row && row.file_path || '');
  const pathMatch = path.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return pathMatch ? pathMatch[1] : '';
}

async function upsertDriveCatalogMaterial(payload) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    throw new Error('Supabase not configured for Drive catalog sync');
  }

  const p = payload || {};
  const driveFileId = String(p.driveFileId || '').trim();
  const existingById = p.existingIndex && driveFileId ? p.existingIndex.byDriveId[driveFileId] : null;

  const record = {
    grade_level: String(p.gradeId || ''),
    topic: String(p.catalogTopic || p.topic || '').trim(),
    file_path: p.fileUrl || null,
    file_name: p.fileName || null,
    notes: p.notes || null,
  };

  if (existingById && existingById.id) {
    const res = await fetch(
      cfg.url + '/rest/v1/' + MATERIALS_TABLE + '?id=eq.' + encodeURIComponent(existingById.id),
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.key,
          Authorization: 'Bearer ' + cfg.key,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(record),
      }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error('community_materials update failed (' + res.status + '): ' + text.slice(0, 300));
    }
    const data = text ? JSON.parse(text) : [];
    return { row: Array.isArray(data) ? data[0] : data, added: false, updated: true };
  }

  const res = await fetch(cfg.url + '/rest/v1/' + MATERIALS_TABLE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(record),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('community_materials insert failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const data = text ? JSON.parse(text) : [];
  return { row: Array.isArray(data) ? data[0] : data, added: true, updated: false };
}

async function walkDriveFolderTree(folderId, ctx, accessToken, stats) {
  if (!folderId || !ctx || ctx.depth > MAX_FOLDER_DEPTH) return;

  const folderLabel = ctx.path.length ? ctx.path.join(' / ') : '(root)';
  console.log(
    '[drive-catalog-sync] entering subfolder:',
    folderLabel,
    '| grade:', ctx.gradeId || '(none)',
    '| catalogTopic:', ctx.catalogTopic || '(none)',
    '| depth:', ctx.depth
  );

  let children = [];
  try {
    children = await listDriveChildren(folderId, accessToken);
  } catch (listErr) {
    stats.errors.push({ folder: folderLabel, error: listErr.message || String(listErr) });
    console.warn('[drive-catalog-sync] list failed for', folderLabel, listErr.message || listErr);
    return;
  }

  for (let i = 0; i < children.length; i++) {
    const item = children[i];
    if (!item || !item.id) continue;

    if (item.mimeType === FOLDER_MIME) {
      const childName = String(item.name || '').trim();
      const nextPath = ctx.path.concat(childName);
      const nextCtx = {
        depth: ctx.depth + 1,
        path: nextPath,
        gradeId: ctx.gradeId,
        catalogTopic: ctx.catalogTopic,
      };

      if (!ctx.gradeId) {
        const gradeId = parseGradeIdFromFolderName(childName);
        if (gradeId) {
          nextCtx.gradeId = gradeId;
          console.log('[drive-catalog-sync] matched grade folder:', childName, '→ grade', gradeId);
        }
      } else if (!ctx.catalogTopic) {
        const topic = catalogTopics.resolveCatalogTopicFromFolderName(childName);
        nextCtx.catalogTopic = topic;
        console.log('[drive-catalog-sync] inherited catalog topic from folder:', childName, '→', topic);
      }

      await walkDriveFolderTree(item.id, nextCtx, accessToken, stats);
      continue;
    }

    if (!isSyncableDriveFile(item)) continue;
    if (!ctx.gradeId) {
      stats.skipped += 1;
      continue;
    }

    const inheritedTopic = ctx.catalogTopic
      || catalogTopics.resolveCatalogTopicFromFolderName(ctx.path[ctx.path.length - 1] || '');
    const catalogTopic = inheritedTopic || 'כללי';
    const fileUrl = buildDriveFileUrl(item);
    const drivePath = ctx.path.concat(item.name || '').join(' / ');
    const notes = catalogTopics.packDriveCatalogNotes({
      subfolder: ctx.catalogTopic || '',
      catalogTopic: catalogTopic,
      driveFileId: item.id,
      drivePath: drivePath,
      title: item.name || catalogTopic,
      searchTags: catalogTopics.getSearchTagsForCanonicalTopic(catalogTopic),
    });

    try {
      const result = await upsertDriveCatalogMaterial({
        gradeId: ctx.gradeId,
        catalogTopic: catalogTopic,
        topic: catalogTopic,
        fileUrl: fileUrl,
        fileName: item.name || 'קובץ Drive',
        notes: notes,
        driveFileId: item.id,
        existingIndex: stats.existingIndex,
      });

      stats.filesScanned += 1;
      if (result.added) stats.added += 1;
      else if (result.updated) stats.updated += 1;

      if (result.row && result.row.id) {
        stats.existingIndex.byDriveId[item.id] = result.row;
      }

      if (communityIngest.isIngestEnabled() && result.row && result.row.id && result.added) {
        try {
          await communityIngest.ingestCommunityUpload({
            gradeId: ctx.gradeId,
            topic: catalogTopic,
            materialId: result.row.id,
            indexBundle: false,
            origin: 'drive_catalog_sync',
          });
        } catch (ingestErr) {
          console.warn('[drive-catalog-sync] ingest skipped for', item.name, ingestErr.message || ingestErr);
        }
      }
    } catch (upsertErr) {
      stats.errors.push({ file: item.name, error: upsertErr.message || String(upsertErr) });
      console.warn('[drive-catalog-sync] upsert failed:', item.name, upsertErr.message || upsertErr);
    }
  }
}

function buildExistingIndex(rows) {
  const byDriveId = {};
  (rows || []).forEach(function (row) {
    const id = driveFileIdFromRow(row);
    if (id) byDriveId[id] = row;
  });
  return { byDriveId: byDriveId };
}

/**
 * Recursively scan a Google Drive catalog tree and upsert into community_materials.
 */
async function syncCommunityDriveCatalog(options) {
  const opts = options || {};
  const rootFolderId = String(
    opts.rootFolderId || process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID || ''
  ).trim();

  if (!rootFolderId) {
    const err = new Error('GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID is not configured');
    err.statusCode = 503;
    throw err;
  }

  const accessToken = await resolveDriveAccessToken(opts);
  const existingRows = await fetchExistingDriveMaterialRows();
  const stats = {
    filesScanned: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    existingIndex: buildExistingIndex(existingRows),
    rootFolderId: rootFolderId,
  };

  console.log('[drive-catalog-sync] starting recursive scan from root folder', rootFolderId);

  await walkDriveFolderTree(
    rootFolderId,
    { depth: 0, path: [], gradeId: opts.gradeId || '', catalogTopic: opts.catalogTopic || '' },
    accessToken,
    stats
  );

  console.log(
    '[drive-catalog-sync] complete — files:', stats.filesScanned,
    'added:', stats.added,
    'updated:', stats.updated,
    'skipped:', stats.skipped,
    'errors:', stats.errors.length
  );

  return {
    ok: true,
    filesScanned: stats.filesScanned,
    added: stats.added,
    updated: stats.updated,
    skipped: stats.skipped,
    errors: stats.errors.length ? stats.errors : undefined,
    rootFolderId: rootFolderId,
  };
}

function backgroundFetchDriveCatalogAsync(options) {
  syncCommunityDriveCatalog(options).catch(function (err) {
    console.warn('[drive-catalog-sync] background fetch failed:', err.message || err);
  });
}

function isDriveCatalogSyncConfigured() {
  const root = String(process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID || '').trim();
  const hasSa = Boolean(parseServiceAccountJson());
  return Boolean(root && hasSa);
}

function stableNormalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Escape a literal for Drive API `q` single-quoted strings. */
function escapeDriveQueryLiteral(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/**
 * Build Drive files.list `q` for name + fullText keyword search.
 * Example: (fullText contains 'רומא' or name contains 'רומא') and trashed=false
 */
function buildDriveKeywordSearchQuery(keyword, options) {
  const opts = options || {};
  const term = String(keyword || '').trim();
  if (!term || term.length < 2) return '';

  const lit = escapeDriveQueryLiteral(term);
  const parts = [
    "(fullText contains '" + lit + "' or name contains '" + lit + "')",
    'trashed=false',
    "mimeType != '" + FOLDER_MIME + "'",
  ];

  const parentIds = Array.isArray(opts.parentFolderIds)
    ? opts.parentFolderIds.filter(Boolean).slice(0, 20)
    : [];
  if (parentIds.length === 1) {
    parts.push("'" + escapeDriveQueryLiteral(parentIds[0]) + "' in parents");
  } else if (parentIds.length > 1) {
    parts.push(
      '(' + parentIds.map(function (id) {
        return "'" + escapeDriveQueryLiteral(id) + "' in parents";
      }).join(' or ') + ')'
    );
  }

  return parts.join(' and ');
}

async function listDriveSearchResults(accessToken, driveQuery, options) {
  const opts = options || {};
  const limit = opts.limit || MAX_DRIVE_SEARCH_RESULTS;
  const items = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams();
    params.set('q', driveQuery);
    params.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,webViewLink,parents,trashed)'
    );
    params.set('pageSize', String(Math.min(SEARCH_PAGE_SIZE, limit - items.length)));
    params.set('supportsAllDrives', 'true');
    params.set('includeItemsFromAllDrives', 'true');
    params.set('corpora', 'allDrives');
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(DRIVE_API + '/files?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error('Drive files.list search failed (' + res.status + '): ' + text.slice(0, 300));
    }
    const data = JSON.parse(text);
    if (Array.isArray(data.files)) items.push.apply(items, data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken && items.length < limit);

  return items.slice(0, limit);
}

/**
 * Walk the shared catalog tree and index every folder with inherited grade/topic.
 */
async function buildDriveFolderIndex(rootFolderId, accessToken) {
  const byFolderId = {};
  const gradeRootFolders = {};
  const topicFolders = {};

  async function walk(folderId, ctx) {
    if (!folderId || ctx.depth > MAX_FOLDER_DEPTH) return;

    byFolderId[folderId] = {
      gradeId: ctx.gradeId || '',
      catalogTopic: ctx.catalogTopic || '',
      path: ctx.path.slice(),
      parentId: ctx.parentId || '',
    };

    let children = [];
    try {
      children = await listDriveChildren(folderId, accessToken);
    } catch (listErr) {
      console.warn(
        '[drive-search] folder index list failed for',
        ctx.path.join(' / ') || '(root)',
        listErr.message || listErr
      );
      return;
    }

    for (let i = 0; i < children.length; i++) {
      const item = children[i];
      if (!item || !item.id || item.mimeType !== FOLDER_MIME) continue;

      const childName = String(item.name || '').trim();
      const nextPath = ctx.path.concat(childName);
      const nextCtx = {
        depth: ctx.depth + 1,
        path: nextPath,
        gradeId: ctx.gradeId,
        catalogTopic: ctx.catalogTopic,
        parentId: folderId,
      };

      if (!ctx.gradeId) {
        const gradeId = parseGradeIdFromFolderName(childName);
        if (gradeId) {
          nextCtx.gradeId = gradeId;
          gradeRootFolders[gradeId] = item.id;
        }
      } else if (!ctx.catalogTopic) {
        const topic = catalogTopics.resolveCatalogTopicFromFolderName(childName);
        nextCtx.catalogTopic = topic;
        if (!topicFolders[ctx.gradeId]) topicFolders[ctx.gradeId] = {};
        topicFolders[ctx.gradeId][stableNormalize(topic)] = item.id;
        // Also index the raw folder name for strict topic matching.
        topicFolders[ctx.gradeId][stableNormalize(childName)] = item.id;
      }

      await walk(item.id, nextCtx);
    }
  }

  await walk(rootFolderId, {
    depth: 0,
    path: [],
    gradeId: '',
    catalogTopic: '',
    parentId: '',
  });

  return {
    rootFolderId: rootFolderId,
    byFolderId: byFolderId,
    gradeRootFolders: gradeRootFolders,
    topicFolders: topicFolders,
  };
}

async function getDriveFolderIndex(options) {
  const opts = options || {};
  const rootFolderId = String(
    opts.rootFolderId || process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID || ''
  ).trim();
  if (!rootFolderId) {
    const err = new Error('GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID is not configured');
    err.statusCode = 503;
    throw err;
  }

  const cacheKey = rootFolderId;
  const now = Date.now();
  if (
    driveFolderIndexCache.index &&
    driveFolderIndexCache.key === cacheKey &&
    driveFolderIndexCache.expiresAt > now &&
    !opts.forceRefresh
  ) {
    return driveFolderIndexCache.index;
  }

  const accessToken = await resolveDriveAccessToken(opts);
  const index = await buildDriveFolderIndex(rootFolderId, accessToken);
  driveFolderIndexCache = {
    key: cacheKey,
    expiresAt: now + FOLDER_INDEX_TTL_MS,
    index: index,
  };
  return index;
}

function topicsStrictlyCompatible(expectedTopic, candidateTopic) {
  const expected = stableNormalize(expectedTopic);
  const candidate = stableNormalize(candidateTopic);
  if (!expected) return true;
  if (!candidate) return false;
  if (expected === candidate) return true;

  const expectedCanon = stableNormalize(
    catalogTopics.resolveCatalogTopicFromFolderName(expectedTopic) || expectedTopic
  );
  const candidateCanon = stableNormalize(
    catalogTopics.resolveCatalogTopicFromFolderName(candidateTopic) || candidateTopic
  );
  if (expectedCanon && candidateCanon && expectedCanon === candidateCanon) return true;

  const expectedAliases = new Set(
    catalogTopics.expandCatalogTopicAliases([expectedTopic, expectedCanon]).map(stableNormalize)
  );
  return expectedAliases.has(candidate) || expectedAliases.has(candidateCanon);
}

/**
 * Resolve the set of Drive folder IDs allowed under a strict grade/topic scope.
 */
function resolveStrictDriveScopeFolderIds(index, gradeId, topic) {
  const allowed = new Set();
  if (!index || !index.byFolderId) return allowed;

  const gid = String(gradeId || '').trim();
  const topicNorm = stableNormalize(
    topic ? (catalogTopics.resolveCatalogTopicFromFolderName(topic) || topic) : ''
  );

  Object.keys(index.byFolderId).forEach(function (folderId) {
    const meta = index.byFolderId[folderId];
    if (!meta) return;
    if (gid && String(meta.gradeId || '') !== gid) return;
    if (!gid && !meta.gradeId) return;
    if (topicNorm && !topicsStrictlyCompatible(topicNorm, meta.catalogTopic || '')) return;
    allowed.add(folderId);
  });

  return allowed;
}

function resolveFileScopeFromParents(file, index) {
  const parents = Array.isArray(file && file.parents) ? file.parents : [];
  for (let i = 0; i < parents.length; i++) {
    const meta = index.byFolderId[parents[i]];
    if (meta && meta.gradeId) {
      return {
        parentId: parents[i],
        gradeId: meta.gradeId,
        catalogTopic: meta.catalogTopic || 'כללי',
        path: meta.path.slice(),
      };
    }
  }
  return null;
}

function formatDriveSearchHit(file, scope, query) {
  const fileName = String((file && file.name) || '').trim() || 'קובץ Drive';
  const qNorm = stableNormalize(query);
  const nameNorm = stableNormalize(fileName);
  const nameHit = Boolean(qNorm && nameNorm && nameNorm.indexOf(qNorm) >= 0);
  const catalogTopic = scope.catalogTopic || 'כללי';
  const pathLabels = scope.path.concat(fileName).join(' / ');
  const gradeId = String(scope.gradeId || '');
  const gradeLabel = pedagogicalScope.GRADE_LABEL_BY_ID[gradeId] || '';

  return {
    id: 'drive:' + file.id,
    source: 'drive',
    driveFileId: file.id,
    title: fileName,
    displayTitle: fileName,
    topic: catalogTopic,
    subject: catalogTopic,
    catalogTopic: catalogTopic,
    bundleTopic: catalogTopic,
    gradeId: gradeId,
    grade_level: gradeId,
    gradeLabel: gradeLabel,
    fileName: fileName,
    filePath: pathLabels,
    pathLabels: pathLabels,
    drivePath: pathLabels,
    fileUrl: buildDriveFileUrl(file),
    similarity: nameHit ? 0.95 : 0.88,
    matchType: nameHit ? 'drive_name' : 'drive_fulltext',
    matchedInBundle: Boolean(catalogTopic && stableNormalize(catalogTopic) !== nameNorm),
    alertText: catalogTopic
      ? ('נמצא חומר בתיקיית «' + catalogTopic + '» ב-Google Drive')
      : '',
  };
}

function pickBestMatchingAlias(query, aliases) {
  const qNorm = stableNormalize(query);
  if (!qNorm || !Array.isArray(aliases) || !aliases.length) return '';
  let best = '';
  let bestLen = 0;
  aliases.forEach(function (alias) {
    const aNorm = stableNormalize(alias);
    if (!aNorm || aNorm.length < 2) return;
    if (aNorm === qNorm || qNorm.indexOf(aNorm) >= 0 || aNorm.indexOf(qNorm) >= 0) {
      if (aNorm.length > bestLen) {
        best = String(alias).trim();
        bestLen = aNorm.length;
      }
    }
  });
  return best;
}

function resolveDriveSearchScope(query, options) {
  const opts = options || {};
  const q = String(query || '').trim();
  const qNorm = stableNormalize(q);
  const uiGrade = String(opts.gradeId || opts.currentGrade || '').trim();
  const uiTopic = String(opts.topic || opts.catalogTopic || '').trim();

  const block = pedagogicalScope.inferTopicCurriculumBlock(q);
  // Curriculum ownership wins over the currently open UI grade.
  const strictGradeId = (block && block.gradeId) || uiGrade || '';

  let strictTopic = uiTopic;
  if (!strictTopic) {
    const fromFolder = catalogTopics.resolveCatalogTopicFromFolderName(q);
    if (fromFolder) {
      strictTopic = fromFolder;
    } else if (block) {
      // Lock to the alias that actually matched the query (גיאולוגיה ≠ רומא).
      strictTopic = pickBestMatchingAlias(q, block.aliases);
    }
    if (!strictTopic) {
      if (qNorm === 'רומא' || qNorm.indexOf('רומא') === 0) strictTopic = 'רומא';
      else if (qNorm === 'יוון' || qNorm.indexOf('יוון') === 0) strictTopic = 'יוון';
    }
  }

  return {
    gradeId: strictGradeId,
    topic: strictTopic,
    curriculumBlock: block || null,
  };
}

/**
 * Live community search against the shared Google Drive catalog.
 * Uses Drive files.list `q` (name + fullText) and a strict grade/topic folder filter.
 */
async function searchDriveCommunityCatalog(query, options) {
  const opts = options || {};
  const q = String(query || opts.userMessage || '').trim();
  if (!q || q.length < 2) {
    return { matches: [], count: 0, query: q, matchMethod: 'none', driveScoped: true };
  }
  if (!isDriveCatalogSyncConfigured() && !opts.accessToken) {
    return { matches: [], count: 0, query: q, matchMethod: 'none', driveScoped: false };
  }

  const accessToken = await resolveDriveAccessToken(opts);
  const index = await getDriveFolderIndex(Object.assign({}, opts, { accessToken: accessToken }));
  const scope = resolveDriveSearchScope(q, opts);

  if (!scope.gradeId && !scope.topic) {
    // Refuse unconstrained Drive fullText sweeps — too noisy pedagogically.
    return {
      matches: [],
      count: 0,
      query: q,
      matchMethod: 'none',
      driveScoped: true,
      scope: scope,
    };
  }

  const allowedFolderIds = resolveStrictDriveScopeFolderIds(
    index,
    scope.gradeId,
    scope.topic
  );

  // If a topic lock produced zero folders, fall back to grade-only (still strict on grade).
  let effectiveAllowed = allowedFolderIds;
  let topicRelaxed = false;
  if (!effectiveAllowed.size && scope.gradeId && scope.topic) {
    effectiveAllowed = resolveStrictDriveScopeFolderIds(index, scope.gradeId, '');
    topicRelaxed = true;
  }

  if (!effectiveAllowed.size) {
    return {
      matches: [],
      count: 0,
      query: q,
      matchMethod: 'none',
      driveScoped: true,
      scope: scope,
    };
  }

  const searchTerms = [q];
  const aliases = catalogTopics.expandCatalogTopicAliases([q]).filter(function (term) {
    const t = String(term || '').trim();
    return t.length >= 2 && t.length <= 48;
  });
  aliases.forEach(function (alias) {
    if (searchTerms.indexOf(alias) < 0) searchTerms.push(alias);
  });

  const seenFileIds = new Set();
  const rawFiles = [];

  for (let i = 0; i < Math.min(searchTerms.length, 4); i++) {
    const term = searchTerms[i];
    const driveQuery = buildDriveKeywordSearchQuery(term, {});
    if (!driveQuery) continue;
    try {
      const batch = await listDriveSearchResults(accessToken, driveQuery, {
        limit: MAX_DRIVE_SEARCH_RESULTS,
      });
      (batch || []).forEach(function (file) {
        if (!file || !file.id || seenFileIds.has(file.id)) return;
        if (!isSyncableDriveFile(file)) return;
        seenFileIds.add(file.id);
        rawFiles.push(file);
      });
    } catch (searchErr) {
      console.warn('[drive-search] query failed for', term, searchErr.message || searchErr);
    }
  }

  const matches = [];
  rawFiles.forEach(function (file) {
    const parents = Array.isArray(file.parents) ? file.parents : [];
    const inScope = parents.some(function (parentId) {
      return effectiveAllowed.has(parentId);
    });
    if (!inScope) return;

    const fileScope = resolveFileScopeFromParents(file, index);
    if (!fileScope || !fileScope.gradeId) return;
    if (scope.gradeId && fileScope.gradeId !== scope.gradeId) return;

    if (scope.topic) {
      const topicOk = topicsStrictlyCompatible(scope.topic, fileScope.catalogTopic || '');
      if (!topicOk) {
        // Topic folder missing (relaxed grade-wide search): allow only when the
        // keyword is central in the file name — never sibling-folder fullText hits.
        if (!topicRelaxed) return;
        const nameNorm = stableNormalize(file.name || '');
        const topicNorm = stableNormalize(scope.topic);
        const qNorm = stableNormalize(q);
        const nameCentral = (topicNorm && nameNorm.indexOf(topicNorm) >= 0)
          || (qNorm && nameNorm.indexOf(qNorm) >= 0);
        if (!nameCentral) return;
      }
    }

    matches.push(formatDriveSearchHit(file, fileScope, q));
  });

  matches.sort(function (a, b) {
    return (b.similarity || 0) - (a.similarity || 0);
  });

  const limit = opts.limit || 8;
  const sliced = matches.slice(0, limit);
  return {
    matches: sliced,
    count: sliced.length,
    query: q,
    matchMethod: sliced.length ? 'drive_fulltext' : 'none',
    driveScoped: true,
    scope: {
      gradeId: scope.gradeId,
      topic: scope.topic,
      topicRelaxed: topicRelaxed,
    },
  };
}

module.exports = {
  syncCommunityDriveCatalog,
  backgroundFetchDriveCatalogAsync,
  isDriveCatalogSyncConfigured,
  listDriveChildren,
  walkDriveFolderTree,
  parseGradeIdFromFolderName,
  resolveDriveAccessToken,
  escapeDriveQueryLiteral,
  buildDriveKeywordSearchQuery,
  buildDriveFolderIndex,
  getDriveFolderIndex,
  resolveStrictDriveScopeFolderIds,
  resolveDriveSearchScope,
  topicsStrictlyCompatible,
  searchDriveCommunityCatalog,
  formatDriveSearchHit,
};
