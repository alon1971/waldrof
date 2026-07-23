/**
 * POST /api/community-summarizer — standalone community Drive topic summary.
 *
 * Decoupled from live web search (phases A–C). Workflow (strict order):
 *  1) Query community_drive_archive ONLY (exact + semantic; never cached_results)
 *  2) Partial / close match → "האם התכוונת ל-…?" (needs confirmation)
 *  3) If usable cache row:
 *       → recent row OR focused files.get(ids) OR strict topic folder only
 *       → never topic-relaxed grade-wide (~69 folder) scan for validation OR regenerate
 *       → Cache Hit skips extract + Gemini
 *  4) Else (no archive): full Drive listing → extract → Gemini → upsert
 *  5) Gemini system prompt: Waldorf expert; exclusive reliance on attached archive sources only
 *
 * HARD BAN: never call Perplexity / Sonar / /api/generate / live web research.
 * CACHE SOURCE ISOLATION: never consults cached_results / Perplexity.
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
const COMMUNITY_SUMMARY_PROCESSING =
  'מפיק סיכום חדש מתוך מאגר הדרייב... תהליך זה קורה ברקע ויטען מיד.';
const POLL_HINT_MS = 3500;

const SUMMARIZER_PHASE = 'community_summarizer';

/** In-flight Gemini create jobs keyed by archive_key (prevents duplicate work). */
const inflightSummaryJobs = new Map();

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
 * Strip any live-research / Perplexity flags a client might accidentally send.
 * Community summarizer is Gemini + Drive/archive only.
 */
function stripLiveResearchFlags(input) {
  const body = input && typeof input === 'object' ? Object.assign({}, input) : {};
  delete body.liveSearch;
  delete body.usePerplexity;
  delete body.perplexity;
  delete body.sonar;
  delete body.webResearch;
  delete body.externalResearch;
  delete body.bypassCacheToLive;
  delete body.forceLiveSearch;
  // Never let a generate.js phase leak into this route.
  if (
    body.phase
    && String(body.phase) !== SUMMARIZER_PHASE
    && String(body.phase) !== 'community_catalog'
  ) {
    console.warn(
      '[community-summarizer] ignoring non-community phase flag:',
      JSON.stringify(body.phase)
    );
  }
  body.phase = SUMMARIZER_PHASE;
  body.usePerplexity = false;
  body.liveSearch = false;
  body.skipLiveSearchBilling = true;
  body.freeCommunitySummary = true;
  return body;
}

/**
 * Community Drive summaries run on Gemini only — never bill live-search credits.
 * Clients that share invokePureApi with phase-c/general-search look at meta.
 */
function withNonBillableMeta(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  body.freeCommunitySummary = true;
  body.skipLiveSearchBilling = true;
  body.usedPerplexity = false;
  body.usedLiveResearch = false;
  body.pipeline = 'community-drive-archive+gemini';
  body.meta = Object.assign({}, body.meta || {}, {
    phase: SUMMARIZER_PHASE,
    searchBilled: false,
    billable: false,
    free: true,
    freeCommunitySummary: true,
    skipLiveSearchBilling: true,
    usedPerplexity: false,
    usedLiveResearch: false,
    pipeline: 'community-drive-archive+gemini',
    fromCache: Boolean(body.fromArchive || body.instantArchiveHit || body.communitySummaryFromArchive || body.smartCacheHit),
    smartCacheHit: Boolean(body.smartCacheHit),
    didYouMean: Boolean(body.didYouMean || body.needsConfirmation),
  });
  return body;
}

function finalizeSummaryPayload(base, summary, citations, extras) {
  const extra = extras || {};
  let summaryText = summary.summary != null && String(summary.summary).trim()
    ? String(summary.summary)
    : COMMUNITY_SUMMARY_EMPTY;
  const citeList = Array.isArray(citations) ? citations : [];
  if (
    (summary.communityStatus === 'ok' || summary.communityStatus === 'degraded')
    && citeList.length
    && typeof communitySearch.appendCitationsMarkdown === 'function'
    && !(/מראי מקום/.test(summaryText) && /https?:\/\//.test(summaryText))
  ) {
    summaryText = communitySearch.appendCitationsMarkdown(summaryText, citeList);
  }
  if (typeof communityDriveArchive.sanitizeCommunitySummaryMarkdown === 'function') {
    summaryText = communityDriveArchive.sanitizeCommunitySummaryMarkdown(summaryText);
  }

  const status = summary.communityStatus === 'ok'
    || summary.communityStatus === 'degraded'
    || summary.communityStatus === 'needs_confirmation'
    || summary.communityStatus === 'processing'
    || summary.communityStatus === 'summarizing'
    ? summary.communityStatus
    : (summary.communityStatus || (extra.configured ? 'empty' : 'not_configured'));

  return withNonBillableMeta(Object.assign({}, base, {
    success: true,
    communityStatus: status,
    communitySummaryHeading: summary.heading || COMMUNITY_SUMMARY_HEADING,
    communitySummary: summaryText,
    communityMatchCount: extra.matchCount != null ? extra.matchCount : (extra.matches || []).length,
    communityMatches: extra.matches || [],
    communityCitations: citeList,
    communitySummaryFromArchive: Boolean(summary.fromArchive),
    communitySummaryDeltaUpdated: Boolean(summary.deltaUpdated),
    communityArchiveKey: summary.archiveKey || null,
    communitySummaryModel: summary.model || null,
    communityDriveConfigured: Boolean(extra.configured),
    communityError: summary.communityError || extra.probeError || null,
    fromArchive: Boolean(summary.fromArchive),
    deltaUpdated: Boolean(summary.deltaUpdated),
    instantArchiveHit: Boolean(summary.instantHit),
    smartCacheHit: Boolean(summary.smartCacheHit),
    didYouMean: Boolean(summary.didYouMean || summary.needsConfirmation),
    needsConfirmation: Boolean(summary.needsConfirmation || summary.didYouMean),
    suggestedTopic: summary.suggestedTopic || null,
    requestedTopic: summary.requestedTopic || base.topic || null,
    similarity: summary.similarity != null ? summary.similarity : null,
    matchType: summary.matchType || null,
    processing: status === 'processing' || status === 'summarizing',
    poll: Boolean(extra.poll) || status === 'processing' || status === 'summarizing',
    pollAfterMs: (status === 'processing' || status === 'summarizing')
      ? (extra.pollAfterMs != null ? Number(extra.pollAfterMs) : POLL_HINT_MS)
      : null,
    driveDebug: extra.driveDebug || null,
  }));
}

async function listMatchesForTopic(lockedGradeId, topic, opts) {
  let matches = [];
  let probeError = null;
  let driveDebug = null;
  const listLimit = Math.max(Number(opts.limit) || 40, 24);
  const cacheValidation = opts.cacheValidation === true || opts.strictTopicOnly === true;
  const allowFallbackSearch = opts.allowFallbackSearch !== false && !cacheValidation;

  if (typeof driveCatalogSync.listDriveFilesForGradeTopic === 'function') {
    try {
      const listed = await driveCatalogSync.listDriveFilesForGradeTopic(lockedGradeId, topic, {
        limit: listLimit,
        topic: topic,
        catalogTopic: topic,
        allowTopicRelaxation: !cacheValidation,
        strictTopicOnly: cacheValidation,
        skipUngradedPass: cacheValidation,
        cacheValidation: cacheValidation,
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
  if (!matches.length && allowFallbackSearch) {
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

  const citations = Array.isArray(probe && probe.communityCitations)
    ? probe.communityCitations
    : communitySearch.buildCommunityCitations(matches);

  return {
    matches: matches,
    citations: citations,
    probeError: probeError,
    driveDebug: driveDebug,
  };
}

/**
 * Full on-demand community topic summary (public archive + root Drive scan).
 * Smart cache + semantic normalization + optional "did you mean" confirmation.
 */
async function runCommunityTopicSummary(options) {
  const opts = options || {};
  const requestedTopic = String(opts.topic || opts.query || opts.userMessage || '').trim();
  const confirmed = opts.confirmedTopic === true
    || opts.confirmSuggestion === true
    || opts.skipDidYouMean === true;
  const confirmedSuggested = String(opts.suggestedTopic || opts.confirmSuggestedTopic || '').trim();
  const topic = (confirmed && confirmedSuggested) ? confirmedSuggested : requestedTopic;
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

  const base = {
    topic: topic,
    requestedTopic: requestedTopic,
    gradeId: lockedGradeId,
  };

  // ── 1) community_drive_archive only (never cached_results) ──
  let archiveMatch = null;
  if (!forceRefresh && typeof communityDriveArchive.findCommunityArchiveMatch === 'function') {
    try {
      console.log(
        '[community-summarizer] step 1 — query community_drive_archive',
        '| topic:',
        JSON.stringify(topic),
        '| grade:',
        lockedGradeId
      );
      archiveMatch = await communityDriveArchive.findCommunityArchiveMatch(topic, {
        gradeId: lockedGradeId,
        currentGrade: lockedGradeId,
        topic: topic,
        catalogTopic: topic,
        phase: SUMMARIZER_PHASE,
      });
      if (archiveMatch && archiveMatch.row) {
        console.log(
          '[community-summarizer] cache row found',
          '| matchType:',
          archiveMatch.matchType,
          '| key:',
          String(archiveMatch.archiveKey || archiveMatch.row.archive_key || '').slice(0, 12)
        );
      } else {
        console.log('[community-summarizer] no usable cache row for topic/grade');
      }
    } catch (archiveErr) {
      console.warn(
        '[community-summarizer] archive match failed — continuing to Drive:',
        archiveErr && archiveErr.message ? archiveErr.message : archiveErr
      );
    }
  }

  // Processing stubs are not "usable" cache hits — detect them by archive_key so we can
  // return poll hints / restart create without a full Drive re-scan.
  if (!archiveMatch && !forceRefresh && typeof communityDriveArchive.fetchArchiveRow === 'function') {
    try {
      const pendingKey = communityDriveArchive.buildArchiveKey(topic, {
        gradeId: lockedGradeId,
        topic: topic,
        phase: SUMMARIZER_PHASE,
      });
      const pendingRow = await communityDriveArchive.fetchArchiveRow(pendingKey);
      const pendingStatus = pendingRow ? String(pendingRow.community_status || '') : '';
      if (pendingRow && (pendingStatus === 'processing' || pendingStatus === 'summarizing')) {
        console.log(
          '[community-summarizer] processing stub found by archive_key',
          '| status:',
          pendingStatus,
          '| archive_key:',
          pendingKey.slice(0, 16)
        );
        archiveMatch = {
          matchType: 'exact',
          similarity: 1,
          row: pendingRow,
          archiveKey: pendingKey,
          suggestedTopic: String(pendingRow.topic || topic).trim(),
          requestedTopic: topic,
          gradeId: lockedGradeId,
        };
      }
    } catch (pendingErr) {
      console.warn(
        '[community-summarizer] processing stub lookup failed:',
        pendingErr && pendingErr.message ? pendingErr.message : pendingErr
      );
    }
  }

  // Partial / close archive match → ask before full summarize (unless user already confirmed).
  if (
    archiveMatch
    && archiveMatch.matchType === 'partial'
    && !confirmed
    && typeof communityDriveArchive.buildDidYouMeanResult === 'function'
  ) {
    console.log(
      '[community-summarizer] DID YOU MEAN (archive partial):',
      JSON.stringify(requestedTopic),
      '→',
      JSON.stringify(archiveMatch.suggestedTopic)
    );
    return finalizeSummaryPayload(
      base,
      communityDriveArchive.buildDidYouMeanResult(requestedTopic, {
        gradeId: lockedGradeId,
      }, archiveMatch),
      [],
      { configured: configured, matches: [], matchCount: 0 }
    );
  }

  // Semantic archive equivalence: summarize under the archived canonical topic label.
  const effectiveTopic = (
    archiveMatch
    && (archiveMatch.matchType === 'exact' || archiveMatch.matchType === 'semantic')
    && archiveMatch.suggestedTopic
  ) ? String(archiveMatch.suggestedTopic).trim() : topic;

  if (effectiveTopic !== topic) {
    console.log(
      '[community-summarizer] semantic topic normalize:',
      JSON.stringify(topic),
      '→',
      JSON.stringify(effectiveTopic)
    );
  }

  // Already creating in background — return processing immediately (no Drive re-scan).
  let reuseProcessingStubCorpus = false;
  if (
    archiveMatch
    && archiveMatch.row
    && String(archiveMatch.row.community_status || '') === 'processing'
    && !forceRefresh
  ) {
    const processingKey = String(
      archiveMatch.archiveKey || archiveMatch.row.archive_key || ''
    ).trim();
    if (processingKey && inflightSummaryJobs.has(processingKey)) {
      console.log(
        '[community-summarizer] processing stub + inflight job — return poll hint',
        '| archive_key:',
        processingKey.slice(0, 16)
      );
      return finalizeSummaryPayload(base, {
        heading: COMMUNITY_SUMMARY_HEADING,
        summary: COMMUNITY_SUMMARY_PROCESSING,
        communityStatus: 'processing',
        fromArchive: false,
        deltaUpdated: false,
        archiveKey: processingKey,
        fileRefs: Array.isArray(archiveMatch.row.file_refs) ? archiveMatch.row.file_refs : [],
        model: null,
      }, [], {
        configured: configured,
        matches: [],
        matchCount: Array.isArray(archiveMatch.row.file_refs)
          ? archiveMatch.row.file_refs.length
          : 0,
        poll: true,
        pollAfterMs: POLL_HINT_MS,
      });
    }
    console.log(
      '[community-summarizer] orphaned processing stub (no inflight) — will restart create',
      '| archive_key:',
      processingKey.slice(0, 16)
    );
    if (Array.isArray(archiveMatch.row.file_refs) && archiveMatch.row.file_refs.length) {
      reuseProcessingStubCorpus = true;
    }
  }

  // ── 2) Fast cache validation (no grade-wide ~69-folder scan) ──
  let matches = [];
  let citations = [];
  let probeError = null;
  let driveDebug = null;

  const usableArchive = Boolean(
    archiveMatch
    && archiveMatch.row
    && String(archiveMatch.row.community_status || '') === 'ok'
    && (archiveMatch.matchType === 'exact' || archiveMatch.matchType === 'semantic')
    && !forceRefresh
  );

  function returnArchiveHit(hit, hitMatches, hitCitations, hitDebug, reason) {
    console.log(
      '[community-summarizer] CACHE HIT —',
      reason,
      '| skip extract + Gemini'
    );
    const cites = (hitCitations && hitCitations.length)
      ? hitCitations
      : citationsFromFileRefs(hit.fileRefs);
    return finalizeSummaryPayload(base, hit, cites, {
      configured: configured,
      matches: hitMatches || [],
      matchCount: (hitMatches && hitMatches.length)
        || (hit.fileRefs || []).length,
      probeError: probeError,
      driveDebug: hitDebug || driveDebug,
    });
  }

  if (usableArchive) {
    // 2a) Recent cache → instant hit, zero Drive I/O
    if (
      typeof communityDriveArchive.isRecentArchiveRow === 'function'
      && communityDriveArchive.isRecentArchiveRow(archiveMatch.row)
      && typeof communityDriveArchive.evaluateSmartCacheAgainstDrive === 'function'
    ) {
      const ageMs = Date.now() - Date.parse(
        archiveMatch.row.created_at || archiveMatch.row.updated_at || ''
      );
      console.log(
        '[community-summarizer] step 2a — recent cache instant HIT',
        '| created_at:',
        archiveMatch.row.created_at || archiveMatch.row.updated_at,
        '| ageMs:',
        Number.isFinite(ageMs) ? ageMs : null,
        '| skip Drive folder scan'
      );
      const instant = communityDriveArchive.evaluateSmartCacheAgainstDrive(
        archiveMatch.row,
        [],
        {
          topic: effectiveTopic,
          matchedTopic: archiveMatch.suggestedTopic,
          matchType: archiveMatch.matchType,
        }
      );
      if (instant) {
        return returnArchiveHit(
          instant,
          [],
          citationsFromFileRefs(instant.fileRefs),
          { instantRecentCache: true },
          'recent archive row (no Drive scan)'
        );
      }
    }

    // 2b) Focused probe: files.get(modifiedTime) for cached file ids only
    const cachedRefs = Array.isArray(archiveMatch.row.file_refs)
      ? archiveMatch.row.file_refs
      : [];
    const cachedIds = Array.isArray(archiveMatch.row.source_file_ids)
      ? archiveMatch.row.source_file_ids
      : [];
    const probeInput = cachedRefs.length ? cachedRefs : cachedIds;

    if (
      probeInput.length
      && typeof driveCatalogSync.probeDriveCachedFileMetadata === 'function'
      && typeof communityDriveArchive.evaluateSmartCacheAgainstDrive === 'function'
    ) {
      console.log(
        '[community-summarizer] step 2b — focused Drive probe of',
        probeInput.length,
        'cached file id(s) (no topic-relaxed grade scan)'
      );
      try {
        const probed = await driveCatalogSync.probeDriveCachedFileMetadata(probeInput, {
          gradeId: lockedGradeId,
          currentGrade: lockedGradeId,
        });
        matches = Array.isArray(probed.matches) ? probed.matches : [];
        driveDebug = {
          matchMethod: probed.matchMethod || 'cached_file_ids_probe',
          probedIds: probed.probedIds || probeInput.length,
          scannedFolderCount: 0,
          topicRelaxed: false,
        };

        const probeRefs = communityDriveArchive.normalizeFileRefsFromMatches
          ? communityDriveArchive.normalizeFileRefsFromMatches(matches)
          : matches;
        const probeFingerprint = communityDriveArchive.buildSourceFingerprint
          ? communityDriveArchive.buildSourceFingerprint(probeRefs)
          : '';
        const cachedFp = String(
          archiveMatch.row.drive_fingerprint
          || archiveMatch.row.source_fingerprint
          || ''
        );
        if (probeFingerprint && cachedFp && probeFingerprint === cachedFp) {
          console.log(
            '[community-summarizer] step 2b — drive/source fingerprint match',
            '| fingerprint:',
            probeFingerprint.slice(0, 12)
          );
          const fpHit = communityDriveArchive.evaluateSmartCacheAgainstDrive(
            archiveMatch.row,
            matches,
            {
              topic: effectiveTopic,
              matchedTopic: archiveMatch.suggestedTopic,
              matchType: archiveMatch.matchType,
            }
          );
          if (fpHit) {
            return returnArchiveHit(
              fpHit,
              matches,
              citationsFromFileRefs(fpHit.fileRefs),
              driveDebug,
              'fingerprint unchanged (focused probe)'
            );
          }
        }

        const focusedHit = communityDriveArchive.evaluateSmartCacheAgainstDrive(
          archiveMatch.row,
          matches,
          {
            topic: effectiveTopic,
            matchedTopic: archiveMatch.suggestedTopic,
            matchType: archiveMatch.matchType,
          }
        );
        if (focusedHit) {
          return returnArchiveHit(
            focusedHit,
            matches,
            citationsFromFileRefs(focusedHit.fileRefs),
            driveDebug,
            'focused file-id probe unchanged'
          );
        }
        console.log(
          '[community-summarizer] step 2b — focused probe found meaningful Drive delta'
        );
      } catch (probeErr) {
        console.warn(
          '[community-summarizer] focused cache probe failed — trying strict topic listing:',
          probeErr && probeErr.message ? probeErr.message : probeErr
        );
      }
    }

    // 2c) Strict topic-folder listing only (never relax to whole grade)
    console.log(
      '[community-summarizer] step 2c — strict topic-folder listing only',
      '| topic:',
      JSON.stringify(effectiveTopic),
      '| no topic-relaxed grade scan'
    );
    const strictListed = await listMatchesForTopic(lockedGradeId, effectiveTopic, Object.assign({}, opts, {
      cacheValidation: true,
      strictTopicOnly: true,
      allowFallbackSearch: false,
    }));
    matches = strictListed.matches;
    citations = strictListed.citations;
    probeError = strictListed.probeError;
    driveDebug = Object.assign({}, strictListed.driveDebug || {}, {
      strictTopicOnly: true,
      topicRelaxed: false,
    });

    console.log(
      '[community-summarizer] strict topic metadata ready:',
      matches.length,
      'file(s)',
      '| scannedFolders:',
      driveDebug && driveDebug.scannedFolderCount != null ? driveDebug.scannedFolderCount : '?',
      matches.map(function (m) {
        return (m.fileName || m.title || m.driveFileId)
          + (m.modifiedTime ? (' @' + String(m.modifiedTime).slice(0, 19)) : '');
      }).join(' | ')
    );

    if (typeof communityDriveArchive.evaluateSmartCacheAgainstDrive === 'function') {
      const strictHit = communityDriveArchive.evaluateSmartCacheAgainstDrive(
        archiveMatch.row,
        matches,
        {
          topic: effectiveTopic,
          matchedTopic: archiveMatch.suggestedTopic,
          matchType: archiveMatch.matchType,
        }
      );
      if (strictHit) {
        return returnArchiveHit(
          strictHit,
          matches,
          citations.length ? citations : citationsFromFileRefs(strictHit.fileRefs),
          driveDebug,
          'strict topic listing unchanged'
        );
      }
    }

    console.log(
      '[community-summarizer] cache stale after focused/strict checks — regenerating from strict/focused matches only (no grade-wide relax)'
    );
    // Keep matches from 2b/2c. Never fall through to topic-relaxed ~69-folder scan
    // when an archive row already matched — that scan was the latency bug.
    if (!matches.length && Array.isArray(archiveMatch.row.file_refs) && archiveMatch.row.file_refs.length) {
      matches = (archiveMatch.row.file_refs || []).map(function (ref) {
        return {
          driveFileId: ref.driveFileId || ref.id,
          fileName: ref.name || ref.fileName,
          title: ref.name || ref.fileName,
          mimeType: ref.mimeType || '',
          modifiedTime: ref.modifiedTime || '',
          webViewLink: ref.webViewLink || ref.fileUrl || '',
          fileUrl: ref.fileUrl || ref.webViewLink || '',
          resourceKey: ref.resourceKey || '',
          catalogTopic: ref.folder || ref.catalogTopic || effectiveTopic,
          topic: ref.folder || ref.catalogTopic || effectiveTopic,
          gradeId: lockedGradeId,
          matchType: 'archive_file_refs',
        };
      }).filter(function (m) { return m.driveFileId; });
      driveDebug = Object.assign({}, driveDebug || {}, {
        matchMethod: 'archive_file_refs_fallback',
        topicRelaxed: false,
        scannedFolderCount: 0,
      });
      console.log(
        '[community-summarizer] regenerate corpus from archived file_refs:',
        matches.length
      );
    }
  } else if (reuseProcessingStubCorpus) {
    // Orphaned processing stub — reuse stored file_refs (skip cold Drive listing).
    const stubRefs = archiveMatch.row.file_refs;
    matches = stubRefs.map(function (ref) {
      return {
        driveFileId: ref.driveFileId || ref.id || '',
        fileName: ref.name || ref.fileName || ref.title || '',
        title: ref.name || ref.fileName || ref.title || '',
        mimeType: ref.mimeType || '',
        webViewLink: ref.webViewLink || ref.url || '',
        modifiedTime: ref.modifiedTime || '',
        folderPath: ref.folderPath || '',
      };
    }).filter(function (m) { return m.driveFileId; });
    citations = citationsFromFileRefs(stubRefs);
    driveDebug = {
      matchMethod: 'processing_stub_file_refs',
      topicRelaxed: false,
      scannedFolderCount: 0,
    };
    console.log(
      '[community-summarizer] Drive query skipped — reusing processing stub file_refs:',
      matches.length
    );
  } else {
    // ── Cold start / no usable archive: full Drive listing (may relax) ──
    console.log(
      '[community-summarizer] Drive query started — full Drive metadata listing (no archive match)',
      '| topic:',
      JSON.stringify(effectiveTopic)
    );
    const listed = await listMatchesForTopic(lockedGradeId, effectiveTopic, opts);
    matches = listed.matches;
    citations = listed.citations;
    probeError = listed.probeError || probeError;
    driveDebug = listed.driveDebug || driveDebug;

    console.log(
      '[community-summarizer] Drive query finished / files ready:',
      matches.length,
      'file(s)',
      matches.map(function (m) {
        return (m.fileName || m.title || m.driveFileId)
          + (m.modifiedTime ? (' @' + String(m.modifiedTime).slice(0, 19)) : '');
      }).join(' | ')
    );
  }

  // No Drive hits: try folder-name "did you mean", else empty / orphan archive reuse.
  if (!matches.length) {
    const gradeTopics = driveDebug && Array.isArray(driveDebug.gradeTopicFolders)
      ? driveDebug.gradeTopicFolders
      : [];
    if (
      !confirmed
      && typeof communityDriveArchive.suggestDriveFolderTopic === 'function'
    ) {
      const folderSuggest = communityDriveArchive.suggestDriveFolderTopic(topic, gradeTopics);
      if (
        folderSuggest
        && folderSuggest.matchType === 'partial'
        && folderSuggest.suggestedTopic
        && typeof communityDriveArchive.buildDidYouMeanResult === 'function'
      ) {
        console.log(
          '[community-summarizer] DID YOU MEAN (Drive folder):',
          JSON.stringify(topic),
          '→',
          JSON.stringify(folderSuggest.suggestedTopic)
        );
        return finalizeSummaryPayload(
          base,
          communityDriveArchive.buildDidYouMeanResult(requestedTopic, {
            gradeId: lockedGradeId,
          }, folderSuggest),
          [],
          { configured: configured, matches: [], matchCount: 0, driveDebug: driveDebug }
        );
      }
      // Semantic folder equivalence — retry listing under canonical folder name.
      if (
        folderSuggest
        && folderSuggest.matchType === 'semantic'
        && folderSuggest.suggestedTopic
        && folderSuggest.suggestedTopic !== effectiveTopic
      ) {
        const retry = await listMatchesForTopic(lockedGradeId, folderSuggest.suggestedTopic, opts);
        if (retry.matches.length) {
          matches = retry.matches;
          citations = retry.citations;
          probeError = retry.probeError || probeError;
          driveDebug = retry.driveDebug || driveDebug;
        }
      }
    }

    if (!matches.length) {
      // Archive exists but Drive currently empty: still allow smart reuse of archive row.
      if (
        archiveMatch
        && archiveMatch.row
        && (archiveMatch.matchType === 'exact' || archiveMatch.matchType === 'semantic')
        && !forceRefresh
        && typeof communityDriveArchive.evaluateSmartCacheAgainstDrive === 'function'
      ) {
        const orphanHit = communityDriveArchive.evaluateSmartCacheAgainstDrive(
          archiveMatch.row,
          [],
          {
            topic: effectiveTopic,
            matchedTopic: archiveMatch.suggestedTopic,
            matchType: archiveMatch.matchType,
          }
        );
        if (orphanHit) {
          console.log(
            '[community-summarizer] CACHE HIT (orphan Drive empty) — returning archived summary'
          );
          const orphanCitations = citationsFromFileRefs(orphanHit.fileRefs);
          return finalizeSummaryPayload(base, orphanHit, orphanCitations, {
            configured: configured,
            matches: [],
            matchCount: (orphanHit.fileRefs || []).length,
            probeError: probeError,
            driveDebug: driveDebug,
          });
        }
      }

      const failureReasons = driveDebug && Array.isArray(driveDebug.topicFilterFailureReasons)
        ? driveDebug.topicFilterFailureReasons
        : [];
      console.log('[community-summarizer] empty archive result', {
        topic: topic,
        effectiveTopic: effectiveTopic,
        gradeId: lockedGradeId,
        driveConfigured: configured,
        gradeTopicFolders: gradeTopics,
        topicFilterFailureReasons: failureReasons,
        communityError: probeError || null,
      });

      return withNonBillableMeta({
        success: true,
        topic: topic,
        requestedTopic: requestedTopic,
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
      });
    }
  }

  // ── 4) Cache miss / no archive → background Gemini create + upsert ──
  console.log(
    '[community-summarizer] CACHE MISS create pipeline started',
    '| Drive query / files ready:',
    matches.length,
    '| topic:',
    JSON.stringify(effectiveTopic),
    '| grade:',
    lockedGradeId
  );

  const archiveKey = communityDriveArchive.buildArchiveKey(effectiveTopic, {
    gradeId: lockedGradeId,
    topic: effectiveTopic,
    phase: SUMMARIZER_PHASE,
  });
  const fileRefs = communityDriveArchive.normalizeFileRefsFromMatches
    ? communityDriveArchive.normalizeFileRefsFromMatches(matches)
    : matches;
  const fingerprint = communityDriveArchive.buildSourceFingerprint
    ? communityDriveArchive.buildSourceFingerprint(fileRefs)
    : '';

  try {
    console.log('[community-summarizer] Upserting to Supabase (processing stub)');
    await communityDriveArchive.upsertProcessingStub(effectiveTopic, {
      gradeId: lockedGradeId,
      currentGrade: lockedGradeId,
      topic: effectiveTopic,
      catalogTopic: effectiveTopic,
      phase: SUMMARIZER_PHASE,
      archiveKey: archiveKey,
      sourceFingerprint: fingerprint,
    }, fileRefs);
  } catch (stubErr) {
    console.error(
      '[community-summarizer] processing stub upsert failed — continuing background job anyway:',
      stubErr && stubErr.message ? stubErr.message : stubErr
    );
  }

  function startCreateJob() {
    if (inflightSummaryJobs.has(archiveKey)) {
      console.log(
        '[community-summarizer] background create already in flight',
        '| archive_key:',
        archiveKey.slice(0, 16)
      );
      return inflightSummaryJobs.get(archiveKey);
    }
    console.log(
      '[community-summarizer] Scheduling background create job',
      '| archive_key:',
      archiveKey.slice(0, 16),
      '| files:',
      matches.length
    );
    const job = Promise.resolve()
      .then(function () {
        console.log('[community-summarizer] Sending to Gemini (background job)');
        return communityDriveArchive.resolveCommunityDriveSummary(
          effectiveTopic,
          matches,
          {
            gradeId: lockedGradeId,
            currentGrade: lockedGradeId,
            topic: effectiveTopic,
            catalogTopic: effectiveTopic,
            phase: SUMMARIZER_PHASE,
            citations: citations,
            forceRefresh: true,
            skipCacheLookup: true,
            existingArchiveRow: null,
            matchedTopic: archiveMatch && archiveMatch.suggestedTopic
              ? archiveMatch.suggestedTopic
              : effectiveTopic,
            matchType: archiveMatch && archiveMatch.matchType ? archiveMatch.matchType : 'exact',
          }
        );
      })
      .then(function (summary) {
        console.log(
          '[community-summarizer] background create finished',
          '| status:',
          summary && summary.communityStatus,
          '| archive_key:',
          archiveKey.slice(0, 16),
          '| summaryChars:',
          summary && summary.summary ? String(summary.summary).length : 0
        );
        return summary;
      })
      .catch(function (jobErr) {
        console.error(
          '[community-summarizer] background create FAILED',
          '| archive_key:',
          archiveKey.slice(0, 16),
          '| error:',
          jobErr && jobErr.message ? jobErr.message : jobErr,
          '| stack:',
          jobErr && jobErr.stack ? jobErr.stack : null
        );
        return communityDriveArchive.upsertArchiveRow({
          archive_key: archiveKey,
          search_query: effectiveTopic,
          query_text: effectiveTopic,
          grade_id: lockedGradeId,
          grade_level: lockedGradeId,
          topic: effectiveTopic,
          summary_md: 'יצירת הסיכום נכשלה: ' + String(jobErr && jobErr.message ? jobErr.message : jobErr),
          summary_text: 'יצירת הסיכום נכשלה: ' + String(jobErr && jobErr.message ? jobErr.message : jobErr),
          community_status: 'unavailable',
          source_fingerprint: fingerprint,
          drive_fingerprint: fingerprint,
          source_file_ids: fileRefs.map(function (r) { return r.driveFileId; }).filter(Boolean),
          file_refs: fileRefs,
          model: null,
        }).catch(function (persistFail) {
          console.error(
            '[community-summarizer] failed-status upsert also failed:',
            persistFail && persistFail.message ? persistFail.message : persistFail
          );
        });
      })
      .finally(function () {
        inflightSummaryJobs.delete(archiveKey);
      });
    inflightSummaryJobs.set(archiveKey, job);
    return job;
  }

  // Fire-and-forget so the HTTP response is not blocked by Gemini (avoids FE timeout).
  startCreateJob();

  return finalizeSummaryPayload(base, {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: COMMUNITY_SUMMARY_PROCESSING,
    communityStatus: 'processing',
    fromArchive: false,
    deltaUpdated: false,
    archiveKey: archiveKey,
    fileRefs: fileRefs,
    sourceFingerprint: fingerprint,
    model: null,
  }, citations, {
    configured: configured,
    matches: matches,
    matchCount: matches.length,
    probeError: probeError,
    driveDebug: driveDebug,
    poll: true,
    pollAfterMs: POLL_HINT_MS,
  });
}

async function pollCommunitySummaryJob(options) {
  const opts = options || {};
  const topic = String(opts.topic || opts.query || '').trim();
  const gradeId = String(opts.gradeId || opts.currentGrade || '').trim();
  const archiveKey = String(opts.archiveKey || opts.communityArchiveKey || '').trim()
    || (topic && gradeId
      ? communityDriveArchive.buildArchiveKey(topic, {
        gradeId: gradeId,
        topic: topic,
        phase: SUMMARIZER_PHASE,
      })
      : '');
  if (!archiveKey) {
    const err = new Error('archiveKey (or topic+gradeId) is required to poll');
    err.statusCode = 400;
    throw err;
  }

  console.log(
    '[community-summarizer] poll status',
    '| archive_key:',
    archiveKey.slice(0, 16),
    '| inflight:',
    inflightSummaryJobs.has(archiveKey)
  );

  let row = null;
  try {
    row = await communityDriveArchive.fetchArchiveRow(archiveKey);
  } catch (e) {
    console.warn('[community-summarizer] poll fetchArchiveRow failed:', e.message || e);
  }

  const base = {
    topic: topic || (row && row.topic) || '',
    requestedTopic: topic || (row && (row.search_query || row.query_text)) || '',
    gradeId: gradeId || (row && row.grade_id) || '',
  };

  if (row && row.community_status === 'ok' && String(row.summary_md || '').trim()) {
    console.log('[community-summarizer] poll READY — returning archived summary');
    return finalizeSummaryPayload(base, {
      heading: COMMUNITY_SUMMARY_HEADING,
      summary: String(row.summary_md || ''),
      communityStatus: 'ok',
      fromArchive: true,
      deltaUpdated: false,
      archiveKey: row.archive_key || archiveKey,
      fileRefs: Array.isArray(row.file_refs) ? row.file_refs : [],
      sourceFingerprint: String(row.source_fingerprint || row.drive_fingerprint || ''),
      model: row.model || null,
      smartCacheHit: true,
    }, citationsFromFileRefs(row.file_refs), {
      configured: driveIsConfigured(),
      matches: [],
      matchCount: Array.isArray(row.file_refs) ? row.file_refs.length : 0,
      poll: true,
    });
  }

  if (row && row.community_status === 'unavailable') {
    return finalizeSummaryPayload(base, {
      heading: COMMUNITY_SUMMARY_HEADING,
      summary: String(row.summary_md || COMMUNITY_SUMMARY_EMPTY),
      communityStatus: 'unavailable',
      fromArchive: false,
      archiveKey: archiveKey,
    }, [], { configured: driveIsConfigured(), matches: [], matchCount: 0, poll: true });
  }

  return finalizeSummaryPayload(base, {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: COMMUNITY_SUMMARY_PROCESSING,
    communityStatus: 'processing',
    fromArchive: false,
    archiveKey: archiveKey,
  }, [], {
    configured: driveIsConfigured(),
    matches: [],
    matchCount: 0,
    poll: true,
    pollAfterMs: POLL_HINT_MS,
  });
}

async function executeCommunitySummarizer(req) {
  const rawBody = parseRequestBody(req);
  if (!rawBody || typeof rawBody !== 'object') {
    const err = new Error('Request body is missing');
    err.statusCode = 400;
    throw err;
  }
  const body = stripLiveResearchFlags(rawBody);
  console.log(
    '[community-summarizer] pipeline=community-drive-archive+gemini',
    '| usedPerplexity=false | usedLiveResearch=false',
    '| poll:',
    body.poll === true || body.checkStatus === true
  );

  if (body.poll === true || body.checkStatus === true) {
    return pollCommunitySummaryJob({
      topic: body.topic || body.query || body.userMessage || body.q,
      gradeId: body.gradeId || body.currentGrade,
      currentGrade: body.currentGrade || body.gradeId,
      archiveKey: body.archiveKey || body.communityArchiveKey || '',
      communityArchiveKey: body.communityArchiveKey || body.archiveKey || '',
    });
  }

  return runCommunityTopicSummary({
    topic: body.topic || body.query || body.userMessage || body.q,
    gradeId: body.gradeId || body.currentGrade,
    currentGrade: body.currentGrade || body.gradeId,
    limit: body.limit,
    forceRefresh: body.forceRefresh === true || body.refresh === true,
    confirmedTopic: body.confirmedTopic === true || body.confirmSuggestion === true,
    confirmSuggestion: body.confirmSuggestion === true,
    skipDidYouMean: body.skipDidYouMean === true,
    suggestedTopic: body.suggestedTopic || body.confirmSuggestedTopic || '',
    confirmSuggestedTopic: body.confirmSuggestedTopic || body.suggestedTopic || '',
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
    return sendJson(res, status, withNonBillableMeta({
      error: err.message || String(err),
      success: false,
      communitySummaryHeading: COMMUNITY_SUMMARY_HEADING,
      communitySummary: COMMUNITY_SUMMARY_EMPTY,
      communityStatus: 'unavailable',
    }));
  }
}

module.exports = {
  SUMMARIZER_PHASE,
  COMMUNITY_SUMMARY_HEADING,
  COMMUNITY_SUMMARY_EMPTY,
  COMMUNITY_SUMMARY_PROCESSING,
  runCommunityTopicSummary,
  pollCommunitySummaryJob,
  executeCommunitySummarizer,
  legacyHandler,
};
