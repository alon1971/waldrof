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
  const res = await fetch(url + '/rest/v1/cached_results?select=id,query,created_at&order=created_at.desc&limit=30', {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  console.log('Status:', res.status);
  const rows = await res.json();
  if (!Array.isArray(rows)) {
    console.log(rows);
    return;
  }
  console.log('Row count:', rows.length);
  rows.forEach(function (r, i) {
    const q = String(r.query || '');
    console.log(i + 1, JSON.stringify({
      id: r.id,
      query_preview: q.slice(0, 120),
      created_at: r.created_at,
    }));
  });

  const gradeA = rows.filter(function (r) {
    const q = String(r.query || '');
    return q.indexOf('כיתה א') >= 0 || q.indexOf('grade') >= 0 && q.indexOf('1') >= 0;
  });
  console.log('\nGrade-A related rows:', gradeA.length);
  gradeA.forEach(function (r) {
    console.log(JSON.stringify({ id: r.id, query: r.query, created_at: r.created_at }));
  });
}

main().catch(console.error);
