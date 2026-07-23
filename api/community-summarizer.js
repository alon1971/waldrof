/**
 * POST /api/community-summarizer — standalone community Drive topic summary.
 *
 * Decoupled from live web search (phases A–C). Workflow:
 *  1) Scan community root Drive folder for grade + topic
 *  2) Public archive lookup (no userId filter)
 *  3) Reuse if fingerprint matches; else Gemini summarize + upsert
 *     (JSON responseMimeType + fence-strip parse live in api/community-drive-archive.js)
 *  4) Clear empty message when nothing exists in Drive or archive
 */
const communitySearch = require('./community-search');
const communityDriveArchive = require('./community-drive-archive');
const driveCatalogSync = require('./drive-catalog-sync');
const catalogTopics = require('./catalog-topics');

const COMMUNITY_SUMMARY_HEADING =
  communityDriveArchive.COMMUNITY_SUMMARY_HEADING || 'סיכום נושא מתוך המאגר הקהילתי';
const COMMUNITY_SUMMARY_EMPTY =
  communityDriveArchive.COMMUNITY_SUMMARY_EMPTY ||
  'לצערי, הנושא שביקשת אינו נמצא במאגר (ייתכן והוא נקרא בשם אחר, ולכן כדאי לבדוק בתיקיות באופן ידני).';

const SUMMARIZER_PHASE = 'community_summarizer';

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

function driveIsConfigured() {
  return typeof driveCatalogSync.isDriveCatalogSyncConfigured === 'function'
    ? driveCatalogSync.isDriveCatalogSyncConfigured()
    : false;
}

function citationsFromFileRefs(fileRefs) {
  if (typeof communitySearch.buildCommunityCitations === 'function') {
    return communitySearch.buildCommunityCitations((fileRefs || []).map(function (ref) {
      return {
        fileName: communityDriveArchive.shortCitationDisplayName
          ? communityDriveArchive.shortCitationDisplayName(ref.name || ref.fileName, 'קובץ Drive')
          : (ref.name || ref.fileName || 'קובץ Drive'),
        title: ref.name || ref.fileName || '',
        displayTitle: ref.name || ref.fileName || '',
        locationPath: '',
        webViewLink: ref.webViewLink || ref.fileUrl || '',
        fileUrl: ref.fileUrl || ref.webViewLink || '',
        driveFileId: ref.driveFileId || '',
        mimeType: ref.mimeType || '',
        gradeId: ref.gradeId || '',
        catalogTopic: ref.folder || ref.catalogTopic || '',
      };
    }));
  }
  return [];
}

/**
 * Full on-demand community topic summary (public archive + root Drive scan).
 * Instant archive hit (topic + grade) skips Drive listing and Gemini entirely
 * unless forceRefresh is set.
 */
async function runCommunityTopicSummary(options) {
  const opts = options || {};
  const topic = String(opts.topic || opts.query || opts.userMessage || '').trim();
  const gradeId = String(opts.gradeId || opts.currentGrade || '').trim();
  const forceRefresh = opts.forceRefresh === true || opts.refresh === true;

  if (!topic) {
    const err = new Error('topic is required');
    err.statusCode = 400;
    throw err;
  }
  if (!gradeId) {
    const err = new Error('gradeId is required');
    err.statusCode = 400;
    throw err;
  }

  const gradePolicy = typeof catalogTopics.resolveCommunityGradeScanPolicy === 'function'
    ? catalogTopics.resolveCommunityGradeScanPolicy(topic, {
      gradeId: gradeId,
      currentGrade: gradeId,
      topic: topic,
      catalogTopic: topic,
    })
    : { lockedGradeId: gradeId, allowBroadScan: false, crossCutting: false };
  const lockedGradeId = String(gradePolicy.lockedGradeId || gradeId).trim();
  const configured = driveIsConfigured();

  // ── Aggressive cache: return archived summary BEFORE any Drive/Gemini work ──
  if (!forceRefresh && typeof communityDriveArchive.tryInstantArchiveRetrieval === 'function') {
    try {
      const instant = await communityDriveArchive.tryInstantArchiveRetrieval(topic, {
        gradeId: lockedGradeId,
        currentGrade: lockedGradeId,
        topic: topic,
        catalogTopic: topic,
        phase: SUMMARIZER_PHASE,
      });
      if (instant && instant.summary) {
        const citations = citationsFromFileRefs(instant.fileRefs);
        let summaryText = String(instant.summary).trim();
        if (
          citations.length
          && typeof communitySearch.appendCitationsMarkdown === 'function'
          && !(/מראי מקום/.test(summaryText) && /https?:\/\//.test(summaryText))
        ) {
          summaryText = communitySearch.appendCitationsMarkdown(summaryText, citations);
        }
        if (typeof communityDriveArchive.sanitizeCommunitySummaryMarkdown === 'function') {
          summaryText = communityDriveArchive.sanitizeCommunitySummaryMarkdown(summaryText);
        }
        console.log(
          '[community-summarizer] returning INSTANT archived summary for',
          JSON.stringify(topic),
          'grade',
          lockedGradeId
        );
        return {
          success: true,
          topic: topic,
          gradeId: lockedGradeId,
          communityStatus: 'ok',
          communitySummaryHeading: instant.heading || COMMUNITY_SUMMARY_HEADING,
          communitySummary: summaryText,
          communityMatchCount: (instant.fileRefs || []).length,
          communityMatches: [],
          communityCitations: citations,
          communitySummaryFromArchive: true,
          communitySummaryDeltaUpdated: false,
          communityArchiveKey: instant.archiveKey || null,
          communitySummaryModel: instant.model || null,
          communityDriveConfigured: configured,
          communityError: null,
          fromArchive: true,
          deltaUpdated: false,
          instantArchiveHit: true,
        };
      }
    } catch (instantErr) {
      console.warn(
        '[community-summarizer] instant archive check failed — continuing to Drive:',
        instantErr && instantErr.message ? instantErr.message : instantErr
      );
    }
  }

  // Prefer a full listing of every file under the grade/topic folder tree
  // (incl. shortcut targets) so Gemini receives a multi-file merge — not a
  // single keyword-search hit.
  let matches = [];
  let probeError = null;
  let driveDebug = null;
  const listLimit = Math.max(Number(opts.limit) || 40, 24);
  if (typeof driveCatalogSync.listDriveFilesForGradeTopic === 'function') {
    try {
      const listed = await driveCatalogSync.listDriveFilesForGradeTopic(lockedGradeId, topic, {
        limit: listLimit,
        topic: topic,
        catalogTopic: topic,
      });
      matches = Array.isArray(listed.matches) ? listed.matches : [];
      if (listed.communityError) probeError = listed.communityError;
      if (listed.debug) driveDebug = listed.debug;
    } catch (listErr) {
      console.warn(
        '[community-summarizer] topic-folder listing failed — falling back to search:',
        listErr && listErr.message ? listErr.message : listErr
      );
    }
  }

  let probe = null;
  if (!matches.length) {
    probe = await communitySearch.runNavigationCommunitySearch(topic, {
      gradeId: lockedGradeId,
      currentGrade: lockedGradeId,
      topic: topic,
      catalogTopic: topic,
      phase: SUMMARIZER_PHASE,
      globalScan: false,
      broadScan: false,
      includeFolderBrief: false,
      limit: listLimit,
      driveSearch: true,
      requireCentralMatch: false,
    });
    matches = Array.isArray(probe.matches) ? probe.matches : [];
    if (probe.communityError) probeError = probe.communityError;
    if (probe.driveDebug) driveDebug = probe.driveDebug;
    else if (probe.debug) driveDebug = probe.debug;
  }

  console.log(
    '[community-summarizer] files selected for summary:',
    matches.length,
    matches.map(function (m) {
      return m.fileName || m.title || m.driveFileId;
    }).join(' | ')
  );

  const citations = Array.isArray(probe && probe.communityCitations)
    ? probe.communityCitations
    : communitySearch.buildCommunityCitations(matches);

  if (!matches.length) {
    const gradeTopics = driveDebug && Array.isArray(driveDebug.gradeTopicFolders)
      ? driveDebug.gradeTopicFolders
      : [];
    const failureReasons = driveDebug && Array.isArray(driveDebug.topicFilterFailureReasons)
      ? driveDebug.topicFilterFailureReasons
      : [];
    console.log('[community-summarizer] empty archive result', {
      topic: topic,
      gradeId: lockedGradeId,
      driveConfigured: configured,
      scannedFolderCount: driveDebug && driveDebug.scannedFolderCount != null
        ? driveDebug.scannedFolderCount
        : null,
      rawHitCount: driveDebug && driveDebug.rawHitCount != null ? driveDebug.rawHitCount : null,
      searchTerms: driveDebug && driveDebug.searchTerms ? driveDebug.searchTerms : null,
      gradeTopicFolders: gradeTopics,
      topicRelaxed: driveDebug && driveDebug.topicRelaxed,
      ungradedPassRan: driveDebug && driveDebug.ungradedPassRan,
      topicFilterFailureReasons: failureReasons,
      rejectedSample: driveDebug && Array.isArray(driveDebug.rejected)
        ? driveDebug.rejected.slice(0, 8)
        : [],
      communityError: probeError || null,
    });
    if (gradeTopics.length) {
      console.log(
        '[community-summarizer] folders under grade',
        lockedGradeId + ':',
        gradeTopics.join(' | ')
      );
    } else {
      console.log(
        '[community-summarizer] no topic folders indexed for grade',
        lockedGradeId
      );
    }
    console.log(
      '[community-summarizer] why filter failed for topic',
      JSON.stringify(topic) + ':',
      failureReasons.length
        ? failureReasons.join(' ; ')
        : 'no Drive files matched topic aliases under this grade (and root fallback found none)'
    );

    return {
      success: true,
      topic: topic,
      gradeId: lockedGradeId,
      communityStatus: configured ? 'empty' : 'not_configured',
      communitySummaryHeading: COMMUNITY_SUMMARY_HEADING,
      communitySummary: COMMUNITY_SUMMARY_EMPTY,
      communityMatchCount: 0,
      communityMatches: [],
      communityCitations: [],
      communitySummaryFromArchive: false,
      communitySummaryDeltaUpdated: false,
      communityArchiveKey: communityDriveArchive.buildArchiveKey(topic, {
        gradeId: lockedGradeId,
        topic: topic,
        phase: SUMMARIZER_PHASE,
      }),
      communitySummaryModel: null,
      communityDriveConfigured: configured,
      communityError: probeError || null,
      fromArchive: false,
      deltaUpdated: false,
      driveDebug: driveDebug,
    };
  }

  const summary = await communityDriveArchive.resolveCommunityDriveSummary(
    topic,
    matches,
    {
      gradeId: lockedGradeId,
      currentGrade: lockedGradeId,
      topic: topic,
      catalogTopic: topic,
      phase: SUMMARIZER_PHASE,
      citations: citations,
      forceRefresh: forceRefresh,
    }
  );

  let summaryText = summary.summary != null && String(summary.summary).trim()
    ? String(summary.summary)
    : COMMUNITY_SUMMARY_EMPTY;
  if (
    (summary.communityStatus === 'ok' || summary.communityStatus === 'degraded')
    && citations.length
    && typeof communitySearch.appendCitationsMarkdown === 'function'
  ) {
    summaryText = communitySearch.appendCitationsMarkdown(summaryText, citations);
  }
  if (typeof communityDriveArchive.sanitizeCommunitySummaryMarkdown === 'function') {
    summaryText = communityDriveArchive.sanitizeCommunitySummaryMarkdown(summaryText);
  }

  const status = summary.communityStatus === 'ok' || summary.communityStatus === 'degraded'
    ? summary.communityStatus
    : (summary.communityStatus || (configured ? 'empty' : 'not_configured'));

  return {
    success: true,
    topic: topic,
    gradeId: lockedGradeId,
    communityStatus: status,
    communitySummaryHeading: summary.heading || COMMUNITY_SUMMARY_HEADING,
    communitySummary: summaryText,
    communityMatchCount: matches.length,
    communityMatches: matches,
    communityCitations: citations,
    communitySummaryFromArchive: Boolean(summary.fromArchive),
    communitySummaryDeltaUpdated: Boolean(summary.deltaUpdated),
    communityArchiveKey: summary.archiveKey || null,
    communitySummaryModel: summary.model || null,
    communityDriveConfigured: configured,
    communityError: summary.communityError || probeError || null,
    fromArchive: Boolean(summary.fromArchive),
    deltaUpdated: Boolean(summary.deltaUpdated),
    instantArchiveHit: false,
  };
}

async function executeCommunitySummarizer(req) {
  const body = parseRequestBody(req);
  if (!body || typeof body !== 'object') {
    const err = new Error('Request body is missing');
    err.statusCode = 400;
    throw err;
  }
  return runCommunityTopicSummary({
    topic: body.topic || body.query || body.userMessage || body.q,
    gradeId: body.gradeId || body.currentGrade,
    currentGrade: body.currentGrade || body.gradeId,
    limit: body.limit,
    forceRefresh: body.forceRefresh === true || body.refresh === true,
  });
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
    const data = await executeCommunitySummarizer(req);
    return sendJson(res, 200, data);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[community-summarizer]', status, err.message || err);
    if (err && /JSON/i.test(String(err.message || ''))) {
      console.error('[community-summarizer] JSON parse/generation failure detail:', err.stack || err);
    }
    return sendJson(res, status, {
      error: err.message || String(err),
      success: false,
      communitySummaryHeading: COMMUNITY_SUMMARY_HEADING,
      communitySummary: COMMUNITY_SUMMARY_EMPTY,
      communityStatus: 'unavailable',
    });
  }
}

module.exports = {
  SUMMARIZER_PHASE,
  COMMUNITY_SUMMARY_HEADING,
  COMMUNITY_SUMMARY_EMPTY,
  runCommunityTopicSummary,
  executeCommunitySummarizer,
  legacyHandler,
};
