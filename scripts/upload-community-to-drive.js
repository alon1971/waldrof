#!/usr/bin/env node
'use strict';

/**
 * Upload community_materials from Supabase into the Google Drive catalog root,
 * organized as: כיתה X / נושא / קבצים (or shortcuts).
 *
 * Then optionally run Gemini community summarizer for every grade+topic pair.
 *
 * Usage:
 *   node scripts/upload-community-to-drive.js                 # dry-run
 *   node scripts/upload-community-to-drive.js --apply         # upload + organize
 *   node scripts/upload-community-to-drive.js --apply --summarize
 *   npm run upload-community-drive
 *   npm run upload-community-drive:apply
 *
 * Env:
 *   GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID or DRIVE_ROOT_FOLDER_ID
 *   GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON (Editor on the catalog folder)
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   GEMINI_API_KEY (only for --summarize)
 */

require('../api/env');
const path = require('path');
const drive = require('../api/drive-catalog-sync');
const pedagogicalScope = require('../api/pedagogical-scope');
const communitySummarizer = require('../api/community-summarizer');
const env = require('../api/env');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = drive.FOLDER_MIME || 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = drive.SHORTCUT_MIME || 'application/vnd.google-apps.shortcut';
const DOCS_MIME = 'application/vnd.google-apps.document';
const MATERIALS_TABLE = 'community_materials';
const STORAGE_BUCKET = 'community-uploads';
const GENERAL_GRADE_FOLDER = 'כללי / בין-כיתתי';
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

function parseArgs(argv) {
  const args = {
    apply: false,
    summarize: false,
    summarizeOnly: false,
    limit: 0,
    skipExisting: true,
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
    else if (a === '--force') args.skipExisting = false;
    else if (a.indexOf('--limit=') === 0) {
      const n = Number(a.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
    }
  });
  return args;
}

function driveHeaders(accessToken) {
  if (typeof drive.buildDriveRequestHeaders === 'function') {
    return drive.buildDriveRequestHeaders(accessToken, {});
  }
  return { Authorization: 'Bearer ' + accessToken };
}

function gradeFolderLabel(gradeId) {
  const gid = String(gradeId || '').trim();
  if (!gid || gid === 'general') return GENERAL_GRADE_FOLDER;
  return (pedagogicalScope.GRADE_LABEL_BY_ID || {})[gid] || ('כיתה ' + gid);
}

function classifyFilePath(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return { kind: 'empty', value: '' };
  if (/supabase\.co\/storage\/v1\/object\/public\/community-uploads\//i.test(p)
    || /\/storage\/v1\/object\/public\/community-uploads\//i.test(p)) {
    return { kind: 'storage', value: p };
  }
  const driveFile = p.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i);
  if (driveFile) return { kind: 'drive_file', value: p, driveId: driveFile[1] };
  const driveFolder = p.match(/drive\.google\.com\/(?:drive\/)?folders\/([^/?#]+)/i);
  if (driveFolder) return { kind: 'drive_folder', value: p, driveId: driveFolder[1] };
  const docs = p.match(/docs\.google\.com\/document\/d\/([^/?#]+)/i);
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
  if (n.endsWith('.txt')) return 'text/plain';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function safeDriveFileName(name, fallback) {
  const raw = String(name || '').trim() || String(fallback || 'קובץ').trim();
  return raw.replace(/[\\/]+/g, ' - ').slice(0, 180) || 'קובץ';
}

async function fetchAllMaterials() {
  const url = env.getSupabaseUrl();
  const key = env.getSupabaseServiceRoleKey();
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
  };
  const all = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      url + '/rest/v1/' + MATERIALS_TABLE
      + '?select=id,grade_level,topic,file_name,file_path,notes,created_at'
      + '&order=grade_level.asc,topic.asc,created_at.asc'
      + '&limit=1000&offset=' + offset,
      { headers: headers }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error('community_materials fetch failed (' + res.status + '): ' + text.slice(0, 400));
    }
    const rows = JSON.parse(text);
    all.push.apply(all, rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return all;
}

async function downloadHttpBuffer(url, maxBytes) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('download failed (' + res.status + '): ' + url.slice(0, 120));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > (maxBytes || MAX_DOWNLOAD_BYTES)) {
    throw new Error('file too large (' + buf.length + ' bytes): ' + url.slice(0, 120));
  }
  return {
    buffer: buf,
    contentType: String(res.headers.get('content-type') || '').split(';')[0].trim(),
  };
}

async function findChildByName(parentId, name, mimeType, accessToken, cache) {
  const key = parentId + '|' + mimeType + '|' + String(name || '').trim().toLowerCase();
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

async function ensureFolder(parentId, name, accessToken, dryRun, cache) {
  const existing = await findChildByName(parentId, name, FOLDER_MIME, accessToken, cache);
  if (existing) return existing.id;

  const cacheKey = parentId + '|' + FOLDER_MIME + '|' + String(name || '').trim().toLowerCase();
  if (dryRun) {
    const fakeId = 'dry-run-folder:' + parentId + ':' + name;
    cache[cacheKey] = { id: fakeId, name: name, mimeType: FOLDER_MIME };
    console.log('  [dry-run] would create folder:', name, 'under', parentId);
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
  console.log('  created folder:', name, '→', created.id);
  return created.id;
}

async function uploadBufferToDrive(parentId, fileName, mimeType, buffer, accessToken, dryRun) {
  if (String(parentId || '').indexOf('dry-run-') === 0 || dryRun) {
    console.log('  [dry-run] would upload file:', fileName, '(' + buffer.length + ' bytes)');
    return { id: 'dry-run-file', name: fileName, dryRun: true };
  }

  const existing = await findChildByName(parentId, fileName, null, accessToken, {});
  if (existing && existing.mimeType !== FOLDER_MIME && existing.mimeType !== SHORTCUT_MIME) {
    console.log('  already exists, skip upload:', existing.name, existing.id);
    return Object.assign({}, existing, { skipped: true });
  }

  const boundary = 'waldorf_' + Date.now().toString(36);
  const meta = JSON.stringify({
    name: fileName,
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
  const body = Buffer.concat([preamble, buffer, closing]);

  const res = await fetch(
    DRIVE_UPLOAD_API + '/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink,parents',
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
    throw new Error('upload failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const created = JSON.parse(text);
  console.log('  uploaded:', created.name, '→', created.id);
  return created;
}

async function createDriveShortcut(parentId, name, targetId, accessToken, dryRun) {
  if (String(parentId || '').indexOf('dry-run-') === 0 || dryRun) {
    console.log('  [dry-run] would create shortcut:', name, '→', targetId);
    return { id: 'dry-run-shortcut', name: name, dryRun: true };
  }

  const existing = await findChildByName(parentId, name, SHORTCUT_MIME, accessToken, {});
  if (existing) {
    console.log('  shortcut already exists, skip:', existing.name, existing.id);
    return Object.assign({}, existing, { skipped: true });
  }

  const res = await fetch(DRIVE_API + '/files?supportsAllDrives=true&fields=id,name,mimeType,webViewLink', {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, driveHeaders(accessToken)),
    body: JSON.stringify({
      name: name,
      mimeType: SHORTCUT_MIME,
      parents: [parentId],
      shortcutDetails: { targetId: targetId },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('create shortcut failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const created = JSON.parse(text);
  console.log('  shortcut:', created.name, '→', targetId, '(' + created.id + ')');
  return created;
}

async function createLinkDocument(parentId, name, url, accessToken, dryRun) {
  const docName = safeDriveFileName(name, 'קישור חיצוני');
  if (String(parentId || '').indexOf('dry-run-') === 0 || dryRun) {
    console.log('  [dry-run] would create link doc:', docName, '→', url);
    return { id: 'dry-run-link-doc', name: docName, dryRun: true };
  }

  const existing = await findChildByName(parentId, docName, DOCS_MIME, accessToken, {});
  if (existing) {
    console.log('  link doc already exists, skip:', existing.name, existing.id);
    return Object.assign({}, existing, { skipped: true });
  }

  const res = await fetch(DRIVE_API + '/files?supportsAllDrives=true&fields=id,name,mimeType,webViewLink', {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, driveHeaders(accessToken)),
    body: JSON.stringify({
      name: docName,
      mimeType: DOCS_MIME,
      parents: [parentId],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('create link doc failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const created = JSON.parse(text);
  // Best-effort: put URL into description via files.update
  await fetch(
    DRIVE_API + '/files/' + encodeURIComponent(created.id) + '?supportsAllDrives=true&fields=id,description',
    {
      method: 'PATCH',
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
      }, driveHeaders(accessToken)),
      body: JSON.stringify({
        description: 'קישור חיצוני מהמאגר הקהילתי:\n' + url,
      }),
    }
  ).catch(function () { /* non-fatal */ });

  console.log('  link doc:', created.name, '→', created.id, url.slice(0, 80));
  return created;
}

async function processMaterial(row, ctx) {
  const gradeId = String(row.grade_level || '').trim() || 'general';
  const topic = String(row.topic || '').trim() || 'כללי';
  const fileName = safeDriveFileName(row.file_name, topic);
  const classified = classifyFilePath(row.file_path);
  const gradeLabel = gradeFolderLabel(gradeId);

  console.log(
    '\n→',
    gradeLabel,
    '/',
    topic,
    '/',
    fileName,
    '|',
    classified.kind
  );

  const gradeFolderId = await ensureFolder(
    ctx.rootFolderId,
    gradeLabel,
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

  ctx.tree[gradeLabel] = ctx.tree[gradeLabel] || { gradeId: gradeId, topics: {} };
  ctx.tree[gradeLabel].topics[topic] = ctx.tree[gradeLabel].topics[topic] || [];
  const pairKey = gradeId + '::' + topic;
  ctx.pairs[pairKey] = { gradeId: gradeId, topic: topic, gradeLabel: gradeLabel };

  let result = null;
  if (classified.kind === 'storage') {
    const downloaded = await downloadHttpBuffer(classified.value);
    const mime = downloaded.contentType || guessMimeFromName(fileName);
    result = await uploadBufferToDrive(
      topicFolderId,
      fileName,
      mime,
      downloaded.buffer,
      ctx.accessToken,
      ctx.dryRun
    );
    ctx.stats.uploaded += result.skipped ? 0 : 1;
    if (result.skipped) ctx.stats.skippedExisting += 1;
  } else if (
    classified.kind === 'drive_file'
    || classified.kind === 'drive_folder'
    || classified.kind === 'docs'
  ) {
    const shortcutName = fileName.indexOf('קישור') === 0
      ? safeDriveFileName(topic + ' — קישור', topic)
      : fileName;
    result = await createDriveShortcut(
      topicFolderId,
      shortcutName,
      classified.driveId,
      ctx.accessToken,
      ctx.dryRun
    );
    ctx.stats.shortcuts += result.skipped ? 0 : 1;
    if (result.skipped) ctx.stats.skippedExisting += 1;
  } else if (classified.kind === 'external_url') {
    result = await createLinkDocument(
      topicFolderId,
      fileName.indexOf('קישור') === 0 ? (topic + ' — קישור חיצוני') : fileName,
      classified.value,
      ctx.accessToken,
      ctx.dryRun
    );
    ctx.stats.linkDocs += result.skipped ? 0 : 1;
    if (result.skipped) ctx.stats.skippedExisting += 1;
  } else {
    ctx.stats.skippedUnsupported += 1;
    console.log('  skip unsupported path kind:', classified.kind, classified.value.slice(0, 100));
    return;
  }

  const entry = {
    materialId: row.id,
    gradeId: gradeId,
    gradeLabel: gradeLabel,
    topic: topic,
    fileName: fileName,
    kind: classified.kind,
    driveId: result && result.id,
    webViewLink: result && result.webViewLink,
    skipped: Boolean(result && result.skipped),
  };
  ctx.tree[gradeLabel].topics[topic].push(entry);
  ctx.uploaded.push(entry);
}

function printTreeReport(tree, stats) {
  console.log('\n========== UPLOAD / ORGANIZE REPORT ==========');
  const grades = Object.keys(tree).sort();
  grades.forEach(function (gradeLabel) {
    const gradeNode = tree[gradeLabel];
    console.log('\n📁 ' + gradeLabel + ' (gradeId=' + gradeNode.gradeId + ')');
    const topics = Object.keys(gradeNode.topics).sort();
    topics.forEach(function (topic) {
      const files = gradeNode.topics[topic] || [];
      console.log('  📂 ' + topic + '  (' + files.length + ' items)');
      files.forEach(function (f) {
        console.log(
          '    -',
          f.fileName,
          '[' + f.kind + ']',
          f.skipped ? '(already existed)' : 'OK',
          f.driveId ? 'id=' + f.driveId : ''
        );
      });
    });
  });
  console.log('\n--- totals ---');
  console.log(JSON.stringify(stats, null, 2));
}

async function runSummarizerForPairs(pairs, dryRun) {
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
      const matchCount = result.communityMatchCount || 0;
      const fromArchive = Boolean(result.communitySummaryFromArchive);
      const delta = Boolean(result.communitySummaryDeltaUpdated);
      console.log(
        '  status=',
        status,
        'matches=',
        matchCount,
        'fromArchive=',
        fromArchive,
        'delta=',
        delta
      );
      if (result.communitySummary) {
        const preview = String(result.communitySummary).replace(/\s+/g, ' ').slice(0, 160);
        console.log('  preview:', preview + (preview.length >= 160 ? '…' : ''));
      }
      summaryReport.push({
        gradeId: pair.gradeId,
        topic: pair.topic,
        status: status,
        matchCount: matchCount,
        fromArchive: fromArchive,
        deltaUpdated: delta,
        error: result.communityError || null,
      });
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

  console.log('\n--- summarizer totals ---');
  const byStatus = {};
  summaryReport.forEach(function (r) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  });
  console.log(JSON.stringify({ pairs: summaryReport.length, byStatus: byStatus }, null, 2));
  return summaryReport;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !args.apply;

  console.log('[upload-community-to-drive] mode =',
    args.summarizeOnly ? 'SUMMARIZE-ONLY' : (dryRun ? 'DRY-RUN' : 'APPLY'));
  console.log('[upload-community-to-drive] summarize =', args.summarize);

  if (!drive.isDriveCatalogSyncConfigured()) {
    console.error('Drive is not configured. See docs/google-drive-setup.md');
    process.exit(2);
  }

  const rootFolderId = drive.getCatalogRootFolderId();
  console.log('[upload-community-to-drive] root =', rootFolderId);
  console.log(
    '[upload-community-to-drive] env DRIVE_ROOT_FOLDER_ID =',
    process.env.DRIVE_ROOT_FOLDER_ID || '(unset)'
  );
  console.log(
    '[upload-community-to-drive] env GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID =',
    process.env.GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID || '(unset)'
  );

  const materials = await fetchAllMaterials();
  console.log('[upload-community-to-drive] community_materials rows:', materials.length);

  const ctx = {
    rootFolderId: rootFolderId,
    accessToken: null,
    dryRun: dryRun,
    folderCache: {},
    tree: {},
    pairs: {},
    uploaded: [],
    stats: {
      scanned: materials.length,
      uploaded: 0,
      shortcuts: 0,
      linkDocs: 0,
      skippedExisting: 0,
      skippedUnsupported: 0,
      errors: 0,
    },
  };

  if (args.summarizeOnly) {
    materials.forEach(function (row) {
      const gradeId = String(row.grade_level || '').trim() || 'general';
      const topic = String(row.topic || '').trim() || 'כללי';
      const gradeLabel = gradeFolderLabel(gradeId);
      const pairKey = gradeId + '::' + topic;
      ctx.pairs[pairKey] = { gradeId: gradeId, topic: topic, gradeLabel: gradeLabel };
      ctx.tree[gradeLabel] = ctx.tree[gradeLabel] || { gradeId: gradeId, topics: {} };
      ctx.tree[gradeLabel].topics[topic] = ctx.tree[gradeLabel].topics[topic] || [];
      ctx.tree[gradeLabel].topics[topic].push({
        materialId: row.id,
        fileName: row.file_name,
        kind: classifyFilePath(row.file_path).kind,
      });
    });
    printTreeReport(ctx.tree, { scanned: materials.length, note: 'summarize-only (no upload)' });
  } else {
    ctx.accessToken = await drive.resolveDriveAccessToken({ write: !dryRun });
    let processed = 0;
    for (let i = 0; i < materials.length; i++) {
      if (args.limit && processed >= args.limit) break;
      const row = materials[i];
      processed += 1;
      try {
        await processMaterial(row, ctx);
      } catch (err) {
        ctx.stats.errors += 1;
        console.error(
          '  ERROR material',
          row && row.id,
          err && err.message ? err.message : err
        );
      }
    }
    printTreeReport(ctx.tree, ctx.stats);
  }

  let summaryReport = [];
  if (args.summarize) {
    // Summarize-only always hits live Drive/Gemini (never dry-run skip).
    summaryReport = await runSummarizerForPairs(ctx.pairs, args.summarizeOnly ? false : dryRun);
  } else {
    console.log('\n(Skipping summarizer — pass --summarize or --summarize-only)');
  }

  const reportPath = path.join(
    process.cwd(),
    'scripts',
    'upload-community-to-drive-report.json'
  );
  try {
    const fs = require('fs');
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        mode: dryRun ? 'dry-run' : 'apply',
        rootFolderId: rootFolderId,
        generatedAt: new Date().toISOString(),
        stats: ctx.stats,
        tree: ctx.tree,
        summarizer: summaryReport,
      }, null, 2),
      'utf8'
    );
    console.log('\nWrote report:', reportPath);
  } catch (writeErr) {
    console.warn('Could not write report file:', writeErr && writeErr.message);
  }

  if (dryRun) {
    console.log('\nDry-run only. Re-run with --apply --summarize to upload and summarize.');
    console.log('Ensure the service account has Editor access on the catalog folder.');
  }

  process.exit(ctx.stats.errors ? 1 : 0);
}

main().catch(function (err) {
  console.error('[upload-community-to-drive] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
