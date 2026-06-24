#!/usr/bin/env node
'use strict';
/**
 * Global eviction: delete or strip ALL legacy / thin / malformed phase_c curriculum caches
 * so the next load uses the deep 3-chunk Perplexity pipeline.
 *
 * Usage:
 *   node scripts/evict-all-legacy-curriculum-caches.js --dry-run
 *   node scripts/evict-all-legacy-curriculum-caches.js --execute
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
}

const cacheDb = require('../api/cache');
const env = require('../api/env');

const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');
const TABLE = cacheDb.TABLE_NAME || 'cached_results';

function supabaseHeaders() {
  const key = env.getSupabaseServiceRoleKey() || env.getSupabaseAnonKey();
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function supabaseUrl() {
  return String(env.getSupabaseUrl() || '').replace(/\/$/, '');
}

function rowHasCurriculumPayload(data) {
  if (!data || typeof data !== 'object') return false;
  const bp = data.blockPlan;
  if (!bp || typeof bp !== 'object') {
    return Boolean(data.curriculum || data.table_data);
  }
  if (Array.isArray(bp.curriculum) && bp.curriculum.length) return true;
  if (Array.isArray(bp.days) && bp.days.length) return true;
  if (bp.rawCurriculum || bp.curriculumRaw || bp.table_data) return true;
  if (data.curriculum || data.table_data) return true;
  return cacheDb.countValidPhaseCCurriculumDays(data) > 0;
}

function classifyRow(row) {
  if (!row || !row.cache_key || !row.result_data) return 'skip';
  const data = cacheDb.coerceCachedResultData(row.result_data);
  if (!data) return 'skip';
  const phase = String(row.phase || '').trim();

  if (phase === 'phase_c') {
    if (!rowHasCurriculumPayload(data)) return 'skip';
    if (cacheDb.isPhaseCCurriculumServeReady(data)) return 'valid';
    return 'delete';
  }

  if (phase === 'topic') {
    if (!cacheDb.isLessonCurriculumCarrier(data)) return 'skip';
    if (cacheDb.isPhaseCCurriculumServeReady(data)) return 'valid';
    const rows = data.blockPlan
      ? (data.blockPlan.curriculum || data.blockPlan.days || [])
      : [];
    if (Array.isArray(rows) && rows.length) return 'strip';
    if (rowHasCurriculumPayload(data)) return 'strip';
    return 'skip';
  }

  return 'skip';
}

function stripCurriculumFromTopicData(data) {
  data = cacheDb.coerceArchiveLessonResultData(cacheDb.coerceCachedResultData(data)) || data;
  if (!data || typeof data !== 'object') return null;
  if (!data.blockPlan || typeof data.blockPlan !== 'object') {
    if (data.curriculum || data.table_data) {
      delete data.curriculum;
      delete data.table_data;
      return data;
    }
    return null;
  }
  const bp = data.blockPlan;
  const hadCurriculum = !!(
    bp.curriculum ||
    bp.days ||
    bp.rawCurriculum ||
    bp.curriculumRaw ||
    bp.table_data ||
    data.curriculum ||
    data.table_data
  );
  if (!hadCurriculum) return null;
  delete bp.curriculum;
  delete bp.days;
  delete bp.rawCurriculum;
  delete bp.curriculumRaw;
  delete bp.table_data;
  delete data.curriculum;
  delete data.table_data;
  return data;
}

async function fetchAllRows() {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  if (!url || !headers.apikey) return [];

  const rows = [];
  const pageSize = 200;
  let offset = 0;
  while (true) {
    const params = new URLSearchParams();
    params.set(
      'select',
      'cache_key,phase,grade_id,grade_label,topic,query_text,created_at,result_data'
    );
    params.set('order', 'created_at.asc');
    params.set('limit', String(pageSize));
    params.set('offset', String(offset));

    const res = await fetch(url + '/rest/v1/' + TABLE + '?' + params.toString(), { headers: headers });
    const body = await res.json();
    if (!res.ok) {
      throw new Error('Supabase query failed (' + res.status + '): ' + JSON.stringify(body));
    }
    if (!Array.isArray(body) || !body.length) break;
    rows.push.apply(rows, body);
    if (body.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function removeFromLocalFallback(keysToDelete, topicPatches) {
  const localPath = path.join(ROOT, 'data', 'cached_results.json');
  if (!fs.existsSync(localPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const rowList = Array.isArray(parsed.rows) ? parsed.rows : [];
    const deleteSet = new Set(keysToDelete);
    const patchMap = new Map();
    (topicPatches || []).forEach(function (entry) {
      patchMap.set(entry.cache_key, entry.result_data);
    });

    let removed = 0;
    let patched = 0;
    const kept = rowList.map(function (row) {
      if (!row || !row.cache_key) return row;
      if (deleteSet.has(row.cache_key)) {
        removed++;
        return null;
      }
      if (patchMap.has(row.cache_key)) {
        patched++;
        return Object.assign({}, row, { result_data: patchMap.get(row.cache_key) });
      }
      return row;
    }).filter(Boolean);

    if (!removed && !patched) return;
    fs.writeFileSync(localPath, JSON.stringify({
      version: parsed.version || 1,
      updatedAt: new Date().toISOString(),
      rows: kept,
    }, null, 2));
    console.log('Local fallback: removed', removed, 'row(s), patched', patched, 'topic row(s).');
  } catch (err) {
    console.warn('Local fallback cleanup skipped:', err.message || err);
  }
}

async function patchTopicRow(cacheKey, resultData) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  const res = await fetch(
    url + '/rest/v1/' + TABLE + '?cache_key=eq.' + encodeURIComponent(cacheKey),
    {
      method: 'PATCH',
      headers: Object.assign({}, headers, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ result_data: resultData }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('PATCH failed for ' + cacheKey + ': ' + res.status + ' ' + errText.slice(0, 200));
  }
  return true;
}

async function main() {
  if (!DRY_RUN && !EXECUTE) {
    console.log('Usage: node scripts/evict-all-legacy-curriculum-caches.js --dry-run|--execute');
    process.exit(1);
  }

  const rows = await fetchAllRows();
  console.log('Scanned cached_results rows:', rows.length);

  const keysToDelete = [];
  const topicPatches = [];
  let validCurriculum = 0;
  let skipped = 0;

  rows.forEach(function (row) {
    const action = classifyRow(row);
    if (action === 'valid') {
      validCurriculum++;
      return;
    }
    if (action === 'skip') {
      skipped++;
      return;
    }
    if (action === 'delete') {
      keysToDelete.push(row.cache_key);
      console.log('DELETE', row.phase, row.topic || row.query_text || '', row.cache_key.slice(0, 16) + '…');
      return;
    }
    if (action === 'strip') {
      const stripped = stripCurriculumFromTopicData(row.result_data);
      if (stripped) {
        topicPatches.push({
          cache_key: row.cache_key,
          result_data: stripped,
          topic: row.topic || row.query_text,
        });
        console.log('STRIP', row.topic || row.query_text || '', row.cache_key.slice(0, 16) + '…');
      }
    }
  });

  console.log('\nSummary:');
  console.log('  valid deep curriculum rows:', validCurriculum);
  console.log('  skipped (no curriculum payload):', skipped);
  console.log('  phase_c rows to DELETE:', keysToDelete.length);
  console.log('  topic rows to STRIP:', topicPatches.length);

  if (DRY_RUN) {
    console.log('\nDry run only — no changes applied.');
    return;
  }

  for (let i = 0; i < keysToDelete.length; i++) {
    const key = keysToDelete[i];
    const deleted = await cacheDb.deleteCachedRowByKey(key);
    console.log(deleted ? 'Deleted' : 'Delete miss', key.slice(0, 16) + '…');
  }

  for (let j = 0; j < topicPatches.length; j++) {
    const entry = topicPatches[j];
    if (cacheDb.isSupabaseCacheEnabled && cacheDb.isSupabaseCacheEnabled()) {
      await patchTopicRow(entry.cache_key, entry.result_data);
    }
    console.log('Stripped curriculum from topic row', entry.cache_key.slice(0, 16) + '…');
  }

  removeFromLocalFallback(keysToDelete, topicPatches);
  console.log('\nGlobal legacy curriculum eviction complete.');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
