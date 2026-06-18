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

const url = (process.env.SUPABASE_URL || process.env.SUPABASE_URI || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const knowledgeIngest = require('../api/knowledge-ingest');
const { SEED_ENTRIES } = require('../api/knowledge-seed');

async function main() {
  if (!url || !key) {
    console.error('Missing Supabase credentials in .env');
    process.exit(1);
  }

  const force = process.argv.includes('--force');
  const countRes = await fetch(url + '/rest/v1/knowledge_base?select=id&limit=1', {
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Prefer: 'count=exact',
    },
  });
  const range = countRes.headers.get('content-range') || '';
  const match = range.match(/\/(\d+)$/);
  const existing = match ? parseInt(match[1], 10) : 0;

  if (existing > 0 && !force) {
    console.log('Table already has', existing, 'rows. Use --force to insert starter content anyway.');
    return;
  }

  let inserted = 0;
  for (let i = 0; i < SEED_ENTRIES.length; i++) {
    const entry = SEED_ENTRIES[i];
    const result = await knowledgeIngest.insertKnowledgeText(entry.content, {
      title: entry.title,
      author: entry.author,
      origin: 'auto_seed',
    });
    inserted += result.inserted || 0;
    console.log('•', entry.title, '→', result.inserted || 0, 'chunk(s)');
  }

  console.log('\nDone. Inserted', inserted, 'chunks total.');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
