/**
 * Shared helpers for isolated pure Perplexity routes (no cache / archive).
 */
const perplexityClient = require('./perplexity-client');
const jsonRepair = require('./json-repair');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-user-email',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function setCors(res) {
  Object.entries(CORS_HEADERS).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(statusCode).json(payload);
}

function coerceText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(function (item) { return String(item || '').trim(); }).filter(Boolean).join('\n\n');
  }
  if (typeof value === 'object') {
    return String(value.text || value.content || value.summary || JSON.stringify(value)).trim();
  }
  return String(value).trim();
}

function coerceList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(function (item) {
      if (item == null) return '';
      if (typeof item === 'object') {
        return String(item.text || item.title || item.content || item.point || '').trim();
      }
      return String(item).trim();
    }).filter(Boolean);
  }
  const text = coerceText(value);
  if (!text) return [];
  return text.split(/\n+/).map(function (line) { return line.replace(/^[-*•\d.)\s]+/, '').trim(); }).filter(Boolean);
}

function coerceReadingList(value) {
  if (!value) return [];
  if (!Array.isArray(value)) {
    return coerceList(value).map(function (line) { return { title: line, author: '', note: '' }; });
  }
  return value.map(function (item) {
    if (typeof item === 'string') return { title: item.trim(), author: '', note: '' };
    if (!item || typeof item !== 'object') return null;
    return {
      title: String(item.title || item.name || item.book || '').trim(),
      author: String(item.author || item.writer || '').trim(),
      note: String(item.note || item.description || item.summary || '').trim(),
    };
  }).filter(function (item) { return item && item.title; });
}

function coerceLinks(value) {
  if (!value) return [];
  if (!Array.isArray(value)) {
    const text = coerceText(value);
    if (!text) return [];
    const urlMatch = text.match(/https?:\/\/\S+/);
    return urlMatch ? [{ title: text.replace(urlMatch[0], '').trim() || urlMatch[0], url: urlMatch[0] }] : [];
  }
  return value.map(function (item) {
    if (typeof item === 'string') {
      const urlMatch = item.match(/https?:\/\/\S+/);
      if (!urlMatch) return null;
      return { title: item.replace(urlMatch[0], '').trim() || urlMatch[0], url: urlMatch[0] };
    }
    if (!item || typeof item !== 'object') return null;
    const url = String(item.url || item.link || item.href || '').trim();
    if (!url) return null;
    return { title: String(item.title || item.name || url).trim(), url: url };
  }).filter(Boolean);
}

async function callPerplexityJson(systemPrompt, userPrompt) {
  const raw = await perplexityClient.callPerplexityChat({
    model: perplexityClient.PERPLEXITY_MODEL,
    temperature: 0.35,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  return jsonRepair.parseJsonFromModel(raw);
}

function createLegacyPostHandler(runFn) {
  return async function legacyHandler(req, res) {
    if (req.method === 'OPTIONS') {
      setCors(res);
      return res.status(204).end();
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, { error: 'Missing JSON body' });
    }
    try {
      const data = await runFn(body);
      return sendJson(res, 200, { ok: true, data: data, meta: { fromCache: false, source: 'perplexity-pure' } });
    } catch (err) {
      const statusCode = err && err.statusCode ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : String(err);
      console.error('[pure-api]', statusCode, message);
      return sendJson(res, statusCode, { error: message });
    }
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const PROFESSIONAL_LINKS_INSTRUCTION = [
  'LIVE WEB SEARCH REQUIRED for every external URL — include ONLY verified, functioning HTTPS links from professional pedagogical sources.',
  'PRIORITIZE: Rudolf Steiner Archive / GA lectures, waldorflibrary.org, AWSNA, IASWECE, academic Waldorf essays, teacher journals,',
  'deep source centers (e.g. Adam Olam / אדם עולם), anthroposophic research libraries, and classroom-practice curriculum guides.',
  'EXCLUDE: generic parent-facing school homepages, enrollment pages, broken or guessed URLs, social media (except Pinterest in pinterest_links).',
  'If a link cannot be verified from live search, omit it — never invent URLs.',
].join(' ');

module.exports = {
  CORS_HEADERS,
  setCors,
  sendJson,
  coerceText,
  coerceList,
  coerceReadingList,
  coerceLinks,
  callPerplexityJson,
  createLegacyPostHandler,
  badRequest,
  PROFESSIONAL_LINKS_INSTRUCTION,
};
