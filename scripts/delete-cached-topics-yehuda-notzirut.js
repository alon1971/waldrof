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
const TOPICS_TO_DELETE = ['יהודה', 'נצרות'];

if (!url || !key) {
  console.error('Missing SUPABASE_URL or API key in .env');
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: 'Bearer ' + key,
  'Content-Type': 'application/json',
};

async function fetchRows(topic) {
  const res = await fetch(
    url + '/rest/v1/cached_results?select=cache_key,topic,grade_id,phase,query_text,created_at&topic=eq.' + encodeURIComponent(topic),
    { headers: headers }
  );
  const body = await res.json();
  if (!res.ok) {
    throw new Error('Query failed (' + res.status + '): ' + JSON.stringify(body));
  }
  return body;
}

async function deleteTopic(topic) {
  const res = await fetch(
    url + '/rest/v1/cached_results?topic=eq.' + encodeURIComponent(topic),
    {
      method: 'DELETE',
      headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
    }
  );
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body: body };
}

async function main() {
  for (const topic of TOPICS_TO_DELETE) {
    const before = await fetchRows(topic);
    console.log('\nTopic "' + topic + '" — rows before delete:', before.length);
    before.forEach(function (row, i) {
      console.log(
        '  ' + (i + 1) + '.',
        JSON.stringify({
          cache_key: row.cache_key,
          grade_id: row.grade_id,
          phase: row.phase,
          query_text: row.query_text,
          created_at: row.created_at,
        })
      );
    });

    const result = await deleteTopic(topic);
    console.log('DELETE status:', result.status);
    const deleted = Array.isArray(result.body) ? result.body.length : 0;
    console.log('Deleted rows:', deleted);

    const remaining = await fetchRows(topic);
    console.log('Remaining rows for topic "' + topic + '":', remaining.length);
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
