#!/usr/bin/env node
'use strict';

/**
 * One-time OAuth setup for Drive uploads into a personal My Drive catalog.
 *
 * Service Accounts have no storage quota on personal My Drive — even when the
 * catalog folder is shared with the SA as Editor. Uploads must run as the
 * human folder owner (this script) or use a Shared Drive / Workspace delegation.
 *
 * Prerequisites (Google Cloud Console → APIs & Services):
 *   1. Enable Google Drive API
 *   2. Create OAuth client ID (Desktop app OR Web with redirect
 *      http://127.0.0.1:53682/oauth2callback)
 *   3. Add your Google account as a test user if the app is in Testing
 *
 * Usage:
 *   node scripts/google-drive-oauth-setup.js
 *   node scripts/google-drive-oauth-setup.js --write-env
 *   GOOGLE_DRIVE_OAUTH_CLIENT_ID=... GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=... \
 *     node scripts/google-drive-oauth-setup.js --write-env
 *
 * Then re-run: npm run organize-drive:apply
 */

require('../api/env');

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const REDIRECT_PORT = Number(process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_PORT || 53682);
const REDIRECT_URI = 'http://127.0.0.1:' + REDIRECT_PORT + '/oauth2callback';
const ENV_PATH = path.join(__dirname, '..', '.env');

function clean(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function parseArgs(argv) {
  const args = { writeEnv: false, clientId: '', clientSecret: '' };
  (argv || []).forEach(function (raw) {
    const a = String(raw || '').trim();
    if (a === '--write-env') args.writeEnv = true;
    else if (a.indexOf('--client-id=') === 0) args.clientId = a.slice('--client-id='.length);
    else if (a.indexOf('--client-secret=') === 0) args.clientSecret = a.slice('--client-secret='.length);
  });
  return args;
}

function upsertEnvKey(envPath, key, value) {
  let text = '';
  if (fs.existsSync(envPath)) text = fs.readFileSync(envPath, 'utf8');
  const line = key + '=' + value;
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=.*$', 'm');
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    if (text && text.charAt(text.length - 1) !== '\n') text += '\n';
    text += '\n# Google Drive user OAuth (uploads use owner quota — from google-drive-oauth-setup.js)\n'
      + line + '\n';
  }
  fs.writeFileSync(envPath, text, 'utf8');
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  if (platform === 'win32') cmd = 'start "" "' + url.replace(/"/g, '') + '"';
  else if (platform === 'darwin') cmd = 'open "' + url.replace(/"/g, '\\"') + '"';
  else cmd = 'xdg-open "' + url.replace(/"/g, '\\"') + '"';
  exec(cmd, function () { /* ignore */ });
}

function waitForAuthCode() {
  return new Promise(function (resolve, reject) {
    const server = http.createServer(function (req, res) {
      try {
        const u = new URL(req.url, 'http://127.0.0.1:' + REDIRECT_PORT);
        if (u.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const err = u.searchParams.get('error');
        const code = u.searchParams.get('code');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>OAuth error</h1><pre>' + err + '</pre>');
          server.close();
          reject(new Error('OAuth error: ' + err));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing code');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h1>Drive OAuth OK</h1><p>You can close this tab and return to the terminal.</p>'
        );
        server.close();
        resolve(code);
      } catch (e) {
        reject(e);
      }
    });
    server.on('error', reject);
    server.listen(REDIRECT_PORT, '127.0.0.1');
  });
}

async function exchangeCode(clientId, clientSecret, code) {
  const body = new URLSearchParams();
  body.set('code', code);
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  body.set('redirect_uri', REDIRECT_URI);
  body.set('grant_type', 'authorization_code');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('Token exchange failed (' + res.status + '): ' + text.slice(0, 400));
  }
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clientId = clean(
    args.clientId
    || process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID
    || process.env.GOOGLE_OAUTH_CLIENT_ID
  );
  const clientSecret = clean(
    args.clientSecret
    || process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET
    || process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );

  if (!clientId || !clientSecret) {
    console.error(
      'Missing OAuth client credentials.\n'
      + 'Create a Desktop (or Web) OAuth client in Google Cloud Console, then either:\n'
      + '  1) Put them in .env:\n'
      + '       GOOGLE_DRIVE_OAUTH_CLIENT_ID=...\n'
      + '       GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=...\n'
      + '     and re-run: node scripts/google-drive-oauth-setup.js --write-env\n'
      + '  2) Or pass flags:\n'
      + '       node scripts/google-drive-oauth-setup.js --write-env '
      + '--client-id=... --client-secret=...\n'
      + '\nRedirect URI that must be allowed on the client:\n  ' + REDIRECT_URI
    );
    process.exit(2);
  }

  console.log('[google-drive-oauth-setup] redirect URI:', REDIRECT_URI);
  console.log('[google-drive-oauth-setup] scope:', SCOPE);
  console.log('[google-drive-oauth-setup] Sign in as the owner of the catalog folder.');

  const authParams = new URLSearchParams();
  authParams.set('client_id', clientId);
  authParams.set('redirect_uri', REDIRECT_URI);
  authParams.set('response_type', 'code');
  authParams.set('scope', SCOPE);
  authParams.set('access_type', 'offline');
  authParams.set('prompt', 'consent');
  const authUrl = AUTH_URL + '?' + authParams.toString();

  console.log('\nOpen this URL if the browser does not open automatically:\n');
  console.log(authUrl);
  console.log('');

  const codePromise = waitForAuthCode();
  openBrowser(authUrl);
  const code = await codePromise;
  console.log('[google-drive-oauth-setup] got authorization code, exchanging…');

  const tokens = await exchangeCode(clientId, clientSecret, code);
  if (!tokens.refresh_token) {
    console.error(
      'No refresh_token returned. Revoke prior app access at '
        + 'https://myaccount.google.com/permissions and re-run with prompt=consent.'
    );
    process.exit(1);
  }

  console.log('[google-drive-oauth-setup] access_token acquired; refresh_token present.');

  if (args.writeEnv) {
    upsertEnvKey(ENV_PATH, 'GOOGLE_DRIVE_OAUTH_CLIENT_ID', clientId);
    upsertEnvKey(ENV_PATH, 'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET', clientSecret);
    upsertEnvKey(ENV_PATH, 'GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN', tokens.refresh_token);
    console.log('[google-drive-oauth-setup] Wrote GOOGLE_DRIVE_OAUTH_* to .env');
  } else {
    console.log('\nAdd these to .env (or re-run with --write-env):\n');
    console.log('GOOGLE_DRIVE_OAUTH_CLIENT_ID=' + clientId);
    console.log('GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=' + clientSecret);
    console.log('GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN=' + tokens.refresh_token);
  }

  console.log('\nNext: npm run organize-drive:apply');
}

main().catch(function (err) {
  console.error('[google-drive-oauth-setup] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
