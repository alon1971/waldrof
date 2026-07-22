#!/usr/bin/env node
'use strict';

/**
 * Live probe for standalone community Drive topic summarizer + public archive.
 * Usage:
 *   node scripts/probe-drive-community-search.js [topic] [gradeId]
 *
 * Expects GOOGLE_DRIVE_* (+ GEMINI_API_KEY for summaries) in .env (loaded via api/env).
 */
require('../api/env');
const drive = require('../api/drive-catalog-sync');
const communitySummarizer = require('../api/community-summarizer');

async function main() {
  const topic = String(process.argv[2] || 'רומא').trim();
  const gradeId = String(process.argv[3] || '5').trim();
  const configured = drive.isDriveCatalogSyncConfigured();
  console.log('[probe] topic =', topic, '| gradeId =', gradeId);
  console.log('[probe] driveConfigured =', configured);
  console.log(
    '[probe] GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID =',
    process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID ? 'set' : 'MISSING'
  );
  console.log(
    '[probe] GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON =',
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON ? 'set' : 'MISSING'
  );
  console.log(
    '[probe] GEMINI_API_KEY =',
    process.env.GEMINI_API_KEY ? 'set' : 'MISSING'
  );

  if (!configured) {
    console.error('');
    console.error('BLOCKED: Drive credentials are missing or empty.');
    console.error('Paste these two values into .env, then re-run:');
    console.error('  1) GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID  — folder id from Drive URL');
    console.error('  2) GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON    — full service-account JSON (one line)');
    console.error('Also share the catalog folder with the service-account email.');
    process.exit(2);
  }

  const result = await communitySummarizer.runCommunityTopicSummary({
    topic: topic,
    gradeId: gradeId,
    limit: 8,
  });

  const status = result.communityStatus || (result.communityMatchCount > 0 ? 'ok' : 'empty');
  console.log('[probe] communityStatus =', status);
  console.log('[probe] count =', result.communityMatchCount || 0);
  console.log('[probe] summaryFromArchive =', Boolean(result.communitySummaryFromArchive));
  console.log('[probe] deltaUpdated =', Boolean(result.communitySummaryDeltaUpdated));
  console.log('[probe] summaryModel =', result.communitySummaryModel || '(none)');
  console.log('[probe] archiveKey =', result.communityArchiveKey || '(none)');
  if (result.communityError) console.log('[probe] communityError =', result.communityError);
  (result.communityMatches || []).slice(0, 5).forEach(function (m, i) {
    console.log(
      '  [' + (i + 1) + ']',
      (m.title || m.fileName || m.topic || '(untitled)'),
      '|',
      m.gradeId || '-',
      '|',
      m.catalogTopic || m.topic || '-',
      '|',
      m.matchType || m.source || ''
    );
  });

  const summary = String(result.communitySummary || '');
  console.log('[probe] communitySummaryHeading =', result.communitySummaryHeading || '');
  console.log('[probe] communitySummary preview =', summary.slice(0, 180).replace(/\s+/g, ' '));

  if (!result.communityMatchCount) {
    if (summary !== communitySummarizer.COMMUNITY_SUMMARY_EMPTY) {
      console.error('[probe] FAILED — empty hits must return exact empty copy');
      console.error('  expected:', communitySummarizer.COMMUNITY_SUMMARY_EMPTY);
      process.exit(1);
    }
    console.error('[probe] INCOMPLETE — Drive configured but no matches for this query.');
    console.error('[probe] empty copy OK.');
    process.exit(1);
  }

  if (status === 'ok' && result.communityMatchCount > 0) {
    console.log('[probe] SUCCESS — community summarizer + archive path returned matches.');
    process.exit(0);
  }
  console.error('[probe] FAILED — communityStatus=' + status);
  process.exit(1);
}

main().catch(function (err) {
  console.error('[probe] ERROR:', err && err.message ? err.message : err);
  process.exit(1);
});
