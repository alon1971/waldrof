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

async function trySelect(cols) {
  const res = await fetch(url + '/rest/v1/cached_results?select=' + encodeURIComponent(cols) + '&limit=1', {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  const text = await res.text();
  return { cols: cols, status: res.status, body: text.slice(0, 300) };
}

async function main() {
  const cols = [
    '*',
    'id',
    'cache_key',
    'phase',
    'grade_id',
    'grade_label',
    'query_text',
    'result_data',
    'created_at',
    'id,phase,grade_id,query_text,result_data',
  ];
  for (const c of cols) {
    const r = await trySelect(c);
    console.log(r.cols, '->', r.status, r.body);
  }

  const openapi = await fetch(url + '/rest/v1/', {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/openapi+json' },
  });
  const spec = await openapi.json();
  const def = spec.definitions && spec.definitions.cached_results;
  if (def) {
    console.log('\ncached_results columns:', Object.keys(def.properties || {}).join(', '));
  } else {
    console.log('\nNo cached_results in OpenAPI definitions');
    console.log('Tables:', Object.keys(spec.definitions || {}).filter(function (k) { return k.indexOf('cached') >= 0; }));
  }
}

main().catch(console.error);
