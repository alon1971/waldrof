/**
 * POST /api/pure-general-search — Phase A only: Perplexity search → JSON.
 * No Phase B / reference-citation scan / Drive cross-check (removed; do not reintroduce).
 * Body: { query, periodBlock?: boolean }
 */
const shared = require('./pure-api-shared');
const cache = require('./cache');
const authContext = require('./auth-context');
const subscriptionApi = require('./subscription');
const hebrewGuardrails = require('./perplexity-hebrew-guardrails');
const keyboardLayout = require('./keyboard-layout');

const SYSTEM_PROMPT =
  'אתה מנוע חיפוש פדגוגי מומחה לחינוך ולדורף. תפקידך לייצר מערכי שיעור, תכנים פדגוגיים ותוכניות לימוד עשירות ומפורטות מאוד בעברית על בסיס הידע הרחב שלך באינטרנט. ענה בצורה ממוקדת, מקצועית ומהירה. ' +
  'אתה מנוע חיפוש פדגוגי מומחה לחינוך ולדורף. תפקידך לייצר מערכי שיעור ותוכניות לימוד עשירות ומפורטות מאוד בעברית על בסיס הידע הרחב שלך באינטרנט. ענה בצורה ממוקדת ומקצועית. ' +
  'CRITICAL: עליך להחזיר את התשובה אך ורק בפורמט JSON תקין ומבנה מדויק כפי שה-Frontend מצפה לקבל, ללא תוספות טקסט חופשי, הקדמות או סימוני Markdown מחוץ ל-JSON.';

const PERIOD_BLOCK_SYSTEM_PROMPT = [
  hebrewGuardrails.PERPLEXITY_HEBREW_GUARDRAILS,
  'You are a Waldorf / anthroposophical pedagogy expert specializing in main-lesson block planning.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'developmental_axis (string: 1-2 comprehensive Hebrew paragraphs on soul-spiritual developmental context for the stated grade and subject),',
  'core_pedagogical_emphases (string: 1-2 comprehensive Hebrew paragraphs with Waldorf block rhythm, narrative arc, and teacher compass for this grade+subject),',
  'recommended_literature (array of 3-6 objects: {title, author, note} — note MUST explain relevance to this block),',
  'relevant_links (array of 4-6 objects: {title, url} — professional Waldorf sources only),',
  'curriculum (array of EXACTLY 15 objects — one per school day — each with: day (integer 1-15), week (integer 1-3), topic (Hebrew lesson topic), content (Hebrew main narrative/story focus, 2-4 sentences), art (Hebrew notebook/drawing/painting/handwork activity)).',
  'Strictly exclude any sources, domains, or web links from Russian websites, Russian academic databases (e.g., CyberLeninka, KPFU), or Russian social networks (e.g., VK). All returned sources and citations MUST be exclusively from reputable English or Hebrew websites and domains (.com, .org, .edu, .gov, .co.il, etc.).',
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

function buildGeneralSearchArchiveText(historic) {
  if (!historic || typeof historic !== 'object') return '';
  const parts = [];
  if (historic.developmental_axis) parts.push(String(historic.developmental_axis));
  if (historic.core_pedagogical_emphases) parts.push(String(historic.core_pedagogical_emphases));
  if (Array.isArray(historic.recommended_literature) && historic.recommended_literature.length) {
    parts.push(JSON.stringify(historic.recommended_literature));
  }
  if (Array.isArray(historic.relevant_links) && historic.relevant_links.length) {
    parts.push(JSON.stringify(historic.relevant_links));
  }
  if (Array.isArray(historic.curriculum) && historic.curriculum.length) {
    parts.push(JSON.stringify(historic.curriculum));
  }
  return parts.join('\n\n').trim().slice(0, 16000);
}

function buildArchiveUpgradeIntro(archiveText, userQuery) {
  const text = String(archiveText || '').trim().slice(0, 16000);
  const query = String(userQuery || '').trim();
  return [
    'The user is not fully satisfied with this existing archive material: ' + text + '.',
    'Please run a live web search on the topic \'' + query + '\' and synthesize a brand-new, updated, comprehensive Waldorf pedagogical document that merges the best parts of the archive with the fresh discovery.',
    'Return a single, cohesive response.',
  ].join(' ');
}

function buildResearchExpandIntro(archiveText, userQuery) {
  const text = String(archiveText || '').trim().slice(0, 16000);
  const query = String(userQuery || '').trim();
  return [
    'Continue and EXPAND this existing Waldorf pedagogical research document.',
    'EXISTING OUTPUT (preserve all strong content — extend and deepen, never shrink):',
    text,
    '',
    'TASK: Run additional live web search on the topic \'' + query + '\' and ADD substantially more pedagogical depth, classroom examples, developmental nuance, and verified English/Hebrew sources.',
    'Return one complete, richer updated document.',
  ].join(' ');
}

async function enforceLiveSearchQuota(body, requestContext) {
  const headers = (requestContext && requestContext.headers) || {};
  await subscriptionApi.assertLiveSearchAllowedForPureApi(body, headers);
}

async function recordLiveSearchUsage(body, requestContext, teacher) {
  const headers = (requestContext && requestContext.headers) || {};
  const reqShape = { body: body || {}, headers: headers };
  const billed = await subscriptionApi.recordLiveSearchFromRequest(reqShape, teacher || undefined);
  return billed && billed.usage ? billed.usage : null;
}

function hasBillableGeneralSearchData(normalized) {
  if (!normalized || typeof normalized !== 'object') return false;
  return Boolean(
    String(normalized.developmental_axis || '').trim() ||
    String(normalized.core_pedagogical_emphases || '').trim() ||
    (Array.isArray(normalized.recommended_literature) && normalized.recommended_literature.length > 0) ||
    (Array.isArray(normalized.relevant_links) && normalized.relevant_links.length > 0) ||
    (Array.isArray(normalized.curriculum) && normalized.curriculum.length > 0)
  );
}

async function billLiveSearchAfterSuccess(body, requestContext, teacher, normalized) {
  if (!hasBillableGeneralSearchData(normalized)) return null;
  try {
    return await recordLiveSearchUsage(body, requestContext, teacher);
  } catch (billErr) {
    if (billErr && billErr.statusCode === 429) throw billErr;
    console.warn('[pure-general-search] live search billing failed:', billErr.message || billErr);
    return null;
  }
}

async function runArchiveUpgradeGeneralSearch(body, requestContext, teacher) {
  const query = String(body.query || body.topic || body.q || '').trim();
  if (!query) throw shared.badRequest('query is required');
  const historic = body.historicPayload;
  if (!historic || typeof historic !== 'object') {
    throw shared.badRequest('historicPayload is required for archive upgrade');
  }

  const periodBlock = Boolean(body.periodBlock || body.buildPeriodPlan || body.period_block);
  const archiveText = buildGeneralSearchArchiveText(historic) || JSON.stringify(historic).slice(0, 16000);
  const upgradeIntro = buildArchiveUpgradeIntro(archiveText, query);
  const systemPrompt = periodBlock ? PERIOD_BLOCK_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const basePrompt = periodBlock ? buildPeriodBlockUserPrompt(query) : buildStandardUserPrompt(query);
  const userPrompt = upgradeIntro + '\n\n' + basePrompt;

  await enforceLiveSearchQuota(body, requestContext);
  try {
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

    const searchUsage = await billLiveSearchAfterSuccess(body, requestContext, teacher, normalized);

    return {
      data: normalized,
      meta: {
        fromCache: false,
        source: 'archive_upgrade_synthesis',
        archiveUpgraded: true,
        periodBlock: periodBlock,
        cacheKey: archiveResult.cacheKey || undefined,
        archived: archiveResult.archived,
        archiveBackend: cache.isSupabaseCacheEnabled() ? 'supabase' : 'local-fallback',
        searchBilled: Boolean(searchUsage),
        usage: searchUsage || undefined,
      },
    };
  } catch (err) {
    throw err;
  }
}

async function runResearchExpandGeneralSearch(body, requestContext, teacher) {
  const query = String(body.query || body.topic || body.q || '').trim();
  if (!query) throw shared.badRequest('query is required');
  const historic = body.historicPayload;
  if (!historic || typeof historic !== 'object') {
    throw shared.badRequest('historicPayload is required for research expand');
  }

  const periodBlock = Boolean(body.periodBlock || body.buildPeriodPlan || body.period_block);
  const archiveText = buildGeneralSearchArchiveText(historic) || JSON.stringify(historic).slice(0, 16000);
  const expandIntro = buildResearchExpandIntro(archiveText, query);
  const systemPrompt = periodBlock ? PERIOD_BLOCK_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const basePrompt = periodBlock ? buildPeriodBlockUserPrompt(query) : buildStandardUserPrompt(query);
  const userPrompt = expandIntro + '\n\n' + basePrompt;

  await enforceLiveSearchQuota(body, requestContext);
  try {
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

    const searchUsage = await billLiveSearchAfterSuccess(body, requestContext, teacher, normalized);

    return {
      data: normalized,
      meta: {
        fromCache: false,
        source: 'research_expand',
        researchExpanded: true,
        periodBlock: periodBlock,
        cacheKey: archiveResult.cacheKey || undefined,
        archived: archiveResult.archived,
        archiveBackend: cache.isSupabaseCacheEnabled() ? 'supabase' : 'local-fallback',
        searchBilled: Boolean(searchUsage),
        usage: searchUsage || undefined,
      },
    };
  } catch (err) {
    throw err;
  }
}

async function runPureGeneralSearch(body, requestContext) {
  // Fix reversed English keyboard before cache key / Perplexity / cached_results.
  const query = keyboardLayout.applyReversedKeyboardCorrection(
    String(body.query || body.topic || body.q || '').trim()
  );
  if (body && query) {
    if (body.query != null) body.query = query;
    if (body.topic != null) body.topic = query;
    if (body.q != null) body.q = query;
  }
  if (!query) throw shared.badRequest('query is required');

  let teacher = null;
  try {
    teacher = await authContext.resolveVerifiedUser(
      { headers: (requestContext && requestContext.headers) || {} },
      body
    );
  } catch (authErr) {
    console.warn('[pure-general-search] resolve teacher failed:', authErr.message || authErr);
  }
  if (teacher) {
    authContext.sanitizeCachedUserFields(body, teacher);
  }

  const periodBlock = Boolean(body.periodBlock || body.buildPeriodPlan || body.period_block);
  const bypassCache = Boolean(
    body.bypassCache || body.forceRefresh || body.forceFresh || body.skipCache || body.archiveUpgrade || body.researchExpand
  );

  if (body.researchExpand && body.historicPayload && typeof body.historicPayload === 'object') {
    return runResearchExpandGeneralSearch(body, requestContext, teacher);
  }

  if (body.archiveUpgrade && body.historicPayload && typeof body.historicPayload === 'object') {
    return runArchiveUpgradeGeneralSearch(body, requestContext, teacher);
  }

  // "כן, התכוונתי" — the teacher confirmed a suggested archive match: serve it directly.
  const confirmArchiveKey = String(body.confirmArchiveKey || body.archiveCacheKey || '').trim();
  if (confirmArchiveKey) {
    const confirmed = await cache.getGeneralSearchByCacheKey(confirmArchiveKey, { periodBlock: periodBlock });
    if (confirmed && confirmed.data) {
      return {
        data: normalizeGeneralSearchResponse(confirmed.data, { periodBlock: periodBlock }),
        meta: Object.assign({
          fromCache: true,
          source: 'general_search_confirmed',
          periodBlock: periodBlock,
          archived: true,
          archiveBackend: cache.isSupabaseCacheEnabled() ? 'supabase' : 'local-fallback',
        }, confirmed.meta || {}),
      };
    }
    // Fall through to a fresh run if the confirmed key vanished from the archive.
  }

  if (!bypassCache) {
    // Hard 4s budget: partial/corrupt archive rows must never hang the gateway.
    // On timeout or bad payload we purge and fall through to a fresh Perplexity search.
    const cached = await cache.safeArchiveLookup(
      'general_search_cache:' + query.slice(0, 40),
      function () {
        return cache.getGeneralSearchCache(query, { periodBlock: periodBlock });
      },
      { phase: 'general_search', budgetMs: cache.ARCHIVE_LOOKUP_BUDGET_MS }
    );
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
    // No semantic archive suggestion / reference scan — go straight to Phase A (Perplexity).
  }

  const systemPrompt = periodBlock ? PERIOD_BLOCK_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const userPrompt = periodBlock ? buildPeriodBlockUserPrompt(query) : buildStandardUserPrompt(query);

  await enforceLiveSearchQuota(body, requestContext);
  console.log('[pure-general-search] phase-a-only — Perplexity search, no reference/citation scan');
  try {
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

    const searchUsage = await billLiveSearchAfterSuccess(body, requestContext, teacher, normalized);

    return {
      data: normalized,
      meta: {
        fromCache: false,
        source: 'perplexity-pure',
        periodBlock: periodBlock,
        cacheKey: archiveResult.cacheKey || undefined,
        archived: archiveResult.archived,
        archiveBackend: cache.isSupabaseCacheEnabled() ? 'supabase' : 'local-fallback',
        searchBilled: Boolean(searchUsage),
        usage: searchUsage || undefined,
      },
    };
  } catch (err) {
    throw err;
  }
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
    return shared.sendJson(res, statusCode, {
      error: message,
      code: err && err.code ? err.code : undefined,
      usage: err && err.usage ? err.usage : undefined,
    });
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
    return Response.json({
      error: err.message || String(err),
      code: err && err.code ? err.code : undefined,
      usage: err && err.usage ? err.usage : undefined,
    }, { status: statusCode, headers: headers });
  }
}

module.exports = {
  legacyHandler,
  fetch: fetchHandler,
  runPureGeneralSearch,
  normalizeGeneralSearchResponse,
  coerceCurriculumDays,
};
