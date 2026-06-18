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
const content = 'בדיקת עמודות טבלת ידע — טקסט לדוגמה ארוך מספיק כדי לעבור את סף האורך המינימלי של המערכת לצורך הזרעת תוכן ראשוני.';

const candidates = [
  { content },
  { content, title: 'בדיקה' },
  { content, document_title: 'בדיקה' },
  { content, name: 'בדיקה' },
];

async function post(row) {
  const res = await fetch(url + '/rest/v1/knowledge_base', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: 'Bearer ' + key,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  return { keys: Object.keys(row).join(','), status: res.status, body: text.slice(0, 300) };
}

(async function () {
  for (const row of candidates) {
    console.log(await post(row));
  }
})();
