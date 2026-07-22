/**
 * Live-site Google Drive OAuth connect (folder-owner quota for uploads).
 *
 * Routes (registered in server.js):
 *   GET /api/auth/google-drive           — start OAuth (requires CRON_SECRET)
 *   GET /api/auth/google-drive/callback  — exchange code, persist refresh token
 *   GET /api/auth/google-drive/status    — connected? (requires CRON_SECRET)
 *
 * Prerequisites:
 *   GOOGLE_DRIVE_OAUTH_CLIENT_ID + GOOGLE_DRIVE_OAUTH_CLIENT_SECRET on Render
 *   Web OAuth client redirect:
 *     {APP_BASE_URL}/api/auth/google-drive/callback
 *   Run supabase/drive_oauth_credentials.sql once
 */
'use strict';

const crypto = require('crypto');
const env = require('./env');
const drive = require('./drive-catalog-sync');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Short-lived CSRF state → cron secret binding (in-process). */
const pendingStates = new Map();
const STATE_TTL_MS = 15 * 60 * 1000;

function clean(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function getOauthClientCredentials() {
  const clientId = clean(
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID
  );
  const clientSecret = clean(
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  if (!clientId || !clientSecret) return null;
  return { clientId: clientId, clientSecret: clientSecret };
}

function getDriveOauthRedirectUri() {
  const explicit = clean(process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI);
  if (explicit) return explicit;
  return env.getAppBaseUrl() + '/api/auth/google-drive/callback';
}

function assertCronAuthorized(req, query) {
  const secret = env.getCronSecret();
  if (!secret) {
    const err = new Error(
      'CRON_SECRET is not configured — refuse Drive OAuth admin routes'
    );
    err.statusCode = 503;
    throw err;
  }
  const auth = String((req && req.headers && req.headers.authorization) || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  const headerSecret = (req && req.headers && (
    req.headers['x-cron-secret'] || req.headers['X-Cron-Secret']
  )) || '';
  const querySecret = query && query.secret;
  if (auth === secret || headerSecret === secret || querySecret === secret) return;
  const err = new Error('Unauthorized — pass ?secret=CRON_SECRET (or Bearer / x-cron-secret)');
  err.statusCode = 401;
  throw err;
}

function pruneStates() {
  const now = Date.now();
  pendingStates.forEach(function (entry, key) {
    if (!entry || entry.expiresAt < now) pendingStates.delete(key);
  });
}

function createState(secret) {
  pruneStates();
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, {
    secret: secret,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  return state;
}

function consumeState(state) {
  pruneStates();
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlPage(title, bodyHtml) {
  return (
    '<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + escapeHtml(title) + '</title>'
    + '<style>'
    + 'body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:40rem;'
    + 'margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}'
    + 'a{color:#0b5fff}code{background:#f3f4f6;padding:.1rem .35rem;border-radius:4px}'
    + '.ok{color:#066a2b}.err{color:#b00020}ul{padding-right:1.2rem}'
    + '</style></head><body>'
    + bodyHtml
    + '</body></html>'
  );
}

function writeHtml(res, statusCode, title, bodyHtml) {
  const html = htmlPage(title, bodyHtml);
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function exchangeAuthorizationCode(clientId, clientSecret, code, redirectUri) {
  const body = new URLSearchParams();
  body.set('code', code);
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  body.set('redirect_uri', redirectUri);
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

async function fetchGoogleAccountEmail(accessToken) {
  if (!accessToken) return '';
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!res.ok) return '';
    const data = await res.json();
    return clean(data && data.email);
  } catch (e) {
    return '';
  }
}

function buildAuthUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams();
  params.set('client_id', clientId);
  params.set('redirect_uri', redirectUri);
  params.set('response_type', 'code');
  params.set('scope', DRIVE_SCOPE);
  params.set('access_type', 'offline');
  params.set('prompt', 'consent');
  params.set('include_granted_scopes', 'true');
  params.set('state', state);
  return AUTH_URL + '?' + params.toString();
}

async function handleStart(req, res, query) {
  assertCronAuthorized(req, query);
  const creds = getOauthClientCredentials();
  if (!creds) {
    writeHtml(
      res,
      503,
      'Drive OAuth — missing client',
      '<h1 class="err">חסרים פרטי OAuth Client</h1>'
      + '<p>הגדר ב-Render את '
      + '<code>GOOGLE_DRIVE_OAUTH_CLIENT_ID</code> ו-'
      + '<code>GOOGLE_DRIVE_OAUTH_CLIENT_SECRET</code>.</p>'
      + '<p>צור OAuth client מסוג <strong>Web application</strong> עם redirect:</p>'
      + '<p><code>' + escapeHtml(getDriveOauthRedirectUri()) + '</code></p>'
    );
    return;
  }

  const secret = env.getCronSecret();
  const state = createState(secret);
  const redirectUri = getDriveOauthRedirectUri();
  const authUrl = buildAuthUrl(creds.clientId, redirectUri, state);

  res.writeHead(302, {
    Location: authUrl,
    'Cache-Control': 'no-store',
  });
  res.end();
}

async function handleCallback(req, res, query) {
  const oauthError = clean(query && query.error);
  if (oauthError) {
    writeHtml(
      res,
      400,
      'Drive OAuth error',
      '<h1 class="err">שגיאת OAuth</h1><pre>' + escapeHtml(oauthError) + '</pre>'
      + '<p>' + escapeHtml(clean(query && query.error_description)) + '</p>'
    );
    return;
  }

  const state = clean(query && query.state);
  const stateEntry = consumeState(state);
  if (!stateEntry) {
    writeHtml(
      res,
      400,
      'Drive OAuth — invalid state',
      '<h1 class="err">state לא תקין או שפג תוקף</h1>'
      + '<p>התחל מחדש מ-'
      + '<code>/api/auth/google-drive?secret=…</code></p>'
    );
    return;
  }

  // Re-check the secret that started the flow (bound into state).
  const cronSecret = env.getCronSecret();
  if (!cronSecret || stateEntry.secret !== cronSecret) {
    writeHtml(
      res,
      401,
      'Drive OAuth — unauthorized',
      '<h1 class="err">Unauthorized</h1><p>CRON_SECRET mismatch.</p>'
    );
    return;
  }

  const code = clean(query && query.code);
  if (!code) {
    writeHtml(res, 400, 'Drive OAuth — missing code', '<h1 class="err">Missing code</h1>');
    return;
  }

  const creds = getOauthClientCredentials();
  if (!creds) {
    writeHtml(
      res,
      503,
      'Drive OAuth — missing client',
      '<h1 class="err">חסרים CLIENT_ID / CLIENT_SECRET</h1>'
    );
    return;
  }

  const redirectUri = getDriveOauthRedirectUri();
  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(
      creds.clientId,
      creds.clientSecret,
      code,
      redirectUri
    );
  } catch (exchangeErr) {
    writeHtml(
      res,
      502,
      'Drive OAuth — exchange failed',
      '<h1 class="err">החלפת code נכשלה</h1>'
      + '<pre>' + escapeHtml(exchangeErr && exchangeErr.message ? exchangeErr.message : exchangeErr)
      + '</pre>'
    );
    return;
  }

  if (!tokens.refresh_token) {
    writeHtml(
      res,
      400,
      'Drive OAuth — no refresh token',
      '<h1 class="err">לא התקבל refresh_token</h1>'
      + '<p>בטל גישה קודמת ב-'
      + '<a href="https://myaccount.google.com/permissions" rel="noopener">myaccount.google.com/permissions</a>'
      + ' והתחבר שוב (prompt=consent).</p>'
    );
    return;
  }

  const accountEmail = await fetchGoogleAccountEmail(tokens.access_token);
  let persisted = { supabase: false, memory: true };
  try {
    persisted = await drive.saveDriveOauthCredentials({
      refreshToken: tokens.refresh_token,
      accountEmail: accountEmail,
    });
  } catch (persistErr) {
    console.warn(
      '[google-drive-oauth] persist failed:',
      persistErr && persistErr.message ? persistErr.message : persistErr
    );
    // Still apply in-process so this dyno can write until restart.
    process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN = tokens.refresh_token;
    persisted = {
      supabase: false,
      memory: true,
      error: persistErr && persistErr.message ? persistErr.message : String(persistErr),
    };
  }

  const syncUrl = env.getAppBaseUrl()
    + '/api/cron/drive-catalog-sync?secret='
    + encodeURIComponent(cronSecret);
  const statusUrl = env.getAppBaseUrl()
    + '/api/auth/google-drive/status?secret='
    + encodeURIComponent(cronSecret);

  writeHtml(
    res,
    200,
    'Drive OAuth OK',
    '<h1 class="ok">חיבור Google Drive הצליח</h1>'
    + (accountEmail
      ? '<p>חשבון: <strong>' + escapeHtml(accountEmail) + '</strong></p>'
      : '')
    + '<ul>'
    + '<li>refresh_token נשמר בזיכרון השרת'
    + (persisted.supabase ? ' וב-Supabase' : ' (Supabase: לא נשמר — הרץ supabase/drive_oauth_credentials.sql)')
    + '</li>'
    + '<li>העלאות/כתיבות Drive ירוצו במכסת בעל התיקייה</li>'
    + '</ul>'
    + (persisted.error
      ? '<p class="err">אזהרת שמירה: ' + escapeHtml(persisted.error) + '</p>'
      : '')
    + '<p><a href="' + escapeHtml(syncUrl) + '">הפעל סנכרון קטלוג Drive עכשיו</a></p>'
    + '<p><a href="' + escapeHtml(statusUrl) + '">בדיקת סטטוס חיבור</a></p>'
    + '<p style="color:#666;font-size:.9rem">צינור organize-and-convert המלא (PDF→Docs) נשאר CLI מקומי; '
    + 'באתר החי הסנכרון הוא catalog sync דרך הקישור למעלה.</p>'
  );
}

async function handleStatus(req, res, query) {
  assertCronAuthorized(req, query);
  if (typeof drive.ensureOauthRefreshTokenLoaded === 'function') {
    await drive.ensureOauthRefreshTokenLoaded();
  }
  const oauth = typeof drive.getDriveOauthUserCredentials === 'function'
    ? drive.getDriveOauthUserCredentials()
    : null;
  const client = getOauthClientCredentials();
  writeJson(res, 200, {
    ok: true,
    connected: Boolean(oauth && oauth.refreshToken),
    hasClientId: Boolean(client && client.clientId),
    hasClientSecret: Boolean(client && client.clientSecret),
    redirectUri: getDriveOauthRedirectUri(),
    accountEmail: (typeof drive.getCachedDriveOauthAccountEmail === 'function'
      ? drive.getCachedDriveOauthAccountEmail()
      : '') || null,
    authModeHint: typeof drive.describeDriveAuthMode === 'function'
      ? drive.describeDriveAuthMode({ write: true })
      : null,
  });
}

/**
 * Node HTTP handler (server.js).
 */
async function handleRequest(req, res, pathname, query) {
  const q = query || {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    if (pathname === '/api/auth/google-drive' || pathname === '/api/auth/google-drive/') {
      await handleStart(req, res, q);
      return;
    }
    if (pathname === '/api/auth/google-drive/callback') {
      await handleCallback(req, res, q);
      return;
    }
    if (pathname === '/api/auth/google-drive/status') {
      await handleStatus(req, res, q);
      return;
    }
    writeJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 500;
    if (String(req.headers.accept || '').indexOf('text/html') >= 0 || status === 401 || status === 503) {
      writeHtml(
        res,
        status,
        'Drive OAuth',
        '<h1 class="err">' + escapeHtml(err && err.message ? err.message : err) + '</h1>'
      );
      return;
    }
    writeJson(res, status, { error: err && err.message ? err.message : String(err) });
  }
}

module.exports = {
  handleRequest,
  getDriveOauthRedirectUri,
  getOauthClientCredentials,
  DRIVE_SCOPE,
};
