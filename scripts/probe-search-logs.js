#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
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

async function probe(table) {
  const res = await fetch(url + '/rest/v1/' + table + '?select=*&limit=1', {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { table: table, status: res.status, body: body };
}

async function main() {
  console.log('URL:', url || '(missing)');
  for (const table of ['search_logs', 'profiles', 'user_subscriptions', 'cached_results']) {
    const r = await probe(table);
    const msg = r.body && r.body.message
      ? r.body.message
      : (Array.isArray(r.body) ? 'ok rows=' + r.body.length : String(r.body).slice(0, 100));
    console.log(r.table, r.status, msg);
    if (Array.isArray(r.body) && r.body[0]) {
      console.log('  columns:', Object.keys(r.body[0]).join(', '));
    }
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
