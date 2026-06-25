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

const PEDAGOGICAL_DEPTH_INSTRUCTION = [
  '=== HIGH-DENSITY PEDAGOGICAL CONTENT (MANDATORY — never superficial, brief, or generic) ===',
  '',
  'דגשים פדגוגיים ומהותיים (core_emphases / core_pedagogical_emphases):',
  '- Write a deep, highly detailed pedagogical breakdown of AT LEAST 2-3 comprehensive paragraphs (not short summaries).',
  '- MUST explicitly include the "Developmental Compass" (רציונל התפתחותי ומצפן למורה):',
  '  (1) Why are we teaching this specific topic at this specific age/grade?',
  '  (2) What inner developmental milestone of the child does it address (soul-spiritual, cognitive, moral-imaginative)?',
  '  (3) What structural rhythm, artistic approach, or qualitative attitude must the teacher embody in the classroom?',
  '- Ground the prose in Waldorf/anthroposophical developmental psychology (e.g. seven-year cycles, temperaments, main-lesson rhythm).',
  '',
  'נקודות מרכזיות (key_points — when present):',
  '- Provide exactly 5-6 SUBSTANTIAL bullet points; each must be 2-4 full sentences.',
  '- Detail explicit lesson-block dynamics, transition ideas, rhythm/architecture of the main lesson, or core subject concepts.',
  '- Do NOT write terse one-line bullets or vague slogans.',
  '',
  'ספרות מומלצת (recommended_reading / recommended_literature):',
  '- List 5-8 foundational Waldorf/anthroposophical texts relevant to the topic.',
  '- Each entry MUST include a substantive "note" field: 1-2 sentences explaining what the source covers and why it matters for the teacher.',
  '',
  'קישורים (relevant_links):',
  '- Actively hunt for live professional essays, Rudolf Steiner lecture archives (GA), Waldorf Library items, AWSNA/IASWECE resources, and professional journals.',
  '- Each link title MUST include a short context phrase (after an em dash or colon) explaining what the source covers.',
  '- Provide at least 6-8 verified links when possible.',
  '',
  '=== END PEDAGOGICAL DEPTH REQUIREMENTS ===',
].join('\n');

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
  PEDAGOGICAL_DEPTH_INSTRUCTION,
};
