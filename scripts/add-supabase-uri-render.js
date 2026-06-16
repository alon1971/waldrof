#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SERVICE_ID = 'srv-d8ldhe8js32c7396nr80';
const API = 'https://api.render.com/v1';
const NEW_VAR = {
  key: 'SUPABASE_URI',
  value: String(process.env.SUPABASE_URI || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim(),
};

(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
})();

const token = String(process.env.RENDER_API_KEY || '').trim();
if (!token) {
  console.error('Set RENDER_API_KEY first (https://dashboard.render.com/u/settings#api-keys)');
  process.exit(1);
}
if (!NEW_VAR.value) {
  console.error('Set SUPABASE_URI (or SUPABASE_URL) in .env before running.');
  process.exit(1);
}

async function api(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.message) || text || res.statusText);
  return data;
}

async function main() {
  const rows = await api('GET', '/services/' + SERVICE_ID + '/env-vars?limit=100');
  const current = {};
  rows.forEach(function (row) {
    const env = row.envVar;
    if (env && env.key) current[env.key] = env.value;
  });

  current[NEW_VAR.key] = NEW_VAR.value;
  const payload = Object.keys(current).sort().map(function (key) {
    return { key: key, value: String(current[key]) };
  });

  await api('PUT', '/services/' + SERVICE_ID + '/env-vars', payload);
  console.log('Added', NEW_VAR.key);

  const deploy = await api('POST', '/services/' + SERVICE_ID + '/deploys', { clearCache: 'clear' });
  console.log('Deploy started:', deploy.id);

  for (;;) {
    const status = String((await api('GET', '/services/' + SERVICE_ID + '/deploys/' + deploy.id)).status || '');
    console.log('Status:', status);
    if (status === 'live') break;
    if (status === 'build_failed' || status === 'update_failed' || status === 'canceled') {
      throw new Error('Deploy failed: ' + status);
    }
    await new Promise(function (r) { setTimeout(r, 10000); });
  }

  console.log('Done — waldrof is live with SUPABASE_URI.');
}

main().catch(function (err) {
  console.error(err.message || err);
  process.exit(1);
});
