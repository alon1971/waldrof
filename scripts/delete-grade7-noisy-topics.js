#!/usr/bin/env node
'use strict';
/**
 * Remove incorrect grade-7 discovery-topic archive rows; keep "תקופת מגלי עולם".
 * Equivalent SQL:
 *   DELETE FROM public.cached_results
 *   WHERE topic IN ('מגלים', 'מסעות גילוי וכיתה ז׳',
 *     'מגלים - מסעות גילוי וגיל ההתבגרות המוקדם בכיתה ז׳');
 */
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
const TOPICS_TO_DELETE = [
  'מגלים',
  'מסעות גילוי וכיתה ז׳',
  'מגלים - מסעות גילוי וגיל ההתבגרות המוקדם בכיתה ז׳',
];
const TOPIC_KEEP = 'תקופת מגלי עולם';

const headers = {
  apikey: key,
  Authorization: 'Bearer ' + key,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function fetchByTopic(topic) {
  const res = await fetch(
    url + '/rest/v1/' + TABLE + '?select=cache_key,topic,grade_id,phase,created_at&topic=eq.' + encodeURIComponent(topic),
    { headers: headers }
  );
  const body = await res.json();
  if (!res.ok) throw new Error('Query failed (' + res.status + '): ' + JSON.stringify(body));
  return body;
}

async function main() {
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or API key in .env');
    process.exit(1);
  }

  console.log('=== Before delete ===');
  for (let i = 0; i < TOPICS_TO_DELETE.length; i++) {
    const rows = await fetchByTopic(TOPICS_TO_DELETE[i]);
    console.log('DELETE target:', TOPICS_TO_DELETE[i], '→', rows.length, 'row(s)');
    rows.forEach(function (r) { console.log(' ', JSON.stringify(r)); });
  }
  const kept = await fetchByTopic(TOPIC_KEEP);
  console.log('KEEP:', TOPIC_KEEP, '→', kept.length, 'row(s)');
  kept.forEach(function (r) { console.log(' ', JSON.stringify(r)); });

  const orParts = TOPICS_TO_DELETE.map(function (t) {
    return 'topic.eq.' + encodeURIComponent(t);
  });
  const delRes = await fetch(url + '/rest/v1/' + TABLE + '?or=(' + orParts.join(',') + ')', {
    method: 'DELETE',
    headers: headers,
  });
  const delText = await delRes.text();
  let deleted;
  try { deleted = JSON.parse(delText); } catch (e) { deleted = delText; }
  console.log('\nDELETE status:', delRes.status);
  console.log('Deleted rows:', JSON.stringify(deleted, null, 2));

  console.log('\n=== After delete ===');
  for (let j = 0; j < TOPICS_TO_DELETE.length; j++) {
    const after = await fetchByTopic(TOPICS_TO_DELETE[j]);
    console.log('Remaining', TOPICS_TO_DELETE[j] + ':', after.length);
  }
  const keptAfter = await fetchByTopic(TOPIC_KEEP);
  console.log('Kept', TOPIC_KEEP + ':', keptAfter.length);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
