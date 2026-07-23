/**
 * POST /api/community-search — community Drive probe (navigation / citations only).
 *
 * Scans the shared community Google Drive root and returns precise citations.
 * Gemini pedagogical summaries live in api/community-summarizer.js (decoupled).
 */
const cacheDb = require('./cache');
const communityDriveArchive = require('./community-drive-archive');
const driveCatalogSync = require('./drive-catalog-sync');
const catalogTopics = require('./catalog-topics');

const COMMUNITY_SUMMARY_HEADING = communityDriveArchive.COMMUNITY_SUMMARY_HEADING;
const COMMUNITY_SUMMARY_EMPTY = communityDriveArchive.COMMUNITY_SUMMARY_EMPTY;

const MODE_NAVIGATION = 'navigation';
/** @deprecated Summarization moved to /api/community-summarizer — kept for callers/tests. */
const MODE_PEDAGOGICAL = 'pedagogical';

const EMPTY_COMMUNITY_PROBE = Object.freeze({
  matches: [],
  count: 0,
  query: '',
  matchMethod: 'none',
  communityStatus: 'empty',
  communityMode: MODE_NAVIGATION,
  communityCitations: [],
  communitySummaryHeading: null,
  communitySummary: null,
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-email',
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

function resolveSearchMode(options) {
  const opts = options || {};
  const raw = String(opts.mode || opts.searchMode || opts.communityMode || '').trim().toLowerCase();
  if (raw === MODE_NAVIGATION || raw === 'direct' || raw === 'catalog' || raw === 'navigate') {
    return MODE_NAVIGATION;
  }
  if (raw === MODE_PEDAGOGICAL || raw === 'summary' || raw === 'hybrid') {
    // Pedagogical summarization is handled by /api/community-summarizer.
    // This route always returns navigation/citations only.
    return MODE_NAVIGATION;
  }
  if (opts.summarize === false || opts.includeSummary === false) return MODE_NAVIGATION;
  if (opts.summarize === true || opts.includeSummary === true) return MODE_NAVIGATION;
  return MODE_NAVIGATION;
}

function resolveWebViewLink(match) {
  if (!match || typeof match !== 'object') return '';
  return String(
    match.webViewLink
    || match.fileUrl
    || match.url
    || match.google_docs_url
    || ''
  ).trim();
}

function buildLocationPathFromMatch(match) {
  if (!match || typeof match !== 'object') return '';
  const direct = String(match.locationPath || '').trim();
  if (direct) return direct.replace(/\s*\/\s*/g, ' > ');

  const gradeLabel = String(match.gradeLabel || '').trim();
  const topic = String(
    match.catalogTopic || match.parentCatalogTopic || match.bundleTopic || match.topic || ''
  ).trim();
  if (gradeLabel && topic && topic !== '__general__') {
    return gradeLabel + ' > ' + topic;
  }

  const rawPath = String(match.drivePath || match.pathLabels || match.filePath || '').trim();
  if (!rawPath) return gradeLabel || topic || '';
  const parts = rawPath.split(/\s*\/\s*|\s*>\s*/).map(function (p) {
    return String(p || '').trim();
  }).filter(Boolean);
  const fileName = String(match.fileName || match.title || match.displayTitle || '').trim();
  if (fileName && parts.length && parts[parts.length - 1] === fileName) {
    parts.pop();
  }
  return parts.join(' > ');
}

/**
 * Precise Drive citations for catalog / navigation lists.
 */
function buildCommunityCitations(matches) {
  const shortName = typeof communityDriveArchive.shortCitationDisplayName === 'function'
    ? communityDriveArchive.shortCitationDisplayName
    : function (value, fallback) {
      return String(value || fallback || 'קובץ Drive').trim();
    };
  const seen = new Set();
  const citations = [];
  (matches || []).forEach(function (match) {
    if (!match) return;
    const fileName = shortName(
      match.fileName || match.title || match.displayTitle || match.name || '',
      'קובץ Drive'
    );
    const webViewLink = resolveWebViewLink(match);
    const driveFileId = String(match.driveFileId || '').trim()
      || (String(match.id || '').indexOf('drive:') === 0 ? String(match.id).slice(6) : '');
    const key = (driveFileId || webViewLink || fileName).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    citations.push({
      fileName: fileName || 'קובץ Drive',
      // Keep path for internal use only — UI/DOCX must not render hierarchy.
      locationPath: '',
      webViewLink: webViewLink,
      fileUrl: webViewLink,
      driveFileId: driveFileId || null,
      mimeType: String(match.mimeType || '').trim(),
      gradeId: String(match.gradeId || match.grade_level || '').trim(),
      gradeLabel: String(match.gradeLabel || '').trim(),
      catalogTopic: String(match.catalogTopic || match.topic || '').trim(),
    });
  });
  return citations;
}

function appendCitationsMarkdown(summary, citations) {
  const list = Array.isArray(citations) ? citations : [];
  if (!list.length) return String(summary || '').trim();
  const body = String(summary || '').trim();
  if (/מראי מקום/.test(body) && /https?:\/\//.test(body)) {
    return body;
  }
  const shortName = typeof communityDriveArchive.shortCitationDisplayName === 'function'
    ? communityDriveArchive.shortCitationDisplayName
    : function (value, fallback) {
      return String(value || fallback || 'קובץ Drive').trim();
    };
  const lines = list.map(function (cite, idx) {
    const name = shortName(cite.fileName || '', 'מקור ' + (idx + 1));
    if (cite.webViewLink) {
      return (idx + 1) + '. [' + name + '](' + cite.webViewLink + ')';
    }
    return (idx + 1) + '. ' + name;
  });
  return body
    + (body ? '\n\n' : '')
    + '### מראי מקום\n'
    + lines.join('\n');
}

/**
 * Drive probe for catalog navigation and optional match discovery.
 * Never runs Gemini summarization (see api/community-summarizer.js).
 */
async function runCommunitySearch(query, options) {
  const opts = options || {};
  const mode = MODE_NAVIGATION;
  const q = String(query || '').trim();
  if (!q) {
    return Object.assign({}, EMPTY_COMMUNITY_PROBE, { communityMode: mode });
  }

  const gradePolicy = typeof catalogTopics.resolveCommunityGradeScanPolicy === 'function'
    ? catalogTopics.resolveCommunityGradeScanPolicy(q, opts)
    : {
      lockedGradeId: String(opts.gradeId || opts.currentGrade || '').trim(),
      allowBroadScan: opts.globalScan === true && !String(opts.gradeId || opts.currentGrade || '').trim(),
      crossCutting: false,
    };
  const gradeId = String(gradePolicy.lockedGradeId || '').trim();
  const globalScan = Boolean(gradePolicy.allowBroadScan) && !gradeId;
  const driveConfigured = typeof driveCatalogSync.isDriveCatalogSyncConfigured === 'function'
    ? driveCatalogSync.isDriveCatalogSyncConfigured()
    : (typeof cacheDb.isDriveCatalogSyncConfigured === 'function'
      ? cacheDb.isDriveCatalogSyncConfigured()
      : false);

  try {
    const parentFolderId = String(opts.parentFolderId || opts.folderId || '').trim();
    const result = await cacheDb.probeCommunityGlobalSearch(q, {
      userMessage: q,
      topic: opts.topic || null,
      catalogTopic: opts.catalogTopic || opts.topic || null,
      gradeId: gradeId,
      currentGrade: gradeId,
      parentFolderId: parentFolderId || null,
      folderId: parentFolderId || null,
      globalScan: globalScan || opts.globalScan === true,
      broadScan: globalScan || opts.broadScan === true || Boolean(gradePolicy.crossCutting && !gradeId),
      includeFolderBrief: false,
      repositorySearch: true,
      driveSearch: opts.driveSearch !== false,
      phase: opts.phase || 'community_catalog',
      limit: opts.limit || 8,
      navigationSearch: true,
      requireCentralMatch: opts.requireCentralMatch === true,
      skipGeminiExpand: opts.skipGeminiExpand === true,
    });

    const probe = result
      ? Object.assign({}, result)
      : Object.assign({}, EMPTY_COMMUNITY_PROBE, { query: q });
    probe.communityMode = mode;
    if (probe.driveConfigured == null) probe.driveConfigured = driveConfigured;
    if (!probe.communityStatus) {
      probe.communityStatus = probe.count > 0 ? 'ok' : 'empty';
    }

    probe.communityCitations = buildCommunityCitations(probe.matches || []);
    probe.communitySummaryHeading = null;
    probe.communitySummary = null;
    probe.communitySummaryFromArchive = false;
    probe.communitySummaryDeltaUpdated = false;
    probe.communityArchiveKey = null;
    probe.communitySummaryModel = null;
    if (probe.driveDebug == null && result && result.driveDebug) {
      probe.driveDebug = result.driveDebug;
    }

    if (!probe.count) {
      if (!probe.communityStatus || probe.communityStatus === 'ok') {
        probe.communityStatus = driveConfigured ? 'empty' : 'not_configured';
      }
    }

    return probe;
  } catch (probeErr) {
    const message = probeErr && probeErr.message ? probeErr.message : String(probeErr);
    console.warn('[community-search] probe failed:', message);
    return Object.assign({}, EMPTY_COMMUNITY_PROBE, {
      query: q,
      matchMethod: 'error',
      communityMode: mode,
      communityStatus: 'unavailable',
      communityError: message,
      driveConfigured: driveConfigured,
      communitySummaryHeading: null,
      communitySummary: null,
    });
  }
}

/**
 * Legacy alias — hybrid live search no longer attaches Drive summaries.
 * Returns navigation/citations only (no Gemini).
 */
async function probeCommunityForHybridSearch(query, options) {
  return runCommunitySearch(query, Object.assign({}, options || {}, {
    mode: MODE_NAVIGATION,
    includeFolderBrief: false,
  }));
}

/** Catalog-tab Direct Drive Search (no Gemini). */
async function runNavigationCommunitySearch(query, options) {
  const opts = options || {};
  return runCommunitySearch(query, Object.assign({
    mode: MODE_NAVIGATION,
    includeFolderBrief: false,
    requireCentralMatch: true,
  }, opts));
}

function attachCommunityHybridMeta(meta, communityProbe) {
  const base = meta && typeof meta === 'object' ? Object.assign({}, meta) : {};
  const probe = communityProbe || EMPTY_COMMUNITY_PROBE;
  const rawMatches = Array.isArray(probe.matches) ? probe.matches : [];
  base.communityMatches = rawMatches.map(function (match) {
    return typeof cacheDb.withCatalogNavigationFields === 'function'
      ? cacheDb.withCatalogNavigationFields(match)
      : match;
  });
  base.communityMatchCount = base.communityMatches.length;
  base.communityCitations = Array.isArray(probe.communityCitations)
    ? probe.communityCitations
    : buildCommunityCitations(base.communityMatches);
  base.communityMode = MODE_NAVIGATION;
  if (probe.query) base.communityQuery = probe.query;
  if (probe.matchMethod) base.communityMatchMethod = probe.matchMethod;
  if (probe.folderBrief) base.communityFolderBrief = probe.folderBrief;
  if (probe.driveScoped != null) base.communityDriveScoped = Boolean(probe.driveScoped);
  if (probe.driveScope) base.communityDriveScope = probe.driveScope;
  base.communityStatus = probe.communityStatus
    || (base.communityMatchCount > 0 ? 'ok' : 'empty');
  if (probe.communityError) base.communityError = String(probe.communityError);
  if (probe.driveConfigured != null) base.communityDriveConfigured = Boolean(probe.driveConfigured);

  // Summaries are produced only by /api/community-summarizer — never by live search.
  base.communitySummaryHeading = null;
  base.communitySummary = null;
  base.hybridSearch = false;
  base.directDriveSearch = true;
  return base;
}

function buildHttpResponsePayload(probe) {
  const meta = attachCommunityHybridMeta({}, probe);
  return {
    success: true,
    query: meta.communityQuery || '',
    communityMode: meta.communityMode,
    communityStatus: meta.communityStatus,
    communitySummaryHeading: null,
    communitySummary: null,
    communityMatchCount: meta.communityMatchCount,
    communityMatches: meta.communityMatches,
    communityCitations: meta.communityCitations,
    communityMatchMethod: meta.communityMatchMethod || null,
    communityDriveConfigured: meta.communityDriveConfigured,
    communitySummaryFromArchive: false,
    communitySummaryDeltaUpdated: false,
    communityArchiveKey: null,
    communitySummaryModel: null,
    communityError: meta.communityError || null,
    communityFolderBrief: meta.communityFolderBrief || null,
    meta: meta,
  };
}

async function executeCommunitySearch(req) {
  const body = parseRequestBody(req);
  if (!body || typeof body !== 'object') {
    const err = new Error('Request body is missing');
    err.statusCode = 400;
    throw err;
  }
  const query = String(
    body.query || body.userMessage || body.topic || body.q || ''
  ).trim();
  if (!query) {
    const err = new Error('query is required');
    err.statusCode = 400;
    throw err;
  }

  const gradeId = String(body.gradeId || body.currentGrade || '').trim();
  const parentFolderId = String(body.parentFolderId || body.folderId || '').trim();
  const probe = await runCommunitySearch(query, {
    gradeId: gradeId,
    currentGrade: gradeId,
    parentFolderId: parentFolderId || null,
    folderId: parentFolderId || null,
    topic: body.catalogTopic || body.selectedTopic || body.topic || null,
    catalogTopic: body.catalogTopic || body.selectedTopic || null,
    globalScan: body.globalScan === true || (!gradeId && body.globalScan !== false),
    broadScan: body.broadScan === true,
    includeFolderBrief: false,
    phase: body.phase || 'community_catalog',
    limit: Number(body.limit) > 0 ? Number(body.limit) : 8,
    driveSearch: body.driveSearch !== false,
    mode: MODE_NAVIGATION,
  });

  return buildHttpResponsePayload(probe);
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
    const data = await executeCommunitySearch(req);
    return sendJson(res, 200, data);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[community-search]', status, err.message || err);
    return sendJson(res, status, {
      error: err.message || String(err),
      communitySummaryHeading: null,
      communitySummary: null,
      communityStatus: 'unavailable',
    });
  }
}

module.exports = {
  MODE_NAVIGATION,
  MODE_PEDAGOGICAL,
  COMMUNITY_SUMMARY_HEADING,
  COMMUNITY_SUMMARY_EMPTY,
  EMPTY_COMMUNITY_PROBE,
  resolveSearchMode,
  buildCommunityCitations,
  buildLocationPathFromMatch,
  appendCitationsMarkdown,
  runCommunitySearch,
  runNavigationCommunitySearch,
  probeCommunityForHybridSearch,
  attachCommunityHybridMeta,
  executeCommunitySearch,
  buildHttpResponsePayload,
  legacyHandler,
};
