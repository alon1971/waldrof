/**
 * Shared helpers for isolated pure Perplexity routes (no cache / archive).
 */
const perplexityClient = require('./perplexity-client');
const jsonRepair = require('./json-repair');
const hebrewGuardrails = require('./perplexity-hebrew-guardrails');
const communitySearch = require('./community-search');

const EMPTY_COMMUNITY_PROBE = communitySearch.EMPTY_COMMUNITY_PROBE;
const probeCommunityForHybridSearch = communitySearch.probeCommunityForHybridSearch;
const attachCommunityHybridMeta = communitySearch.attachCommunityHybridMeta;

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

function safeSendJson(res, statusCode, payload) {
  try {
    return sendJson(res, statusCode, payload);
  } catch (sendErr) {
    console.warn('[pure-api] response not sent (client likely disconnected):', sendErr.message || sendErr);
    return null;
  }
}

function coerceText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(function (item) { return String(item || '').trim(); }).filter(Boolean).join('\n\n');
  }
  if (typeof value === 'object') {
    const direct = String(value.text || value.content || value.summary || '').trim();
    if (direct) return direct;
    try {
      return JSON.stringify(value).trim();
    } catch (stringifyErr) {
      return '';
    }
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

/**
 * Rigid system-role contract injected on EVERY model call so the reply is always raw JSON.
 * Kept short and absolute — the lenient parser handles the rest as a safety net.
 */
const RIGID_JSON_SYSTEM_MANDATE = [
  '=== OUTPUT CONTRACT (ABSOLUTE — MANDATORY) ===',
  'Your ENTIRE reply MUST be exactly ONE valid JSON object — nothing before it and nothing after it.',
  'NEVER wrap the JSON in Markdown code fences (no ```json, no ```), and NEVER add preamble, commentary, or notes.',
  'The first character of your reply MUST be { and the last character MUST be }.',
  'Inside string values escape every double quote as \\" and every newline as \\n; emit no trailing commas.',
  'The server runs JSON.parse() on your full reply — any deviation is a fatal error.',
  '=== END OUTPUT CONTRACT ===',
].join(' ');

/** Even stricter reminder appended to the system role on retries after a parse fallback. */
const RIGID_JSON_RETRY_MANDATE = [
  'CRITICAL RETRY: your previous reply could not be parsed as JSON.',
  'Return ONLY raw, valid JSON this time — no Markdown fences, no preamble, no trailing text.',
  'Start with { and end with }. Mentally verify JSON.parse() succeeds before you answer.',
].join(' ');

/** Compose the rigid JSON contract (always) with the caller system prompt and an optional retry reminder. */
function buildRigidJsonSystemPrompt(systemPrompt, isRetry) {
  return [
    RIGID_JSON_SYSTEM_MANDATE,
    isRetry ? RIGID_JSON_RETRY_MANDATE : '',
    String(systemPrompt || ''),
  ].filter(Boolean).join('\n\n');
}

function buildParseContext(opts) {
  return {
    grade: opts.grade || opts.gradeLabel || '',
    gradeLabel: opts.gradeLabel || opts.grade || '',
    topic: opts.topic || '',
    query: opts.query || '',
  };
}

/**
 * Call Perplexity and parse the reply as JSON. The rigid JSON contract is enforced in the
 * system role on every attempt; on a parse fallback we silently retry once with an even
 * stricter system mandate (the request stays open, so the client never sees the first miss).
 */
async function callPerplexityJson(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const phase = opts.phase || 'topic_master';
  const parseContext = buildParseContext(opts);
  const maxAttempts = opts.maxAttempts != null ? Math.max(1, opts.maxAttempts) : 2;

  let lastParsed = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isRetry = attempt > 1;
    const raw = await perplexityClient.callPerplexityChat({
      model: perplexityClient.PERPLEXITY_MODEL,
      temperature: isRetry ? 0.2 : (opts.temperature != null ? opts.temperature : 0.35),
      max_tokens: opts.max_tokens != null
        ? Math.max(4096, opts.max_tokens)
        : perplexityClient.PERPLEXITY_MAX_OUTPUT_TOKENS_PRO,
      jsonObject: false,
      messages: [
        { role: 'system', content: buildRigidJsonSystemPrompt(systemPrompt, isRetry) },
        { role: 'user', content: userPrompt },
      ],
    });
    const result = jsonRepair.parsePureModelJson(jsonRepair.stripReasoningTokens(raw), {
      phase: phase,
      context: parseContext,
      unwrap: true,
    });
    lastParsed = result.parsed;
    if (!result.parseFallback) return result.parsed;
    if (attempt < maxAttempts) {
      console.warn(
        '[pure-api] JSON parse fallback for phase', phase,
        '— retrying with rigid JSON mandate (attempt', attempt + '/' + maxAttempts + ')'
      );
    }
  }
  return lastParsed;
}

/**
 * Same as callPerplexityJson but exposes whether a safe parse fallback was used.
 */
async function callPerplexityJsonSafe(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const phase = opts.phase || 'topic_master';
  const parseContext = buildParseContext(opts);
  const maxAttempts = opts.maxAttempts != null ? Math.max(1, opts.maxAttempts) : 2;
  let lastRaw = '';
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isRetry = attempt > 1;
    lastRaw = await perplexityClient.callPerplexityChat({
      model: perplexityClient.PERPLEXITY_MODEL,
      temperature: isRetry ? 0.2 : (opts.temperature != null ? opts.temperature : 0.35),
      max_tokens: opts.max_tokens != null
        ? Math.max(4096, opts.max_tokens)
        : perplexityClient.PERPLEXITY_MAX_OUTPUT_TOKENS_PRO,
      jsonObject: false,
      messages: [
        { role: 'system', content: buildRigidJsonSystemPrompt(systemPrompt, isRetry) },
        { role: 'user', content: userPrompt },
      ],
    });
    lastResult = jsonRepair.parsePureModelJson(jsonRepair.stripReasoningTokens(lastRaw), {
      phase: phase,
      context: parseContext,
      unwrap: true,
    });
    if (!lastResult.parseFallback) {
      lastResult.raw = lastRaw;
      return lastResult;
    }
    if (attempt < maxAttempts) {
      console.warn(
        '[pure-api] JSON parse fallback for phase', phase,
        '— retrying with rigid JSON mandate (attempt', attempt + '/' + maxAttempts + ')'
      );
    }
  }
  if (lastResult) lastResult.raw = lastRaw;
  return lastResult || {
    parsed: jsonRepair.buildModelParseFallback(phase, lastRaw, parseContext),
    parseFallback: true,
    raw: lastRaw,
  };
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
      const result = await runFn(body, req);
      if (result && typeof result === 'object' && (result.data !== undefined || result.meta)) {
        var responseData = result.data;
        if (responseData != null && typeof responseData === 'object') {
          responseData = hebrewGuardrails.applyHebrewAutoReplacementsDeep(
            JSON.parse(JSON.stringify(responseData))
          );
        } else if (typeof responseData === 'string') {
          responseData = hebrewGuardrails.applyHebrewAutoReplacements(responseData);
        }
        return safeSendJson(res, 200, {
          ok: true,
          data: responseData,
          meta: result.meta || { fromCache: false, source: 'perplexity-pure' },
        });
      }
      return safeSendJson(res, 200, { ok: true, data: result, meta: { fromCache: false, source: 'perplexity-pure' } });
    } catch (err) {
      const statusCode = err && err.statusCode ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : String(err);
      console.error('[pure-api]', statusCode, message);
      return safeSendJson(res, statusCode, {
        error: message,
        code: err && err.code ? err.code : undefined,
        usage: err && err.usage ? err.usage : undefined,
      });
    }
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/** Minimum wall-clock budget for any single live-research HTTP attempt (Perplexity / server). */
const LIVE_SEARCH_MIN_TIMEOUT_MS = 60000;
/** Hard cap for one live Perplexity / Gemini attempt on planner topic + general search. */
const LIVE_SEARCH_BUDGET_MS = Math.max(
  LIVE_SEARCH_MIN_TIMEOUT_MS,
  Number(process.env.LIVE_SEARCH_BUDGET_MS) || 90000
);
/** Two extra attempts after the first failure (3 tries total). */
const LIVE_SEARCH_COMM_RETRY_COUNT = 2;
const LIVE_SEARCH_RETRY_BACKOFF_MS = 1200;

function computeLiveSearchClientWaitMs() {
  const attempts = LIVE_SEARCH_COMM_RETRY_COUNT + 1;
  let backoffSum = 0;
  for (let i = 0; i < LIVE_SEARCH_COMM_RETRY_COUNT; i++) {
    backoffSum += LIVE_SEARCH_RETRY_BACKOFF_MS * Math.pow(2, i);
  }
  return attempts * LIVE_SEARCH_BUDGET_MS + backoffSum + 20000;
}

/** Browser fetch budget — must cover all server retries + backoff. */
const LIVE_SEARCH_CLIENT_WAIT_MS = computeLiveSearchClientWaitMs();

function isLiveSearchTimeoutError(err) {
  if (!err) return false;
  if (err.code === 'LIVE_SEARCH_TIMEOUT' || err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|חוסר תגובה|aborted|Gateway timeout/i.test(msg);
}

function isCommunicationError(err) {
  if (isLiveSearchTimeoutError(err)) return true;
  if (err && err.code === 'PERPLEXITY_EMPTY_CONTENT') return true;
  if (err && (err.httpStatus === 502 || err.httpStatus === 503 || err.httpStatus === 504 || err.httpStatus === 524)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err || '');
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR|שגיאת רשת|network|empty or unusable synthesis|Gateway timeout|502 Bad Gateway|504 Gateway|Bad Gateway/i.test(msg);
}

/** Network + timeout failures eligible for background retries. */
function isRetriableCommunicationError(err) {
  return isCommunicationError(err);
}

function sleepMs(ms) {
  const delay = typeof ms === 'number' && ms > 0 ? ms : 0;
  if (!delay) return Promise.resolve();
  return new Promise(function (resolve) {
    setTimeout(resolve, delay);
  });
}

function liveSearchTimeoutError(message) {
  const err = new Error(message || 'הקריאה לחיפוש החי הופסקה עקב חוסר תגובה (timeout).');
  err.code = 'LIVE_SEARCH_TIMEOUT';
  return err;
}

/**
 * Race a promise against a hard wall-clock budget. Does not cancel the loser.
 * hooks.onLateResolve runs if the underlying promise settles after the budget fired.
 */
function withHardTimeout(promise, ms, message, hooks) {
  const rawBudget = typeof ms === 'number' && ms > 0 ? ms : LIVE_SEARCH_BUDGET_MS;
  const allowSubMin = Boolean(hooks && hooks.allowSubMinBudget);
  const budget = allowSubMin
    ? rawBudget
    : Math.max(LIVE_SEARCH_MIN_TIMEOUT_MS, rawBudget);
  let timer = null;
  let timedOut = false;
  const wrapped = Promise.resolve(promise).then(function (val) {
    if (timedOut && hooks && typeof hooks.onLateResolve === 'function') {
      try {
        hooks.onLateResolve(val);
      } catch (lateHookErr) {
        console.warn('[pure-api] onLateResolve hook failed:', lateHookErr.message || lateHookErr);
      }
    }
    return val;
  });
  const timeoutPromise = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      timedOut = true;
      reject(liveSearchTimeoutError(message));
    }, budget);
  });
  return Promise.race([wrapped, timeoutPromise]).finally(function () {
    if (timer) clearTimeout(timer);
  });
}

/** Up to two background retries with exponential backoff — never on 401/429/403. */
async function withLiveSearchRetry(factory, options) {
  const opts = options || {};
  const extraRetries = opts.retries != null ? Number(opts.retries) : LIVE_SEARCH_COMM_RETRY_COUNT;
  const attempts = Math.max(1, extraRetries + 1);
  const budget = opts.budgetMs || LIVE_SEARCH_BUDGET_MS;
  const backoffBase = opts.backoffMs != null ? Number(opts.backoffMs) : LIVE_SEARCH_RETRY_BACKOFF_MS;
  let lastErr = null;
  const lateHook = {};
  if (opts.onLateResolve && typeof opts.onLateResolve === 'function') {
    lateHook.onLateResolve = opts.onLateResolve;
  }
  if (opts.allowSubMinBudget === true) {
    lateHook.allowSubMinBudget = true;
  }
  const hookArg = lateHook.onLateResolve || lateHook.allowSubMinBudget ? lateHook : null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withHardTimeout(factory(), budget, undefined, hookArg);
    } catch (err) {
      lastErr = err;
      if (err && (err.statusCode === 429 || err.statusCode === 401 || err.statusCode === 403)) throw err;
      if (!isRetriableCommunicationError(err) || i === attempts - 1) throw err;
      const delay = backoffBase * Math.pow(2, i);
      console.warn(
        '[pure-api] live search communication failure — retry',
        (i + 1) + '/' + (attempts - 1),
        'in',
        delay,
        'ms:',
        err && err.message ? err.message : err
      );
      await sleepMs(delay);
    }
  }
  throw lastErr;
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
  '- recommended_reading (ספרות מומלצת): include ONLY entries with verified live citation URLs and substantive notes — empty array if none verified.',
  '- relevant_links (קישורים רלוונטיים): include ONLY verified live HTTPS URLs from Perplexity citations — empty array if none verified.',
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
  '  Use חציית הרוביקון הראשונה (גיל 9) / חציית הרוביקון השנייה (גיל 12) in headings and prose — NEVER "הלידה הראשונה" or "הלידה השנייה".',
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
  callPerplexityJsonSafe,
  buildRigidJsonSystemPrompt,
  RIGID_JSON_SYSTEM_MANDATE,
  RIGID_JSON_RETRY_MANDATE,
  createLegacyPostHandler,
  badRequest,
  LIVE_SEARCH_MIN_TIMEOUT_MS,
  LIVE_SEARCH_BUDGET_MS,
  LIVE_SEARCH_CLIENT_WAIT_MS,
  LIVE_SEARCH_COMM_RETRY_COUNT,
  LIVE_SEARCH_RETRY_BACKOFF_MS,
  isLiveSearchTimeoutError,
  isCommunicationError,
  isRetriableCommunicationError,
  liveSearchTimeoutError,
  sleepMs,
  withHardTimeout,
  withLiveSearchRetry,
  PROFESSIONAL_LINKS_INSTRUCTION,
  STRUCTURAL_COMPLETENESS_INSTRUCTION,
  PEDAGOGICAL_DEPTH_INSTRUCTION,
  EMPTY_COMMUNITY_PROBE,
  probeCommunityForHybridSearch,
  attachCommunityHybridMeta,
};
