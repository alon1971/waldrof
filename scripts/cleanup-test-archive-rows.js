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
const TABLE = 'cached_results';
const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');

async function fetchMatching() {
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  const select = 'cache_key,phase,topic,query_text,created_at';
  const res = await fetch(url + '/rest/v1/' + TABLE + '?select=' + select, { headers });
  const all = await res.json();
  if (!Array.isArray(all)) {
    throw new Error('Fetch failed: ' + JSON.stringify(all).slice(0, 400));
  }
  return all.filter(function (row) {
    const topic = String(row.topic || '');
    if (topic.toLowerCase().includes('חבל')) return true;
    if (topic === 'אות') return true;
    return false;
  });
}

async function deleteRow(cacheKey) {
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    Prefer: 'return=minimal',
  };
  const res = await fetch(
    url + '/rest/v1/' + TABLE + '?cache_key=eq.' + encodeURIComponent(cacheKey),
    { method: 'DELETE', headers }
  );
  return res.status;
}

async function main() {
  if (!url || !key) {
    console.error('Missing SUPABASE_URL/SUPABASE_URI or service role key in .env');
    process.exit(1);
  }
  if (!DRY_RUN && !EXECUTE) {
    console.log('Usage: node scripts/cleanup-test-archive-rows.js --dry-run|--execute');
    process.exit(1);
  }

  const rows = await fetchMatching();
  console.log('Table: public.' + TABLE);
  console.log('Matching rows (topic contains חבל OR topic = אות):', rows.length);
  rows.forEach(function (r, i) {
    console.log(
      (i + 1) + '.',
      JSON.stringify({ topic: r.topic, phase: r.phase, cache_key: r.cache_key, created_at: r.created_at })
    );
  });

  if (DRY_RUN) {
    console.log('\nDry run only — no rows deleted.');
    return;
  }

  let deleted = 0;
  for (const row of rows) {
    const status = await deleteRow(row.cache_key);
    if (status >= 200 && status < 300) deleted++;
    else console.warn('Failed to delete', row.cache_key, 'status', status);
  }
  console.log('\nDeleted', deleted, 'of', rows.length, 'rows.');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
