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
const TOPIC_DELETE = 'חבל';
const TOPIC_KEEP = 'קפיצה בחבל';

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
    url + '/rest/v1/cached_results?select=cache_key,topic,grade_id,phase,query_text&topic=eq.' + encodeURIComponent(topic),
    { headers: headers }
  );
  const body = await res.json();
  if (!res.ok) {
    throw new Error('Query failed (' + res.status + '): ' + JSON.stringify(body));
  }
  return body;
}

async function main() {
  const toDelete = await fetchRows(TOPIC_DELETE);
  const toKeep = await fetchRows(TOPIC_KEEP);
  console.log('Rows to DELETE (topic=' + TOPIC_DELETE + '):', JSON.stringify(toDelete, null, 2));
  console.log('Rows to KEEP (topic=' + TOPIC_KEEP + '):', JSON.stringify(toKeep, null, 2));

  const delRes = await fetch(
    url + '/rest/v1/cached_results?topic=eq.' + encodeURIComponent(TOPIC_DELETE),
    {
      method: 'DELETE',
      headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
    }
  );
  const deletedText = await delRes.text();
  let deleted;
  try { deleted = JSON.parse(deletedText); } catch (e) { deleted = deletedText; }
  console.log('DELETE status:', delRes.status);
  console.log('DELETE result:', JSON.stringify(deleted, null, 2));

  const afterKeep = await fetchRows(TOPIC_KEEP);
  console.log('After delete — kept rows:', JSON.stringify(afterKeep, null, 2));

  const remaining = await fetchRows(TOPIC_DELETE);
  console.log('Remaining topic=' + TOPIC_DELETE + ' rows:', remaining.length);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
