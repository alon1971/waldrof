#!/usr/bin/env node
/**
 * Verify Supabase Project URL from .env, live /api/config, and optional Render env.
 *
 * Usage:
 *   node scripts/check-supabase-url.js
 *   RENDER_API_KEY=rnd_... node scripts/check-supabase-url.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SUPABASE_CLI_CANDIDATES = [
  process.env.SUPABASE_CLI,
  'C:\\Users\\alon1\\tools\\supabase.exe',
  'supabase',
].filter(Boolean);
const ROOT = path.join(__dirname, '..');
const RENDER_SERVICE_ID = 'srv-d8ldhe8js32c7396nr80';
const LIVE_CONFIG_URL = 'https://waldrof.onrender.com/api/config';

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
}

function normalizeUrl(url) {
  let value = String(url || '').trim().replace(/\/$/, '');
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value.replace(/^\/+/, '');
  return value.replace(/\/$/, '');
}

function getLocalSupabaseUrl() {
  return normalizeUrl(
    process.env.SUPABASE_URI ||
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
}

function maskKey(key) {
  const value = String(key || '').trim();
  if (!value) return '(missing)';
  if (value.length <= 12) return value.slice(0, 4) + '…';
  return value.slice(0, 8) + '…' + value.slice(-4);
}

function decodeJwtRef(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.ref || payload.project_ref || payload.iss || null;
  } catch (e) {
    return null;
  }
}

async function discoverSupabaseProjectsViaCli() {
  for (let i = 0; i < SUPABASE_CLI_CANDIDATES.length; i++) {
    const cli = SUPABASE_CLI_CANDIDATES[i];
    try {
      const { stdout } = await execFileAsync(cli, ['projects', 'list'], {
        timeout: 30000,
        windowsHide: true,
        env: process.env,
      });
      const refs = [];
      stdout.split(/\r?\n/).forEach(function (line) {
        if (!line.includes('|') || line.includes('REFERENCE ID') || line.includes('---')) return;
        const parts = line.split('|').map(function (segment) { return segment.trim(); });
        if (parts.length < 4) return;
        const ref = parts[3];
        if (/^[a-z0-9]{15,30}$/.test(ref)) refs.push(ref);
      });
      if (refs.length) {
        return { ok: true, cli: cli, projects: refs.map(function (ref) {
          return { ref: ref, url: 'https://' + ref + '.supabase.co' };
        }) };
      }
    } catch (err) {
      if (i === SUPABASE_CLI_CANDIDATES.length - 1) {
        return { ok: false, error: err.message || String(err) };
      }
    }
  }
  return { ok: false, error: 'Supabase CLI not found' };
}

async function checkDns(hostname) {
  try {
    const result = await dns.lookup(hostname);
    return { ok: true, address: result.address };
  } catch (err) {
    return { ok: false, code: err.code || err.message };
  }
}

async function checkHealth(url) {
  try {
    const res = await fetch(url + '/auth/v1/health', {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
    return { ok: res.ok, status: res.status, statusText: res.statusText };
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.message };
  }
}

async function fetchLiveConfig() {
  try {
    const res = await fetch(LIVE_CONFIG_URL, {
      signal: AbortSignal.timeout(25000),
    });
    const body = await res.json();
    return {
      ok: res.ok,
      status: res.status,
      supabaseUrl: normalizeUrl(body.data?.supabaseUrl),
      cloudConfigured: Boolean(body.meta?.cloudConfigured),
      anonKeyPrefix: maskKey(body.data?.supabaseAnonKey),
    };
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.message };
  }
}

async function fetchRenderSupabaseVars() {
  const token = String(process.env.RENDER_API_KEY || '').trim();
  if (!token) return { skipped: true, reason: 'RENDER_API_KEY not set' };

  try {
    const res = await fetch(
      'https://api.render.com/v1/services/' + RENDER_SERVICE_ID + '/env-vars?limit=100',
      {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + token,
        },
        signal: AbortSignal.timeout(15000),
      }
    );
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    const rows = JSON.parse(text);
    const keys = [
      'SUPABASE_URL',
      'SUPABASE_URI',
      'NEXT_PUBLIC_SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    ];
    const values = {};
    if (Array.isArray(rows)) {
      rows.forEach(function (row) {
        const env = row && row.envVar;
        if (env && keys.includes(env.key)) values[env.key] = env.value;
      });
    }
    return {
      ok: true,
      supabaseUrl: normalizeUrl(
        values.SUPABASE_URI || values.SUPABASE_URL || values.NEXT_PUBLIC_SUPABASE_URL
      ),
      anonKeyPrefix: maskKey(
        values.SUPABASE_ANON_KEY || values.NEXT_PUBLIC_SUPABASE_ANON_KEY
      ),
      keysFound: Object.keys(values).sort(),
    };
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.message };
  }
}

async function reportUrl(label, url) {
  console.log('\n[' + label + ']');
  if (!url) {
    console.log('  URL: (empty)');
    return;
  }
  console.log('  URL:', url);
  const host = new URL(url).hostname;
  const dnsResult = await checkDns(host);
  if (dnsResult.ok) {
    console.log('  DNS: OK ->', dnsResult.address);
  } else {
    console.log('  DNS: FAIL ->', dnsResult.code, '(NXDOMAIN / domain does not exist)');
  }
  const health = await checkHealth(url);
  if (health.ok) {
    console.log('  Health /auth/v1/health:', health.status, health.statusText);
  } else if (health.status) {
    console.log('  Health /auth/v1/health:', health.status, health.statusText);
  } else {
    console.log('  Health /auth/v1/health: FAIL ->', health.error);
  }
}

async function main() {
  loadDotEnv();

  const localUrl = getLocalSupabaseUrl();
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  const jwtRef = decodeJwtRef(anonKey);

  console.log('=== Waldrof Supabase URL check ===');
  console.log('Local anon key:', maskKey(anonKey));
  if (jwtRef) {
    console.log('JWT payload hint (ref/iss):', jwtRef);
  } else if (anonKey.startsWith('sb_publishable_') || anonKey.startsWith('sb_secret_')) {
    console.log('Key format: Supabase publishable/secret (not JWT — project ref is only in SUPABASE_URL)');
  }

  const cliDiscovery = await discoverSupabaseProjectsViaCli();
  if (cliDiscovery.ok && cliDiscovery.projects.length) {
    console.log('\n[Supabase CLI projects list]');
    cliDiscovery.projects.forEach(function (project) {
      console.log('  ' + project.ref + ' -> ' + project.url);
    });
  } else if (!cliDiscovery.ok) {
    console.log('\n[Supabase CLI projects list]');
    console.log('  Skipped:', cliDiscovery.error);
  }

  await reportUrl('Local .env', localUrl);

  console.log('\n[Live site /api/config] + Render env — fetching…]');
  const [live, render] = await Promise.all([fetchLiveConfig(), fetchRenderSupabaseVars()]);

  if (live.ok) {
    console.log('\n[Live waldrof.onrender.com /api/config]');
    console.log('  URL:', live.supabaseUrl || '(empty)');
    console.log('  cloudConfigured:', live.cloudConfigured);
    console.log('  anon key:', live.anonKeyPrefix);
    if (live.supabaseUrl) await reportUrl('Live DNS/health', live.supabaseUrl);
  } else {
    console.log('\n[Live waldrof.onrender.com /api/config]');
    console.log('  FAIL:', live.error);
  }

  if (render.skipped) {
    console.log('\n[Render env vars]');
    console.log('  Skipped:', render.reason);
    console.log('  Tip: set RENDER_API_KEY and re-run to compare production env.');
  } else if (render.ok) {
    console.log('\n[Render service env vars]');
    console.log('  keys:', render.keysFound.join(', ') || '(none)');
    console.log('  URL:', render.supabaseUrl || '(empty)');
    console.log('  anon key:', render.anonKeyPrefix);
    if (render.supabaseUrl) await reportUrl('Render DNS/health', render.supabaseUrl);
  } else {
    console.log('\n[Render env vars]');
    console.log('  FAIL:', render.error || render.status);
  }

  const urls = [localUrl, live.supabaseUrl, render.supabaseUrl].filter(Boolean);
  if (cliDiscovery.ok) {
    cliDiscovery.projects.forEach(function (project) {
      urls.push(project.url);
    });
  }
  const unique = [...new Set(urls)];
  console.log('\n=== Summary ===');
  if (!unique.length) {
    console.log('No Supabase URL found anywhere. Set SUPABASE_URL in .env and Render.');
    process.exit(1);
  }
  if (unique.length > 1) {
    console.log('WARNING: Different URLs in sources:', unique.join(' | '));
    if (cliDiscovery.ok && cliDiscovery.projects.length === 1) {
      console.log('Recommended live URL from Supabase CLI:', cliDiscovery.projects[0].url);
      console.log('Update .env then run: node scripts/sync-render-env.js');
    }
  } else {
    console.log('All sources agree on URL:', unique[0]);
  }

  const canonical = (cliDiscovery.ok && cliDiscovery.projects.length === 1)
    ? cliDiscovery.projects[0].url
    : (localUrl || unique[0]);
  let host;
  try {
    host = new URL(canonical).hostname;
  } catch (e) {
    console.log('\nInvalid canonical URL:', canonical);
    process.exit(1);
  }
  const dnsOk = await checkDns(host);
  if (!dnsOk.ok) {
    console.log('\nThe configured project ref does NOT resolve in DNS.');
    console.log('Get the correct Project URL from Supabase Dashboard:');
    console.log('  Project Settings -> API -> Project URL');
    console.log('Expected format: https://<project-ref>.supabase.co');
    process.exit(2);
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
