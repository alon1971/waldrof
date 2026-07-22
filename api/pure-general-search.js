/**
 * POST /api/pure-general-search — Phase A Perplexity web search + parallel community/Drive probe.
 * Community matches are returned in meta (communityMatches / communityStatus) for a separate UI block.
 * Body: { query, periodBlock?: boolean }
 */
const shared = require('./pure-api-shared');
const cache = require('./cache');
const authContext = require('./auth-context');
const subscriptionApi = require('./subscription');
const hebrewGuardrails = require('./perplexity-hebrew-guardrails');
const keyboardLayout = require('./keyboard-layout');

/** Absolute Hebrew-only body text — no English prose, footnotes, or citation markers. */
const HEBREW_ONLY_BODY_INSTRUCTION = [
  '=== עברית נקייה בלבד (איסור מוחלט) ===',
  'חל איסור מוחלט לכלול מילים באנגלית, הערות שוליים, סימוני מקורות (כמו [1], [2] או [cite]) או ביטויים זרים בגוף הטקסט.',
  'כל התוכן חייב להיות בעברית נקייה, פדגוגית ומקצועית בלבד.',
  'שמות ספרים/מחברים באנגלית מותרים רק בתוך recommended_literature.title / author וכתובות URL בתוך relevant_links.url — לא בגוף developmental_axis, core_pedagogical_emphases או curriculum.',
  '=== סוף עברית נקייה ===',
].join(' ');

/**
 * Period-block depth without long essay paragraphs that blow the token budget mid-JSON.
 * Full 15-day plans stay complete by using focused bullets + structured lesson rows.
 */
const PERIOD_BLOCK_DEPTH_AND_JSON_INSTRUCTION = [
  '=== תוכנית תקופה מלאה + JSON קשיח (חובה) ===',
  'בנה תוכנית לימודים מלאה, עמוקה ומפורטת ל-15 ימי תקופה מלאים (3 שבועות × 5 ימים) — לעולם אל תבקש/תייצר חומר קצר או מקוצר.',
  'התשובה כולה חייבת להיות אובייקט JSON תקין אחד בלבד, במבנה המדויק שה-Frontend מצפה לקבל — ללא טקסט חופשי, ללא הקדמה, ללא Markdown, ללא ```.',
  'כדי שה-JSON לא יישבר בגלל אורך: בנה את מהלך 15 הימים באמצעות נקודות (bullet points) ממוקדות, נושאי ליבה יומיים ומערכי שיעור מובנים — לא פסקאות טקסט ארוכות ומסורבלות.',
  'כל יום ב-curriculum חייב להיות מלא פדגוגית (נושא + תוכן + אמנות) אך מנוסח כנקודות/משפטים ממוקדים עם \\n בין שורות — לא חיבורי פרוזה ארוכים.',
  'developmental_axis ו-core_pedagogical_emphases: עומק פדגוגי מלא ב-2–4 פסקאות עבריות ממוקדות (לא חיבורים אקדמיים ארוכים שגוזלים את תקציב הטוקנים מימי 10–15).',
  'חובה להשלים את כל 15 הימים עד סוף האובייקט — אל תחתוך באמצע מערך, אל תשמיט ימים, אל תסיים ביום 8–12.',
  '=== סוף תוכנית תקופה ===',
].join(' ');

/** Phase A only — exact JSON keys the Frontend expects. No Phase B / citation scan. */
const SYSTEM_PROMPT = [
  hebrewGuardrails.PERPLEXITY_HEBREW_GUARDRAILS,
  HEBREW_ONLY_BODY_INSTRUCTION,
  'You are a Waldorf / anthroposophical pedagogy expert.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'developmental_axis (string: AT LEAST 2-3 comprehensive Hebrew paragraphs tracing the developmental thread across grades 1-8 — soul-spiritual milestones per age band, never brief),',
  'core_pedagogical_emphases (string: AT LEAST 2-3 comprehensive Hebrew paragraphs with Developmental Compass — רציונל התפתחותי ומצפן למורה — plus grade-band lesson dynamics; never superficial),',
  'recommended_literature (array of 5-8 objects: {title, author, note} — note MUST be 1-2 sentences on what the source covers and why it matters),',
  'relevant_links (array of 6-8 objects: {title, url} — title MUST include short context after em dash/colon; live Steiner archives, Waldorf Library, professional essays).',
  'Strictly exclude any sources, domains, or web links from Russian websites, Russian academic databases (e.g., CyberLeninka, KPFU), or Russian social networks (e.g., VK). All returned sources and citations MUST be exclusively from reputable English or Hebrew websites and domains (.com, .org, .edu, .gov, .co.il, etc.).',
  'CRITICAL: return exactly one valid JSON object — no free text, no preamble, no Markdown outside the JSON.',
].join(' ');

const PERIOD_BLOCK_SYSTEM_PROMPT = [
  hebrewGuardrails.PERPLEXITY_HEBREW_GUARDRAILS,
  HEBREW_ONLY_BODY_INSTRUCTION,
  PERIOD_BLOCK_DEPTH_AND_JSON_INSTRUCTION,
  'You are a Waldorf / anthroposophical pedagogy expert specializing in main-lesson block planning.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'developmental_axis (string: 2-4 focused Hebrew paragraphs — soul-spiritual developmental context for the stated grade and subject; full pedagogical depth, not a stub),',
  'core_pedagogical_emphases (string: 2-4 focused Hebrew paragraphs — Waldorf block rhythm, narrative arc, Developmental Compass / מצפן התפתחותי, and teacher compass for this grade+subject),',
  'recommended_literature (array of 3-6 objects: {title, author, note} — note in clean Hebrew explaining relevance to this block),',
  'relevant_links (array of 4-6 objects: {title, url} — professional Waldorf sources only; title in Hebrew with short context),',
  'curriculum (array of EXACTLY 15 objects — one per school day — each with: day (integer 1-15), week (integer 1-3), topic (Hebrew core daily topic), content (Hebrew focused bullet points for main narrative/story/new material, separated by \\n — NOT long essays), art (Hebrew focused bullet points for notebook/drawing/painting/handwork)).',
  'NEVER shorten the 15-day plan. NEVER omit days. Prefer structured bullets over long paragraphs so the FULL JSON closes cleanly.',
  'Strictly exclude any sources, domains, or web links from Russian websites, Russian academic databases (e.g., CyberLeninka, KPFU), or Russian social networks (e.g., VK). All returned sources and citations MUST be exclusively from reputable English or Hebrew websites and domains (.com, .org, .edu, .gov, .co.il, etc.).',
  'CRITICAL: return exactly one valid JSON object — no free text, no preamble, no Markdown outside the JSON. First char { last char }.',
].join(' ');

/** Strip citation markers / footnotes that leak into Hebrew pedagogical body text. */
function stripCitationMarkers(text) {
  return String(text || '')
    .replace(/\[\s*(?:cite(?:_start|_end)?|citation|ref|source|note)\s*\]/gi, '')
    .replace(/\[\s*\d+\s*\]/g, '')
    .replace(/\(\s*(?:cite|citation|ref|source)\s*[:\s]*[^)]*\)/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function sanitizePedagogicalText(value) {
  return stripCitationMarkers(shared.coerceText(value));
}

function looksLikeGatewayHtmlOrEnglishDump(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/<!DOCTYPE|<html[\s>]|<head[\s>]|<body[\s>]|<pre[\s>]|Gateway Time-?out|502 Bad Gateway|504 Gateway|Cloudflare|nginx/i.test(s)) {
    return true;
  }
  // Raw JSON / repair debris dumped into display fields
  if (/^\s*[\{\[]/.test(s) && /"(?:developmental_axis|curriculum|day|topic)"\s*:/.test(s)) {
    return true;
  }
  const hebrew = (s.match(/[\u0590-\u05FF]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  // Mostly Latin with almost no Hebrew → English dump from parse fallback / model preamble
  if (latin > 80 && hebrew < Math.max(20, latin * 0.15)) return true;
  return false;
}

function isUnusableGeneralSearchParse(parsed, periodBlock) {
  if (!parsed || typeof parsed !== 'object') return true;
  if (parsed._parseFallback) {
    const axis = String(parsed.developmental_axis || '');
    const emphases = String(parsed.core_pedagogical_emphases || '');
    if (looksLikeGatewayHtmlOrEnglishDump(axis) || looksLikeGatewayHtmlOrEnglishDump(emphases)) {
      return true;
    }
    // Fallback with empty curriculum on a period request is unusable
    if (periodBlock) {
      const days = Array.isArray(parsed.curriculum) ? parsed.curriculum.length : 0;
      if (days < 10) return true;
    }
  }
  return false;
}

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
      topic: sanitizePedagogicalText(row.topic || row.title || row.theme || row.subject || ''),
      content: sanitizePedagogicalText(
        row.content || row.narrative || row.story || row.lesson || row.mainLesson || row.text || ''
      ),
      art: sanitizePedagogicalText(
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
    developmental_axis: sanitizePedagogicalText(data.developmental_axis),
    core_pedagogical_emphases: sanitizePedagogicalText(data.core_pedagogical_emphases),
    recommended_literature: shared.coerceReadingList(data.recommended_literature).map(function (item) {
      return {
        title: String(item.title || '').trim(),
        author: String(item.author || '').trim(),
        note: sanitizePedagogicalText(item.note),
      };
    }),
    relevant_links: shared.coerceLinks(data.relevant_links).map(function (item) {
      return {
        title: sanitizePedagogicalText(item.title) || String(item.title || '').trim(),
        url: String(item.url || '').trim(),
      };
    }),
  };
  if (periodBlock) {
    normalized.periodBlock = true;
    normalized.curriculum = coerceCurriculumDays(
      data.curriculum || data.days || (data.blockPlan && data.blockPlan.curriculum)
    );
  }
  return normalized;
}

/**
 * Call Perplexity for general-search; never return English/HTML parse-fallback dumps to the UI.
 */
async function callGeneralSearchJson(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const periodBlock = Boolean(opts.periodBlock);
  const phase = opts.phase || (periodBlock ? 'general_search_period' : 'general_search');
  const result = await shared.callPerplexityJsonSafe(systemPrompt, userPrompt, {
    phase: phase,
    query: opts.query || '',
    max_tokens: opts.max_tokens,
    temperature: opts.temperature,
  });
  const parsed = result && result.parsed;
  if (result && result.parseFallback && isUnusableGeneralSearchParse(parsed, periodBlock)) {
    const err = new Error(
      periodBlock
        ? 'תשובת המודל לא חזרה כ-JSON תקין לתוכנית 15 הימים. נסו שוב — ללא הצגת טקסט גולמי/HTML.'
        : 'תשובת המודל לא חזרה כ-JSON תקין. נסו שוב — ללא הצגת טקסט גולמי/HTML.'
    );
    err.statusCode = 502;
    err.code = 'INVALID_MODEL_JSON';
    throw err;
  }
  return parsed;
}

function buildPeriodBlockUserPrompt(query) {
  return [
    'בנה תוכנית תקופה מלאה בחינוך וולדרוף: 3 שבועות × 5 ימי לימוד = 15 ימים במלואם.',
    'אל תייצר חומר קצר או מקוצר — התוכנית חייבת להיות מלאה, עמוקה ומפורטת לכל 15 הימים.',
    'שאילתה (נושא ו/או כיתה — למשל «רנסנס כיתה ז»): ' + query,
    'חלץ את הכיתה ואת נושא התקופה מהשאילתה. אם הכיתה אינה מפורשת — הסיק את הכיתה הקנונית בחינוך וולדרוף לנושא זה.',
    '',
    HEBREW_ONLY_BODY_INSTRUCTION,
    '',
    PERIOD_BLOCK_DEPTH_AND_JSON_INSTRUCTION,
    '',
    'דרישות מבנה JSON (מפתחות מדויקים בלבד):',
    '- developmental_axis: הקשר נפשי-רוחני התפתחותי לכיתה ולנושא זה — 2–4 פסקאות עבריות ממוקדות ומעמיקות.',
    '- core_pedagogical_emphases: קשת התקופה, מקצב, שילוב אמנותי, מצפן התפתחותי ומצפן למורה — 2–4 פסקאות עבריות ממוקדות.',
    '- recommended_literature: מקורות מקצועיים לתקופה (הערות בעברית נקייה).',
    '- relevant_links: כתובות מקצועיות מאומתות (כותרות בעברית עם הקשר קצר).',
    '',
    'curriculum (תוכנית 15 ימים) — חובה מוחלטת:',
    '- בדיוק 15 אובייקטים: day 1 עד day 15.',
    '- week 1 = ימים 1–5, week 2 = ימים 6–10, week 3 = ימים 11–15.',
    '- בכל יום: topic (נושא ליבה יומי), content (נקודות ממוקדות לסיפור/תוכן חדש — מופרדות ב-\\n), art (נקודות ממוקדות למחברת/ציור/צביעה/עבודת יד).',
    '- אין פסקאות ארוכות ב-content/art — רק נקודות/משפטים ממוקדים ששומרים על JSON שלם עד יום 15.',
    '- קשת נרטיבית רציפה לאורך כל 15 הימים: פתיחה, העמקה, שיא, שילוב.',
    '- מקצב שיעור ראשי: סיפור/דקלום, היזכרות, חומר חדש, עבודה אמנותית.',
    '- שפה ופעילויות מותאמות לגיל הכיתה.',
  ].join('\n');
}

function buildStandardUserPrompt(query) {
  return [
    'General Waldorf pedagogy search across elementary grades (1-8).',
    'Query: ' + query,
    'Provide a structured multi-grade analysis: developmental progression, core emphases by age band,',
    'recommended professional literature, and relevant web resources.',
    '',
    HEBREW_ONLY_BODY_INSTRUCTION,
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
    'CRITICAL: return exactly one valid JSON object — no free text, no preamble, no Markdown.',
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
    const parsed = await callGeneralSearchJson(systemPrompt, userPrompt, {
      phase: periodBlock ? 'general_search_period' : 'general_search',
      query: query,
      periodBlock: periodBlock,
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
    const parsed = await callGeneralSearchJson(systemPrompt, userPrompt, {
      phase: periodBlock ? 'general_search_period' : 'general_search',
      query: query,
      periodBlock: periodBlock,
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

  // Community Drive summarization is decoupled — see /api/community-summarizer.
  // Live general search is web/archive only.

  if (body.researchExpand && body.historicPayload && typeof body.historicPayload === 'object') {
    const expanded = await runResearchExpandGeneralSearch(body, requestContext, teacher);
    return {
      data: expanded.data,
      meta: expanded.meta || {},
    };
  }

  if (body.archiveUpgrade && body.historicPayload && typeof body.historicPayload === 'object') {
    const upgraded = await runArchiveUpgradeGeneralSearch(body, requestContext, teacher);
    return {
      data: upgraded.data,
      meta: upgraded.meta || {},
    };
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
  console.log('[pure-general-search] live web search (community summary decoupled)');
  try {
    const parsed = await callGeneralSearchJson(systemPrompt, userPrompt, {
      phase: periodBlock ? 'general_search_period' : 'general_search',
      query: query,
      periodBlock: periodBlock,
    });
    const normalized = normalizeGeneralSearchResponse(parsed, { periodBlock: periodBlock });

    // Period plans must arrive complete — never archive/serve a truncated curriculum.
    if (periodBlock && (!Array.isArray(normalized.curriculum) || normalized.curriculum.length < 15)) {
      const err = new Error(
        'תוכנית התקופה חזרה חלקית (' +
          (normalized.curriculum ? normalized.curriculum.length : 0) +
          '/15 ימים). נסו שוב לקבלת תוכנית מלאה.'
      );
      err.statusCode = 502;
      err.code = 'INCOMPLETE_PERIOD_CURRICULUM';
      throw err;
    }

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
