/**
 * POST /api/pure-general-search — multi-grade search via Perplexity with Supabase cache.
 * Body: { query, periodBlock?: boolean }
 */
const shared = require('./pure-api-shared');
const cache = require('./cache');
const authContext = require('./auth-context');

const SYSTEM_PROMPT = [
  'You are a Waldorf / anthroposophical pedagogy expert.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'developmental_axis (string: AT LEAST 2-3 comprehensive Hebrew paragraphs tracing the developmental thread across grades 1-8 — soul-spiritual milestones per age band, never brief),',
  'core_pedagogical_emphases (string: AT LEAST 2-3 comprehensive Hebrew paragraphs with Developmental Compass — רציונל התפתחותי ומצפן למורה — plus grade-band lesson dynamics; never superficial),',
  'recommended_literature (array of 5-8 objects: {title, author, note} — note MUST be 1-2 sentences on what the source covers and why it matters),',
  'relevant_links (array of 6-8 objects: {title, url} — title MUST include short context after em dash/colon; live Steiner archives, Waldorf Library, professional essays).',
].join(' ');

const PERIOD_BLOCK_SYSTEM_PROMPT = [
  'You are a Waldorf / anthroposophical pedagogy expert specializing in main-lesson block planning.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'developmental_axis (string: 1-2 comprehensive Hebrew paragraphs on soul-spiritual developmental context for the stated grade and subject),',
  'core_pedagogical_emphases (string: 1-2 comprehensive Hebrew paragraphs with Waldorf block rhythm, narrative arc, and teacher compass for this grade+subject),',
  'recommended_literature (array of 3-6 objects: {title, author, note} — note MUST explain relevance to this block),',
  'relevant_links (array of 4-6 objects: {title, url} — professional Waldorf sources only),',
  'curriculum (array of EXACTLY 15 objects — one per school day — each with: day (integer 1-15), week (integer 1-3), topic (Hebrew lesson topic), content (Hebrew main narrative/story focus, 2-4 sentences), art (Hebrew notebook/drawing/painting/handwork activity)).',
].join(' ');

function coerceCurriculumDays(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (let i = 0; i < value.length && out.length < 15; i++) {
    const row = value[i];
    if (!row || typeof row !== 'object') continue;
    const day = parseInt(row.day || row.dayNumber || row.n, 10);
    const resolvedDay = day >= 1 && day <= 15 ? day : out.length + 1;
    const week = parseInt(row.week || row.weekNumber, 10);
    out.push({
      day: resolvedDay,
      week: week >= 1 && week <= 3 ? week : Math.ceil(resolvedDay / 5),
      topic: shared.coerceText(row.topic || row.title || row.theme || row.subject || ''),
      content: shared.coerceText(
        row.content || row.narrative || row.story || row.lesson || row.mainLesson || row.text || ''
      ),
      art: shared.coerceText(
        row.art || row.notebook || row.artActivity || row.craft || row.handwork || row.drawing || ''
      ),
    });
  }
  return out;
}

function normalizeGeneralSearchResponse(parsed, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const periodBlock = Boolean(opts.periodBlock);
  const data = parsed && typeof parsed === 'object' ? parsed : {};
  const normalized = {
    developmental_axis: shared.coerceText(data.developmental_axis),
    core_pedagogical_emphases: shared.coerceText(data.core_pedagogical_emphases),
    recommended_literature: shared.coerceReadingList(data.recommended_literature),
    relevant_links: shared.coerceLinks(data.relevant_links),
  };
  if (periodBlock) {
    normalized.periodBlock = true;
    normalized.curriculum = coerceCurriculumDays(data.curriculum || data.days || data.blockPlan && data.blockPlan.curriculum);
  }
  return normalized;
}

function buildPeriodBlockUserPrompt(query) {
  return [
    'Build a FULL Waldorf main-lesson block plan: 3 weeks × 5 school days = 15 days total.',
    'Query (subject, topic, and/or grade — e.g. «רנסנס כיתה ז»): ' + query,
    'Extract the target grade and block subject from the query. If grade is not explicit, infer the canonical Waldorf grade for this block topic.',
    'Write in Hebrew unless the query is clearly in another language.',
    '',
    shared.PEDAGOGICAL_DEPTH_INSTRUCTION,
    '',
    'Section requirements:',
    '- developmental_axis: developmental soul-spiritual context for THIS grade and subject only.',
    '- core_pedagogical_emphases: block arc, rhythm, artistic integration, and teacher compass.',
    '- recommended_literature: professional sources for this block.',
    '- relevant_links: verified professional Waldorf URLs.',
    '',
    'curriculum (תוכנית 15 ימים) — MANDATORY:',
    '- EXACTLY 15 objects with day 1 through day 15.',
    '- week 1 = days 1-5, week 2 = days 6-10, week 3 = days 11-15.',
    '- Each day MUST include: topic (נושא השיעור), content (מוקד סיפורי/תוכן מרכזי), art (מחברת/פעילות אמנותית).',
    '- Build a coherent narrative arc across all 15 days — opening, deepening, climax, integration.',
    '- Align with Waldorf main-lesson rhythm: story/recitation, recall, new material, artistic work.',
    '- Age-appropriate language and activities for the target grade.',
  ].join('\n');
}

function buildStandardUserPrompt(query) {
  return [
    'General Waldorf pedagogy search across elementary grades (1-8).',
    'Query: ' + query,
    'Provide a structured multi-grade analysis: developmental progression, core emphases by age band,',
    'recommended professional literature, and relevant web resources.',
    'Write in Hebrew unless the query is clearly in another language.',
    '',
    shared.PROFESSIONAL_LINKS_INSTRUCTION,
    '',
    shared.PEDAGOGICAL_DEPTH_INSTRUCTION,
    '',
    'Section requirements:',
    '- developmental_axis (ציר התפתחותי): deep multi-paragraph developmental progression across grades 1-8.',
    '- core_pedagogical_emphases (דגשים פדגוגיים מרכזיים): deep breakdown with Developmental Compass and grade-band lesson dynamics.',
    '- recommended_literature: each entry with contextual note explaining coverage and relevance.',
    '- relevant_links (קישורים): 6-8 live professional sources with descriptive titles — not parent-facing school homepages.',
  ].join('\n');
}

async function resolveArchiveUser(body, requestContext) {
  const ctx = requestContext && typeof requestContext === 'object' ? requestContext : {};
  const reqShape = {
    method: 'POST',
    headers: ctx.headers || {},
    body: body || {},
  };
  try {
    const verified = await authContext.resolveVerifiedUser(reqShape, body || {});
    if (verified) return verified;
  } catch (authErr) {
    /* optional auth */
  }
  const fromBody = body && body.teacherUser;
  if (fromBody && fromBody.email) {
    return {
      id: fromBody.id && authContext.isValidAuthUuid(fromBody.id) ? String(fromBody.id).trim() : null,
      email: String(fromBody.email || '').trim(),
      name: fromBody.name || fromBody.displayName || fromBody.email || '',
    };
  }
  return null;
}

async function buildArchiveSaveOptions(body, requestContext, periodBlock) {
  const verified = await resolveArchiveUser(body, requestContext);
  return {
    periodBlock: periodBlock,
    teacherUser: verified || (body && body.teacherUser) || null,
    userEmail: (verified && verified.email) || (body && body.teacherUser && body.teacherUser.email) || null,
    userId: verified && verified.id ? verified.id : null,
  };
}

async function persistGeneralSearchArchive(query, normalized, body, requestContext, periodBlock) {
  const archiveOpts = await buildArchiveSaveOptions(body, requestContext, periodBlock);
  const cacheKey = await cache.setGeneralSearchCache(query, normalized, archiveOpts);
  const archived = Boolean(cacheKey);
  if (!archived && cache.isSupabaseCacheEnabled()) {
    console.warn('[cached_results] general_search archive upsert failed for query:', query.slice(0, 120));
  }
  return { cacheKey: cacheKey, archived: archived };
}

async function runPureGeneralSearch(body, requestContext) {
  const query = String(body.query || body.topic || body.q || '').trim();
  if (!query) throw shared.badRequest('query is required');

  const periodBlock = Boolean(body.periodBlock || body.buildPeriodPlan || body.period_block);
  const bypassCache = Boolean(
    body.bypassCache || body.forceRefresh || body.forceFresh || body.skipCache
  );

  if (!bypassCache) {
    const cached = await cache.getGeneralSearchCache(query, { periodBlock: periodBlock });
    if (cached && cached.data) {
      const cacheKey = cached.meta && cached.meta.cacheKey ? cached.meta.cacheKey : null;
      return {
        data: normalizeGeneralSearchResponse(cached.data, { periodBlock: periodBlock }),
        meta: Object.assign({
          fromCache: true,
          source: 'general_search_cache',
          periodBlock: periodBlock,
          cacheKey: cacheKey || undefined,
          archived: true,
          archiveBackend: cache.isSupabaseCacheEnabled() ? 'supabase' : 'local-fallback',
        }, cached.meta || {}),
      };
    }
  }

  const systemPrompt = periodBlock ? PERIOD_BLOCK_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const userPrompt = periodBlock ? buildPeriodBlockUserPrompt(query) : buildStandardUserPrompt(query);

  const parsed = await shared.callPerplexityJson(systemPrompt, userPrompt, {
    phase: periodBlock ? 'general_search_period' : 'general_search',
    query: query,
  });
  const normalized = normalizeGeneralSearchResponse(parsed, { periodBlock: periodBlock });

  const archiveResult = await persistGeneralSearchArchive(
    query,
    normalized,
    body,
    requestContext,
    periodBlock
  );

  return {
    data: normalized,
    meta: {
      fromCache: false,
      source: 'perplexity-pure',
      periodBlock: periodBlock,
      cacheKey: archiveResult.cacheKey || undefined,
      archived: archiveResult.archived,
      archiveBackend: cache.isSupabaseCacheEnabled() ? 'supabase' : 'local-fallback',
    },
  };
}

const legacyHandler = async function (req, res) {
  if (req.method === 'OPTIONS') {
    shared.setCors(res);
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return shared.sendJson(res, 405, { error: 'Method not allowed' });
  }
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return shared.sendJson(res, 400, { error: 'Missing JSON body' });
  }
  try {
    const result = await runPureGeneralSearch(body, { headers: req.headers || {} });
    return shared.sendJson(res, 200, {
      ok: true,
      data: result.data,
      meta: result.meta || { fromCache: false, source: 'perplexity-pure' },
    });
  } catch (err) {
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pure-general-search]', statusCode, message);
    return shared.sendJson(res, statusCode, { error: message });
  }
};

async function fetchHandler(request) {
  const headers = new Headers(shared.CORS_HEADERS);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: headers });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: headers });
  }
  let body;
  try {
    body = await request.json();
  } catch (parseErr) {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: headers });
  }
  try {
    const result = await runPureGeneralSearch(body || {}, {
      headers: Object.fromEntries(request.headers.entries()),
    });
    return Response.json({
      ok: true,
      data: result.data,
      meta: result.meta || { fromCache: false, source: 'perplexity-pure' },
    }, { status: 200, headers: headers });
  } catch (err) {
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    return Response.json({ error: err.message || String(err) }, { status: 500, headers: headers });
  }
}

module.exports = {
  legacyHandler,
  fetch: fetchHandler,
  runPureGeneralSearch,
  normalizeGeneralSearchResponse,
  coerceCurriculumDays,
};
