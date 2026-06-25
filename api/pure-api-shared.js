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

async function callPerplexityJson(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const raw = await perplexityClient.callPerplexityChat({
    model: perplexityClient.PERPLEXITY_MODEL,
    temperature: opts.temperature != null ? opts.temperature : 0.35,
    max_tokens: opts.max_tokens != null
      ? opts.max_tokens
      : perplexityClient.PERPLEXITY_MAX_OUTPUT_TOKENS_PRO,
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

const STRUCTURAL_COMPLETENESS_INSTRUCTION = [
  '=== STRUCTURAL COMPLETENESS (NON-NEGOTIABLE) ===',
  'Every top-level JSON key in the response schema MUST be fully populated — never omit, stub, or truncate ANY section.',
  'NEVER cut off mid-sentence or mid-array. NEVER shorten, trim, or sacrifice depth in ANY tab to save tokens.',
  'Use the full 8000-token output budget to deliver maximum depth across ALL tabs simultaneously.',
  '',
  'Tab 1 — theory (רקע תיאורטי):',
  '- 3-5 rich sections with detailed historical, anthroposophical, and grade-specific foundations.',
  '- bibliography.websites MUST include verified live HTTPS URLs for every web source.',
  '',
  'Tab 2 — inspiration (השראה פדגוגית):',
  '- Multiple global inspiration blocks with vivid artistic/creative classroom ideas, podcast episodes, and narrative threads.',
  '- Never produce thin or generic inspiration stubs.',
  '',
  'Tab 3 — דגשים פדגוגיים ומהותיים (core_emphases + key_points + recommended_reading + relevant_links):',
  '- core_emphases: 3-4 comprehensive Hebrew paragraphs with explicit Developmental Compass (מצפן התפתחותי / רציונל התפתחותי ומצפן למורה).',
  '- key_points: exactly 5-6 substantial bullets — never empty or one-liners.',
  '- recommended_reading (ספרות מומלצת): 5-8 entries — NEVER an empty array.',
  '- relevant_links (קישורים רלוונטיים): 6-8 live HTTPS URLs — NEVER an empty array.',
  '=== END STRUCTURAL COMPLETENESS ===',
].join('\n');

const PEDAGOGICAL_DEPTH_INSTRUCTION = [
  '=== MAXIMUM PEDAGOGICAL DEPTH (MANDATORY — never superficial, brief, generic, or truncated) ===',
  '',
  'Tab 1 — theory / theoretical background:',
  '- Write exhaustive anthroposophical-historical foundations: Steiner lectures (GA), Waldorf curriculum lineage, and soul-spiritual context for this grade+topic.',
  '- Each theory section: multi-paragraph Hebrew prose with depth matching a professional teacher reference work.',
  '- bibliography: populate books, articles, AND websites — every website entry MUST carry a verified live URL.',
  '',
  'Tab 2 — inspiration:',
  '- Highly enriched creative/artistic ideas: chalkboard, form drawing, movement, music, storytelling, and main-lesson book possibilities.',
  '- global blocks: at least 2-3 themed blocks with 4-8 vivid items each; podcast episodes with substantive insights; narrative threads.',
  '',
  'Tab 3 — דגשים פדגוגיים ומהותיים (core_emphases / core_pedagogical_emphases):',
  '- Write 3-4 comprehensive Hebrew paragraphs (never short summaries).',
  '- MUST include Developmental Compass (מצפן התפתחותי / רציונל התפתחותי ומצפן למורה):',
  '  (1) Why this topic at this exact age/grade?',
  '  (2) The child\'s inner developmental milestone (soul-spiritual, cognitive, moral-imaginative)?',
  '  (3) Teacher rhythm, artistic approach, and qualitative classroom attitude?',
  '  (4) Concrete pedagogical goals for the main-lesson block.',
  '- Ground in Waldorf developmental psychology (seven-year cycles, temperaments, main-lesson rhythm).',
  '',
  'נקודות מרכזיות (key_points):',
  '- Exactly 5-6 SUBSTANTIAL bullets; each 2-4 full sentences on lesson-block dynamics, transitions, or core concepts.',
  '',
  'ספרות מומלצת (recommended_reading / recommended_literature):',
  '- 5-8 foundational texts; each with a substantive note (1-2 sentences on coverage and teacher relevance).',
  '',
  'קישורים רלוונטיים (relevant_links):',
  '- 6-8 live professional sources: Steiner archives (GA), waldorflibrary.org, AWSNA/IASWECE, academic Waldorf essays.',
  '- Each title includes short context (em dash or colon) explaining what the source covers.',
  '',
  '=== END MAXIMUM DEPTH REQUIREMENTS ===',
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
  STRUCTURAL_COMPLETENESS_INSTRUCTION,
  PEDAGOGICAL_DEPTH_INSTRUCTION,
};
