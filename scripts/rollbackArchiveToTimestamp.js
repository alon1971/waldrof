#!/usr/bin/env node
/**
 * Scorched-earth rollback of cached_results to a pre-corruption timestamp.
 *
 * Default cutoff: Friday 2026-06-19 09:00 Israel (06:00 UTC).
 *
 * Usage:
 *   node scripts/rollbackArchiveToTimestamp.js --dry-run
 *   node scripts/rollbackArchiveToTimestamp.js --execute
 *   node scripts/rollbackArchiveToTimestamp.js --execute --cutoff 2026-06-19T06:00:00Z
 */
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../api/env');
const cacheDb = require('../api/cache');

const TABLE = cacheDb.TABLE_NAME;
const DEFAULT_CUTOFF = '2026-06-19T06:00:00Z';

function parseArgs(argv) {
  const opts = {
    cutoff: DEFAULT_CUTOFF,
    dryRun: true,
    execute: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cutoff' && argv[i + 1]) { opts.cutoff = argv[++i]; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; opts.execute = false; continue; }
    if (arg === '--execute') { opts.execute = true; opts.dryRun = false; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
  }
  return opts;
}

function printHelp() {
  console.log(
    'Rollback cached_results to rows created before a cutoff timestamp.\n\n' +
    '  --cutoff <iso>   ISO timestamp (default: ' + DEFAULT_CUTOFF + ')\n' +
    '  --dry-run        Preview changes only (default)\n' +
    '  --execute        Export backup, delete post-cutoff rows, strip Gemini merges\n'
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
    const path =
      '/rest/v1/' + TABLE +
      '?select=cache_key,phase,topic,grade_id,query_text,user_id,created_at,last_hit_at,hit_count,result_data' +
      '&order=created_at.asc' +
      '&limit=' + pageSize +
      '&offset=' + offset;
    const res = await supabaseRequest(path, { method: 'GET' });
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

function payloadBytes(row) {
  try {
    return JSON.stringify(row.result_data || {}).length;
  } catch (e) {
    return 0;
  }
}

function stripGeminiGradeMerges(resultData) {
  const data = cacheDb.coerceCachedResultData(resultData);
  if (!data || typeof data !== 'object') return { changed: false, data: resultData };
  const gi = data.gradeInsights;
  if (!gi || typeof gi !== 'object') return { changed: false, data: data };
  const hadMerge = Boolean(
    (Array.isArray(gi.chatEnrichments) && gi.chatEnrichments.length) ||
    gi.lastChatEnrichmentAt ||
    gi.chatEnrichmentCount
  );
  if (!hadMerge) return { changed: false, data: data };
  delete gi.chatEnrichments;
  delete gi.lastChatEnrichmentAt;
  delete gi.chatEnrichmentCount;
  return { changed: true, data: data };
}

function stripArchiveUpgradeTag(resultData) {
  const data = cacheDb.coerceCachedResultData(resultData);
  if (!data || typeof data !== 'object' || !data._archiveUpgrade) {
    return { changed: false, data: data || resultData };
  }
  delete data._archiveUpgrade;
  return { changed: true, data: data };
}

function rowGroupKey(row) {
  return [
    row.phase || '',
    row.grade_id || '',
    String(row.topic || row.query_text || '').trim(),
  ].join('|');
}

function chooseDuplicateKeeper(rows) {
  return rows.slice().sort(function (a, b) {
    const aUp = (a.result_data && a.result_data._archiveUpgrade) ? 1 : 0;
    const bUp = (b.result_data && b.result_data._archiveUpgrade) ? 1 : 0;
    if (aUp !== bUp) return aUp - bUp;
    return payloadBytes(b) - payloadBytes(a);
  })[0];
}

function exportBackup(rows, cutoff) {
  const dir = path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, 'cached_results-pre-rollback-' + stamp + '.json');
  fs.writeFileSync(file, JSON.stringify({
    exportedAt: new Date().toISOString(),
    cutoff: cutoff,
    rowCount: rows.length,
    rows: rows,
  }, null, 2), 'utf8');
  return file;
}

async function deleteRows(cacheKeys, dryRun) {
  if (!cacheKeys.length) return 0;
  if (dryRun) return cacheKeys.length;
  const chunkSize = 40;
  let deleted = 0;
  for (let i = 0; i < cacheKeys.length; i += chunkSize) {
    const chunk = cacheKeys.slice(i, i + chunkSize);
    const filter = 'cache_key=in.(' + chunk.map(function (k) {
      return '"' + String(k).replace(/"/g, '') + '"';
    }).join(',') + ')';
    const res = await supabaseRequest('/rest/v1/' + TABLE + '?' + filter, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('DELETE failed ' + res.status + ': ' + errText.slice(0, 300));
    }
    deleted += chunk.length;
  }
  return deleted;
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

  const cutoffMs = Date.parse(opts.cutoff);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error('Invalid --cutoff timestamp: ' + opts.cutoff);
  }

  console.log('[rollback] cutoff=%s execute=%s', opts.cutoff, opts.execute);
  const allRows = await fetchAllRows();
  console.log('[rollback] fetched %d rows', allRows.length);

  const backupFile = exportBackup(allRows, opts.cutoff);
  console.log('[rollback] backup written:', backupFile);

  const postCutoff = allRows.filter(function (row) {
    return Date.parse(row.created_at) >= cutoffMs;
  });
  const preCutoff = allRows.filter(function (row) {
    return Date.parse(row.created_at) < cutoffMs;
  });

  const deleteKeys = postCutoff.map(function (r) { return r.cache_key; });

  const duplicateDeletes = [];
  const groups = new Map();
  preCutoff.forEach(function (row) {
    if (row.phase !== 'topic' && row.phase !== 'grade') return;
    const key = rowGroupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  groups.forEach(function (groupRows) {
    if (groupRows.length < 2) return;
    const keeper = chooseDuplicateKeeper(groupRows);
    groupRows.forEach(function (row) {
      if (row.cache_key !== keeper.cache_key) {
        duplicateDeletes.push(row.cache_key);
      }
    });
  });

  const patchPlan = [];
  preCutoff.forEach(function (row) {
    if (duplicateDeletes.indexOf(row.cache_key) >= 0) return;
    let data = row.result_data;
    let changed = false;

    const merge = stripGeminiGradeMerges(data);
    if (merge.changed) {
      data = merge.data;
      changed = true;
    }

    const strip = stripArchiveUpgradeTag(data);
    if (strip.changed) {
      data = strip.data;
      changed = true;
    }

    if (changed) {
      patchPlan.push({ cache_key: row.cache_key, result_data: data });
    }
  });

  const allDeleteKeys = deleteKeys.concat(
    duplicateDeletes.filter(function (k) { return deleteKeys.indexOf(k) < 0; })
  );

  console.log('[rollback] post-cutoff deletes:', deleteKeys.length);
  console.log('[rollback] duplicate pre-cutoff deletes:', duplicateDeletes.length);
  console.log('[rollback] pre-cutoff Gemini-merge patches:', patchPlan.length);
  console.log('[rollback] total deletes:', allDeleteKeys.length);

  if (opts.dryRun) {
    console.log('\n[rollback] DRY RUN — no database mutations.');
    postCutoff.slice(0, 15).forEach(function (r) {
      console.log('  DEL', r.created_at, r.phase, 'g' + (r.grade_id || '-'), (r.topic || '-').slice(0, 40));
    });
    if (postCutoff.length > 15) console.log('  ... +' + (postCutoff.length - 15) + ' more');
    return;
  }

  const deleted = await deleteRows(allDeleteKeys, false);
  console.log('[rollback] deleted %d rows', deleted);

  let patched = 0;
  for (const item of patchPlan) {
    await patchRow(item.cache_key, item.result_data, false);
    patched++;
  }
  console.log('[rollback] patched %d pre-cutoff rows (stripped Gemini merges/tags)', patched);

  const remaining = await fetchAllRows();
  console.log('[rollback] remaining rows:', remaining.length);
  console.log('[rollback] DONE');
}

main().catch(function (err) {
  console.error('[rollback] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
