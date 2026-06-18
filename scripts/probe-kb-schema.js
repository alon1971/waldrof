#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  });
}
const url = (process.env.SUPABASE_URL || process.env.SUPABASE_URI || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
fetch(url + '/rest/v1/knowledge_base?select=*&limit=1', {
  headers: { apikey: key, Authorization: 'Bearer ' + key },
}).then(async function (res) {
  const text = await res.text();
  console.log('status', res.status);
  console.log(text.slice(0, 500));
}).catch(console.error);
