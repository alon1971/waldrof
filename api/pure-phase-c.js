/**
 * POST /api/pure-phase-c — isolated Phase C synthesis via Perplexity (no cache).
 * Body: { grade, topic }
 */
const shared = require('./pure-api-shared');

const SYSTEM_PROMPT = [
  'You are a Waldorf / anthroposophical pedagogy expert.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'core_emphases (string: 2-4 HTML-safe paragraphs in Hebrew on pedagogical essence for this grade+topic),',
  'key_points (array of 4-7 concise Hebrew strings),',
  'recommended_reading (array of objects: {title, author, note}),',
  'relevant_links (array of objects: {title, url} from reputable Waldorf/education sources).',
].join(' ');

function normalizePhaseCResponse(parsed) {
  const data = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    core_emphases: shared.coerceText(data.core_emphases),
    key_points: shared.coerceList(data.key_points),
    recommended_reading: shared.coerceReadingList(data.recommended_reading),
    relevant_links: shared.coerceLinks(data.relevant_links),
  };
}

async function runPurePhaseC(body) {
  const grade = String(body.grade || body.gradeLabel || body.gradeId || '').trim();
  const topic = String(body.topic || '').trim();
  if (!grade) throw shared.badRequest('grade is required');
  if (!topic) throw shared.badRequest('topic is required');

  const userPrompt = [
    'Produce Phase C pedagogical products and essence for Waldorf education.',
    'Grade: ' + grade,
    'Topic: ' + topic,
    'Focus on developmental appropriateness, soul-spiritual qualities, and practical classroom orientation.',
    'Write pedagogical content in Hebrew unless the topic itself is in another language.',
  ].join('\n');

  const parsed = await shared.callPerplexityJson(SYSTEM_PROMPT, userPrompt);
  return normalizePhaseCResponse(parsed);
}

const legacyHandler = shared.createLegacyPostHandler(runPurePhaseC);

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
    const data = await runPurePhaseC(body || {});
    return Response.json({ ok: true, data: data, meta: { fromCache: false, source: 'perplexity-pure' } }, { status: 200, headers: headers });
  } catch (err) {
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    return Response.json({ error: err.message || String(err) }, { status: statusCode, headers: headers });
  }
}

module.exports = {
  legacyHandler,
  fetch: fetchHandler,
  runPurePhaseC,
  normalizePhaseCResponse,
};
