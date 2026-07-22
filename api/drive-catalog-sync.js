/**
 * Google Drive → community_materials catalog sync with recursive subfolder traversal.
 * Also powers live community search via Drive files.list (name + fullText).
 * Env: GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID, GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON (inline JSON)
 * Optional: service-account.json in project root; DRIVE_CATALOG_SYNC_ON_BOOT=1;
 * CRON_SECRET for /api/cron/drive-catalog-sync
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const catalogTopics = require('./catalog-topics');
const communityIngest = require('./community-ingest');
const pedagogicalScope = require('./pedagogical-scope');
const env = require('./env');
const driveQueryExpand = require('./drive-query-expand');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** Writable scope for organize / convert automation (requires Editor on the catalog). */
const DRIVE_WRITE_SCOPE = 'https://www.googleapis.com/auth/drive';
/** Canonical community catalog root (override with GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID). */
const DEFAULT_CATALOG_ROOT_FOLDER_ID = '1N50V9Njt3E6IQDX0OfktLM7qkhzyJ0Cs';
/**
 * Service Accounts have no My Drive storage quota. Uploads / Docs conversion into a
 * personal folder shared as Editor still fail with storageQuotaExceeded unless:
 *   1) OAuth of the folder owner (GOOGLE_DRIVE_OAUTH_*), or
 *   2) Domain-wide delegation (GOOGLE_DRIVE_DELEGATE_EMAIL + Workspace), or
 *   3) Catalog root lives in a Shared Drive and SA is Content Manager.
 */
const MATERIALS_TABLE = 'community_materials';
const MAX_FOLDER_DEPTH = 12;
const LIST_PAGE_SIZE = 200;
const SEARCH_PAGE_SIZE = 50;
const FOLDER_INDEX_TTL_MS = 5 * 60 * 1000;
const MAX_DRIVE_SEARCH_RESULTS = 40;
const MAX_EXTRACT_BYTES = 8 * 1024 * 1024;
/** Larger ceiling for multimodal Gemini PDF/image fallback (Gemini PDF cap ≈ 50MB). */
const MAX_MULTIMODAL_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_TOPIC_FOLDER_FILES = 40;
/** Fields needed to resolve shortcuts (incl. resource keys that avoid false 404s). */
const DRIVE_FILE_META_FIELDS =
  'id,name,mimeType,webViewLink,parents,trashed,modifiedTime,resourceKey,'
  + 'shortcutDetails(targetId,targetMimeType,targetResourceKey)';
const DRIVE_LIST_FILE_FIELDS =
  'id,name,mimeType,webViewLink,trashed,modifiedTime,parents,resourceKey,'
  + 'shortcutDetails(targetId,targetMimeType,targetResourceKey)';

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

function getCatalogRootFolderId(options) {
  const opts = options || {};
  const fromOpts = String(opts.rootFolderId || '').trim();
  if (fromOpts) return fromOpts;
  const fromEnv = String(
    process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID
    || process.env.DRIVE_ROOT_FOLDER_ID
    || ''
  ).trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_CATALOG_ROOT_FOLDER_ID;
}

function tryParseServiceAccountObject(raw, sourceLabel) {
  const label = sourceLabel || 'service account';
  if (!raw) return null;
  let text = String(raw).trim();
  if (
    (text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') ||
    (text.charAt(0) === "'" && text.charAt(text.length - 1) === "'")
  ) {
    text = text.slice(1, -1).trim();
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.client_email || !parsed.private_key) {
      console.warn(
        '[drive-catalog-sync]',
        label,
        'is set but missing client_email/private_key — Drive disabled'
      );
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn('[drive-catalog-sync] invalid', label, '(Drive disabled):', e.message || e);
    return null;
  }
}

function loadServiceAccountFromFile() {
  const candidates = [
    String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE || '').trim(),
    path.join(process.cwd(), 'service-account.json'),
    path.join(__dirname, '..', 'service-account.json'),
  ].filter(Boolean);

  for (let i = 0; i < candidates.length; i++) {
    const filePath = candidates[i];
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = tryParseServiceAccountObject(raw, 'service-account file ' + filePath);
      if (parsed) return parsed;
    } catch (readErr) {
      console.warn(
        '[drive-catalog-sync] could not read',
        filePath,
        readErr.message || readErr
      );
    }
  }
  return null;
}

function parseServiceAccountJson() {
  const fromEnv = tryParseServiceAccountObject(
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || '',
    'GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON'
  );
  if (fromEnv) return fromEnv;
  return loadServiceAccountFromFile();
}

function cleanEnvValue(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

/**
 * User OAuth (installed / desktop or web client) — files are owned by the human
 * user and consume their Drive quota (fixes SA storageQuotaExceeded on My Drive).
 */
function getDriveOauthUserCredentials() {
  const clientId = cleanEnvValue(
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID
  );
  const clientSecret = cleanEnvValue(
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  const refreshToken = cleanEnvValue(
    process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN || process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId: clientId, clientSecret: clientSecret, refreshToken: refreshToken };
}

/** Workspace domain-wide delegation: SA JWT `sub` = human user email. */
function getDriveDelegateEmail() {
  return cleanEnvValue(
    process.env.GOOGLE_DRIVE_DELEGATE_EMAIL
    || process.env.GOOGLE_DRIVE_IMPERSONATE_EMAIL
    || process.env.GOOGLE_DRIVE_SUBJECT
  );
}

function hasDriveUserWriteAuth() {
  return Boolean(getDriveOauthUserCredentials() || getDriveDelegateEmail());
}

function createServiceAccountJwt(sa, scope, subject) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: String(scope || DRIVE_SCOPE).trim() || DRIVE_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const sub = cleanEnvValue(subject);
  if (sub) claim.sub = sub;
  const segments = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claim));
  const sign = crypto.createSign('RSA-SHA256').update(segments).sign(sa.private_key, 'base64');
  const signature = sign.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return segments + '.' + signature;
}

async function exchangeOauthRefreshToken(creds) {
  const body = new URLSearchParams();
  body.set('client_id', creds.clientId);
  body.set('client_secret', creds.clientSecret);
  body.set('refresh_token', creds.refreshToken);
  body.set('grant_type', 'refresh_token');
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(
      'Drive OAuth refresh failed (' + res.status + '): ' + text.slice(0, 300)
      + ' — re-run: node scripts/google-drive-oauth-setup.js'
    );
    err.statusCode = res.status;
    throw err;
  }
  const data = JSON.parse(text);
  if (!data.access_token) {
    throw new Error('Drive OAuth refresh returned no access_token');
  }
  return data.access_token;
}

async function exchangeServiceAccountJwt(sa, scope, subject) {
  const jwt = createServiceAccountJwt(sa, scope, subject);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='
      + encodeURIComponent(jwt),
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

/**
 * Resolve a Drive access token.
 * For writes into personal My Drive, prefers user OAuth (or SA + domain-wide
 * delegation) so file bytes count against a human / Shared Drive quota.
 */
async function resolveDriveAccessToken(options) {
  const opts = options || {};
  if (opts.accessToken) return String(opts.accessToken).trim();

  const wantWrite = opts.write === true || opts.writable === true;
  const scope = wantWrite
    ? DRIVE_WRITE_SCOPE
    : (opts.scope || DRIVE_SCOPE);

  // 1) User OAuth — preferred for writes (uses the owner's storage quota).
  const oauth = getDriveOauthUserCredentials();
  if (oauth && (wantWrite || opts.preferOauth === true || opts.forceOauth === true)) {
    return exchangeOauthRefreshToken(oauth);
  }
  // Read path may also use OAuth when no SA is configured.
  if (oauth && !parseServiceAccountJson()) {
    return exchangeOauthRefreshToken(oauth);
  }

  const sa = parseServiceAccountJson();
  if (!sa || !sa.client_email || !sa.private_key) {
    if (oauth) return exchangeOauthRefreshToken(oauth);
    const err = new Error(
      'Drive requires GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON and/or GOOGLE_DRIVE_OAUTH_* '
      + '(see docs/google-drive-setup.md)'
    );
    err.statusCode = 503;
    throw err;
  }

  // 2) SA with domain-wide delegation (Workspace) — acts as the delegate user.
  const delegate = getDriveDelegateEmail();
  if (wantWrite && delegate) {
    return exchangeServiceAccountJwt(sa, scope, delegate);
  }

  // 3) Plain SA — works for reads + Shared Drive writes; My Drive uploads fail.
  return exchangeServiceAccountJwt(sa, scope, '');
}

/** Describe which auth path resolveDriveAccessToken will use (for logs). */
function describeDriveAuthMode(options) {
  const opts = options || {};
  const wantWrite = opts.write === true || opts.writable === true;
  if (opts.accessToken) return 'explicit-access-token';
  const oauth = getDriveOauthUserCredentials();
  if (oauth && (wantWrite || opts.preferOauth === true || opts.forceOauth === true)) {
    return 'oauth-user-refresh';
  }
  if (oauth && !parseServiceAccountJson()) return 'oauth-user-refresh';
  const sa = parseServiceAccountJson();
  if (!sa) return oauth ? 'oauth-user-refresh' : 'none';
  const delegate = getDriveDelegateEmail();
  if (wantWrite && delegate) return 'service-account-delegate:' + delegate;
  return wantWrite ? 'service-account-write' : 'service-account-readonly';
}

function parseGradeIdFromFolderName(name) {
  const s = String(name || '').trim();
  if (!s) return '';

  const digit = s.match(/(?:^|\s)(\d)(?:\s|$)/) || s.match(/^(\d)$/);
  if (digit) return digit[1];

  // «כיתה ז׳», «כיתה-ז», «כיתה ז תשפו», «בכיתה ז'»
  const heb = s.match(/(?:^|[\s\-_/])(?:ו|ב|ל|ש)?כיתה[\s\-_/]*([א-ח])['׳"]?/u)
    || s.match(/^([א-ח])['׳"]?\s*$/u);
  if (heb) return HEBREW_GRADE_TO_ID[heb[1].charAt(0)] || '';

  if (/^כיתה[\s\-_/]*[א-ח]['׳"]?$/iu.test(s)) {
    return HEBREW_GRADE_TO_ID[s.replace(/^כיתה[\s\-_/]*/iu, '').charAt(0)] || '';
  }

  return '';
}

function buildDriveFileUrl(file) {
  const direct = file && String(file.webViewLink || '').trim();
  if (direct) return direct;
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
  if (mime === FOLDER_MIME) {
    return 'https://drive.google.com/drive/folders/' + id;
  }
  return 'https://drive.google.com/file/d/' + id + '/view';
}

/** Human folder path for citations, e.g. "כיתה ה׳ > יוון". */
function formatDriveLocationPath(pathParts) {
  return (Array.isArray(pathParts) ? pathParts : [])
    .map(function (part) { return String(part || '').trim(); })
    .filter(Boolean)
    .join(' > ');
}

function isShortcutMime(mimeType) {
  return String(mimeType || '') === SHORTCUT_MIME;
}

function isSyncableDriveFile(file) {
  if (!file || !file.id) return false;
  if (file.mimeType === FOLDER_MIME) return false;
  if (file.trashed === true) return false;
  // Shortcuts are resolved separately; do not index the shortcut shell itself.
  if (isShortcutMime(file.mimeType)) return false;
  return true;
}

function isDriveNotFoundError(err) {
  const msg = String((err && err.message) || err || '');
  return (
    /\(404\)/.test(msg)
    || /Drive files\.get failed \(404\)/.test(msg)
    || /Drive media download failed \(404\)/.test(msg)
    || /Drive export failed \(404\)/.test(msg)
    || /"reason"\s*:\s*"notFound"/i.test(msg)
    || /File not found/i.test(msg)
  );
}

/**
 * Build Drive API headers. Resource keys prevent false 404s on link-shared targets.
 * Header format: X-Goog-Drive-Resource-Keys: fileId/resourceKey[,fileId2/key2]
 */
function buildDriveRequestHeaders(accessToken, resourceKeyByFileId) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  const pairs = [];
  if (resourceKeyByFileId && typeof resourceKeyByFileId === 'object') {
    Object.keys(resourceKeyByFileId).forEach(function (id) {
      const key = String(resourceKeyByFileId[id] || '').trim();
      const fileId = String(id || '').trim();
      if (fileId && key) pairs.push(fileId + '/' + key);
    });
  }
  if (pairs.length) {
    headers['X-Goog-Drive-Resource-Keys'] = pairs.join(',');
  }
  return headers;
}

function pickResourceKey(fileOrKey) {
  if (!fileOrKey) return '';
  if (typeof fileOrKey === 'string') return String(fileOrKey).trim();
  return String(
    fileOrKey.resourceKey
    || (fileOrKey.shortcutDetails && fileOrKey.shortcutDetails.targetResourceKey)
    || ''
  ).trim();
}

async function fetchDriveFileMeta(fileId, accessToken, fields, options) {
  const opts = options || {};
  const params = new URLSearchParams();
  params.set('fields', fields || DRIVE_FILE_META_FIELDS);
  params.set('supportsAllDrives', 'true');
  const resourceKeys = {};
  const rk = String(opts.resourceKey || '').trim();
  if (rk) resourceKeys[fileId] = rk;
  const res = await fetch(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?' + params.toString(), {
    headers: buildDriveRequestHeaders(accessToken, resourceKeys),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('Drive files.get failed (' + res.status + '): ' + text.slice(0, 300));
    err.statusCode = res.status;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * Resolve a Drive shortcut to its target file/folder metadata.
 * Uses shortcutDetails.targetId + targetResourceKey (avoids false 404s on link-shared files).
 * When meta get still 404s but targetMimeType is known, returns a soft-resolved stub for extract.
 */
async function resolveShortcutTarget(shortcutFile, accessToken) {
  if (!shortcutFile || !isShortcutMime(shortcutFile.mimeType)) return null;
  const details = shortcutFile.shortcutDetails || {};
  const targetId = String(details.targetId || '').trim();
  if (!targetId) {
    // List responses sometimes omit nested shortcutDetails — re-fetch the shortcut shell.
    try {
      const fresh = await fetchDriveFileMeta(
        shortcutFile.id,
        accessToken,
        DRIVE_FILE_META_FIELDS,
        { resourceKey: pickResourceKey(shortcutFile) }
      );
      if (fresh && isShortcutMime(fresh.mimeType) && fresh.shortcutDetails && fresh.shortcutDetails.targetId) {
        return resolveShortcutTarget(
          Object.assign({}, shortcutFile, fresh, {
            parents: Array.isArray(shortcutFile.parents) && shortcutFile.parents.length
              ? shortcutFile.parents
              : fresh.parents,
          }),
          accessToken
        );
      }
    } catch (freshErr) {
      console.warn(
        '[drive-catalog-sync] shortcut shell re-fetch failed:',
        shortcutFile.name || shortcutFile.id,
        freshErr && freshErr.message ? freshErr.message : freshErr
      );
    }
    return null;
  }

  const targetResourceKey = String(details.targetResourceKey || '').trim();
  const targetMimeType = String(details.targetMimeType || '').trim();

  try {
    const target = await fetchDriveFileMeta(targetId, accessToken, DRIVE_FILE_META_FIELDS, {
      resourceKey: targetResourceKey,
    });
    if (!target || target.trashed === true) return null;
    // Nested shortcuts: keep resolving until a real file/folder.
    if (isShortcutMime(target.mimeType)) {
      const nested = await resolveShortcutTarget(target, accessToken);
      if (!nested) return null;
      return Object.assign({}, nested, {
        _resolvedFromShortcutId: shortcutFile.id,
        _shortcutName: shortcutFile.name || nested.name,
        parents: Array.isArray(shortcutFile.parents) && shortcutFile.parents.length
          ? shortcutFile.parents
          : nested.parents,
      });
    }
    return Object.assign({}, target, {
      _resolvedFromShortcutId: shortcutFile.id,
      _shortcutName: shortcutFile.name || target.name,
      resourceKey: target.resourceKey || targetResourceKey || '',
      parents: Array.isArray(shortcutFile.parents) && shortcutFile.parents.length
        ? shortcutFile.parents
        : target.parents,
    });
  } catch (err) {
    // Link-shared targets often 404 without resource keys; with keys still failing,
    // soft-resolve so extract/export can retry against targetId + targetMimeType.
    if ((isDriveNotFoundError(err) || (err && err.statusCode === 404)) && targetMimeType) {
      console.warn(
        '[drive-catalog-sync] shortcut target meta 404 — soft-resolving for extract:',
        shortcutFile.name || shortcutFile.id,
        '→',
        targetId,
        targetMimeType,
        targetResourceKey ? '(with resourceKey)' : '(no resourceKey)'
      );
      return {
        id: targetId,
        name: shortcutFile.name || targetId,
        mimeType: targetMimeType,
        resourceKey: targetResourceKey,
        trashed: false,
        modifiedTime: '',
        webViewLink: '',
        parents: Array.isArray(shortcutFile.parents) ? shortcutFile.parents : [],
        _resolvedFromShortcutId: shortcutFile.id,
        _shortcutName: shortcutFile.name || '',
        _softResolved: true,
      };
    }
    if (isDriveNotFoundError(err) || (err && err.statusCode === 404)) {
      console.warn(
        '[drive-catalog-sync] skipping broken shortcut (404):',
        shortcutFile.name || shortcutFile.id,
        'targetId=',
        targetId
      );
      return null;
    }
    console.warn(
      '[drive-catalog-sync] shortcut resolve failed:',
      shortcutFile.name || shortcutFile.id,
      err.message || err
    );
    return null;
  }
}

/**
 * Expand children list so folder/file shortcuts become their targets under this folder.
 * Broken shortcuts are skipped; they must never abort the catalog walk/search.
 */
async function expandDriveChildrenWithShortcuts(children, accessToken) {
  const out = [];
  for (let i = 0; i < (children || []).length; i++) {
    const item = children[i];
    if (!item || !item.id) continue;
    if (!isShortcutMime(item.mimeType)) {
      out.push(item);
      continue;
    }
    try {
      const target = await resolveShortcutTarget(item, accessToken);
      if (!target) continue;
      out.push(Object.assign({}, target, {
        name: item.name || target.name,
      }));
    } catch (err) {
      console.warn(
        '[drive-catalog-sync] skipping shortcut after unexpected error:',
        item.name || item.id,
        err && err.message ? err.message : err
      );
    }
  }
  return out;
}

async function listDriveChildren(folderId, accessToken) {
  const items = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams();
    params.set('q', "'" + folderId + "' in parents and trashed=false");
    params.set(
      'fields',
      'nextPageToken,files(' + DRIVE_LIST_FILE_FIELDS + ')'
    );
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

  return expandDriveChildrenWithShortcuts(items, accessToken);
}

async function downloadDriveFileBuffer(fileId, accessToken, options) {
  const opts = options || {};
  const params = new URLSearchParams();
  params.set('alt', 'media');
  params.set('supportsAllDrives', 'true');
  const resourceKeys = {};
  const rk = String(opts.resourceKey || '').trim();
  if (rk) resourceKeys[fileId] = rk;
  const res = await fetch(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?' + params.toString(), {
    headers: buildDriveRequestHeaders(accessToken, resourceKeys),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error('Drive media download failed (' + res.status + '): ' + text.slice(0, 300));
    err.statusCode = res.status;
    throw err;
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_EXTRACT_BYTES;
  if (buffer.length > maxBytes) {
    const err = new Error('Drive file too large to extract (' + buffer.length + ' bytes)');
    err.code = 'FILE_TOO_LARGE';
    err.byteLength = buffer.length;
    throw err;
  }
  return buffer;
}

async function exportGoogleWorkspaceText(fileId, accessToken, exportMime, options) {
  const opts = options || {};
  const params = new URLSearchParams();
  params.set('mimeType', exportMime || 'text/plain');
  // Required for Shared Drive / shortcut-target Docs & Slides.
  params.set('supportsAllDrives', 'true');
  const resourceKeys = {};
  const rk = String(opts.resourceKey || '').trim();
  if (rk) resourceKeys[fileId] = rk;
  const res = await fetch(
    DRIVE_API + '/files/' + encodeURIComponent(fileId) + '/export?' + params.toString(),
    { headers: buildDriveRequestHeaders(accessToken, resourceKeys) }
  );
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('Drive export failed (' + res.status + '): ' + text.slice(0, 300));
    err.statusCode = res.status;
    throw err;
  }
  return String(text || '').trim();
}

/**
 * Minimal ZIP reader (stored / deflate) for .pptx slide XML text extraction.
 */
function extractZipEntryBuffers(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const out = {};
  let eocd = -1;
  const minScan = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minScan; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  let offset = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      continue;
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) continue;
    const compressed = buf.slice(dataStart, dataStart + compSize);
    let data = null;
    try {
      if (method === 0) data = compressed;
      else if (method === 8) data = zlib.inflateRawSync(compressed);
    } catch (inflateErr) {
      data = null;
    }
    if (data) out[name] = data;
  }
  return out;
}

function decodeXmlTextEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTextFromPptxBuffer(buffer) {
  const files = extractZipEntryBuffers(buffer);
  const slideNames = Object.keys(files)
    .filter(function (name) { return /^ppt\/slides\/slide\d+\.xml$/i.test(name); })
    .sort(function (a, b) {
      const na = parseInt((a.match(/slide(\d+)/i) || [])[1] || '0', 10);
      const nb = parseInt((b.match(/slide(\d+)/i) || [])[1] || '0', 10);
      return na - nb;
    });
  const texts = [];
  slideNames.forEach(function (name) {
    const xml = files[name].toString('utf8');
    const parts = [];
    xml.replace(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g, function (_m, inner) {
      const piece = decodeXmlTextEntities(inner).trim();
      if (piece) parts.push(piece);
      return '';
    });
    if (parts.length) texts.push(parts.join(' '));
  });
  return texts.join('\n\n').trim();
}

/**
 * Extract plain text from a Drive file (Docs/Slides/PDF/DOCX/PPTX/TXT) for Gemini summarization.
 * Always resolves shortcuts via targetId (+ resource key) before download/export.
 */
async function extractDriveFileText(fileId, options) {
  const opts = options || {};
  const accessToken = await resolveDriveAccessToken(opts);
  let meta = opts.meta || null;
  let workingId = String(fileId || '').trim();
  if (!meta) {
    try {
      meta = await fetchDriveFileMeta(workingId, accessToken, DRIVE_FILE_META_FIELDS, {
        resourceKey: String(opts.resourceKey || '').trim(),
      });
    } catch (metaErr) {
      // Caller may already know mime (e.g. soft-resolved shortcut target).
      if (
        (isDriveNotFoundError(metaErr) || (metaErr && metaErr.statusCode === 404))
        && opts.mimeType
        && !isShortcutMime(opts.mimeType)
      ) {
        meta = {
          id: workingId,
          name: opts.fileName || workingId,
          mimeType: opts.mimeType,
          resourceKey: opts.resourceKey || '',
          modifiedTime: '',
          _softResolved: true,
        };
      } else if (isDriveNotFoundError(metaErr) || (metaErr && metaErr.statusCode === 404)) {
        console.warn('[drive-catalog-sync] skip missing Drive file (404):', workingId);
        return {
          text: '',
          name: String(opts.fileName || workingId),
          mimeType: String(opts.mimeType || ''),
          modifiedTime: '',
          driveFileId: workingId,
          skipped: true,
          skipReason: 'not_found',
        };
      } else {
        throw metaErr;
      }
    }
  }

  // Resolve shortcut shells to the original target before any export/download.
  if (meta && isShortcutMime(meta.mimeType)) {
    let target = null;
    try {
      target = await resolveShortcutTarget(meta, accessToken);
    } catch (shortcutErr) {
      console.warn(
        '[drive-catalog-sync] shortcut extract resolve failed:',
        meta.name || workingId,
        shortcutErr && shortcutErr.message ? shortcutErr.message : shortcutErr
      );
      target = null;
    }
    if (!target || !target.id) {
      console.warn(
        '[drive-catalog-sync] skipping unresolved shortcut for extract:',
        meta.name || workingId
      );
      return {
        text: '',
        name: String(opts.fileName || meta.name || workingId),
        mimeType: String(meta.mimeType || ''),
        modifiedTime: meta.modifiedTime ? String(meta.modifiedTime) : '',
        driveFileId: workingId,
        skipped: true,
        skipReason: 'broken_shortcut',
      };
    }
    console.log(
      '[drive-catalog-sync] extracting via shortcut target:',
      meta.name || workingId,
      '→',
      target.id,
      target.mimeType || ''
    );
    return extractDriveFileText(target.id, {
      accessToken: accessToken,
      meta: target,
      fileName: opts.fileName || target._shortcutName || target.name,
      mimeType: target.mimeType,
      resourceKey: target.resourceKey || '',
    });
  }

  const mime = String((meta && meta.mimeType) || opts.mimeType || '').toLowerCase();
  const fileName = String(opts.fileName || (meta && meta.name) || workingId);
  const resourceKey = String(
    opts.resourceKey || (meta && meta.resourceKey) || ''
  ).trim();
  const extractOpts = { resourceKey: resourceKey };
  let text = '';

  try {
    if (mime === 'application/vnd.google-apps.document') {
      text = await exportGoogleWorkspaceText(workingId, accessToken, 'text/plain', extractOpts);
    } else if (mime === 'application/vnd.google-apps.presentation') {
      text = await exportGoogleWorkspaceText(workingId, accessToken, 'text/plain', extractOpts);
    } else if (mime === 'application/vnd.google-apps.spreadsheet') {
      text = await exportGoogleWorkspaceText(workingId, accessToken, 'text/csv', extractOpts);
    } else if (mime === 'text/plain' || mime === 'text/markdown' || /\.(txt|md)$/i.test(fileName)) {
      const buffer = await downloadDriveFileBuffer(workingId, accessToken, extractOpts);
      text = buffer.toString('utf8');
    } else if (mime === 'application/pdf' || /\.pdf$/i.test(fileName)) {
      const buffer = await downloadDriveFileBuffer(workingId, accessToken, extractOpts);
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer);
      text = parsed && parsed.text ? parsed.text : '';
    } else if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || /\.docx$/i.test(fileName)
    ) {
      const buffer = await downloadDriveFileBuffer(workingId, accessToken, extractOpts);
      const mammoth = require('mammoth');
      const parsed = await mammoth.extractRawText({ buffer: buffer });
      text = parsed && parsed.value ? parsed.value : '';
    } else if (
      mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      || /\.pptx$/i.test(fileName)
    ) {
      const buffer = await downloadDriveFileBuffer(workingId, accessToken, extractOpts);
      text = extractTextFromPptxBuffer(buffer);
    } else {
      throw new Error('Unsupported Drive mime for text extract: ' + (mime || 'unknown'));
    }
  } catch (extractErr) {
    // Soft-resolved shortcut targets may still need a fresh meta fetch with resource keys.
    if (
      meta && meta._softResolved
      && (isDriveNotFoundError(extractErr) || (extractErr && extractErr.statusCode === 404))
    ) {
      console.warn(
        '[drive-catalog-sync] soft-resolved extract 404:',
        fileName,
        extractErr.message || extractErr
      );
      return {
        text: '',
        name: fileName,
        mimeType: mime,
        modifiedTime: '',
        driveFileId: workingId,
        skipped: true,
        skipReason: 'not_found',
      };
    }
    throw extractErr;
  }

  return {
    text: String(text || '').replace(/\u0000/g, '').trim(),
    name: fileName,
    mimeType: mime,
    modifiedTime: meta && meta.modifiedTime ? String(meta.modifiedTime) : '',
    driveFileId: workingId,
    resourceKey: resourceKey,
  };
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
          'Content-Type': 'application/json; charset=utf-8',
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
      'Content-Type': 'application/json; charset=utf-8',
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
  const rootFolderId = getCatalogRootFolderId(opts);

  if (!rootFolderId || (!opts.accessToken && !parseServiceAccountJson() && !getDriveOauthUserCredentials())) {
    const err = new Error(
      'Google Drive is not configured. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON and/or GOOGLE_DRIVE_OAUTH_* '
      + '(or service-account.json) and optionally GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID (see docs/google-drive-setup.md).'
    );
    err.statusCode = 503;
    err.code = 'DRIVE_NOT_CONFIGURED';
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
  if (!isDriveCatalogSyncConfigured() && !(options && options.accessToken)) {
    console.warn(
      '[drive-catalog-sync] background fetch skipped — Drive env not configured (see docs/google-drive-setup.md)'
    );
    return;
  }
  syncCommunityDriveCatalog(options).catch(function (err) {
    console.warn('[drive-catalog-sync] background fetch failed:', err.message || err);
  });
}

function isDriveCatalogSyncConfigured() {
  const root = getCatalogRootFolderId();
  const hasSa = Boolean(parseServiceAccountJson());
  const hasOauth = Boolean(getDriveOauthUserCredentials());
  return Boolean(root && (hasSa || hasOauth));
}

/** Boot / ops helper — never throws; logs why Drive is unavailable. */
function logDriveConfigStatus(prefix) {
  const tag = prefix || '[drive]';
  const root = getCatalogRootFolderId();
  const envRoot = String(process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID || '').trim();
  const sa = parseServiceAccountJson();
  const oauth = getDriveOauthUserCredentials();
  const delegate = getDriveDelegateEmail();
  if (root && (sa || oauth)) {
    const authParts = [];
    if (oauth) authParts.push('oauth-user');
    if (sa) {
      authParts.push(
        'sa:' + sa.client_email + (delegate ? ' (delegate ' + delegate + ')' : '')
      );
    }
    console.log(
      tag,
      'configured — root folder:',
      root,
      envRoot ? '(from env)' : '(default)',
      '| auth:',
      authParts.join(' + ') || 'none'
    );
    if (!oauth && !delegate) {
      console.log(
        tag,
        'write hint: personal My Drive uploads need GOOGLE_DRIVE_OAUTH_* '
          + '(node scripts/google-drive-oauth-setup.js) or a Shared Drive'
      );
    }
    return true;
  }
  if (!sa && !oauth) {
    console.warn(
      tag,
      'not configured — set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON and/or GOOGLE_DRIVE_OAUTH_* '
        + '(see docs/google-drive-setup.md). Community search will use local/index fallback only.'
    );
  } else {
    console.warn(tag, 'incomplete — catalog root folder id is missing');
  }
  return false;
}

function stableNormalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u05F3\u05F4׳״`'"]/g, '')
    .replace(/[-–—_/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Escape a literal for Drive API `q` single-quoted strings. */
function escapeDriveQueryLiteral(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/**
 * Build Drive files.list `q` for name + fullText keyword search.
 * When nameOnly is set, skip fullText (navigation / folder-name precision).
 * Example: (fullText contains 'רומא' or name contains 'רומא') and trashed=false
 */
function buildDriveKeywordSearchQuery(keyword, options) {
  const opts = options || {};
  const term = String(keyword || '').trim();
  if (!term || term.length < 2) return '';

  const lit = escapeDriveQueryLiteral(term);
  const nameClause = "name contains '" + lit + "'";
  const matchClause = opts.nameOnly
    ? '(' + nameClause + ')'
    : "(fullText contains '" + lit + "' or " + nameClause + ')';
  const parts = [
    matchClause,
    'trashed=false',
  ];
  if (opts.includeFolders === true) {
    // Allow folders + files.
  } else {
    parts.push("mimeType != '" + FOLDER_MIME + "'");
  }

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
      'nextPageToken,files(' + DRIVE_LIST_FILE_FIELDS + ')'
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
  }   while (pageToken && items.length < limit);

  const expanded = [];
  for (let i = 0; i < items.length; i++) {
    const file = items[i];
    if (!file || !file.id) continue;
    if (isShortcutMime(file.mimeType)) {
      try {
        const target = await resolveShortcutTarget(file, accessToken);
        if (target && (isSyncableDriveFile(target) || (opts.includeFolders && target.mimeType === FOLDER_MIME))) {
          expanded.push(Object.assign({}, target, {
            name: file.name || target.name,
            parents: Array.isArray(file.parents) && file.parents.length ? file.parents : target.parents,
          }));
        }
      } catch (shortcutErr) {
        console.warn(
          '[drive-catalog-sync] skipping search shortcut after error:',
          file.name || file.id,
          shortcutErr && shortcutErr.message ? shortcutErr.message : shortcutErr
        );
      }
      continue;
    }
    if (file.mimeType === FOLDER_MIME) {
      if (opts.includeFolders) expanded.push(file);
      continue;
    }
    expanded.push(file);
  }
  return expanded.slice(0, limit);
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
  const rootFolderId = getCatalogRootFolderId(opts);
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
  // Fuzzy includes (hyphens/spaces already normalized): «תזונה» ↔ «תזונה ובריאות».
  if (expected.length >= 3 && candidate.indexOf(expected) >= 0) return true;
  if (candidate.length >= 3 && expected.indexOf(candidate) >= 0) return true;

  // Active semantic exclude (e.g. Norse ↔ Greek/Roman mythology).
  if (
    typeof catalogTopics.topicsAreMutuallyExcluded === 'function'
    && catalogTopics.topicsAreMutuallyExcluded(expectedTopic, candidateTopic)
  ) {
    return false;
  }

  const expectedCanon = stableNormalize(
    catalogTopics.resolveCatalogTopicFromFolderName(expectedTopic) || expectedTopic
  );
  const candidateCanon = stableNormalize(
    catalogTopics.resolveCatalogTopicFromFolderName(candidateTopic) || candidateTopic
  );
  if (expectedCanon && candidateCanon && expectedCanon === candidateCanon) return true;
  if (expectedCanon && candidateCanon) {
    if (expectedCanon.length >= 3 && candidateCanon.indexOf(expectedCanon) >= 0) return true;
    if (candidateCanon.length >= 3 && expectedCanon.indexOf(candidateCanon) >= 0) return true;
  }

  const expectedAliases = new Set(
    catalogTopics.expandCatalogTopicAliases([expectedTopic, expectedCanon]).map(stableNormalize)
  );
  if (expectedAliases.has(candidate) || expectedAliases.has(candidateCanon)) return true;
  // Alias substring: folder «תזונה ומערכי שיעור» vs alias «תזונה».
  for (const alias of expectedAliases) {
    if (!alias || alias.length < 3) continue;
    if (candidate.indexOf(alias) >= 0 || (candidateCanon && candidateCanon.indexOf(alias) >= 0)) {
      return true;
    }
    if (alias.indexOf(candidate) >= 0 || (candidateCanon && alias.indexOf(candidateCanon) >= 0)) {
      return true;
    }
  }
  return false;
}

/** True when file/folder name centrally contains the topic or one of its aliases. */
function nameMatchesTopicCentrally(fileName, topic, query) {
  const nameNorm = stableNormalize(fileName);
  if (!nameNorm) return false;
  const seeds = new Set();
  [topic, query].forEach(function (seed) {
    const s = stableNormalize(seed);
    if (s && s.length >= 2) seeds.add(s);
  });
  catalogTopics.expandCatalogTopicAliases([topic, query].filter(Boolean)).forEach(function (alias) {
    const a = stableNormalize(alias);
    if (a && a.length >= 3) seeds.add(a);
  });
  for (const seed of seeds) {
    if (nameNorm === seed) return true;
    if (seed.length >= 3 && nameNorm.indexOf(seed) >= 0) return true;
    if (nameNorm.length >= 4 && seed.indexOf(nameNorm) >= 0) return true;
    // Construct / morphological near-match: «תזונת…» ↔ «תזונה»
    if (seed.length >= 4 && nameNorm.indexOf(seed.slice(0, -1)) >= 0) return true;
  }

  let hebrewTopicMatch = null;
  try {
    hebrewTopicMatch = require('../hebrew-topic-match');
  } catch (e) {
    hebrewTopicMatch = null;
  }
  if (
    hebrewTopicMatch
    && typeof hebrewTopicMatch.extractMeaningfulTokens === 'function'
    && typeof hebrewTopicMatch.hebrewTokensRelated === 'function'
  ) {
    const nameTokens = hebrewTopicMatch.extractMeaningfulTokens(fileName);
    const seedTokens = hebrewTopicMatch.extractMeaningfulTokens(
      [topic, query].filter(Boolean).join(' ')
    );
    for (let i = 0; i < seedTokens.length; i++) {
      for (let j = 0; j < nameTokens.length; j++) {
        if (hebrewTopicMatch.hebrewTokensRelated(seedTokens[i], nameTokens[j])) return true;
      }
    }
  }
  return false;
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
  const folderParts = Array.isArray(scope.path) ? scope.path.slice() : [];
  const locationPath = formatDriveLocationPath(folderParts);
  const pathLabels = folderParts.concat(fileName).join(' / ');
  const locationPathWithFile = formatDriveLocationPath(folderParts.concat(fileName));
  const gradeId = String(scope.gradeId || '');
  const gradeLabel = pedagogicalScope.GRADE_LABEL_BY_ID[gradeId] || '';
  const webViewLink = buildDriveFileUrl(file);

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
    locationPath: locationPath || (gradeLabel && catalogTopic ? (gradeLabel + ' > ' + catalogTopic) : ''),
    locationPathWithFile: locationPathWithFile,
    fileUrl: webViewLink,
    webViewLink: webViewLink,
    mimeType: String((file && file.mimeType) || ''),
    resourceKey: String((file && file.resourceKey) || '').trim(),
    modifiedTime: String((file && file.modifiedTime) || ''),
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
  let hebrewTopicMatch = null;
  try {
    hebrewTopicMatch = require('../hebrew-topic-match');
  } catch (e) {
    hebrewTopicMatch = null;
  }
  aliases.forEach(function (alias) {
    const aNorm = stableNormalize(alias);
    if (!aNorm || aNorm.length < 2) return;
    const substringHit = aNorm === qNorm
      || qNorm.indexOf(aNorm) >= 0
      || aNorm.indexOf(qNorm) >= 0;
    const tokenHit = hebrewTopicMatch
      && typeof hebrewTopicMatch.aliasMatchesQueryByTokens === 'function'
      && hebrewTopicMatch.aliasMatchesQueryByTokens(qNorm, aNorm);
    if (substringHit || tokenHit) {
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
  const queryGrade = typeof catalogTopics.extractGradeIdFromQuery === 'function'
    ? catalogTopics.extractGradeIdFromQuery(q)
    : '';
  const explicitGrade = uiGrade || queryGrade;
  const crossCutting = (
    typeof catalogTopics.isCrossCuttingTopic === 'function'
    && (
      catalogTopics.isCrossCuttingTopic(q)
      || catalogTopics.isCrossCuttingTopic(uiTopic)
    )
  );
  // Broad / global scans (e.g. general search, cross-cutting topics) must not invent
  // a grade lock from curriculum inference — only an explicit UI/query grade may.
  const broadScan = opts.broadScan === true
    || opts.globalScan === true
    || (crossCutting && !explicitGrade);

  const block = pedagogicalScope.inferTopicCurriculumBlock(q);
  // UI / query grade lock wins — never expand Drive search into another classroom.
  const strictGradeId = explicitGrade || (broadScan ? '' : ((block && block.gradeId) || ''));

  let strictTopic = uiTopic;
  if (!strictTopic) {
    const fromFolder = catalogTopics.resolveCatalogTopicFromFolderName(q);
    if (fromFolder) {
      strictTopic = fromFolder;
    } else if (block && !crossCutting) {
      // Lock to the alias that actually matched the query (גיאולוגיה ≠ רומא).
      strictTopic = pickBestMatchingAlias(q, block.aliases);
    }
    if (!strictTopic) {
      if (qNorm === 'רומא' || qNorm.indexOf('רומא') === 0) strictTopic = 'רומא';
      else if (qNorm === 'יוון' || qNorm.indexOf('יוון') === 0) strictTopic = 'יוון';
      else if (qNorm.indexOf('נורד') >= 0 || qNorm.indexOf('norse') >= 0) {
        strictTopic = 'מיתולוגיה נורדית';
      }
    }
  }

  return {
    gradeId: strictGradeId,
    topic: strictTopic,
    curriculumBlock: block || null,
    broadScan: broadScan,
    crossCutting: crossCutting,
    queryGradeId: queryGrade || '',
  };
}

/**
 * Live community search against the shared Google Drive catalog.
 * Uses Drive files.list `q` (name + fullText) and a strict grade/topic folder filter.
 * With broadScan/globalScan and no grade lock, searches across all grade folders.
 * Never filters by signed-in userId — the catalog is global/community scope only.
 */
async function searchDriveCommunityCatalog(query, options) {
  const opts = options || {};
  const q = String(query || opts.userMessage || '').trim();
  if (!q || q.length < 2) {
    return {
      matches: [],
      count: 0,
      query: q,
      matchMethod: 'none',
      driveScoped: true,
      communityStatus: 'empty',
      driveConfigured: isDriveCatalogSyncConfigured(),
    };
  }
  if (!isDriveCatalogSyncConfigured() && !opts.accessToken) {
    return {
      matches: [],
      count: 0,
      query: q,
      matchMethod: 'none',
      driveScoped: false,
      communityStatus: 'not_configured',
      driveConfigured: false,
      communityError: 'GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID / GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON missing',
    };
  }

  const broadScanOpt = opts.broadScan === true || opts.globalScan === true;
  let accessToken;
  let index;
  try {
    accessToken = await resolveDriveAccessToken(opts);
    index = await getDriveFolderIndex(Object.assign({}, opts, { accessToken: accessToken }));
  } catch (setupErr) {
    console.warn('[drive-search] setup failed:', setupErr.message || setupErr);
    return {
      matches: [],
      count: 0,
      query: q,
      matchMethod: 'error',
      driveScoped: false,
      communityStatus: 'unavailable',
      driveConfigured: true,
      communityError: String(setupErr.message || setupErr),
    };
  }

  const scope = resolveDriveSearchScope(q, Object.assign({}, opts, { broadScan: broadScanOpt }));
  // Cross-cutting topics without an explicit grade become broad via resolveDriveSearchScope.
  const broadScan = Boolean(scope.broadScan);

  if (!scope.gradeId && !scope.topic && !broadScan) {
    // Refuse unconstrained Drive fullText sweeps outside explicit broad/global scans.
    return {
      matches: [],
      count: 0,
      query: q,
      matchMethod: 'none',
      driveScoped: true,
      communityStatus: 'empty',
      driveConfigured: true,
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
  // Broad scan with no usable topic folders: open all graded catalog folders.
  if (!effectiveAllowed.size && broadScan) {
    effectiveAllowed = resolveStrictDriveScopeFolderIds(index, '', '');
    topicRelaxed = Boolean(scope.topic);
  }

  if (!effectiveAllowed.size) {
    return {
      matches: [],
      count: 0,
      query: q,
      matchMethod: 'none',
      driveScoped: true,
      communityStatus: 'empty',
      driveConfigured: true,
      scope: scope,
    };
  }

  const navigationMode = opts.navigationSearch === true
    || opts.requireCentralMatch === true
    || String(opts.phase || '').indexOf('community_catalog') === 0
    || String(opts.phase || '') === 'probe_community';

  let expansion = driveQueryExpand.expandDriveNavigationQueryLocal(q);
  if (navigationMode && opts.skipGeminiExpand !== true) {
    try {
      expansion = await driveQueryExpand.expandDriveNavigationQuery(q, {
        skipGemini: opts.skipGeminiExpand === true,
      });
    } catch (expandErr) {
      console.warn('[drive-search] query expand failed:', expandErr.message || expandErr);
    }
  }

  // Prefer multi-word pedagogical phrases; avoid bare tokens like "אדם" that pollute fullText.
  const searchTerms = (expansion.allTerms && expansion.allTerms.length)
    ? expansion.allTerms.slice(0, navigationMode ? 6 : 4)
    : [q];

  const seenFileIds = new Set();
  const rawFiles = [];
  const parentIdList = Array.from(effectiveAllowed);
  const PARENT_BATCH = 20;
  const MAX_PARENT_BATCHES = 6;
  let driveQueryErrors = 0;
  let lastDriveQueryError = '';
  const includeFolders = navigationMode === true;
  // First pass: name-focused for navigation precision; second pass can use fullText if empty.
  const nameOnlyFirstPass = navigationMode === true;
  const debugInfo = {
    scannedFolderCount: parentIdList.length,
    gradeFolderIds: scope.gradeId && index.gradeRootFolders
      ? [index.gradeRootFolders[scope.gradeId]].filter(Boolean)
      : [],
    gradeTopicFolders: scope.gradeId && index.topicFolders && index.topicFolders[scope.gradeId]
      ? Object.keys(index.topicFolders[scope.gradeId])
      : [],
    searchTerms: searchTerms.slice(),
    topicRelaxed: topicRelaxed,
    scopeTopic: scope.topic || '',
    scopeGradeId: scope.gradeId || '',
    rawHitCount: 0,
    rejected: [],
    grade7SampleNames: [],
  };

  async function collectDriveHits(termList, parentBatches, nameOnly) {
    for (let i = 0; i < termList.length; i++) {
      const term = termList[i];
      const batches = parentBatches && parentBatches.length ? parentBatches : [[]];
      for (let b = 0; b < batches.length; b++) {
        const driveQuery = buildDriveKeywordSearchQuery(term, {
          parentFolderIds: batches[b],
          includeFolders: includeFolders,
          nameOnly: nameOnly,
        });
        if (!driveQuery) continue;
        try {
          const batch = await listDriveSearchResults(accessToken, driveQuery, {
            limit: MAX_DRIVE_SEARCH_RESULTS,
            includeFolders: includeFolders,
          });
          (batch || []).forEach(function (file) {
            if (!file || !file.id || seenFileIds.has(file.id)) return;
            if (file.mimeType === FOLDER_MIME) {
              if (!includeFolders) return;
            } else if (!isSyncableDriveFile(file)) {
              return;
            }
            seenFileIds.add(file.id);
            rawFiles.push(file);
          });
        } catch (searchErr) {
          driveQueryErrors += 1;
          lastDriveQueryError = String(searchErr.message || searchErr);
          console.warn('[drive-search] query failed for', term, lastDriveQueryError);
        }
      }
    }
  }

  const parentBatches = [];
  for (let p = 0; p < parentIdList.length && parentBatches.length < MAX_PARENT_BATCHES; p += PARENT_BATCH) {
    parentBatches.push(parentIdList.slice(p, p + PARENT_BATCH));
  }
  if (!parentBatches.length) parentBatches.push([]);

  await collectDriveHits(
    searchTerms.slice(0, navigationMode ? 6 : 4),
    parentBatches,
    nameOnlyFirstPass
  );

  // Fallback: if name-only navigation found nothing, retry with fullText but still
  // enforce central name/folder relevance below.
  if (!rawFiles.length && nameOnlyFirstPass) {
    await collectDriveHits(searchTerms.slice(0, 4), parentBatches, false);
  }

  // When the grade has no matching topic folder (or scoped search is empty), also
  // search the catalog root / ungraded layers by bare topic name — materials like
  // «תזונה ונשימה…» often live as root shortcuts outside כיתה folders.
  const needsUngradedPass = topicRelaxed || !rawFiles.length;
  let ungradedPassRan = false;
  if (needsUngradedPass && scope.topic) {
    ungradedPassRan = true;
    const ungradedTerms = uniquePrioritySearchTerms(q, scope.topic, searchTerms);
    await collectDriveHits(ungradedTerms, [[]], true);
    if (!rawFiles.length) {
      await collectDriveHits(ungradedTerms, [[]], false);
    }
  }
  debugInfo.ungradedPassRan = ungradedPassRan;
  debugInfo.rawHitCount = rawFiles.length;

  if (!rawFiles.length && driveQueryErrors > 0) {
    return {
      matches: [],
      count: 0,
      query: q,
      matchMethod: 'error',
      driveScoped: true,
      communityStatus: 'unavailable',
      driveConfigured: true,
      communityError: lastDriveQueryError || 'Drive files.list search failed',
      debug: debugInfo,
      scope: {
        gradeId: scope.gradeId,
        topic: scope.topic,
        topicRelaxed: topicRelaxed,
        broadScan: broadScan,
      },
    };
  }

  const matches = [];
  const rootFolderId = getCatalogRootFolderId(opts);
  rawFiles.forEach(function (file) {
    const parents = Array.isArray(file.parents) ? file.parents : [];
    const inScope = parents.some(function (parentId) {
      return effectiveAllowed.has(parentId);
    }) || (file.mimeType === FOLDER_MIME && effectiveAllowed.has(file.id));

    let fileScope = resolveFileScopeFromParents(file, index);
    if ((!fileScope || !fileScope.gradeId) && file.mimeType === FOLDER_MIME && index.byFolderId[file.id]) {
      const meta = index.byFolderId[file.id];
      fileScope = {
        parentId: meta.parentId || '',
        gradeId: meta.gradeId || '',
        catalogTopic: meta.catalogTopic || file.name || 'כללי',
        path: (meta.path || []).slice(),
      };
    }

    const isRootOrUngraded = !fileScope || !fileScope.gradeId
      || parents.some(function (pid) { return pid === rootFolderId; })
      || (fileScope && !fileScope.gradeId);
    const nameCentral = nameMatchesTopicCentrally(file.name || '', scope.topic || q, q);

    // Grade-locked search: keep in-scope hits; also admit root/ungraded files whose
    // names centrally match the topic when the classroom has no dedicated topic folder.
    if (!inScope) {
      if (!(needsUngradedPass && isRootOrUngraded && nameCentral)) {
        debugInfo.rejected.push({
          name: file.name,
          reason: 'out_of_scope_folder',
          gradeId: fileScope && fileScope.gradeId,
          catalogTopic: fileScope && fileScope.catalogTopic,
        });
        return;
      }
      // Synthesize a scope so the hit can flow through formatting + grade lock.
      fileScope = {
        parentId: parents[0] || '',
        gradeId: scope.gradeId || '',
        catalogTopic: catalogTopics.resolveCatalogTopicFromFolderName(file.name)
          || scope.topic
          || 'כללי',
        path: (fileScope && fileScope.path && fileScope.path.length)
          ? fileScope.path.slice()
          : (scope.gradeId
            ? [(pedagogicalScope.GRADE_LABEL_BY_ID[scope.gradeId] || ('כיתה ' + scope.gradeId)), fileScope && fileScope.catalogTopic].filter(Boolean)
            : ['מאגר קהילתי']),
        ungradedTopicFallback: true,
      };
    }

    if (!fileScope || !fileScope.gradeId) {
      if (needsUngradedPass && nameCentral) {
        fileScope = {
          parentId: parents[0] || '',
          gradeId: scope.gradeId || 'general',
          catalogTopic: catalogTopics.resolveCatalogTopicFromFolderName(file.name)
            || scope.topic
            || 'כללי',
          path: ['מאגר קהילתי'],
          ungradedTopicFallback: true,
        };
      } else {
        debugInfo.rejected.push({
          name: file.name,
          reason: 'missing_grade_scope',
          nameCentral: nameCentral,
        });
        return;
      }
    }
    if (scope.gradeId && fileScope.gradeId && fileScope.gradeId !== scope.gradeId && !fileScope.ungradedTopicFallback) {
      debugInfo.rejected.push({
        name: file.name,
        reason: 'grade_mismatch',
        gradeId: fileScope.gradeId,
      });
      return;
    }

    // Active exclude: never admit rival mythology / epoch folders.
    if (
      typeof catalogTopics.topicsAreMutuallyExcluded === 'function'
      && (
        catalogTopics.topicsAreMutuallyExcluded(q, fileScope.catalogTopic || '')
        || catalogTopics.topicsAreMutuallyExcluded(scope.topic || q, file.name || '')
      )
    ) {
      debugInfo.rejected.push({ name: file.name, reason: 'topic_excluded' });
      return;
    }

    if (scope.topic) {
      const topicOk = topicsStrictlyCompatible(scope.topic, fileScope.catalogTopic || '')
        || topicsStrictlyCompatible(scope.topic, file.name || '')
        || nameCentral;
      if (!topicOk) {
        // Topic folder missing (relaxed grade-wide / broad search): allow only when the
        // keyword is central in the file name — never sibling-folder fullText hits.
        if (!topicRelaxed && !fileScope.ungradedTopicFallback) {
          debugInfo.rejected.push({
            name: file.name,
            reason: 'topic_filter',
            catalogTopic: fileScope.catalogTopic,
          });
          return;
        }
        if (!nameCentral) {
          debugInfo.rejected.push({
            name: file.name,
            reason: 'topic_relaxed_name_not_central',
            catalogTopic: fileScope.catalogTopic,
          });
          return;
        }
      }
    }

    const hit = formatDriveSearchHit(file, fileScope, q);
    if (fileScope.ungradedTopicFallback) {
      hit.ungradedTopicFallback = true;
      hit.matchType = hit.matchType || 'drive_name';
    }
    // Reject fullText-only false positives (e.g. גילגמש for «אדם חיה»).
    if (!driveQueryExpand.isCentralDriveHitRelevant(q, hit, expansion)) {
      // Name-central ungraded fallback already proved topicality via aliases.
      if (!(fileScope.ungradedTopicFallback && nameCentral)) {
        debugInfo.rejected.push({
          name: file.name,
          reason: 'central_relevance',
          catalogTopic: fileScope.catalogTopic,
        });
        return;
      }
    }
    hit.similarity = Math.max(
      hit.similarity || 0,
      driveQueryExpand.scoreCentralDriveRelevance(q, hit, expansion) || (nameCentral ? 0.9 : 0)
    );
    if (file.mimeType === FOLDER_MIME) {
      hit.matchType = 'drive_folder';
      hit.isFolder = true;
    }
    matches.push(hit);
  });

  // Populate grade folder sample names for empty-result diagnostics.
  if (scope.gradeId && index.topicFolders && index.topicFolders[scope.gradeId]) {
    debugInfo.gradeTopicFolders = Object.keys(index.topicFolders[scope.gradeId]);
  }
  if (!matches.length) {
    const why = [];
    if (!debugInfo.gradeTopicFolders.length) {
      why.push('no_topic_folders_indexed_for_grade');
    } else if (scope.topic && topicRelaxed) {
      why.push('no_folder_compatible_with_topic_' + scope.topic);
      why.push('grade_topics=' + debugInfo.gradeTopicFolders.slice(0, 12).join(','));
    }
    if (!rawFiles.length) {
      why.push('drive_keyword_search_returned_zero_files');
      why.push('search_terms=' + searchTerms.slice(0, 6).join('|'));
    } else {
      why.push('raw_hits=' + rawFiles.length + '_but_all_filtered');
      why.push('reject_reasons=' + debugInfo.rejected.slice(0, 8).map(function (r) {
        return (r.name || '?') + ':' + r.reason;
      }).join(';'));
    }
    debugInfo.topicFilterFailureReasons = why;
  }

  matches.sort(function (a, b) {
    return (b.similarity || 0) - (a.similarity || 0);
  });

  const limit = opts.limit || 8;
  const sliced = matches.slice(0, limit);
  return {
    matches: sliced,
    count: sliced.length,
    query: q,
    matchMethod: sliced.length
      ? (sliced.some(function (m) { return m.matchType === 'drive_folder'; })
        ? 'drive_name'
        : (sliced[0].matchType || 'drive_fulltext'))
      : 'none',
    driveScoped: true,
    communityStatus: sliced.length ? 'ok' : 'empty',
    driveConfigured: true,
    queryExpansion: {
      phrases: (expansion && expansion.phrases) || [],
      geminiExpanded: Boolean(expansion && expansion.geminiExpanded),
    },
    debug: debugInfo,
    scope: {
      gradeId: scope.gradeId,
      topic: scope.topic,
      topicRelaxed: topicRelaxed,
      broadScan: broadScan,
      navigationMode: navigationMode,
      ungradedPassRan: ungradedPassRan,
    },
  };
}

/** Short priority seeds for ungraded/root fallback searches. */
function uniquePrioritySearchTerms(query, topic, existingTerms) {
  const seeds = [];
  const seen = new Set();
  function add(term) {
    const t = String(term || '').trim();
    if (!t || t.length < 2) return;
    const key = stableNormalize(t);
    if (!key || seen.has(key)) return;
    seen.add(key);
    seeds.push(t);
  }
  add(query);
  add(topic);
  // Morphological Hebrew stems so Drive `name contains` finds «תזונת…» for «תזונה».
  [query, topic].forEach(function (seed) {
    const s = String(seed || '').trim();
    if (s.length >= 4) add(s.slice(0, -1));
  });
  catalogTopics.expandCatalogTopicAliases([query, topic].filter(Boolean)).forEach(function (alias) {
    const a = String(alias || '').trim();
    // Prefer compact Hebrew/English topic seeds over long English phrases.
    if (a && a.length >= 3 && a.length <= 24) add(a);
  });
  (existingTerms || []).forEach(add);
  return seeds.slice(0, 8);
}

/**
 * List every syncable file under grade (+ optional topic) catalog folders,
 * including subfolders. Shortcuts are resolved to their targets (with resource keys).
 * Used by the community summarizer for multi-file merge (not keyword search).
 *
 * When the grade has no matching topic folder, still keep only files whose names
 * centrally match the topic, and also pull root/ungraded topic-named materials.
 */
async function listDriveFilesForGradeTopic(gradeId, topic, options) {
  const opts = options || {};
  const gid = String(gradeId || '').trim();
  const topicStr = String(topic || '').trim();
  const limit = Math.max(1, Math.min(Number(opts.limit) || MAX_TOPIC_FOLDER_FILES, 80));

  const debugInfo = {
    scannedFolderCount: 0,
    gradeTopicFolders: [],
    topicRelaxed: false,
    rawHitCount: 0,
    rejected: [],
    topicFilterFailureReasons: [],
    ungradedPassRan: false,
    searchTerms: topicStr ? [topicStr] : [],
  };

  if (!gid) {
    return {
      matches: [],
      count: 0,
      gradeId: gid,
      topic: topicStr,
      communityStatus: 'empty',
      driveConfigured: isDriveCatalogSyncConfigured(),
      debug: debugInfo,
    };
  }
  if (!isDriveCatalogSyncConfigured() && !opts.accessToken) {
    return {
      matches: [],
      count: 0,
      gradeId: gid,
      topic: topicStr,
      communityStatus: 'not_configured',
      driveConfigured: false,
      debug: debugInfo,
    };
  }

  let accessToken;
  let index;
  try {
    accessToken = await resolveDriveAccessToken(opts);
    index = await getDriveFolderIndex(Object.assign({}, opts, { accessToken: accessToken }));
  } catch (setupErr) {
    console.warn('[drive-catalog-sync] listDriveFilesForGradeTopic setup failed:', setupErr.message || setupErr);
    return {
      matches: [],
      count: 0,
      gradeId: gid,
      topic: topicStr,
      communityStatus: 'unavailable',
      driveConfigured: true,
      communityError: String(setupErr.message || setupErr),
      debug: debugInfo,
    };
  }

  if (index.topicFolders && index.topicFolders[gid]) {
    debugInfo.gradeTopicFolders = Object.keys(index.topicFolders[gid]);
  }

  let allowed = resolveStrictDriveScopeFolderIds(index, gid, topicStr);
  let topicRelaxed = false;
  if (!allowed.size && topicStr) {
    allowed = resolveStrictDriveScopeFolderIds(index, gid, '');
    topicRelaxed = true;
  }
  debugInfo.topicRelaxed = topicRelaxed;
  debugInfo.scannedFolderCount = allowed.size;

  const seen = new Set();
  const matches = [];
  const rootFolderId = getCatalogRootFolderId(opts);

  function tryAdmitListedFile(item, folderId, asUngradedFallback) {
    if (!item || !item.id) return false;
    if (item.mimeType === FOLDER_MIME) return false;
    if (!isSyncableDriveFile(item)) return false;
    if (seen.has(item.id)) return false;

    let fileScope = resolveFileScopeFromParents(item, index);
    if (!fileScope || !fileScope.gradeId) {
      const folderMeta = folderId ? index.byFolderId[folderId] : null;
      fileScope = {
        parentId: folderId || '',
        gradeId: (folderMeta && folderMeta.gradeId) || (asUngradedFallback ? gid : ''),
        catalogTopic: (folderMeta && folderMeta.catalogTopic)
          || catalogTopics.resolveCatalogTopicFromFolderName(item.name)
          || topicStr
          || 'כללי',
        path: (folderMeta && folderMeta.path)
          ? folderMeta.path.slice()
          : (asUngradedFallback ? ['מאגר קהילתי'] : []),
        ungradedTopicFallback: Boolean(asUngradedFallback),
      };
    }

    const nameCentral = nameMatchesTopicCentrally(item.name || '', topicStr, topicStr);
    if (topicStr) {
      const topicOk = topicsStrictlyCompatible(topicStr, fileScope.catalogTopic || '')
        || topicsStrictlyCompatible(topicStr, item.name || '')
        || nameCentral;
      // Even when the classroom has no dedicated topic folder, never dump the
      // entire grade tree into the summarizer — require central topic evidence.
      if (!topicOk) {
        debugInfo.rejected.push({
          name: item.name,
          reason: topicRelaxed || asUngradedFallback ? 'topic_relaxed_name_not_central' : 'topic_filter',
          catalogTopic: fileScope.catalogTopic,
        });
        return false;
      }
    }

    if (!asUngradedFallback && String(fileScope.gradeId || '') !== gid) {
      debugInfo.rejected.push({ name: item.name, reason: 'grade_mismatch', gradeId: fileScope.gradeId });
      return false;
    }
    if (asUngradedFallback) {
      fileScope.gradeId = gid;
      fileScope.ungradedTopicFallback = true;
      if (!nameCentral && !topicsStrictlyCompatible(topicStr, item.name || '')) {
        return false;
      }
    }

    seen.add(item.id);
    const hit = formatDriveSearchHit(item, fileScope, topicStr || gid);
    if (fileScope.ungradedTopicFallback) hit.ungradedTopicFallback = true;
    matches.push(hit);
    return true;
  }

  const folderIds = Array.from(allowed);
  console.log(
    '[drive-catalog-sync] listing topic-folder files — grade:',
    gid,
    '| topic:',
    topicStr || '(any)',
    '| folders:',
    folderIds.length,
    topicRelaxed ? '(topic relaxed to grade)' : ''
  );

  for (let i = 0; i < folderIds.length && matches.length < limit; i++) {
    const folderId = folderIds[i];
    let children = [];
    try {
      children = await listDriveChildren(folderId, accessToken);
    } catch (listErr) {
      console.warn(
        '[drive-catalog-sync] topic-folder list failed:',
        folderId,
        listErr && listErr.message ? listErr.message : listErr
      );
      continue;
    }
    for (let c = 0; c < children.length && matches.length < limit; c++) {
      tryAdmitListedFile(children[c], folderId, false);
    }
  }

  // Root / ungraded fallback: keyword-search the whole catalog for topic names
  // when the grade tree had no dedicated topic folder (or yielded nothing).
  if (topicStr && (topicRelaxed || !matches.length) && matches.length < limit) {
    debugInfo.ungradedPassRan = true;
    const ungradedTerms = uniquePrioritySearchTerms(topicStr, topicStr, []);
    debugInfo.searchTerms = ungradedTerms.slice();
    for (let t = 0; t < ungradedTerms.length && matches.length < limit; t++) {
      const driveQuery = buildDriveKeywordSearchQuery(ungradedTerms[t], {
        parentFolderIds: [],
        includeFolders: false,
        nameOnly: true,
      });
      if (!driveQuery) continue;
      try {
        const batch = await listDriveSearchResults(accessToken, driveQuery, {
          limit: MAX_DRIVE_SEARCH_RESULTS,
          includeFolders: false,
        });
        debugInfo.rawHitCount += (batch || []).length;
        (batch || []).forEach(function (file) {
          if (matches.length >= limit) return;
          const parents = Array.isArray(file.parents) ? file.parents : [];
          const parentMeta = parents.length ? index.byFolderId[parents[0]] : null;
          const otherGrade = parentMeta && parentMeta.gradeId && String(parentMeta.gradeId) !== gid;
          if (otherGrade) {
            debugInfo.rejected.push({
              name: file.name,
              reason: 'other_grade',
              gradeId: parentMeta.gradeId,
            });
            return;
          }
          const isUngraded = !parentMeta || !parentMeta.gradeId
            || parents.some(function (pid) { return pid === rootFolderId; });
          if (!isUngraded && !topicRelaxed) return;
          tryAdmitListedFile(file, parents[0] || '', true);
        });
      } catch (searchErr) {
        console.warn(
          '[drive-catalog-sync] ungraded topic search failed:',
          ungradedTerms[t],
          searchErr && searchErr.message ? searchErr.message : searchErr
        );
      }
    }
  }

  if (!matches.length) {
    const why = [];
    if (topicRelaxed) {
      why.push('no_folder_compatible_with_topic_' + topicStr);
      why.push('grade_topics=' + debugInfo.gradeTopicFolders.slice(0, 12).join(','));
    }
    if (!debugInfo.rawHitCount && debugInfo.ungradedPassRan) {
      why.push('ungraded_name_search_returned_zero_or_all_filtered');
    }
    if (debugInfo.rejected.length) {
      why.push('reject_reasons=' + debugInfo.rejected.slice(0, 8).map(function (r) {
        return (r.name || '?') + ':' + r.reason;
      }).join(';'));
    }
    debugInfo.topicFilterFailureReasons = why;
  }

  console.log(
    '[drive-catalog-sync] topic-folder files ready:',
    matches.length,
    matches.map(function (m) { return m.fileName || m.driveFileId; }).join(' | ')
  );

  return {
    matches: matches,
    count: matches.length,
    gradeId: gid,
    topic: topicStr,
    communityStatus: matches.length ? 'ok' : 'empty',
    driveConfigured: true,
    topicRelaxed: topicRelaxed,
    matchMethod: matches.some(function (m) { return m.ungradedTopicFallback; })
      ? 'topic_folder_listing_ungraded'
      : 'topic_folder_listing',
    debug: debugInfo,
  };
}

module.exports = {
  DEFAULT_CATALOG_ROOT_FOLDER_ID,
  SHORTCUT_MIME,
  FOLDER_MIME,
  DRIVE_SCOPE,
  DRIVE_WRITE_SCOPE,
  getCatalogRootFolderId,
  syncCommunityDriveCatalog,
  backgroundFetchDriveCatalogAsync,
  isDriveCatalogSyncConfigured,
  logDriveConfigStatus,
  listDriveChildren,
  listDriveFilesForGradeTopic,
  walkDriveFolderTree,
  parseGradeIdFromFolderName,
  resolveDriveAccessToken,
  describeDriveAuthMode,
  hasDriveUserWriteAuth,
  getDriveOauthUserCredentials,
  getDriveDelegateEmail,
  escapeDriveQueryLiteral,
  buildDriveKeywordSearchQuery,
  buildDriveFolderIndex,
  getDriveFolderIndex,
  resolveStrictDriveScopeFolderIds,
  resolveDriveSearchScope,
  topicsStrictlyCompatible,
  nameMatchesTopicCentrally,
  searchDriveCommunityCatalog,
  formatDriveSearchHit,
  formatDriveLocationPath,
  buildDriveFileUrl,
  resolveShortcutTarget,
  extractDriveFileText,
  downloadDriveFileBuffer,
  MAX_EXTRACT_BYTES,
  MAX_MULTIMODAL_DOWNLOAD_BYTES,
  fetchDriveFileMeta,
  buildDriveRequestHeaders,
  extractTextFromPptxBuffer,
};
