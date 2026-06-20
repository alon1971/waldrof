#!/usr/bin/env node
'use strict';
/**
 * Remove all cached_results rows for Grade 1 (כיתה א׳).
 * Deletes the grade portrait row plus any topic/archive rows tied to grade_id=1
 * or legacy Hebrew grade labels.
 *
 * Usage:
 *   node scripts/delete-grade1-cache.js --dry-run
 *   node scripts/delete-grade1-cache.js --execute
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
const GRADE_ID = '1';
const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');

const headers = {
  apikey: key,
  Authorization: 'Bearer ' + key,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

function gradeCacheKey() {
  return crypto.createHash('sha256').update('grade|' + GRADE_ID, 'utf8').digest('hex');
}

async function fetchGrade1Rows() {
  const params = new URLSearchParams();
  params.set(
    'select',
    'cache_key,phase,grade_id,grade_label,topic,query_text,created_at,hit_count'
  );
  params.set(
    'or',
    '(grade_id.eq.' + GRADE_ID + ',and(phase.eq.grade,grade_label.ilike.*כיתה א*),cache_key.eq.' + gradeCacheKey() + ')'
  );
  params.set('order', 'created_at.desc');

  const res = await fetch(url + '/rest/v1/' + TABLE + '?' + params.toString(), { headers: headers });
  const body = await res.json();
  if (!res.ok) {
    throw new Error('Query failed (' + res.status + '): ' + JSON.stringify(body));
  }
  return body;
}

function removeGrade1FromLocalFallback(deletedKeys) {
  const localPath = path.join(ROOT, 'data', 'cached_results.json');
  if (!fs.existsSync(localPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const keySet = new Set(deletedKeys);
    const kept = rows.filter(function (row) {
      if (!row || !row.cache_key) return false;
      if (keySet.has(row.cache_key)) return false;
      if (String(row.grade_id || '') === GRADE_ID) return false;
      const qt = String(row.query_text || '');
      const gl = String(row.grade_label || '');
      if (gl.indexOf('כיתה א') >= 0 || qt.indexOf('כיתה א') >= 0) return false;
      return true;
    });
    if (kept.length === rows.length) return;
    fs.writeFileSync(localPath, JSON.stringify({
      version: parsed.version || 1,
      updatedAt: new Date().toISOString(),
      rows: kept,
    }, null, 2));
    console.log('Local fallback: removed', rows.length - kept.length, 'grade-1 row(s) from', localPath);
  } catch (err) {
    console.warn('Local fallback cleanup skipped:', err.message || err);
  }
}

async function main() {
  if (!url || !key) {
    console.error('Missing SUPABASE_URL/SUPABASE_URI or API key in .env');
    process.exit(1);
  }
  if (!DRY_RUN && !EXECUTE) {
    console.log('Usage: node scripts/delete-grade1-cache.js --dry-run|--execute');
    process.exit(1);
  }

  console.log('Grade 1 cache key:', gradeCacheKey());
  const rows = await fetchGrade1Rows();
  console.log('Matching cached_results rows:', rows.length);
  rows.forEach(function (r, i) {
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

  const delRes = await fetch(
    url + '/rest/v1/' + TABLE + '?or=(grade_id.eq.' + GRADE_ID + ',and(phase.eq.grade,grade_label.ilike.*כיתה א*),cache_key.eq.' + gradeCacheKey() + ')',
    { method: 'DELETE', headers: headers }
  );
  const delText = await delRes.text();
  let deleted;
  try { deleted = JSON.parse(delText); } catch (e) { deleted = delText; }
  console.log('\nDELETE status:', delRes.status);
  if (Array.isArray(deleted)) {
    console.log('Deleted', deleted.length, 'row(s).');
    removeGrade1FromLocalFallback(deleted.map(function (r) { return r.cache_key; }));
  } else {
    console.log('DELETE response:', delText.slice(0, 500));
  }

  const remaining = await fetchGrade1Rows();
  console.log('Remaining grade-1 rows:', remaining.length);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
