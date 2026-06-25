/**
 * POST /api/pure-general-search — isolated multi-grade search via Perplexity (no cache).
 * Body: { query }
 */
const shared = require('./pure-api-shared');

const SYSTEM_PROMPT = [
  'You are a Waldorf / anthroposophical pedagogy expert.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'developmental_axis (string: AT LEAST 2-3 comprehensive Hebrew paragraphs tracing the developmental thread across grades 1-8 — soul-spiritual milestones per age band, never brief),',
  'core_pedagogical_emphases (string: AT LEAST 2-3 comprehensive Hebrew paragraphs with Developmental Compass — רציונל התפתחותי ומצפן למורה — plus grade-band lesson dynamics; never superficial),',
  'recommended_literature (array of 5-8 objects: {title, author, note} — note MUST be 1-2 sentences on what the source covers and why it matters),',
  'relevant_links (array of 6-8 objects: {title, url} — title MUST include short context after em dash/colon; live Steiner archives, Waldorf Library, professional essays).',
].join(' ');

function normalizeGeneralSearchResponse(parsed) {
  const data = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    developmental_axis: shared.coerceText(data.developmental_axis),
    core_pedagogical_emphases: shared.coerceText(data.core_pedagogical_emphases),
    recommended_literature: shared.coerceReadingList(data.recommended_literature),
    relevant_links: shared.coerceLinks(data.relevant_links),
  };
}

async function runPureGeneralSearch(body) {
  const query = String(body.query || body.topic || body.q || '').trim();
  if (!query) throw shared.badRequest('query is required');

  const userPrompt = [
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
    '- recommended_literature (ספרות מומלצת): each entry with contextual note explaining coverage and relevance.',
    '- relevant_links (קישורים): 6-8 live professional sources with descriptive titles — not parent-facing school homepages.',
  ].join('\n');

  const parsed = await shared.callPerplexityJson(SYSTEM_PROMPT, userPrompt);
  return normalizeGeneralSearchResponse(parsed);
}

const legacyHandler = shared.createLegacyPostHandler(runPureGeneralSearch);

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
    const data = await runPureGeneralSearch(body || {});
    return Response.json({ ok: true, data: data, meta: { fromCache: false, source: 'perplexity-pure' } }, { status: 200, headers: headers });
  } catch (err) {
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    return Response.json({ error: err.message || String(err) }, { status: statusCode, headers: headers });
  }
}

module.exports = {
  legacyHandler,
  fetch: fetchHandler,
  runPureGeneralSearch,
  normalizeGeneralSearchResponse,
};
