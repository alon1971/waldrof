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
const key = process.env.SUPABASE_ANON_KEY || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function probeTable(table, useService) {
  const k = useService && serviceKey ? serviceKey : key;
  const res = await fetch(url + '/rest/v1/' + table + '?select=*&limit=1', {
    headers: { apikey: k, Authorization: 'Bearer ' + k },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body };
}

async function probeBuckets() {
  const res = await fetch(url + '/storage/v1/bucket', {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  const body = await res.json().catch(function () { return []; });
  return { status: res.status, body };
}

async function main() {
  console.log('URL:', url || '(missing)');
  const tables = ['community_materials', 'cached_results', 'knowledge_base'];
  for (const table of tables) {
    const r = await probeTable(table, false);
    if (r.status === 200 && Array.isArray(r.body)) {
      const sample = r.body[0];
      console.log(table + ': OK (anon), rows sample:', sample ? Object.keys(sample).join(', ') : '(empty table)');
    } else {
      const msg = r.body && (r.body.message || r.body.code) ? (r.body.message || r.body.code) : String(r.body).slice(0, 120);
      console.log(table + ': anon ' + r.status + ' ->', msg);
      if (serviceKey) {
        const s = await probeTable(table, true);
        const sm = s.body && (s.body.message || s.body.code) ? (s.body.message || s.body.code) : (Array.isArray(s.body) ? 'rows=' + s.body.length : String(s.body).slice(0, 120));
        console.log('  service role:', s.status, '->', sm);
      }
    }
  }
  const buckets = await probeBuckets();
  const names = (Array.isArray(buckets.body) ? buckets.body : []).map(function (b) { return b.name || b.id; }).filter(Boolean);
  console.log('storage buckets:', buckets.status, names.length ? names.join(', ') : '(none or denied)');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
