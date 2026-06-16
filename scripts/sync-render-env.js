#!/usr/bin/env node
/**
 * Sync Waldrof environment variables to Render and trigger a deploy.
 *
 * Usage:
 *   set RENDER_API_KEY=rnd_xxxxxxxx
 *   node scripts/sync-render-env.js
 *
 * Optional:
 *   RENDER_SERVICE_ID=srv-...
 *   RENDER_SERVICE_NAME=waldrof
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_BASE = 'https://api.render.com/v1';
const SERVICE_NAME = String(process.env.RENDER_SERVICE_NAME || 'waldrof').trim();

const SYNC_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_URI',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
];

(function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
})();

function getApiKey() {
  const key = String(process.env.RENDER_API_KEY || '').trim();
  if (!key) {
    throw new Error(
      'Missing RENDER_API_KEY. Create one at https://dashboard.render.com/u/settings#api-keys'
    );
  }
  return key;
}

function getTargetUpdates() {
  const updates = {};
  const missing = [];

  SYNC_KEYS.forEach(function (key) {
    const value = String(process.env[key] || '').trim();
    if (!value) {
      missing.push(key);
      return;
    }
    updates[key] = value;
  });

  if (missing.length) {
    throw new Error(
      'Missing local values for: ' + missing.join(', ') + '. Add them to .env first.'
    );
  }

  // Keep server aliases aligned when only URI/public names are set.
  if (!updates.SUPABASE_URL && updates.SUPABASE_URI) {
    updates.SUPABASE_URL = updates.SUPABASE_URI;
  }
  if (!updates.SUPABASE_URI && updates.SUPABASE_URL) {
    updates.SUPABASE_URI = updates.SUPABASE_URL;
  }
  if (!updates.SUPABASE_ANON_KEY && updates.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    updates.SUPABASE_ANON_KEY = updates.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }
  if (!updates.NEXT_PUBLIC_SUPABASE_ANON_KEY && updates.SUPABASE_ANON_KEY) {
    updates.NEXT_PUBLIC_SUPABASE_ANON_KEY = updates.SUPABASE_ANON_KEY;
  }
  if (!updates.NEXT_PUBLIC_SUPABASE_URL && updates.SUPABASE_URL) {
    updates.NEXT_PUBLIC_SUPABASE_URL = updates.SUPABASE_URL;
  }

  return updates;
}

async function renderRequest(method, apiPath, body) {
  const res = await fetch(API_BASE + apiPath, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + getApiKey(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  }

  if (!res.ok) {
    const msg = (data && data.message) || text || res.statusText;
    throw new Error('Render API ' + method + ' ' + apiPath + ' failed (' + res.status + '): ' + msg);
  }
  return data;
}

async function listAllServices() {
  const services = [];
  let cursor = '';
  for (;;) {
    const q = '/services?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const page = await renderRequest('GET', q);
    if (!Array.isArray(page) || !page.length) break;
    page.forEach(function (item) {
      if (item && item.service) services.push(item.service);
    });
    const last = page[page.length - 1];
    const next = last && last.cursor;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return services;
}

async function resolveServiceId() {
  const explicit = String(process.env.RENDER_SERVICE_ID || '').trim();
  if (explicit) return explicit;

  const services = await listAllServices();
  const match = services.find(function (svc) {
    return String(svc.name || '').toLowerCase() === SERVICE_NAME.toLowerCase();
  });
  if (!match) {
    throw new Error('Service "' + SERVICE_NAME + '" not found in Render workspace.');
  }
  return match.id;
}

async function getCurrentEnvVars(serviceId) {
  const rows = await renderRequest('GET', '/services/' + serviceId + '/env-vars?limit=100');
  const map = {};
  if (Array.isArray(rows)) {
    rows.forEach(function (row) {
      const env = row && row.envVar;
      if (env && env.key) map[env.key] = env.value;
    });
  }
  return map;
}

function buildEnvPayload(current, updates) {
  const merged = Object.assign({}, current, updates);
  return Object.keys(merged).sort().map(function (key) {
    return { key: key, value: String(merged[key]) };
  });
}

async function waitForDeploy(serviceId, deployId) {
  const timeoutMs = 15 * 60 * 1000;
  const started = Date.now();
  for (;;) {
    const deploy = await renderRequest('GET', '/services/' + serviceId + '/deploys/' + deployId);
    const status = String((deploy && deploy.status) || '').toLowerCase();
    process.stdout.write('  deploy ' + deployId + ': ' + (status || 'unknown') + '\n');
    if (status === 'live') return deploy;
    if (status === 'build_failed' || status === 'update_failed' || status === 'canceled') {
      throw new Error('Deploy failed with status: ' + status);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for deploy to finish.');
    }
    await new Promise(function (r) { setTimeout(r, 10000); });
  }
}

async function main() {
  const updates = getTargetUpdates();

  console.log('Resolving Render service:', SERVICE_NAME);
  const serviceId = await resolveServiceId();
  console.log('Service ID:', serviceId);

  console.log('\nFetching current environment variables...');
  const current = await getCurrentEnvVars(serviceId);
  console.log('Current keys:', Object.keys(current).sort().join(', ') || '(none)');

  const payload = buildEnvPayload(current, updates);
  console.log('\nUpdating keys:', Object.keys(updates).sort().join(', '));
  await renderRequest('PUT', '/services/' + serviceId + '/env-vars', payload);
  console.log('Environment variables saved.');

  console.log('\nTriggering deploy...');
  const deploy = await renderRequest('POST', '/services/' + serviceId + '/deploys', {
    clearCache: 'clear',
  });
  const deployId = deploy && deploy.id;
  if (!deployId) throw new Error('Deploy response missing id.');
  console.log('Deploy started:', deployId);

  console.log('\nWaiting for deploy to go live...');
  await waitForDeploy(serviceId, deployId);
  console.log('\nDone! https://waldrof.onrender.com should now be running with updated env vars.');
}

main().catch(function (err) {
  console.error('\nSync failed:', err.message || err);
  process.exit(1);
});
