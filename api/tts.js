/**
 * POST /api/tts — Google Cloud Text-to-Speech synthesis.
 *
 * Body: { text: string, lang?: 'he' | 'en' | 'he-IL' | 'en-US' }
 * Auth: service-account JWT (GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON / service-account.json)
 *       with scope cloud-platform, or API key fallback
 *       (GOOGLE_TTS_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_CLOUD_API_KEY).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('./env');
const driveCatalogSync = require('./drive-catalog-sync');

const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_INPUT_BYTES = 4500;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

function cleanKey(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
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
      voices: ['en-US-Neural2-F', 'en-US-Neural2-A', 'en-US-Wavenet-F', 'en-US-Standard-C'],
    };
  }
  return {
    languageCode: 'he-IL',
    voices: ['he-IL-Wavenet-A', 'he-IL-Wavenet-B', 'he-IL-Standard-A', 'he-IL-Standard-B'],
  };
}

function cleanTtsText(raw) {
  var text = String(raw || '');
  if (!text.trim()) return '';
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
        // Hard-split oversized sentence by characters.
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

function getTtsApiKey() {
  return cleanKey(
    process.env.GOOGLE_TTS_API_KEY
    || process.env.GOOGLE_CLOUD_API_KEY
    || process.env.GOOGLE_API_KEY
    || env.getGeminiApiKey()
  );
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
  // Prefer the same SA loader used by Drive (handles Render env escaping).
  const saFromDrive = typeof driveCatalogSync.parseServiceAccountJson === 'function'
    ? driveCatalogSync.parseServiceAccountJson()
    : null;
  const sa = (saFromDrive && saFromDrive.client_email && saFromDrive.private_key)
    ? saFromDrive
    : loadServiceAccount();

  if (sa && sa.client_email && sa.private_key) {
    try {
      const accessToken = (typeof driveCatalogSync.exchangeServiceAccountJwt === 'function')
        ? await driveCatalogSync.exchangeServiceAccountJwt(sa, CLOUD_PLATFORM_SCOPE, '')
        : await exchangeServiceAccountJwt(sa);
      return { type: 'bearer', accessToken: accessToken };
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

  // Cloud TTS does not accept API keys for text:synthesize — fail clearly.
  const apiKey = getTtsApiKey();
  if (apiKey) {
    const err = new Error(
      'Cloud Text-to-Speech requires a service account OAuth token '
      + '(GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON). API keys are not supported by this API.'
    );
    err.statusCode = 503;
    throw err;
  }
  const err = new Error(
    'Google TTS is not configured. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON '
    + 'and enable Cloud Text-to-Speech API on that GCP project.'
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

  const res = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      input: { text: text },
      voice: {
        languageCode: voiceConfig.languageCode,
        name: voiceName,
      },
      audioConfig: {
        audioEncoding: 'MP3',
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
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  try {
    const data = await executeTts(req);
    return sendJson(res, 200, data);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[api/tts]', status, err.message || err);
    return sendJson(res, status, {
      ok: false,
      error: err.message || String(err),
    });
  }
}

async function fetchHandler(request) {
  const headers = new Headers(corsHeaders);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: headers });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: headers });
  }
  try {
    const body = await request.json();
    const data = await executeTts({ body: body });
    return Response.json(data, { status: 200, headers: headers });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[api/tts]', status, err.message || err);
    return Response.json({ ok: false, error: err.message || String(err) }, {
      status: status,
      headers: headers,
    });
  }
}

module.exports = fetchHandler;
module.exports.fetch = fetchHandler;
module.exports.legacyHandler = legacyHandler;
module.exports.executeTts = executeTts;
module.exports.cleanTtsText = cleanTtsText;
module.exports.normalizeLang = normalizeLang;
module.exports.splitTextForTts = splitTextForTts;
