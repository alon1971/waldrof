#!/usr/bin/env node
'use strict';

/**
 * CLI wrapper for Supabase → Google Drive full-content backfill.
 * Core logic lives in api/admin-sync-drive.js (also exposed as /api/admin/sync-drive).
 *
 * Usage:
 *   node scripts/upload-community-to-drive.js                 # dry-run
 *   node scripts/upload-community-to-drive.js --apply         # upload content docs + binaries
 *   node scripts/upload-community-to-drive.js --apply --force
 *   npm run upload-community-drive
 *   npm run upload-community-drive:apply
 *
 * Env:
 *   GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID or DRIVE_ROOT_FOLDER_ID
 *   GOOGLE_DRIVE_OAUTH_* (recommended for writes) or service account + Shared Drive
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

require('../api/env');
const path = require('path');
const fs = require('fs');
const drive = require('../api/drive-catalog-sync');
const adminSyncDrive = require('../api/admin-sync-drive');
const communitySummarizer = require('../api/community-summarizer');

function parseArgs(argv) {
  const args = {
    apply: false,
    summarize: false,
    summarizeOnly: false,
    limit: 0,
    force: false,
  };
  (argv || []).forEach(function (raw) {
    const a = String(raw || '').trim();
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--summarize') args.summarize = true;
    else if (a === '--summarize-only') {
      args.summarizeOnly = true;
      args.summarize = true;
      args.apply = false;
    }
    else if (a === '--no-summarize') args.summarize = false;
    else if (a === '--force') args.force = true;
    else if (a.indexOf('--limit=') === 0) {
      const n = Number(a.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
    }
  });
  return args;
}

function gradeFolderLabel(gradeId) {
  return adminSyncDrive.gradeFolderLabel(gradeId);
}

async function runSummarizerForMaterials(materials, dryRun) {
  const pairs = {};
  (materials || []).forEach(function (row) {
    const gradeId = String(row.grade_level || '').trim() || 'general';
    const topic = String(row.topic || '').trim() || 'כללי';
    const pairKey = gradeId + '::' + topic;
    pairs[pairKey] = {
      gradeId: gradeId,
      topic: topic,
      gradeLabel: gradeFolderLabel(gradeId),
    };
  });
  const list = Object.keys(pairs).map(function (k) { return pairs[k]; });
  console.log('\n========== GEMINI SUMMARIZER ==========');
  console.log('pairs:', list.length);
  const summaryReport = [];

  for (let i = 0; i < list.length; i++) {
    const pair = list[i];
    console.log('\n[summarize]', (i + 1) + '/' + list.length, pair.gradeLabel, '/', pair.topic);
    if (dryRun) {
      summaryReport.push({
        gradeId: pair.gradeId,
        topic: pair.topic,
        status: 'dry-run',
      });
      continue;
    }
    try {
      const result = await communitySummarizer.runCommunityTopicSummary({
        topic: pair.topic,
        gradeId: pair.gradeId === 'general' ? '7' : pair.gradeId,
        limit: 30,
      });
      const status = result.communityStatus || 'unknown';
      summaryReport.push({
        gradeId: pair.gradeId,
        topic: pair.topic,
        status: status,
        matchCount: result.communityMatchCount || 0,
        fromArchive: Boolean(result.communitySummaryFromArchive),
        deltaUpdated: Boolean(result.communitySummaryDeltaUpdated),
        error: result.communityError || null,
      });
      console.log('  status=', status, 'matches=', result.communityMatchCount || 0);
    } catch (err) {
      console.error('  ERROR:', err && err.message ? err.message : err);
      summaryReport.push({
        gradeId: pair.gradeId,
        topic: pair.topic,
        status: 'error',
        error: err && err.message ? err.message : String(err),
      });
    }
  }
  return summaryReport;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !args.apply;

  console.log(
    '[upload-community-to-drive] mode =',
    args.summarizeOnly ? 'SUMMARIZE-ONLY' : (dryRun ? 'DRY-RUN' : 'APPLY')
  );

  if (!drive.isDriveCatalogSyncConfigured()) {
    console.error('Drive is not configured. See docs/google-drive-setup.md');
    process.exit(2);
  }

  const rootFolderId = drive.getCatalogRootFolderId();
  console.log('[upload-community-to-drive] root =', rootFolderId);

  let syncResult = null;
  let materials = [];
  if (!args.summarizeOnly) {
    syncResult = await adminSyncDrive.syncSupabaseMaterialsToDrive({
      dryRun: dryRun,
      force: args.force,
      limit: args.limit || undefined,
      rootFolderId: rootFolderId,
    });
    console.log('\n========== SYNC RESULT ==========');
    console.log(JSON.stringify(syncResult.stats || syncResult, null, 2));
  } else {
    materials = await adminSyncDrive.fetchAllMaterials(args.limit || undefined);
    console.log('[upload-community-to-drive] materials for summarize-only:', materials.length);
  }

  let summaryReport = [];
  if (args.summarize) {
    if (!materials.length) {
      materials = await adminSyncDrive.fetchAllMaterials(args.limit || undefined);
    }
    summaryReport = await runSummarizerForMaterials(
      materials,
      args.summarizeOnly ? false : dryRun
    );
  } else {
    console.log('\n(Skipping summarizer — pass --summarize or --summarize-only)');
  }

  const reportPath = path.join(process.cwd(), 'scripts', 'upload-community-to-drive-report.json');
  try {
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        mode: dryRun ? 'dry-run' : 'apply',
        rootFolderId: rootFolderId,
        generatedAt: new Date().toISOString(),
        sync: syncResult,
        summarizer: summaryReport,
      }, null, 2),
      'utf8'
    );
    console.log('\nWrote report:', reportPath);
  } catch (writeErr) {
    console.warn('Could not write report file:', writeErr && writeErr.message);
  }

  if (dryRun && !args.summarizeOnly) {
    console.log('\nDry-run only. Re-run with --apply to write content docs + binaries to Drive.');
    console.log('Or call GET/POST /api/admin/sync-drive?secret=CRON_SECRET');
  }

  const errors = syncResult && syncResult.stats ? syncResult.stats.errors : 0;
  process.exit(errors ? 1 : 0);
}

main().catch(function (err) {
  console.error('[upload-community-to-drive] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
