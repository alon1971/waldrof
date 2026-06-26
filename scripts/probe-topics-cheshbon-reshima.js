#!/usr/bin/env node
'use strict';
// READ-ONLY probe: inspects cache rows for "חשבון" and "רישום צורה" and
// checks whether a standalone `topic_master` table exists. Deletes nothing.
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
const TOPICS = ['חשבון', 'רישום צורה'];

if (!url || !key) {
  console.error('Missing SUPABASE_URL or API key in .env');
  process.exit(1);
}

const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

async function getJson(pathQuery) {
  const res = await fetch(url + pathQuery, { headers: headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body: body };
}

async function main() {
  console.log('SUPABASE_URL:', url);

  // 1) Does a standalone `topic_master` table exist?
  const tm = await getJson('/rest/v1/topic_master?select=*&limit=1');
  console.log('\n[table check] GET /rest/v1/topic_master ->', tm.status);
  if (tm.status === 200) {
    console.log('  topic_master TABLE EXISTS. Sample columns:',
      Array.isArray(tm.body) && tm.body[0] ? Object.keys(tm.body[0]).join(', ') : '(empty table)');
  } else {
    const msg = tm.body && (tm.body.message || tm.body.code) ? (tm.body.message || tm.body.code) : String(tm.body).slice(0, 160);
    console.log('  topic_master table NOT directly accessible ->', msg);
  }

  // 2) Rows in cached_results for each target topic, grouped by phase + grade_id.
  for (const topic of TOPICS) {
    const q = '/rest/v1/cached_results?select=cache_key,phase,grade_id,grade_label,topic,query_text,created_at&topic=eq.' + encodeURIComponent(topic);
    const r = await getJson(q);
    console.log('\n[cached_results] topic = "' + topic + '" ->', r.status, '| rows:', Array.isArray(r.body) ? r.body.length : '(err)');
    if (Array.isArray(r.body)) {
      const byPhase = {};
      r.body.forEach(function (row) {
        const p = row.phase || '(null)';
        byPhase[p] = (byPhase[p] || 0) + 1;
        console.log('   -', JSON.stringify({
          cache_key: (row.cache_key || '').slice(0, 24),
          phase: row.phase,
          grade_id: row.grade_id,
          grade_label: row.grade_label,
          query_text: row.query_text,
          created_at: row.created_at,
        }));
      });
      console.log('   phase distribution:', JSON.stringify(byPhase));
    } else {
      console.log('   body:', JSON.stringify(r.body).slice(0, 200));
    }
  }
}

main().catch(function (err) { console.error(err); process.exit(1); });
