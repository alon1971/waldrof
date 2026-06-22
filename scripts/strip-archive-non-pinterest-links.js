#!/usr/bin/env node
/**
 * One-shot migration: remove all enrichment/inspiration links from cached_results
 * except valid Pinterest URLs.
 *
 * Usage:
 *   node scripts/strip-archive-non-pinterest-links.js --dry-run
 *   node scripts/strip-archive-non-pinterest-links.js --execute
 */
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../api/env');
const cacheDb = require('../api/cache');
const enrichmentLinks = require('../api/enrichment-links');

const TABLE = cacheDb.TABLE_NAME;

function parseArgs(argv) {
  const opts = { dryRun: true, execute: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') { opts.dryRun = true; opts.execute = false; continue; }
    if (arg === '--execute') { opts.execute = true; opts.dryRun = false; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
  }
  return opts;
}

function printHelp() {
  console.log(
    'Strip non-Pinterest enrichment/inspiration links from cached_results.\n\n' +
    '  --dry-run   Preview rows that would change (default)\n' +
    '  --execute   Export backup, PATCH changed rows\n'
  );
}

function getSupabaseConfig() {
  const url = env.getSupabaseUrl();
  const key = env.getSupabaseServerKey();
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  return { url, key };
}

async function supabaseRequest(relativePath, options) {
  const cfg = getSupabaseConfig();
  const headers = Object.assign({
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
  }, options.headers || {});
  return fetch(cfg.url + relativePath, Object.assign({}, options, { headers }));
}

async function fetchAllRows() {
  const rows = [];
  const pageSize = 200;
  let offset = 0;
  while (true) {
    const rel =
      '/rest/v1/' + TABLE +
      '?select=cache_key,phase,topic,grade_id,created_at,result_data' +
      '&order=created_at.asc' +
      '&limit=' + pageSize +
      '&offset=' + offset;
    const res = await supabaseRequest(rel, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) throw new Error('Fetch failed ' + res.status + ': ' + text.slice(0, 300));
    const batch = JSON.parse(text);
    if (!batch.length) break;
    rows.push.apply(rows, batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function exportBackup(rows) {
  const dir = path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, 'cached_results-pre-pinterest-strip-' + stamp + '.json');
  fs.writeFileSync(file, JSON.stringify({
    exportedAt: new Date().toISOString(),
    rowCount: rows.length,
    rows: rows,
  }, null, 2), 'utf8');
  return file;
}

async function patchRow(cacheKey, resultData, dryRun) {
  if (dryRun) return true;
  const res = await supabaseRequest(
    '/rest/v1/' + TABLE + '?cache_key=eq.' + encodeURIComponent(cacheKey),
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ result_data: resultData }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('PATCH failed ' + res.status + ' for ' + cacheKey.slice(0, 12) + ': ' + errText.slice(0, 200));
  }
  return true;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.execute && !opts.dryRun) {
    printHelp();
    process.exit(1);
  }

  console.log('[strip-pinterest] mode=%s', opts.execute ? 'execute' : 'dry-run');
  const rows = await fetchAllRows();
  console.log('[strip-pinterest] fetched %d rows from %s', rows.length, TABLE);

  const backupFile = exportBackup(rows);
  console.log('[strip-pinterest] backup written:', backupFile);

  let changedCount = 0;
  let patchedCount = 0;

  for (const row of rows) {
    const coerced = cacheDb.coerceCachedResultData(row.result_data);
    const result = enrichmentLinks.stripNonPinterestLinksFromArchiveData(coerced);
    if (!result.changed) continue;
    changedCount++;
    console.log(
      '[strip-pinterest] would update',
      JSON.stringify({
        cache_key: row.cache_key,
        phase: row.phase,
        topic: row.topic,
        grade_id: row.grade_id,
      })
    );
    if (opts.execute) {
      await patchRow(row.cache_key, result.data, false);
      patchedCount++;
    }
  }

  console.log(
    '[strip-pinterest] rows with link changes: %d%s',
    changedCount,
    opts.execute ? ' (patched ' + patchedCount + ')' : ' (dry-run — no writes)'
  );
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
