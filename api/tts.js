/**
 * POST /api/tts — Google Cloud Text-to-Speech synthesis.
 * GET  /api/tts — configuration status (no secrets).
 *
 * Body: { text: string, lang?: 'he' | 'en' | 'he-IL' | 'en-US' }
 * Auth: service-account JWT (GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON /
 *       GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_BASE64 / service-account.json)
 *       with scope cloud-platform.
 * Note: Cloud TTS does not accept API keys for text:synthesize.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const driveCatalogSync = require('./drive-catalog-sync');

const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Plain-text budget before SSML wrapping (Cloud TTS input limit is ~5000 bytes). */
const MAX_INPUT_BYTES = 3500;
const SSML_BREAK = '<break time="300ms"/>';
const SSML_PROSODY_RATE = '0.95';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-email',
  'Cache-Control': 'no-store, max-age=0',
};

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(statusCode).json(payload);
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizeLang(lang) {
  const code = String(lang || '').trim().toLowerCase();
  if (code.indexOf('en') === 0) {
    return {
      languageCode: 'en-US',
      voices: ['en-US-Wavenet-F', 'en-US-Neural2-F', 'en-US-Wavenet-A', 'en-US-Standard-C'],
    };
  }
  return {
    languageCode: 'he-IL',
    // Prefer human-like Wavenet voices for Hebrew.
    voices: ['he-IL-Wavenet-A', 'he-IL-Wavenet-B', 'he-IL-Standard-A', 'he-IL-Standard-B'],
  };
}

function cleanTtsText(raw) {
  var text = String(raw || '');
  if (!text.trim()) return '';
  text = text.replace(/\r\n|\r/g, '\n');
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
  }
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/[*_`~#>]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[|{}[\]\\^=]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function escapeSsml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build SSML with subtle pauses for colons, dashes, and line breaks,
 * and a slightly relaxed prosody rate for natural reading.
 */
function buildSsml(plainText) {
  var text = cleanTtsText(plainText);
  if (!text) return '';
  var escaped = escapeSsml(text);
  var withBreaks = escaped
    .replace(/\n+/g, SSML_BREAK)
    .replace(/:/g, SSML_BREAK)
    .replace(/—|–/g, SSML_BREAK)
    .replace(/\s-\s/g, ' ' + SSML_BREAK + ' ')
    .replace(/-{2,}/g, SSML_BREAK)
    .replace(/(?:<break time="300ms"\/>\s*){2,}/g, SSML_BREAK)
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (
    '<speak><prosody rate="' + SSML_PROSODY_RATE + '">'
    + withBreaks
    + '</prosody></speak>'
  );
}

function splitTextForTts(text) {
  const clean = cleanTtsText(text);
  if (!clean) return [];
  if (Buffer.byteLength(clean, 'utf8') <= MAX_INPUT_BYTES) return [clean];

  const parts = [];
  const sentences = clean.match(/[^.!?…。؟\n]+[.!?…。؟\n]+|[^.!?…。؟\n]+$/g) || [clean];
  let buf = '';
  sentences.forEach(function (sentence) {
    const next = buf ? buf + ' ' + sentence : sentence;
    if (Buffer.byteLength(next, 'utf8') > MAX_INPUT_BYTES) {
      if (buf) parts.push(buf);
      if (Buffer.byteLength(sentence, 'utf8') > MAX_INPUT_BYTES) {
        let chunk = '';
        for (let i = 0; i < sentence.length; i++) {
          const trial = chunk + sentence[i];
          if (Buffer.byteLength(trial, 'utf8') > MAX_INPUT_BYTES) {
            if (chunk) parts.push(chunk);
            chunk = sentence[i];
          } else {
            chunk = trial;
          }
        }
        buf = chunk;
      } else {
        buf = sentence;
      }
    } else {
      buf = next;
    }
  });
  if (buf) parts.push(buf);
  return parts;
}

function tryParseServiceAccountObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.client_email && parsed.private_key) return parsed;
  } catch (e) { /* ignore */ }
  return null;
}

function loadServiceAccount() {
  const fromEnv = tryParseServiceAccountObject(
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON
    || process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  );
  if (fromEnv) return fromEnv;

  const candidates = [
    String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE || '').trim(),
    path.join(process.cwd(), 'service-account.json'),
    path.join(__dirname, '..', 'service-account.json'),
  ].filter(Boolean);

  for (let i = 0; i < candidates.length; i++) {
    try {
      if (!fs.existsSync(candidates[i])) continue;
      const parsed = tryParseServiceAccountObject(fs.readFileSync(candidates[i], 'utf8'));
      if (parsed) return parsed;
    } catch (e) { /* ignore */ }
  }
  return null;
}

function resolveServiceAccount() {
  const saFromDrive = typeof driveCatalogSync.parseServiceAccountJson === 'function'
    ? driveCatalogSync.parseServiceAccountJson()
    : null;
  if (saFromDrive && saFromDrive.client_email && saFromDrive.private_key) {
    return saFromDrive;
  }
  return loadServiceAccount();
}

function projectNumberFromError(message) {
  const m = String(message || '').match(/project\s+(\d{6,})/i);
  return m ? m[1] : '';
}

function classifyTtsError(err) {
  const message = String((err && err.message) || err || '');
  const status = (err && err.statusCode) || 500;
  const project = projectNumberFromError(message) || '313816048472';
  const enableApiUrl =
    'https://console.developers.google.com/apis/api/texttospeech.googleapis.com/overview?project='
    + project;

  if (/has not been used|is disabled|SERVICE_DISABLED|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message)
    || (/Cloud Text-to-Speech API/i.test(message) && status === 403)) {
    return {
      statusCode: 503,
      reason: 'api_not_enabled',
      error:
        'Cloud Text-to-Speech API is not enabled for this GCP project. Enable it at '
        + enableApiUrl
        + ' then retry.',
      enableApiUrl: enableApiUrl,
    };
  }
  if (/service account OAuth token|not configured|API keys are not supported/i.test(message)) {
    return {
      statusCode: 503,
      reason: 'missing_service_account',
      error: message,
      enableApiUrl: enableApiUrl,
    };
  }
  if (/token exchange|service-account auth failed/i.test(message)) {
    return {
      statusCode: 503,
      reason: 'service_account_auth_failed',
      error: message,
      enableApiUrl: enableApiUrl,
    };
  }
  return {
    statusCode: status >= 400 && status < 600 ? status : 500,
    reason: 'tts_failed',
    error: message || 'TTS failed',
    enableApiUrl: enableApiUrl,
  };
}

function getTtsStatus() {
  const sa = resolveServiceAccount();
  const projectId = sa && sa.project_id ? String(sa.project_id) : '';
  const email = sa && sa.client_email ? String(sa.client_email) : '';
  return {
    ok: true,
    configured: Boolean(sa),
    auth: sa ? 'service_account' : 'missing',
    projectId: projectId || null,
    serviceAccountEmail: email || null,
    enableApiUrl: projectId
      ? ('https://console.developers.google.com/apis/api/texttospeech.googleapis.com/overview?project='
        + encodeURIComponent(projectId))
      : 'https://console.developers.google.com/apis/api/texttospeech.googleapis.com/overview',
    note:
      'Cloud TTS requires GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON (or _BASE64) and '
      + 'Cloud Text-to-Speech API enabled on that GCP project. API keys are not supported.',
  };
}

function createServiceAccountJwt(sa) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const segments = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claim));
  const sign = crypto.createSign('RSA-SHA256').update(segments).sign(sa.private_key, 'base64');
  const signature = sign.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return segments + '.' + signature;
}

async function exchangeServiceAccountJwt(sa) {
  const jwt = createServiceAccountJwt(sa);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='
      + encodeURIComponent(jwt),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('TTS token exchange failed (' + res.status + '): ' + text.slice(0, 300));
    err.statusCode = res.status === 401 || res.status === 403 ? 503 : 502;
    throw err;
  }
  const data = JSON.parse(text);
  if (!data.access_token) {
    throw new Error('TTS token exchange returned no access_token');
  }
  return data.access_token;
}

async function resolveTtsAuth() {
  const sa = resolveServiceAccount();

  if (sa && sa.client_email && sa.private_key) {
    try {
      const accessToken = (typeof driveCatalogSync.exchangeServiceAccountJwt === 'function')
        ? await driveCatalogSync.exchangeServiceAccountJwt(sa, CLOUD_PLATFORM_SCOPE, '')
        : await exchangeServiceAccountJwt(sa);
      return { type: 'bearer', accessToken: accessToken, serviceAccountEmail: sa.client_email };
    } catch (tokenErr) {
      console.error('[api/tts] service-account token exchange failed:', tokenErr.message || tokenErr);
      const err = new Error(
        'Google TTS service-account auth failed. Enable Cloud Text-to-Speech API for project of '
        + sa.client_email + ' and ensure the SA can mint cloud-platform tokens. '
        + (tokenErr.message || '')
      );
      err.statusCode = 503;
      throw err;
    }
  }

  const err = new Error(
    'Google TTS is not configured. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON '
    + '(or GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_BASE64) on this host and enable '
    + 'Cloud Text-to-Speech API on that GCP project. API keys are not supported.'
  );
  err.statusCode = 503;
  throw err;
}

async function synthesizeChunk(text, voiceConfig, auth, voiceName) {
  const headers = { 'Content-Type': 'application/json' };
  if (!auth || auth.type !== 'bearer' || !auth.accessToken) {
    const err = new Error('Cloud TTS requires a Bearer access token');
    err.statusCode = 503;
    throw err;
  }
  headers.Authorization = 'Bearer ' + auth.accessToken;

  const ssml = buildSsml(text);
  if (!ssml) {
    const err = new Error('text is required');
    err.statusCode = 400;
    throw err;
  }

  const res = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      input: { ssml: ssml },
      voice: {
        languageCode: voiceConfig.languageCode,
        name: voiceName,
      },
      audioConfig: {
        audioEncoding: 'MP3',
        // Pace is controlled via SSML <prosody rate="0.95">.
        speakingRate: 1.0,
        pitch: 0,
      },
    }),
  });
  const payloadText = await res.text();
  let payload = null;
  try { payload = JSON.parse(payloadText); } catch (e) { payload = null; }
  if (!res.ok) {
    const message = (payload && (payload.error && payload.error.message))
      || payloadText.slice(0, 300)
      || ('TTS synthesize failed (' + res.status + ')');
    const err = new Error(message);
    err.statusCode = res.status;
    err.retryableVoice = /voice|does not exist|INVALID_ARGUMENT/i.test(message);
    throw err;
  }
  const audioContent = payload && payload.audioContent ? String(payload.audioContent) : '';
  if (!audioContent) {
    throw new Error('TTS synthesize returned empty audioContent');
  }
  return audioContent;
}

async function synthesizeText(text, lang) {
  const chunks = splitTextForTts(text);
  if (!chunks.length) {
    const err = new Error('text is required');
    err.statusCode = 400;
    throw err;
  }

  const voiceConfig = normalizeLang(lang);
  const auth = await resolveTtsAuth();
  const audioChunks = [];
  let usedVoice = voiceConfig.voices[0];

  for (let c = 0; c < chunks.length; c++) {
    let synthesized = false;
    let lastErr = null;
    for (let v = 0; v < voiceConfig.voices.length; v++) {
      const voiceName = voiceConfig.voices[v];
      try {
        const audioContent = await synthesizeChunk(chunks[c], voiceConfig, auth, voiceName);
        audioChunks.push(audioContent);
        usedVoice = voiceName;
        synthesized = true;
        break;
      } catch (err) {
        lastErr = err;
        if (!err.retryableVoice) throw err;
      }
    }
    if (!synthesized) throw lastErr || new Error('TTS synthesize failed');
  }

  return {
    ok: true,
    mimeType: 'audio/mpeg',
    lang: voiceConfig.languageCode,
    voice: usedVoice,
    audioContent: audioChunks[0],
    audioDataUri: 'data:audio/mpeg;base64,' + audioChunks[0],
    chunks: audioChunks,
    chunkCount: audioChunks.length,
  };
}

async function executeTts(req) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  const text = cleanTtsText(body.text || body.content || body.summary || '');
  if (!text) {
    const err = new Error('text is required');
    err.statusCode = 400;
    throw err;
  }
  if (text.length > 20000) {
    const err = new Error('text is too long (max 20000 characters)');
    err.statusCode = 400;
    throw err;
  }
  return synthesizeText(text, body.lang || body.language || 'he');
}

async function legacyHandler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  if (req.method === 'GET') {
    return sendJson(res, 200, getTtsStatus());
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  try {
    const data = await executeTts(req);
    return sendJson(res, 200, data);
  } catch (err) {
    const classified = classifyTtsError(err);
    console.error('[api/tts]', classified.statusCode, classified.reason, classified.error);
    return sendJson(res, classified.statusCode, {
      ok: false,
      error: classified.error,
      reason: classified.reason,
      enableApiUrl: classified.enableApiUrl,
    });
  }
}

async function fetchHandler(request) {
  const headers = new Headers(corsHeaders);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: headers });
  }
  if (request.method === 'GET') {
    return Response.json(getTtsStatus(), { status: 200, headers: headers });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: headers });
  }
  try {
    const body = await request.json();
    const data = await executeTts({ body: body });
    return Response.json(data, { status: 200, headers: headers });
  } catch (err) {
    const classified = classifyTtsError(err);
    console.error('[api/tts]', classified.statusCode, classified.reason, classified.error);
    return Response.json({
      ok: false,
      error: classified.error,
      reason: classified.reason,
      enableApiUrl: classified.enableApiUrl,
    }, {
      status: classified.statusCode,
      headers: headers,
    });
  }
}

module.exports = fetchHandler;
module.exports.fetch = fetchHandler;
module.exports.legacyHandler = legacyHandler;
module.exports.executeTts = executeTts;
module.exports.cleanTtsText = cleanTtsText;
module.exports.buildSsml = buildSsml;
module.exports.escapeSsml = escapeSsml;
module.exports.normalizeLang = normalizeLang;
module.exports.splitTextForTts = splitTextForTts;
module.exports.getTtsStatus = getTtsStatus;
module.exports.classifyTtsError = classifyTtsError;
