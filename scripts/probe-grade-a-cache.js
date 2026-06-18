#!/usr/bin/env node
'use strict';
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

const url = String(process.env.SUPABASE_URL || process.env.SUPABASE_URI || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

async function main() {
  if (!url || !key) {
    console.log('Missing SUPABASE_URL or key');
    return;
  }
  console.log('Supabase URL:', url);

  const params = new URLSearchParams();
  params.set('select', 'cache_key,phase,grade_id,grade_label,query_text,created_at,hit_count');
  params.set('or', '(grade_id.eq.1,grade_label.ilike.*כיתה א*,query_text.ilike.*כיתה א*)');
  params.set('order', 'created_at.desc');
  params.set('limit', '20');

  const res = await fetch(url + '/rest/v1/cached_results?' + params.toString(), {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  console.log('Status:', res.status);
  const rows = await res.json();
  if (!Array.isArray(rows)) {
    console.log('Response:', JSON.stringify(rows).slice(0, 500));
    return;
  }
  console.log('Total rows for grade A:', rows.length);
  rows.forEach(function (r, i) {
    console.log(i + 1, JSON.stringify({
      cache_key: (r.cache_key || '').slice(0, 20),
      phase: r.phase,
      grade_id: r.grade_id,
      grade_label: r.grade_label,
      query_text: r.query_text,
      created_at: r.created_at,
    }));
  });

  const phases = {};
  const gradeIds = {};
  rows.forEach(function (r) {
    phases[r.phase || '(null)'] = (phases[r.phase || '(null)'] || 0) + 1;
    gradeIds[r.grade_id || '(null)'] = (gradeIds[r.grade_id || '(null)'] || 0) + 1;
  });
  console.log('Phase distribution:', phases);
  console.log('grade_id distribution:', gradeIds);

  const cache = require(path.join(ROOT, 'api', 'cache'));
  const testBody = { phase: 'grade', currentGrade: '1', gradeId: '1', gradeLabel: 'כיתה א׳' };
  const testKey = cache.buildCacheKey(testBody);
  console.log('New scheme cache key for grade 1:', testKey);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
