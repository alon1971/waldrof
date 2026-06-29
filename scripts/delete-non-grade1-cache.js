#!/usr/bin/env node
'use strict';
/**
 * Remove all cached_results rows for grades 2–8 (כיתה ב׳ through ח׳).
 * STRICTLY preserves Grade 1 (כיתה א׳) — no rows with grade_id=1 or כיתה א labels are touched.
 *
 * Usage:
 *   node scripts/delete-non-grade1-cache.js --dry-run
 *   node scripts/delete-non-grade1-cache.js --execute
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const url = String(process.env.SUPABASE_URL || process.env.SUPABASE_URI || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const TABLE = 'cached_results';
const GRADE1_ID = '1';
const OTHER_GRADE_IDS = ['2', '3', '4', '5', '6', '7', '8'];
const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');

const headers = {
  apikey: key,
  Authorization: 'Bearer ' + key,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

function gradeCacheKey(gradeId) {
  return crypto.createHash('sha256').update('grade|' + gradeId, 'utf8').digest('hex');
}

const GRADE1_CACHE_KEY = gradeCacheKey(GRADE1_ID);

function isGrade1Row(row) {
  if (!row) return false;
  if (String(row.grade_id || '') === GRADE1_ID) return true;
  if (String(row.cache_key || '') === GRADE1_CACHE_KEY) return true;
  const gl = String(row.grade_label || '');
  const qt = String(row.query_text || '');
  if (gl.indexOf('כיתה א') >= 0 || qt.indexOf('כיתה א') >= 0) return true;
  return false;
}

function isOtherGradeRow(row) {
  if (!row || isGrade1Row(row)) return false;
  const gid = String(row.grade_id || '').trim();
  if (OTHER_GRADE_IDS.indexOf(gid) >= 0) return true;
  if (row.phase === 'grade') {
    const gl = String(row.grade_label || '');
    if (gl && gl.indexOf('כיתה א') < 0 && /כיתה\s+[ב-ח]/.test(gl)) return true;
  }
  const gl = String(row.grade_label || '');
  const qt = String(row.query_text || '');
  if (/כיתה\s+[ב-ח]/.test(gl) || /כיתה\s+[ב-ח]/.test(qt)) return true;
  return false;
}

async function fetchAllRows() {
  const params = new URLSearchParams();
  params.set(
    'select',
    'cache_key,phase,grade_id,grade_label,topic,query_text,created_at,hit_count'
  );
  params.set('order', 'created_at.desc');
  params.set('limit', '5000');

  const res = await fetch(url + '/rest/v1/' + TABLE + '?' + params.toString(), { headers: headers });
  const body = await res.json();
  if (!res.ok) {
    throw new Error('Query failed (' + res.status + '): ' + JSON.stringify(body));
  }
  return Array.isArray(body) ? body : [];
}

function removeFromLocalFallback(deletedKeys) {
  const localPath = path.join(ROOT, 'data', 'cached_results.json');
  if (!fs.existsSync(localPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const keySet = new Set(deletedKeys);
    const kept = rows.filter(function (row) {
      if (!row || !row.cache_key) return false;
      if (keySet.has(row.cache_key)) return false;
      if (isOtherGradeRow(row)) return false;
      return true;
    });
    if (kept.length === rows.length) return;
    fs.writeFileSync(localPath, JSON.stringify({
      version: parsed.version || 1,
      updatedAt: new Date().toISOString(),
      rows: kept,
    }, null, 2));
    console.log('Local fallback: removed', rows.length - kept.length, 'non-grade-1 row(s) from', localPath);
  } catch (err) {
    console.warn('Local fallback cleanup skipped:', err.message || err);
  }
}

async function deleteRowByKey(cacheKey) {
  const res = await fetch(
    url + '/rest/v1/' + TABLE + '?cache_key=eq.' + encodeURIComponent(cacheKey),
    { method: 'DELETE', headers: headers }
  );
  return res.status;
}

async function main() {
  if (!url || !key) {
    console.error('Missing SUPABASE_URL/SUPABASE_URI or API key in .env');
    process.exit(1);
  }
  if (!DRY_RUN && !EXECUTE) {
    console.log('Usage: node scripts/delete-non-grade1-cache.js --dry-run|--execute');
    process.exit(1);
  }

  console.log('Grade 1 cache key (PRESERVED):', GRADE1_CACHE_KEY);
  const allRows = await fetchAllRows();
  console.log('Total cached_results rows fetched:', allRows.length);

  const toDelete = allRows.filter(isOtherGradeRow);
  const grade1Rows = allRows.filter(isGrade1Row);
  console.log('Grade 1 rows (will NOT be deleted):', grade1Rows.length);
  console.log('Other-grade rows to delete:', toDelete.length);

  toDelete.forEach(function (r, i) {
    console.log(
      (i + 1) + '.',
      JSON.stringify({
        cache_key: r.cache_key,
        phase: r.phase,
        grade_id: r.grade_id,
        grade_label: r.grade_label,
        topic: r.topic,
        query_text: r.query_text,
        created_at: r.created_at,
      })
    );
  });

  if (DRY_RUN) {
    console.log('\nDry run only — no rows deleted.');
    return;
  }

  let deleted = 0;
  for (const row of toDelete) {
    const status = await deleteRowByKey(row.cache_key);
    if (status >= 200 && status < 300) deleted++;
    else console.warn('Failed to delete', row.cache_key, 'status', status);
  }
  console.log('\nDeleted', deleted, 'of', toDelete.length, 'row(s).');
  removeFromLocalFallback(toDelete.map(function (r) { return r.cache_key; }));

  const remaining = (await fetchAllRows()).filter(isOtherGradeRow);
  console.log('Remaining other-grade rows:', remaining.length);
  const grade1Remaining = (await fetchAllRows()).filter(isGrade1Row);
  console.log('Grade 1 rows still intact:', grade1Remaining.length);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
