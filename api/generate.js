/**
 * Waldorf research API — secure Perplexity proxy.
 * Perplexity API key is read server-side only (never exposed to the browser).
 * Set PERPLEXITY_API_KEY or AI_API_KEY in Render Environment (or .env locally).
 *
 * Content hierarchy (lesson generation):
 *   1. LIVE WEB SEARCH (Perplexity) — primary anchor for broad, deep lesson content
 *   2. INGESTED GOOGLE DRIVE ARCHIVE (knowledge_base) — supplementary Waldorf enrichment
 *   3. CONSOLIDATED OUTPUT → cached_results — serve on 99%+ similarity match
 *
 * Primary runtime: Render / Node.js via server.js → executeGenerate().
 * Optional: legacyHandler(req, res) for adapters; fetch(request) for Vercel serverless.
 */

const fs = require('fs');
const path = require('path');
const cacheDb = require('./cache');
const ragDb = require('./rag');
const knowledgeIngest = require('./knowledge-ingest');
const subscriptionApi = require('./subscription');
const searchLogs = require('./search-logs');
const authContext = require('./auth-context');
const perplexityClient = require('./perplexity-client');
const jsonRepair = require('./json-repair');
const env = require('./env');

const {
  cleanAndParseJSON,
  parseJsonLenient,
  parseJsonFromModel,
  unwrapParsedModelPayload,
  buildModelParseFallback,
} = jsonRepair;

(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
})();

const PERPLEXITY_URL = perplexityClient.PERPLEXITY_URL;
const PERPLEXITY_MODEL = perplexityClient.PERPLEXITY_MODEL;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const NO_LATEX_BLOCK =
  '\n=== NO LaTeX / MATH MARKUP (MANDATORY) ===\n' +
  'NEVER use LaTeX, TeX, MathJax, KaTeX, or any backslash math notation.\n' +
  'FORBIDDEN examples: \\frac, \\(, \\), \\[, \\], $...$, \\sqrt, \\times, \\cdot, \\div, \\text, \\begin, \\end.\n' +
  'Write ALL fractions and formulas as simple plain Hebrew text: slash notation (1/2, 3/2) or words (חצי, שלושה חצאים, חצי ועוד חצי).\n' +
  'In HTML fields use ONLY simple tags (<p>, <ul>, <ol>, <li>, <strong>, <em>, <h3>) — NEVER output <div class="prose-ai"> wrappers (the UI adds them).\n' +
  '=== END NO LaTeX ===\n';

const JSON_ONLY_INSTRUCTION =
  'Return ONLY the raw, valid JSON object matching the requested schema. ' +
  'Do not include any markdown formatting, do not wrap the response in ```json ... ``` blocks, ' +
  'and do not append any text, explanations, or extra characters before or after the JSON structure.';

const JSON_RESPONSE_ENFORCEMENT =
  '\n=== OUTPUT: RAW JSON ONLY (ABSOLUTE — MANDATORY) ===\n' +
  'Your ENTIRE reply MUST be exactly ONE valid JSON object — nothing before it, nothing after it.\n' +
  'FORBIDDEN: markdown code fences (```json, ```), preamble ("הנה התשובה", "Here is the JSON"), postamble, comments, // notes, trailing commas.\n' +
  'The server runs JSON.parse() on your full reply — ANY extra character outside the {…} object causes a fatal error and cached results cannot be saved.\n' +
  'Start with { and end with } — no leading or trailing prose, labels, or whitespace-only wrappers.\n' +
  'Inside every string value: escape every literal double quote (") as \\"; prefer « » for Hebrew inner quotations; escape newlines as \\n.\n' +
  'Verify mentally that JSON.parse(your_entire_reply) succeeds with zero syntax errors before you finish.\n' +
  '=== END OUTPUT: RAW JSON ONLY ===\n';

const JSON_VALID_SYNTAX_INSTRUCTION =
  '\n=== JSON STRING ESCAPING (MANDATORY) ===\n' +
  'The entire response MUST pass JSON.parse() with zero syntax errors.\n' +
  'Inside EVERY string value — Hebrew text, HTML, citations, quotes, titles, bullet items, and nested content:\n' +
  '- Escape every literal double quote (") as \\" (backslash then quote). Example: "המורה אמר \\"כימיה\\" בכיתה".\n' +
  '- Escape every backslash as \\\\.\n' +
  '- Escape control characters inside strings: newline as \\n, tab as \\t, carriage return as \\r.\n' +
  '- When Hebrew text contains nested quotes, guillemets (« »), or special characters, ensure they remain INSIDE a valid JSON string — never let an unescaped " terminate the string early.\n' +
  '- Prefer Hebrew guillemets « » for inner quotations when possible; if ASCII double quotes appear inside a value, they MUST be written as \\".\n' +
  'Property names MUST be double-quoted; all string values MUST use double quotes (never single quotes for JSON strings).\n' +
  'No trailing commas, no comments, no raw unescaped line breaks inside string values.\n' +
  'Before finishing, verify that every property name and value maintains valid JSON syntax end-to-end.\n' +
  '=== END JSON STRING ESCAPING ===\n';

const WEB_SEARCH_PRIORITY_INSTRUCTION =
  '\n=== WEB SEARCH STRATEGY — CORE ANCHOR (MANDATORY) ===\n' +
  'LIVE INTERNET SEARCH via Perplexity is the PRIMARY and MANDATORY foundation for every lesson plan. ' +
  'Perform a BROAD, EXHAUSTIVE internet search for the richest general educational and pedagogical material relevant to the query. ' +
  'Gather wide lesson structures, classroom practice, curriculum sequences, and anthroposophic perspectives from live web sources ' +
  '(AWSNA, IASWECE, Waldorf Library, Steiner Archive, international teacher resources, classroom practice, and more). ' +
  'The lesson plan MUST be deep, comprehensive, and never lacking in content — web research is the core anchor.\n' +
  'CORE ARCHIVE — Waldorf Research Institute Library (https://waldorflibrary.org/): ' +
  'Always search this official library as an additional core archive and draw relevant pedagogical material from it when available. ' +
  'Do NOT restrict research to this site alone — continue broad web search across all other sources listed above.\n' +
  'Also check (but do NOT force) Alon Yerushalmy\'s platforms for a genuinely relevant match:\n' +
  '- Alon Yerushalmy (אלון ירושלמי)\n' +
  '- The Hebrew podcast «מסעות בחינוך»\n' +
  '- The website educationpace.com\n' +
  'Include these ONLY when search results contain direct, substantial, topic-specific material — never invent or stretch a connection.\n' +
  'When such content genuinely matches, weave it objectively alongside general web research — list each used source once at the end, never repeatedly in the body.\n' +
  'If there is no meaningful match (e.g. Chemistry, Physics, or other topics not covered by his materials), OMIT his name and platforms entirely.\n' +
  'Also actively search for diverse Waldorf/anthroposophic authors, global curriculum boards, international researchers, ' +
  'and prominent Israeli Waldorf educators beyond the priority sources — to build a broad, credible source landscape.\n' +
  '=== END WEB SEARCH STRATEGY ===\n';

const CONTENT_HIERARCHY_INSTRUCTION =
  '\n=== CONTENT HIERARCHY (MANDATORY — ALL LESSON GENERATION) ===\n' +
  'Follow this exact three-tier architecture:\n' +
  '1. LIVE WEB SEARCH (Perplexity) — CORE ANCHOR: Build the lesson plan primarily from broad, rich, exhaustive live web research. ' +
  'Never shorten, narrow, or omit web-sourced content because local archive excerpts exist.\n' +
  '2. PRIVATE INGESTED GOOGLE DRIVE ARCHIVE (Alon) — SUPPLEMENTARY ENRICHMENT: When PRIVATE DRIVE ARCHIVE excerpts are provided below, ' +
  'use them as a secondary layer of pedagogical enrichment and Waldorf-philosophy validation — blend them INTO the web foundation. ' +
  'Drive archive folders: חינוך, קורס, כיתה, מחזור ראשון, מחזור שני, הרצאות, waldorf, waldorf project, waldrof project, שטיינר.\n' +
  '3. SHARED COMMUNITY ARCHIVE — SUPPLEMENTARY ENRICHMENT: When SHARED COMMUNITY ARCHIVE excerpts are provided below, ' +
  'use teacher-uploaded lesson plans and pedagogical notes as an additional enrichment layer — blend them INTO the web foundation alongside Drive excerpts. ' +
  'Community materials come from teacher uploads (PDF/Word/text) indexed in community_knowledge_base.\n' +
  '4. MERGE: Produce ONE deep, comprehensive, consolidated lesson plan that merges live web breadth with relevant Drive-archive and community-archive insights. ' +
  'The final output must be richer than any single source alone — never a thin summary of local excerpts only.\n' +
  '=== END CONTENT HIERARCHY ===\n';

const DRIVE_ARCHIVE_ENRICHMENT_INSTRUCTION =
  '\n=== PRIVATE DRIVE ARCHIVE (Alon) — SUPPLEMENTARY ONLY ===\n' +
  'Excerpts tagged [ארכיון Drive פרטי — העשרה משלימה] or under PRIVATE DRIVE ARCHIVE come from ingested Google Drive folders. ' +
  'They are SUPPLEMENTARY — never the primary source. Use them to enrich tone, validate Waldorf doctrine, and add teacher-community nuance. ' +
  'Do NOT replace, narrow, or shorten web-sourced lesson content because Drive excerpts exist. ' +
  'If no Drive excerpts match, proceed fully from live web search alone.\n' +
  '=== END PRIVATE DRIVE ARCHIVE ===\n';

const COMMUNITY_ARCHIVE_ENRICHMENT_INSTRUCTION =
  '\n=== SHARED COMMUNITY ARCHIVE — SUPPLEMENTARY ONLY ===\n' +
  'Excerpts tagged [ארכיון קהילה משותף — העשרה משלימה] or under SHARED COMMUNITY ARCHIVE come from teacher community uploads ' +
  '(lesson plans, main-lesson blocks, pedagogical notes) indexed in community_knowledge_base. ' +
  'They are SUPPLEMENTARY — never the primary source. Use them to enrich classroom practice, period planning, and peer-teacher insights. ' +
  'Do NOT replace, narrow, or shorten web-sourced lesson content because community excerpts exist. ' +
  'If no community excerpts match, proceed from live web search (and Drive excerpts if present).\n' +
  '=== END SHARED COMMUNITY ARCHIVE ===\n';

const STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION =
  '\n=== STEINER / ANTHROPOSOPHIC SOURCE FIDELITY (CRITICAL — ABSOLUTE — ALL OUTPUTS) ===\n' +
  'This rule binds EVERY response in the application: Step A (age portrait / תמונת גיל), Step B (topic research / מחקר נושא), ' +
  'Step C (period planning / תכנון תקופה), and the Pedagogical AI Chat Assistant (עוזר ה-AI).\n' +
  'AUTHORITATIVE SOURCES ONLY:\n' +
  'Base ALL pedagogical and anthroposophic content EXCLUSIVELY on reliable, established, proven material from Rudolf Steiner\'s anthroposophy and Waldorf pedagogy — ' +
  'including foundation lectures (GA / Gesamtausgabe), core pedagogical writings, and verified anthroposophic literature faithfully grounded in Steiner\'s corpus.\n' +
  'Primary anchors: Steiner Archive, official GA education lecture cycles (e.g. The Foundations of Human Experience, Practical Advice to Teachers, Discussions with Teachers), ' +
  'and recognized anthroposophic pedagogical scholarship derived directly from Steiner — not popular summaries or unverified reinterpretations.\n' +
  'When LIVE WEB SEARCH results are provided, treat them as the PRIMARY foundation for substantive claims and lesson breadth.\n' +
  'When INGESTED DRIVE ARCHIVE excerpts are also provided, blend them as supplementary Waldorf enrichment and validation — ' +
  'they do NOT replace or narrow live web research. Steiner/GA material from web search takes precedence over secondary sources when they conflict.\n' +
  'ABSOLUTE PROHIBITION — NO HALLUCINATION:\n' +
  'You are STRICTLY FORBIDDEN to hallucinate, guess, speculate, invent concepts, doctrines, developmental claims, temperament links, ' +
  'curriculum sequences, main-lesson practices, or classroom activities.\n' +
  'You are STRICTLY FORBIDDEN to offer free personal interpretations, modern spins, intuitive associations, or plausible-sounding Waldorf ideas ' +
  'that lack DIRECT backing in Steiner\'s foundational lectures, core writings, or explicitly retrieved official anthroposophic sources.\n' +
  'If a claim cannot be traced to such verified material — OMIT it entirely. Never pad, never improvise, never "fill gaps" with model knowledge.\n' +
  'QUALITY STANDARD:\n' +
  'Every sentence must be accurate, professionally grounded, and faithful to the original anthroposophic-pedagogical source. ' +
  'Write as a careful translator of established Steiner-based pedagogy — not as a creative interpreter.\n' +
  '=== END STEINER / ANTHROPOSOPHIC SOURCE FIDELITY ===\n';

const FACTUAL_INTEGRITY_INSTRUCTION =
  '\n=== FACTUAL INTEGRITY & ACCURACY (ABSOLUTE — MANDATORY) ===\n' +
  'UNIVERSAL CITATION & CREDIT RULE:\n' +
  'You are STRICTLY FORBIDDEN from fabricating, hallucinating, or assuming authorship, credits, or direct quotes for ANYONE — ' +
  'including Rudolf Steiner, Alon Yerushalmy (אלון ירושלמי), or any other educator or platform ' +
  '(such as the «מסעות בחינוך» podcast or educationpace.com).\n' +
  'Every single credit, attribution, or direct quote MUST be 100% factually backed and explicitly found within your retrieved web search results.\n' +
  'If a concept is true but not explicitly linked to a specific person in the search data, describe it objectively without inventing a source or attribution.\n' +
  'STRICT RELEVANCE & FACTUALITY RULE:\n' +
  'You are STRICTLY PROHIBITED from inventing or fabricating any concepts, curriculum details, or historical/pedagogical facts that are not supported by the search results.\n' +
  'Stay within the boundaries of verified facts. Never pad or dilute the response with irrelevant, stray, or invented theories just to make the text longer.\n' +
  'Every single sentence MUST be accurate, highly relevant to the query, and 100% grounded in reality.\n' +
  '=== END FACTUAL INTEGRITY & ACCURACY ===\n';

const ACADEMIC_TONE_INSTRUCTION =
  '\n=== ACADEMIC TONE & SOURCE DISCIPLINE (MANDATORY) ===\n' +
  'Write in a professional, clean, and humble academic tone.\n' +
  'Present curriculum and pedagogical content OBJECTIVELY — as established knowledge and classroom practice, not as repeated endorsements.\n' +
  'Do NOT scatter credits, attributions, or name-drops throughout the body text.\n' +
  'FORBIDDEN: repetitive phrasing such as "inspired by Alon Yerushalmy", "according to אלון ירושלמי", "from מסעות בחינוך", ' +
  'or mentioning the same person, podcast, archive, or platform multiple times across sections.\n' +
  'Mention any educator, podcast, archive, or platform AT MOST ONCE in the entire response — and only if genuinely drawn from your search results.\n' +
  'List all sources quietly and professionally at the very end under "Sources & Further Reading" ' +
  '(or the schema\'s existing sources/bibliography field) — never scattered through the body.\n' +
  'The main body must read as coherent pedagogical prose without promotional or repetitive attribution.\n' +
  '=== END ACADEMIC TONE & SOURCE DISCIPLINE ===\n';

const PEDAGOGICAL_CHAT_GROUNDING_INSTRUCTION =
  '\n=== PEDAGOGICAL CHAT — COMMUNITY FIRST + STEINER-GROUNDED + LIVE WEB SEARCH (MANDATORY) ===\n' +
  'You are the Pedagogical Chat Assistant for Waldorf / Steiner-Waldorf teachers — a supportive, highly accurate pedagogical peer.\n' +
  'RESEARCH STRATEGY (every question — strict order):\n' +
  '0. COMMUNITY FIRST: Before answering, review the COMMUNITY MATERIALS DATABASE block in the user message. ' +
  'It lists titles, topics, and descriptions already uploaded by teachers to community_materials / community_knowledge_base (Supabase). ' +
  'When matches exist, celebrate them in your opening and weave them into the answer.\n' +
  '1. LIVE WEB SEARCH via Perplexity — Rudolf Steiner (GA lectures, Steiner Archive), ' +
  'core anthroposophic pedagogical writings, AWSNA, IASWECE, Waldorf Research Institute Library (waldorflibrary.org).\n' +
  '2. Supplement with lesson context and any KNOWLEDGE BASE excerpts in the user message.\n' +
  'ANTI-HALLUCINATION:\n' +
  'NEVER fabricate Steiner quotes, GA numbers, doctrines, temperament links, or curriculum details absent from search or provided sources.\n' +
  'NEVER answer from vague model knowledge or free personal anthroposophic interpretation.\n' +
  'WHEN TO ANSWER:\n' +
  'Give a full, warm, practical Hebrew answer when community materials, live search, and/or lesson context provide verified material.\n' +
  'FALLBACK (only when community database + live search + lesson context + knowledge base all lack verified material on the specific question):\n' +
  'Respond humbly in Hebrew that you could not locate verified material on this point — invite reframing or sharing sources.\n' +
  'Do NOT claim "אין חומר במאגר הקהילתי" when the COMMUNITY MATERIALS DATABASE block lists matches.\n' +
  'Do NOT default to "אין חומר במאגר הקהילתי" when web search can answer from Steiner/core anthroposophic sources.\n' +
  'For fallback replies: write the same humble Hebrew decline as plain prose.\n' +
  'TONE: Grounded, authentic, authoritative yet humble. Practical for classroom teachers when sources support it.\n' +
  '=== END PEDAGOGICAL CHAT — COMMUNITY FIRST + STEINER-GROUNDED + LIVE WEB SEARCH ===\n';

const COMMUNITY_FIRST_CHAT_INSTRUCTION =
  '\n=== COMMUNITY FIRST — PEDAGOGICAL CHAT OPENING (MANDATORY WHEN MATCHES EXIST) ===\n' +
  'When the COMMUNITY MATERIALS DATABASE block lists one or more matches (keyword OR semantic), ' +
  'you MUST open your Hebrew reply with the exact celebration line supplied in that block or in CRITICAL INSTRUCTION.\n' +
  'Required opening pattern (use teacher name, grade label, and matched file title from the provided blocks):\n' +
  '«[שם פרטי], הרווחת! מישהו מהקהילה העלה למאגר הקהילתי ל[כיתה] «[שם הקובץ]». אתה יכול להיכנס למאגר הקהילתי באתר, תחת [כיתה] כדי לצפות בקובץ הנוכחי.»\n' +
  'When NO community matches are listed, proceed with your standard high-quality pedagogical assistance — no forced celebration opening.\n' +
  '=== END COMMUNITY FIRST — PEDAGOGICAL CHAT OPENING ===\n';

const SOURCES_CITATION_INSTRUCTION =
  '\n=== SOURCES, CITATIONS & VISUAL INSPIRATION (MANDATORY) ===\n' +
  'ALON YERUSHALMY — RELEVANCE-FIRST, SINGLE CITATION RULE:\n' +
  'NEVER force, fabricate, or artificially insert Alon Yerushalmy, «מסעות בחינוך», or educationpace.com into the response.\n' +
  'Cite his platforms ONLY when search results provide a direct, meaningful, substantial match to the specific query — ' +
  'not as a courtesy mention, filler, or vague thematic overlap.\n' +
  'If a topic (e.g. Chemistry, Physics) is not naturally covered by his materials, OMIT his name completely — ' +
  'do not bend the truth or force a connection; focus 100% on other verified Waldorf/anthroposophic sources and Pinterest visual inspiration.\n' +
  'When genuinely relevant content IS found across his platforms (educationpace.com, «מסעות בחינוך» podcast, courses, articles, or related channels), ' +
  'combine ALL of it into ONE quiet, professional citation at the very end under "Sources & Further Reading" ' +
  '(or the schema\'s sources/bibliography field). Example: "אלון ירושלמי — educationpace.com, פודקאסט מסעות בחינוך" (adapt to what was actually used).\n' +
  'STRICTLY FORBIDDEN: listing Alon Yerushalmy multiple times, separating his platforms into distinct source entries, or citing him when search data does not support it.\n' +
  'SOURCE DIVERSITY — "Sources & Further Reading":\n' +
  'This section MUST be rich, diverse, and objective. Actively search for and include a broad pedagogical landscape: ' +
  'Rudolf Steiner (GA lectures where verified), anthroposophic authors (e.g. von Baravalle, Finser, Harwood, Aeppli, Rawson, Stebbing), ' +
  'AWSNA, IASWECE, the Waldorf Research Institute Library (https://waldorflibrary.org/), Steiner Archive, global Waldorf curriculum boards, and prominent Israeli / international Waldorf educators and researchers.\n' +
  'No single figure or platform may dominate — aim for breadth and professional credibility.\n' +
  'PINTEREST VISUAL INSPIRATION:\n' +
  'Actively search for or suggest relevant Pinterest boards and search queries tied to the pedagogical topic ' +
  '(e.g. Waldorf Chemistry main-lesson experiments, chalkboard drawings, hands-on craft for the block).\n' +
  'Present these cleanly in the gallery field as optional visual inspiration — descriptive Hebrew board titles and precise Pinterest search phrases in "pin"; no URLs required.\n' +
  '=== END SOURCES, CITATIONS & VISUAL INSPIRATION ===\n';

function waldorfSystemPrompt(extra) {
  return (
    'You are an expert Waldorf / Steiner-Waldorf pedagogy researcher and curriculum designer. ' +
    'Use live web search as the CORE ANCHOR to gather broad, exhaustive, high-quality educational material for every query. ' +
    CONTENT_HIERARCHY_INSTRUCTION +
    STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
    WEB_SEARCH_PRIORITY_INSTRUCTION +
    DRIVE_ARCHIVE_ENRICHMENT_INSTRUCTION +
    COMMUNITY_ARCHIVE_ENRICHMENT_INSTRUCTION +
    FACTUAL_INTEGRITY_INSTRUCTION +
    ACADEMIC_TONE_INSTRUCTION +
    SOURCES_CITATION_INSTRUCTION +
    JSON_ONLY_INSTRUCTION +
    JSON_RESPONSE_ENFORCEMENT +
    JSON_VALID_SYNTAX_INSTRUCTION +
    ' Write pedagogical content in Hebrew. ' +
    'Ground every claim in verified Steiner/anthroposophic sources from live web search — never general model knowledge or invented pedagogy. ' +
    'Blend ingested Drive archive excerpts as supplementary enrichment when provided — never let them replace web breadth. ' +
    'Base claims on real Waldorf principles: child development (body/soul/spirit), main lesson blocks, biography, artistic integration. ' +
    'Cite Steiner/GA when appropriate. Be specific, warm, and practical for classroom teachers — only where sources support it.' +
    NO_LATEX_BLOCK +
    (extra || '')
  );
}

const CHAT_FREE_TEXT_OUTPUT_INSTRUCTION =
  '\n=== CHAT OUTPUT: FREE TEXT / MARKDOWN (MANDATORY) ===\n' +
  'Reply with warm, pedagogical Hebrew prose — plain text or light Markdown only.\n' +
  'Use paragraphs, **bold**, bullet lists, and headings when helpful. Do NOT return JSON, code fences, or schema wrappers.\n' +
  'Write 2–6 rich paragraphs when verified sources support a full answer.\n' +
  '=== END CHAT OUTPUT ===\n';

function pedagogicalChatSystemPrompt(extra) {
  return (
    'You are the Pedagogical Chat Assistant for Waldorf / Steiner-Waldorf teachers. ' +
    'Help teachers with follow-up questions about their generated lesson plan as a supportive, highly accurate pedagogical peer. ' +
    'COMMUNITY FIRST: Always check the COMMUNITY MATERIALS DATABASE in the user message before answering. ' +
    'Celebrate and reference matching teacher-uploaded materials when present, then enrich with live web search. ' +
    'Use live web search on EVERY question to retrieve verified Rudolf Steiner and anthroposophic pedagogical material. ' +
    STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
    PEDAGOGICAL_CHAT_GROUNDING_INSTRUCTION +
    COMMUNITY_FIRST_CHAT_INSTRUCTION +
    WEB_SEARCH_PRIORITY_INSTRUCTION +
    FACTUAL_INTEGRITY_INSTRUCTION +
    CHAT_FREE_TEXT_OUTPUT_INSTRUCTION +
    ' Write all chat replies in Hebrew. ' +
    'Deliver full, practical answers when community materials and/or Steiner-based sources support them — do not decline when matches or live search can answer.' +
    NO_LATEX_BLOCK +
    (extra || '')
  );
}

function resolvedGradeId(body) {
  return String(body.currentGrade ?? body.gradeId ?? '').trim();
}

function resolveClientIp(requestContext) {
  const ctx = requestContext && typeof requestContext === 'object' ? requestContext : {};
  const headers = ctx.headers || {};
  const forwarded = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) return first;
  }
  const realIp = headers['x-real-ip'] || headers['X-Real-Ip'] || headers['X-Real-IP'];
  if (realIp) return String(realIp).trim();
  if (ctx.ip) return String(ctx.ip).trim();
  const socket = ctx.socket;
  if (socket && socket.remoteAddress) {
    return String(socket.remoteAddress).replace(/^::ffff:/, '');
  }
  return 'unknown';
}

function buildActionLabel(body) {
  const b = body && typeof body === 'object' ? body : {};
  const parts = [];
  if (b.phase) parts.push(String(b.phase));
  const grade = String(b.gradeLabel || b.currentGrade || b.gradeId || '').trim();
  if (grade) parts.push(grade);
  const subject = String(
    b.topic || b.userMessage || b.archiveQuery || b.activityTitle || ''
  ).trim();
  if (subject) parts.push(subject.slice(0, 120));
  return parts.length ? parts.join(' / ') : 'unknown';
}

function logPerplexityCall(ip, action, status) {
  console.log(
    '[Perplexity Call] - Timestamp: ' + new Date().toISOString() +
    ' - IP: ' + ip +
    ' - Action: ' + action +
    ' - Status: ' + status
  );
}

function logBlockedUnauthorizedAccess(ip, action) {
  console.log(
    '[Blocked Unauthorized Access] - IP: ' + ip +
    ' - Action: ' + action
  );
}

function buildGradeLockBlock(body) {
  const gradeId = resolvedGradeId(body);
  const gradeLabel = body.gradeLabel || '';
  const age = body.age || '';
  if (!gradeId && !gradeLabel) return '';

  const defaultLockHe =
    'ודא שכל הרעיונות, הדגשים הפדגוגיים והסיפורים מתאימים אך ורק לשכבת הגיל והתפתחות הילד של הכיתה שנבחרה ' +
    "(לדוגמה: אם נבחרה כיתה ח', אל תציג שום תוכן או דוגמה שקשורים לכיתות נמוכות כמו א' או ב'). " +
    'אסור לערבב תוכן מכיתות אחרות — כל סעיף חייב להתאים ל-currentGrade בלבד.';

  const lockText = (body.gradeLockInstruction && body.gradeLockInstruction.trim()) || defaultLockHe;

  return (
    '\n=== GRADE LOCK (MANDATORY) ===\n' +
    'currentGrade (id): ' + gradeId + '\n' +
    'gradeLabel: ' + gradeLabel + '\n' +
    'age: ' + age + '\n' +
    'INSTRUCTION: ' + lockText + '\n' +
    'Reject or rewrite any idea, story, fairy tale, example, or pedagogical emphasis that belongs to a different grade.\n' +
    '=== END GRADE LOCK ===\n'
  );
}

function buildRagContextBlock(body) {
  const rag = String(body.ragContext || '').trim();
  const driveCtx = String(body.ragDriveContext || '').trim();
  const communityCtx = String(body.ragCommunityContext || '').trim();
  const isChat = body && body.phase === 'chat_followup';
  const isLessonPhase = body && (body.phase === 'grade' || body.phase === 'topic' ||
    body.phase === 'pedagogy_deep_dive' || body.phase === 'archive_search' || body.phase === 'archive_summary');

  if (!rag && !driveCtx && !communityCtx && isChat) {
    return (
      '\n=== HYBRID SEARCH CONTEXT (RAG — NO LOCAL EXCERPTS) ===\n' +
      'No local Drive or community archive excerpts matched this question — this is normal. ' +
      'Proceed with LIVE WEB SEARCH (PRIMARY) for Rudolf Steiner (GA lectures), Steiner Archive, waldorflibrary.org, AWSNA, IASWECE, ' +
      'and verified anthroposophic pedagogy. Also use lesson context below when relevant. ' +
      'Do NOT decline solely because local RAG is empty.\n' +
      '=== END HYBRID SEARCH CONTEXT ===\n\n'
    );
  }

  if (!rag && !driveCtx && !communityCtx && isLessonPhase) {
    return (
      '\n=== HYBRID SEARCH CONTEXT (NO MATCHING LOCAL EXCERPTS) ===\n' +
      'No private Drive archive or shared community archive excerpts matched this query — this is normal. ' +
      'Build the full lesson plan EXCLUSIVELY from LIVE WEB SEARCH (Perplexity) as the PRIMARY core anchor. ' +
      'Do NOT shorten, limit, or omit content because local archives are empty.\n' +
      '=== END HYBRID SEARCH CONTEXT ===\n\n'
    );
  }

  if (!rag && !driveCtx && !communityCtx) return '';

  if (isChat) {
    return (
      '\n=== HYBRID SEARCH CONTEXT (SUPPLEMENTARY LOCAL EXCERPTS) ===\n' +
      'LIVE WEB SEARCH (Perplexity) remains the PRIMARY anchor. The excerpts below are supplementary local context.\n' +
      (driveCtx
        ? '\n--- PRIVATE DRIVE ARCHIVE (Alon) ---\n' + driveCtx + '\n--- END PRIVATE DRIVE ARCHIVE ---\n'
        : '') +
      (communityCtx
        ? '\n--- SHARED COMMUNITY ARCHIVE ---\n' + communityCtx + '\n--- END SHARED COMMUNITY ARCHIVE ---\n'
        : '') +
      (!driveCtx && !communityCtx && rag ? '\n' + rag + '\n' : '') +
      'Reference document titles when citing. Do not contradict verified Steiner sources.\n' +
      '=== END HYBRID SEARCH CONTEXT ===\n\n'
    );
  }

  return (
    '\n=== HYBRID SEARCH CONTEXT (SUPPLEMENTARY — LIVE WEB SEARCH IS PRIMARY) ===\n' +
    'LIVE WEB SEARCH via Perplexity is the MANDATORY PRIMARY foundation. Local excerpts below are SECONDARY enrichment only.\n\n' +
    (driveCtx
      ? '--- PRIVATE DRIVE ARCHIVE (Alon — ingested Google Drive folders) ---\n' +
        'Folders: חינוך, קורס, כיתה, מחזור ראשון, מחזור שני, הרצאות, waldorf, waldorf project, waldrof project, שטיינר.\n' +
        'Blend as Waldorf-philosophy validation — never replace web breadth.\n\n' +
        driveCtx + '\n--- END PRIVATE DRIVE ARCHIVE ---\n\n'
      : '--- PRIVATE DRIVE ARCHIVE: no matching excerpts ---\n\n') +
    (communityCtx
      ? '--- SHARED COMMUNITY ARCHIVE (teacher uploads — community_knowledge_base) ---\n' +
        'Blend peer-teacher lesson plans and pedagogical notes as supplementary enrichment.\n\n' +
        communityCtx + '\n--- END SHARED COMMUNITY ARCHIVE ---\n\n'
      : '--- SHARED COMMUNITY ARCHIVE: no matching excerpts ---\n\n') +
    (!driveCtx && !communityCtx && rag ? rag + '\n\n' : '') +
    '=== END HYBRID SEARCH CONTEXT ===\n\n'
  );
}

function buildLanguageBlock(body) {
  if (!body.outputLanguageInstruction) return '';
  return '\nOUTPUT LANGUAGE: ' + body.outputLanguageInstruction + '\n';
}

function buildNoLatexBlock(body) {
  if (body.noLatexInstruction && body.noLatexInstruction.trim()) {
    return '\nNO LATEX (CLIENT):\n' + body.noLatexInstruction.trim() + '\n';
  }
  return '';
}

function buildPriorChatAnswerBlock(prior) {
  if (!prior || !prior.data) return '';
  const priorText = cacheDb.extractChatAnswerText(prior.data);
  if (!priorText) return '';

  const matchNote = prior.matchType === 'similar'
    ? ' (נמצאה תשובה דומה במאגר — ' + (prior.queryText || '') + ')'
    : '';

  return (
    '\n=== EXISTING ANSWER IN OUR PEDAGOGICAL DATABASE' + matchNote + ' ===\n' +
    'זו התשובה הקיימת במאגר שלנו בנושא זה. המטרה שלך היא לאפס, לדייק, להעמיק ולהרחיב אותה על בסיס מקורות אנתרופוסופיים נוספים, ' +
    'כדי להפוך אותה לעשירה ומומחית יותר מהגרסה הקודמת.\n' +
    'Do NOT copy verbatim. Refine inaccuracies, add verified Steiner/anthroposophic depth, and expand practical classroom value.\n\n' +
    priorText +
    '\n=== END EXISTING ANSWER ===\n\n'
  );
}

function buildPriorGradeCacheBlock(gradePrior) {
  if (!gradePrior || !gradePrior.data) return '';
  const priorText = cacheDb.extractGradeInsightsText(gradePrior.data);
  if (!priorText) return '';

  return (
    '\n=== CACHED GRADE INSIGHTS (STEP A — SUPABASE cached_results) ===\n' +
    'להלן תמונת הגיל והידע הקיים במאגר לכיתה שנבחרה. השתמש בזה כבסיס, חפש ברשת חומר נוסף מאומת, והרחב/עדכן כדי לייצר תשובה עשירה ומדויקת יותר.\n' +
    'Do NOT discard verified prior content — refine, deepen, and extend it with live Steiner/anthroposophic search.\n\n' +
    priorText +
    '\n=== END CACHED GRADE INSIGHTS ===\n\n'
  );
}

function buildPriorTopicCacheBlock(topicPrior) {
  if (!topicPrior || !topicPrior.data) return '';
  const data = topicPrior.data;
  const chunks = [];
  if (data.webResearch && data.webResearch.summary) {
    chunks.push('סיכום מחקר נושא:\n' + String(data.webResearch.summary).replace(/<[^>]+>/g, ' ').trim());
  }
  if (data.blockPlan && data.blockPlan.theory && Array.isArray(data.blockPlan.theory.sections)) {
    data.blockPlan.theory.sections.slice(0, 4).forEach(function (sec) {
      if (sec && sec.content) chunks.push((sec.heading || 'תיאוריה') + ':\n' + String(sec.content).replace(/<[^>]+>/g, ' ').trim());
    });
  }
  const text = chunks.filter(Boolean).join('\n\n').slice(0, 8000);
  if (!text) return '';

  return (
    '\n=== CACHED TOPIC LESSON PLAN (SUPABASE cached_results) ===\n' +
    text +
    '\n=== END CACHED TOPIC PLAN ===\n\n'
  );
}

function resolveTeacherFirstName(body) {
  const tu = body && body.teacherUser;
  if (!tu || typeof tu !== 'object') return 'מורה';
  const raw = String(tu.displayName || tu.name || '').trim();
  if (!raw) return 'מורה';
  const first = raw.split(/\s+/)[0].replace(/[^\u0590-\u05FFa-zA-Z'-]/g, '');
  return first || 'מורה';
}

function formatCommunityMatchForPrompt(match, index) {
  const title = match.displayTitle || match.title || match.topic || ('חומר ' + (index + 1));
  const topic = match.topic || match.bundleTopic || '';
  const gradeId = match.gradeId || '';
  const contributor = match.contributorName || '';
  const preview = match.contentPreview ? String(match.contentPreview).slice(0, 240) : '';
  let line = (index + 1) + '. «' + title + '»';
  if (topic && topic !== title) line += ' (נושא: ' + topic + ')';
  if (gradeId) line += ' [כיתה ' + gradeId + ']';
  if (contributor) line += ' — תורם: ' + contributor;
  if (preview) line += '\n   תקציר: ' + preview;
  if (match.matchedInBundle && match.alertText) line += '\n   ' + match.alertText;
  return line;
}

function buildCommunityMatchCriticalSystemBlock(probe, body) {
  const matches = probe && Array.isArray(probe.matches) ? probe.matches : [];
  if (!matches.length) return '';

  const matchedFile = matches[0];
  const teacherName = resolveTeacherFirstName(body);
  const gradeLabel = String(body.gradeLabel || '').trim() || ('כיתה ' + (resolvedGradeId(body) || '?'));
  const title = matchedFile.displayTitle || matchedFile.title || matchedFile.topic || 'חומר קהילתי';
  const openingLine =
    teacherName + ', הרווחת! מישהו מהקהילה העלה למאגר הקהילתי ל' + gradeLabel + ' «' + title + '». ' +
    'אתה יכול להיכנס למאגר הקהילתי באתר, תחת ' + gradeLabel + ' כדי לצפות בקובץ הנוכחי.';

  return (
    '\n=== CRITICAL INSTRUCTION — COMMUNITY DATABASE MATCH ===\n' +
    'A relevant file was found in the community database (hybrid keyword/semantic search).\n' +
    'You MUST start your Hebrew response verbatim with this exact opening sentence:\n' +
    '«' + openingLine + '»\n' +
    'STRICT RULES WHEN THIS MATCH EXISTS:\n' +
    '- The verified community upload is the primary answer — announce it clearly in the opening.\n' +
    '- Do NOT invent details about commercial plays (e.g. Roee Chen / רואי חן), publishers, or external internet productions.\n' +
    '- Do NOT substitute web-search play or curriculum recommendations when this community file already answers the teacher.\n' +
    '- Focus first on telling the teacher this specific file exists in their school community database and how to view it.\n' +
    '- Only after the mandatory opening, add brief grounded context if the matched material metadata or lesson context supports it.\n' +
    '=== END CRITICAL INSTRUCTION — COMMUNITY DATABASE MATCH ===\n'
  );
}

function buildCommunityMaterialsContextBlock(probe, body) {
  const matches = probe && Array.isArray(probe.matches) ? probe.matches : [];
  const teacherName = resolveTeacherFirstName(body);
  const gradeLabel = String(body.gradeLabel || '').trim() || ('כיתה ' + (resolvedGradeId(body) || '?'));
  const query = probe && probe.query ? String(probe.query).trim() : '';

  if (!matches.length) {
    return (
      '\n=== COMMUNITY MATERIALS DATABASE (community_materials + community_knowledge_base — Supabase) ===\n' +
      'חיפוש במאגר הקהילתי' + (query ? ' עבור «' + query + '»' : '') + ' לא מצא התאמה.\n' +
      'המשך עם סיוע פדגוגי סטנדרטי איכותי (חיפוש חי + הקשר השיעור) — אין צורך בפתיחה חגיגית.\n' +
      '=== END COMMUNITY MATERIALS DATABASE ===\n\n'
    );
  }

  const primaryTitle = matches[0].displayTitle || matches[0].title || matches[0].topic || 'חומר קהילתי';
  const mandatoryOpening =
    teacherName + ', הרווחת! מישהו מהקהילה העלה למאגר הקהילתי ל' + gradeLabel + ' «' + primaryTitle + '». ' +
    'אתה יכול להיכנס למאגר הקהילתי באתר, תחת ' + gradeLabel + ' כדי לצפות בקובץ הנוכחי.';
  const lines = matches.slice(0, 6).map(formatCommunityMatchForPrompt);
  const matchMethod = probe && probe.matchMethod ? String(probe.matchMethod) : '';
  const semanticNote = matchMethod.indexOf('semantic') >= 0
    ? 'Match method: SEMANTIC (' + matchMethod + ') — teacher intent was linked to catalog material even without identical wording.\n'
    : (matchMethod && matchMethod !== 'keyword_fuzzy'
      ? 'Match method: ' + matchMethod + '.\n'
      : '');

  return (
    '\n=== COMMUNITY MATERIALS DATABASE (community_materials + community_knowledge_base — Supabase) ===\n' +
    'COMMUNITY MATCH FOUND — ' + matches.length + ' material(s) for this question.\n' +
    semanticNote +
    'Teacher first name for opening: «' + teacherName + '»\n' +
    'Grade label for opening: «' + gradeLabel + '»\n' +
    'Best match title for opening: «' + primaryTitle + '»\n' +
    'MANDATORY OPENING (first sentence of your Hebrew reply — ABSOLUTE, keyword OR semantic match):\n' +
    '«' + mandatoryOpening + '»\n' +
    'Do NOT invent commercial plays, external productions, or internet sources when this community file exists. ' +
    'Lead with the community database file; only add brief grounded follow-up if supported by matched metadata.\n\n' +
    'Matched materials:\n' +
    lines.join('\n') +
    '\n=== END COMMUNITY MATERIALS DATABASE ===\n\n'
  );
}

const LAZY_LOAD_NOTE =
  'Do NOT include expansion, contentExpansion, artExpansion, or nested practical-expansion objects — expansions load on-demand via pedagogy_deep_dive.\n';

/**
 * chat_followup: accept free text / Markdown from the model.
 * If the model still returns JSON, unwrap it; otherwise treat the full reply as the answer.
 */
function normalizeChatFollowupFromModel(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return buildModelParseFallback('chat_followup', '', {});
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = cleanAndParseJSON(text, {
        phase: 'chat_followup',
        fallbackOnError: false,
        unwrap: true,
      });
      if (parsed && parsed.chatReply && typeof parsed.chatReply === 'object') {
        return parsed;
      }
      if (parsed && parsed.reply) {
        return { chatReply: { answer: String(parsed.reply).trim() } };
      }
      if (parsed && (parsed.answer || parsed.answerHtml)) {
        return { chatReply: parsed };
      }
    } catch (jsonErr) {
      console.warn('[generate] chat_followup JSON unwrap failed, using free text:', jsonErr.message || jsonErr);
    }
  }

  return { chatReply: { answer: text } };
}

/** @deprecated alias — grade phase uses the same pipeline as parseJsonFromModel */
function parseGradeJsonFromModel(text) {
  return parseJsonFromModel(text);
}

function buildUserPrompt(body) {
  const phase = body.phase;
  const ragBlock = buildRagContextBlock(body);

  if (phase === 'test') {
    return 'Return JSON only: {"ok":true,"message":"אישור קצר בעברית שהחיבור עובד"}';
  }

  if (phase === 'grade') {
    const gradeExtra = body.gradePrompt
      ? '\nGRADE INSIGHTS INSTRUCTIONS (MANDATORY):\n' + body.gradePrompt + '\n'
      : '';
    const noUrls = body.noUrlsInstruction
      ? '\nNO URLS:\n' + body.noUrlsInstruction + '\n'
      : '\nDo NOT include internet URLs in sources or HTML.\n';

    return (
      ragBlock +
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      noUrls +
      gradeExtra +
      CONTENT_HIERARCHY_INSTRUCTION +
      WEB_SEARCH_PRIORITY_INSTRUCTION +
      'Perform exhaustive live web research on Waldorf/Steiner anthroposophic child development for:\n' +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Grade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\n\n' +
      'All insights MUST match currentGrade only — never mix content from other grades.\n' +
      'Produce inspiring content — keep response fast. Uniform 16px text in UI.\n' +
      LAZY_LOAD_NOTE +
      JSON_ONLY_INSTRUCTION +
      JSON_RESPONSE_ENFORCEMENT +
      '\nReturn JSON only — your reply MUST start with { and end with }:\n' +
      '{\n' +
      '  "gradeInsights": {\n' +
      '    "part1AgePictureHtml": "<p>Rich Hebrew HTML: age picture & pedagogical emphases (4–6 paragraphs)</p>",\n' +
      '    "part1DevelopmentBullets": ["8–12 detailed Hebrew bullets on development"],\n' +
      '    "archivesSynthesisHtml": "<p>Deep Hebrew synthesis from AWSNA/IASWECE/Steiner archives</p>",\n' +
      '    "developmentBullets": ["body/soul/spirit Hebrew bullets"],\n' +
      '    "part2ClassroomIdeasHtml": "<p>Rich Hebrew HTML: practical classroom ideas (5–8 paragraphs)</p>",\n' +
      '    "part2ClassroomIdeas": [{ "title": "Hebrew title", "detail": "Full Hebrew practical paragraph" }],\n' +
      '    "part3CommunityExpansionsHtml": "<p>Rich Hebrew HTML: parents, community, environmental projects for this age</p>",\n' +
      '    "part3CommunityIdeas": [{ "title": "Hebrew title", "detail": "Full Hebrew paragraph" }],\n' +
      '    "globalCurricula": ["6–10 Hebrew curriculum bullets"],\n' +
      '    "typicalBlocks": ["Hebrew main lesson block names"],\n' +
      '    "sources": ["source name only — no URLs"]\n' +
      '  },\n' +
      '  "teacherSummaries": [\n' +
      '    { "author": "שם מורה, עיר", "title": "כותרת", "body": "2-3 משפטים" }\n' +
      '  ]\n' +
      '}\n' +
      'gradeInsights.sources: rich diverse "Sources & Further Reading" (8–12 entries); cite Alon Yerushalmy only if genuinely relevant — merge his platforms into ONE entry, otherwise omit entirely.\n' +
      'Provide exactly 3 teacherSummaries as plausible community-shared folder summaries.'
    );
  }

  if (phase === 'topic') {
    const topic = (body.topic || '').replace(/"/g, '');
    const theoryExtra = body.theoryPrompt
      ? '\nTHEORY TAB INSTRUCTIONS:\n' + body.theoryPrompt + '\n'
      : '';
    const inspirationExtra = body.inspirationPrompt
      ? '\nINSPIRATION TAB INSTRUCTIONS:\n' + body.inspirationPrompt + '\n'
      : '';
    const curriculumExtra = body.curriculumPrompt
      ? '\nCURRICULUM TAB INSTRUCTIONS:\n' + body.curriculumPrompt + '\n'
      : '';
    const bibExtra = body.bibliographyRequirements
      ? '\nBIBLIOGRAPHY REQUIREMENTS (MANDATORY):\n' + body.bibliographyRequirements + '\n'
      : '';
    const pedagogyHint = body.pedagogyExpandHint
      ? '\nINSPIRATION & CURRICULUM FORMAT:\n' + body.pedagogyExpandHint + '\n'
      : '';
    const noUrls = body.noUrlsInstruction
      ? '\nNO URLS (MANDATORY):\n' + body.noUrlsInstruction + '\n'
      : '\nDo NOT include internet URLs in bibliography, HTML, summaries, or recommendations.\n';

    return (
      ragBlock +
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      noUrls +
      'Live web research: Waldorf main lesson block planning.\n' +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Grade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\n' +
      'Block topic: «' + topic + '»\n' +
      'Grade context: ' + (body.gradeContext || '') + '\n' +
      theoryExtra +
      inspirationExtra +
      curriculumExtra +
      bibExtra +
      pedagogyHint +
      CONTENT_HIERARCHY_INSTRUCTION +
      WEB_SEARCH_PRIORITY_INSTRUCTION +
      'Perform exhaustive live web research for this Waldorf main lesson block. Merge web breadth with any ingested Drive archive excerpts above.\n' +
      'Every field in blockPlan MUST be written for currentGrade only. Do not mention activities, stories, or developmental themes from other grades.\n' +
      'blockPlan.inspiration.podcast: when priority sources have relevant material, convey themes and insights objectively in episode entries — do not repeat source names across body fields.\n' +
      'webResearch.highlights: include diverse pedagogical highlights alongside priority-source findings.\n' +
      'Produce rich content — keep response fast. Uniform 16px text in UI.\n' +
      'theory.bibliography MUST have at least 3 books, 3 articles, 3 websites — title + author/publisher only, NEVER url fields. ' +
      'Populate as a rich, diverse "Sources & Further Reading" landscape; cite Alon Yerushalmy only if genuinely relevant — merge his platforms into ONE entry, otherwise omit entirely.\n' +
      'PINTEREST: populate gallery with 4–8 visual inspiration entries (experiments, main-lesson drawings, classroom displays) — Hebrew titles and precise Pinterest search phrases in "pin".\n' +
      LAZY_LOAD_NOTE +
      'The UI shows a «הרחבה ואספקטים פרקטיים 📝» button — expansions load on demand.\n' +
      'CRITICAL — blockPlan.curriculum MUST be a JSON ARRAY (not an object) of exactly 15 day objects.\n' +
      'Each day object MUST use these exact keys: "day" (number 1–15), "topic" (Hebrew string), "content" (4–6 Hebrew sentences), "art" (2–4 Hebrew sentences on art/craft), "hint" (optional Hebrew string).\n' +
      'Do NOT nest curriculum under days/items/lessons — use blockPlan.curriculum as a flat array.\n' +
      JSON_ONLY_INSTRUCTION +
      JSON_RESPONSE_ENFORCEMENT +
      '\nReturn JSON only — your reply MUST start with { and end with }:\n' +
      '{\n' +
      '  "webResearch": {\n' +
      '    "topic": "' + topic + '",\n' +
      '    "summary": "Rich Hebrew paragraph",\n' +
      '    "connections": ["Hebrew phrases tied to currentGrade"],\n' +
      '    "highlights": ["Hebrew highlights for this grade only"]\n' +
      '  },\n' +
      '  "blockPlan": {\n' +
      '    "theory": { "title": "Hebrew", "sections": [{ "heading": "Hebrew", "icon": "fa-compass", "content": "<p>Rich Hebrew HTML paragraphs</p>", "quotes": [{ "text": "Hebrew", "source": "GA" }] }], "bibliography": { "books": [{ "title": "Hebrew", "author": "Hebrew", "publisher": "Hebrew", "year": "YYYY", "lang": "he" }], "articles": [{ "title": "Hebrew", "author": "Hebrew", "lang": "he" }], "websites": [{ "title": "Hebrew org name", "publisher": "Hebrew", "lang": "he" }] } },\n' +
      '    "inspiration": { "title": "Hebrew", "global": [{ "title": "Hebrew", "items": ["full Hebrew paragraph per item"] }], "podcast": { "title": "Hebrew", "episodes": [{ "theme": "Hebrew", "insight": "rich Hebrew paragraph" }] }, "narrative": ["rich story/metaphor paragraph"] },\n' +
      '    "curriculum": [{ "day": 1, "topic": "Hebrew", "content": "4-6 sentence guided lesson flow", "art": "2-4 sentences on art/craft", "hint": "optional" }]\n' +
      '  },\n' +
      '  "gallery": [{ "board": "Hebrew", "title": "Hebrew", "pin": "Pinterest search phrase only — no URL required", "src": "" }]\n' +
      '}\n' +
      'curriculum MUST be a flat ARRAY of exactly 15 objects (days 1–15) — never wrap in { days: [...] } or similar.\n' +
      'Each curriculum item MUST include day, topic, content, and art fields using those exact key names.\n' +
      'gallery MUST include 4–8 Pinterest visual inspiration options with varied angles for the block topic.'
    );
  }

  if (phase === 'pedagogy_deep_dive') {
    const title = (body.activityTitle || '').replace(/"/g, "'");
    const preview = (body.activityPreview || '').replace(/"/g, "'");
    const expand = body.expandInstruction ||
      'הרחב ל: (1) הסבר מלא של מהות הפעילות, (2) הקשר פדגוגי אנתרופוסופי לגיל ולתקופה, (3) שלבי ביצוע פרקטיים שלב-אחר-שלב בכיתה עבור המורה.';
    return (
      ragBlock +
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      "Expand a Waldorf teacher's pedagogical suggestion into a full classroom guide.\n" +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Grade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\n' +
      'Block topic: ' + (body.topic || '') + '\n' +
      'Activity type: ' + (body.activityType || '') + ' / ' + (body.activitySubtype || '') + '\n' +
      'Day: ' + (body.dayNumber || 'n/a') + '\n' +
      'Context: ' + (body.activityContext || '') + '\n' +
      'Title: «' + title + '»\n' +
      'Preview: ' + preview + '\n\n' +
      'EXPAND INSTRUCTION: ' + expand + '\n\n' +
      WEB_SEARCH_PRIORITY_INSTRUCTION +
      'This is an ON-DEMAND expansion for ONE idea only — return practical aspects and inspiration references.\n' +
      JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n' +
      '{\n' +
      '  "pedagogyDeepDive": {\n' +
      '    "title": "' + title + '",\n' +
      '    "classroomImplementation": "Hebrew: 1-2 paragraphs on practical in-class implementation",\n' +
      '    "parentCommunityAspects": "Hebrew: parents/community aspects when relevant",\n' +
      '    "practicalSteps": ["4-8 Hebrew concrete classroom steps for the teacher"],\n' +
      '    "inspirationReferences": ["3-6 named books, articles, or Waldorf projects — NO URLs"],\n' +
      '    "summaryHtml": "<p>Optional rich Hebrew HTML</p>"\n' +
      '  }\n' +
      '}'
    );
  }

  if (phase === 'drive') {
    return (
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Teacher scanned Google Drive for Waldorf block «' + body.topic + '» in ' + body.gradeLabel + '.\n' +
      'Files: ' + (body.personalFiles || []).join('; ') + '\n' +
      JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n' +
      '{\n' +
      '  "driveMerge": {\n' +
      '    "title": "[חומרי מורה משולבים] — דגשים אישיים מתוך הדרייב",\n' +
      '    "bullets": ["Hebrew bullets for inspiration tab"],\n' +
      '    "curriculumNotes": "Hebrew notes for daily plan tab"\n' +
      '  }\n' +
      '}'
    );
  }

  if (phase === 'archive_search') {
    const q = (body.archiveQuery || '').replace(/"/g, "'");
    return (
      ragBlock +
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      'Live web search: Anthroposophic knowledge archive for Waldorf teachers.\n' +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Search query (Hebrew or English): «' + q + '»\n' +
      'Grade context: ' + (body.gradeLabel || '') + ' (age ' + (body.age || '') + ')\n' +
      'Optional block topic: ' + (body.topic || '') + '\n\n' +
      WEB_SEARCH_PRIORITY_INSTRUCTION +
      'Also prioritize: Steiner Archive (GA lectures), rsarchive.org, steinerarchive.org, ' +
      'Rudolf Steiner Press, Waldorf Library, anthroposophy.org, pedagogical anthroposophy, ' +
      'Hebrew Waldorf/anthroposophy resources when relevant.\n' +
      'Include Rudolf Steiner AND other anthroposophic authors (e.g. von Baravalle, Finser, Harwood, ' +
      'Stebbing, Rawson, Aeppli) when they match the query.\n' +
      JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n' +
      '{\n' +
      '  "archiveSearch": {\n' +
      '    "query": "' + q + '",\n' +
      '    "intro": "Hebrew paragraph introducing the result set",\n' +
      '    "sources": [\n' +
      '      {\n' +
      '        "id": "stable-slug-english",\n' +
      '        "title": "Hebrew title of book/lecture/article",\n' +
      '        "author": "Hebrew author name",\n' +
      '        "type": "book|lecture|article",\n' +
      '        "year": "optional year or GA number",\n' +
      '        "description": "1-2 Hebrew sentences on relevance to pedagogy",\n' +
      '        "readUrl": "https://full-working-url-to-read-or-archive-page"\n' +
      '      }\n' +
      '    ]\n' +
      '  }\n' +
      '}\n' +
      'Provide 6–10 sources. readUrl MUST be real HTTPS links to public pages (archive, publisher, PDF index). ' +
      'Do not invent dead links.'
    );
  }

  if (phase === 'archive_summary') {
    const title = (body.sourceTitle || '').replace(/"/g, "'");
    const isPedagogy = Boolean(body.pedagogyDeepDive);
    const isBibliography = Boolean(body.bibliographyContext);
    const expand = body.expandInstruction || '';
    const noUrls = body.noUrlsInstruction
      ? '\nNO URLS:\n' + body.noUrlsInstruction + '\n'
      : '\nDo NOT include internet URLs in the response.\n';
    const depth = body.summaryDepthInstruction
      ? '\nDEPTH:\n' + body.summaryDepthInstruction + '\n'
      : '';
    const pedagogyBlock = isPedagogy
      ? '\nThis is a pedagogy deep-dive expansion. ' + expand + '\nReturn pedagogyDeepDive instead of archiveSummary.\n'
      : '';
    const bibBlock = isBibliography
      ? '\nThis is a bibliography «תקציר מעמיק ומורחב» deep summary for the theory tab. ' +
        'Produce an exceptionally broad, deep pedagogical summary grounded in the named source. Text only.\n'
      : '';
    return (
      ragBlock +
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      noUrls +
      depth +
      bibBlock +
      (isPedagogy
        ? 'Create a full pedagogical activity guide for a Waldorf teacher.\n'
        : 'Create a deep pedagogical summary in Hebrew for a Waldorf teacher reading this anthroposophic source.\n') +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Title: «' + title + '»\n' +
      'Author: ' + (body.sourceAuthor || '') + '\n' +
      'Type: ' + (body.sourceType || '') + '\n' +
      'Year/GA: ' + (body.sourceYear || '') + '\n' +
      'Description: ' + (body.sourceDescription || '') + '\n' +
      'Grade context: ' + (body.gradeLabel || '') + ' · Block: ' + (body.topic || '') + '\n' +
      pedagogyBlock +
      WEB_SEARCH_PRIORITY_INSTRUCTION +
      '\nUse web search to ground the summary in the actual work when possible.\n' +
      'Uniform 16px text in UI. Never output URLs or hyperlinks.\n' +
      (isPedagogy
        ? JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n{\n  "pedagogyDeepDive": {\n' +
          '    "title": "' + title + '",\n' +
          '    "essence": "Hebrew",\n' +
          '    "pedagogicalContext": "Hebrew anthroposophic context for currentGrade",\n' +
          '    "practicalSteps": ["Hebrew steps"],\n' +
          '    "materialsNeeded": ["Hebrew"],\n' +
          '    "summaryHtml": "<p>Rich Hebrew HTML</p>"\n' +
          '  }\n}'
        : JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n{\n  "archiveSummary": {\n' +
          '    "title": "' + title + '",\n' +
          '    "author": "Hebrew",\n' +
          '    "summaryHtml": "<p>Rich Hebrew HTML: core ideas, soul-spirit development, main-lesson relevance, practical classroom angles — broad and deep</p>",\n' +
          '    "keyPoints": ["5-8 Hebrew bullet insights"],\n' +
          '    "pedagogicalAngles": ["Hebrew: how to use in Waldorf teaching for currentGrade"],\n' +
          '    "relevance": "Hebrew paragraph on relevance to the block topic and currentGrade",\n' +
          '    "furtherReading": ["Hebrew book/source name only — no URLs"]\n' +
          '  }\n}')
    );
  }

  if (phase === 'chat_followup') {
    const question = (body.userMessage || '').replace(/"/g, "'");
    const context = String(body.researchContext || '').slice(0, 12000);
    const historyBlock = '';

    const hasContext = Boolean(context.trim());
    const hasRag = Boolean(String(body.ragContext || '').trim());
    const priorBlock = buildPriorChatAnswerBlock(body.priorCachedAnswer);
    const gradePriorBlock = buildPriorGradeCacheBlock(body.priorGradeCache);
    const topicPriorBlock = buildPriorTopicCacheBlock(body.priorTopicCache);
    const communityBlock = buildCommunityMaterialsContextBlock(body.communityMaterialsProbe, body);
    const hasCommunityMatches = Boolean(
      body.communityMaterialsProbe &&
      body.communityMaterialsProbe.count > 0 &&
      Array.isArray(body.communityMaterialsProbe.matches) &&
      body.communityMaterialsProbe.matches.length
    );

    return (
      ragBlock +
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      communityBlock +
      gradePriorBlock +
      topicPriorBlock +
      priorBlock +
      'You are the Pedagogical Chat Assistant helping a teacher with follow-up questions about their generated lesson plan.\n' +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Grade: ' + (body.gradeLabel || '') + ' (age ' + (body.age || '') + ')\n' +
      'Block topic: ' + (body.topic || '') + '\n' +
      'Verified sources available: community_materials=' + (hasCommunityMatches ? 'yes (' + body.communityMaterialsProbe.count + ' match(es))' : 'no') +
      ', knowledge_base=' + (hasRag ? 'yes' : 'no') + ', lesson_context=' + (hasContext ? 'yes' : 'no') + '\n\n' +
      '=== ORIGINAL RESEARCH & LESSON CONTEXT (ground answers here when explicit) ===\n' +
      (hasContext ? context : '(empty — no lesson context provided)') + '\n' +
      '=== END CONTEXT ===\n' +
      historyBlock +
      'Teacher follow-up question: «' + question + '»\n\n' +
      'ANSWER STRATEGY (MANDATORY — COMMUNITY FIRST):\n' +
      (hasCommunityMatches
        ? '0. COMMUNITY FIRST: A verified community file matched (keyword OR semantic). Open with the mandatory opening verbatim — announce the community upload and direct the teacher to the community repository. Do NOT invent commercial plays (e.g. Roee Chen) or external internet productions.\n'
        : '0. COMMUNITY FIRST: No community match above — proceed with standard high-quality pedagogical assistance.\n') +
      (gradePriorBlock
        ? '0a. CACHED GRADE INSIGHTS (step A) are above — treat as authoritative baseline; enrich with live web search.\n'
        : '') +
      (topicPriorBlock
        ? '0b. CACHED TOPIC LESSON PLAN is above — integrate when relevant.\n'
        : '') +
      (priorBlock
        ? '0c. You have an EXISTING DATABASE ANSWER above — refine, correct, deepen, and expand it with live web search; output must be clearly richer than the prior version.\n'
        : '') +
      '1. Perform LIVE WEB SEARCH for verified Rudolf Steiner / anthroposophic pedagogical material on this question.\n' +
      '2. Integrate community materials (when matched), lesson context, and any knowledge_base excerpts when they add verified detail.\n' +
      '3. NEVER fabricate Steiner quotes, GA citations, or doctrines — only state what search and context support.\n' +
      '4. Give a full, warm, practical Hebrew answer (2–6 paragraphs) when verified material exists.\n' +
      '5. Use the Hebrew fallback decline ONLY when community database + live search + context all lack verified material on this specific question.\n' +
      WEB_SEARCH_PRIORITY_INSTRUCTION +
      CHAT_FREE_TEXT_OUTPUT_INSTRUCTION +
      'Write your full Hebrew answer directly as warm pedagogical prose (plain text or light Markdown). ' +
      'Do NOT wrap the reply in JSON or code blocks.'
    );
  }

  throw new Error('Unknown phase');
}

async function callPerplexity(apiKey, userPrompt, extraSystem, options) {
  const opts = options || {};
  const systemBuilder = typeof opts.systemPrompt === 'function' ? opts.systemPrompt : waldorfSystemPrompt;
  const temperature = opts.temperature !== undefined ? opts.temperature : 0.35;
  const useStream = opts.stream !== false;

  try {
    return await perplexityClient.callPerplexityChat({
      apiKey: apiKey,
      model: PERPLEXITY_MODEL,
      temperature: temperature,
      stream: useStream,
      messages: [
        { role: 'system', content: systemBuilder(extraSystem) },
        { role: 'user', content: userPrompt },
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/שגיאת רשת בחיבור ל-Perplexity|PERPLEXITY_API_KEY is not configured/i.test(msg)) {
      throw err;
    }
    throw new Error(msg || 'שגיאה בקריאה ל-Perplexity — נסו שוב בעוד רגע.');
  }
}

/** Extract assistant text from Perplexity / OpenAI-compatible chat completion payloads. */
function extractPerplexityMessageContent(data) {
  if (!data || typeof data !== 'object') return '';

  if (typeof data.output === 'string' && data.output.trim()) return data.output.trim();
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim();

  const choice = data.choices && data.choices[0];
  if (!choice) return '';

  const message = choice.message || choice.delta || choice;
  if (!message || typeof message !== 'object') return '';

  const content = message.content != null ? message.content : message.text;
  if (typeof content === 'string') return content.trim();

  if (Array.isArray(content)) {
    return content.map(function (part) {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    }).join('').trim();
  }

  return '';
}

function validatePhaseResult(phase, data) {
  if (!data || typeof data !== 'object') return false;
  if (phase === 'grade') return Boolean(data.gradeInsights && typeof data.gradeInsights === 'object');
  if (phase === 'topic') return Boolean(data.blockPlan && typeof data.blockPlan === 'object');
  if (phase === 'chat_followup') {
    return Boolean(cacheDb.extractChatAnswerText(data));
  }
  if (phase === 'pedagogy_deep_dive') return Boolean(data.pedagogyDeepDive);
  if (phase === 'archive_search') return Boolean(data.archiveSearch);
  if (phase === 'archive_summary') return Boolean(data.archiveSummary || data.pedagogyDeepDive);
  if (phase === 'drive') return Boolean(data.driveMerge);
  if (phase === 'test') return data.ok === true;
  return true;
}

const MODEL_PARSE_MAX_ATTEMPTS = 2;
const JSON_RETRY_SYSTEM_SUFFIX =
  ' CRITICAL RETRY: Your previous reply was rejected — invalid JSON or missing required fields. ' +
  'Reply with raw JSON only. First character MUST be { and last character MUST be }. ' +
  'No ```json fences, no Hebrew/English preamble, no trailing commas.';
const GENERIC_GENERATION_ERROR = 'לא הצלחנו ליצור את התוכן הפדגוגי. נסו שוב בעוד רגע.';

function isRetriablePerplexityCallError(err) {
  const msg = err instanceof Error ? err.message : String(err || '');
  return !/API key|unauthorized|PERPLEXITY_API_KEY|not configured|Method not allowed/i.test(msg);
}

/**
 * Fetch from Perplexity, parse model JSON, and validate phase shape.
 * On parse/validation failure, silently retries once with a stricter JSON system prompt
 * while the client request stays open (spinner remains active).
 */
async function fetchParsedModelWithRetry(body, apiKey, userPrompt, extraSystem, perplexityOptions, isChatFollowup, logContext) {
  const phase = body.phase;
  const baseOpts = perplexityOptions || {};
  const ip = (logContext && logContext.ip) || 'unknown';
  const action = (logContext && logContext.action) || buildActionLabel(body);
  let lastPreview = '';
  let lastRaw = '';

  for (let attempt = 1; attempt <= MODEL_PARSE_MAX_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    const retrySuffix = isRetry && !isChatFollowup ? JSON_RETRY_SYSTEM_SUFFIX : '';
    const callOpts = Object.assign({}, baseOpts, {
      temperature: isRetry
        ? 0.2
        : (baseOpts.temperature !== undefined ? baseOpts.temperature : 0.35),
    });
    const useParseFallback = attempt >= MODEL_PARSE_MAX_ATTEMPTS;

    let raw;
    try {
      if (isRetry) {
        console.warn('[generate] Silent Perplexity retry for phase', phase, '(attempt', attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + ')');
      }
      logPerplexityCall(ip, action, 'Initiated');
      raw = await callPerplexity(apiKey, userPrompt, extraSystem + retrySuffix, callOpts);
      lastRaw = raw;
      logPerplexityCall(ip, action, 'Success');
    } catch (aiErr) {
      logPerplexityCall(ip, action, 'Failed');
      const msg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      console.error('[generate] Perplexity call failed for phase', phase, '(attempt', attempt + '):', msg);
      if (attempt < MODEL_PARSE_MAX_ATTEMPTS && isRetriablePerplexityCallError(aiErr)) {
        continue;
      }
      throw new Error(msg || 'שגיאה בקריאה ל-AI — נסו שוב בעוד רגע.');
    }

    let data;
    if (isChatFollowup) {
      data = normalizeChatFollowupFromModel(raw);
    } else {
      try {
        data = cleanAndParseJSON(raw, {
          phase: phase,
          context: body,
          fallbackOnError: useParseFallback,
        });
      } catch (parseErr) {
        const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        lastPreview = String(raw).slice(0, 600);
        console.error(
          '[generate] JSON parse failed for phase',
          phase,
          '(attempt ' + attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + '):',
          parseMsg
        );
        console.error('Model output preview:', lastPreview);
        if (!useParseFallback) continue;
        data = buildModelParseFallback(phase, raw, body);
      }
    }

    if (data && data._parseFallback) {
      console.warn('[generate] Using parse fallback for phase', phase, '(attempt', attempt + ')');
      return data;
    }

    if (!validatePhaseResult(phase, data)) {
      lastPreview = String(raw).slice(0, 600);
      console.error(
        '[generate] Parsed JSON missing required fields for phase',
        phase,
        '(attempt ' + attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + ')'
      );
      console.error('Model output preview:', lastPreview);
      if (!useParseFallback) continue;
      console.warn('[generate] Validation failed — returning parse fallback for phase', phase);
      return buildModelParseFallback(phase, raw, body);
    }

    if (isRetry) {
      console.log('[generate] Silent retry succeeded for phase', phase);
    }
    return data;
  }

  if (isChatFollowup) {
    return normalizeChatFollowupFromModel(lastRaw || '');
  }
  return buildModelParseFallback(phase, lastRaw || '', body);
}

function resolveApiKey() {
  return perplexityClient.resolveApiKey();
}

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

const MISSING_KEY_ERROR =
  'מפתח Perplexity לא מוגדר. הוסיפו PERPLEXITY_API_KEY (או AI_API_KEY) ב-Render → Environment ופרסמו מחדש.';

function isNonBlockingSubscriptionDbError(err) {
  const msg = String((err && err.message) || err || '');
  return /foreign key constraint/i.test(msg)
    || /search_logs_profile_id_fkey/i.test(msg)
    || /Could not find the table/i.test(msg)
    || /schema cache/i.test(msg);
}

/** Build success payload for /api/generate HTTP responses. */
function buildGenerateHttpPayload(result) {
  if (!result || typeof result !== 'object') {
    return { data: null, meta: { fromCache: false } };
  }

  const meta = result.meta && typeof result.meta === 'object'
    ? cacheDb.sanitizeForJsonStorage(Object.assign({}, result.meta))
    : { fromCache: false };

  let data = result.data !== undefined ? result.data : result;

  // Cached rows may store JSON text — parse once; never run model fence/repair heuristics.
  if (typeof data === 'string') {
    data = cacheDb.coerceCachedResultData(data);
  }

  data = cacheDb.sanitizeForJsonStorage(data);

  if (meta.fromCache) {
    if (!data || typeof data !== 'object') {
      const err = new Error('מבנה נתוני cache לא תקין');
      err.statusCode = 500;
      throw err;
    }
    return { data: data, meta: meta };
  }

  return { data: data, meta: meta };
}

function shouldProbeCommunityMaterials(phase) {
  return phase === 'topic' || phase === 'chat_followup';
}

/** When the global topic is unset, derive probe terms from the live chat message. */
function resolveCommunityProbeQuery(body) {
  const userMsg = String((body && body.userMessage) || '').trim();
  const topic = String((body && body.topic) || '').trim();
  if (topic) {
    return {
      query: userMsg || topic,
      topic: topic,
      userMessage: userMsg || null,
    };
  }
  if (!userMsg) {
    return { query: '', topic: null, userMessage: null };
  }
  const terms = cacheDb.buildCommunitySearchTerms(userMsg);
  const keywords = terms.filter(function (term) { return term && term.length >= 3; });
  return {
    query: (keywords.length ? keywords.slice(0, 6).join(' ') : userMsg),
    topic: null,
    userMessage: userMsg,
  };
}

async function probeCommunityMaterialsForBody(body) {
  if (!body || !shouldProbeCommunityMaterials(body.phase)) {
    return { matches: [], count: 0, query: '', matchMethod: 'none' };
  }
  const gradeId = body.currentGrade || body.gradeId;
  const resolved = resolveCommunityProbeQuery(body);
  if (!resolved.query) {
    return { matches: [], count: 0, query: '', matchMethod: 'none' };
  }
  const enableSemantic = body.phase === 'chat_followup';
  const baseOpts = {
    query: resolved.query,
    topic: resolved.topic,
    userMessage: resolved.userMessage,
    gradeId: gradeId,
    limit: 8,
    semanticFallback: enableSemantic,
  };
  try {
    let result = await cacheDb.findCommunityMaterials(baseOpts);
    if (!result.count && body.phase === 'chat_followup') {
      const topicOnly = String(body.topic || '').trim();
      const userMsg = String(body.userMessage || '').trim();
      if (topicOnly && topicOnly !== userMsg) {
        const topicProbe = await cacheDb.findCommunityMaterials({
          query: topicOnly,
          topic: body.topic,
          gradeId: gradeId,
          limit: 8,
          semanticFallback: enableSemantic,
          userMessage: userMsg || null,
        });
        if (topicProbe.count > 0) result = topicProbe;
      } else if (!topicOnly && userMsg) {
        if (userMsg !== resolved.query) {
          const fullMsgProbe = await cacheDb.findCommunityMaterials({
            query: userMsg,
            userMessage: userMsg,
            gradeId: gradeId,
            limit: 8,
            semanticFallback: enableSemantic,
          });
          if (fullMsgProbe.count > 0) result = fullMsgProbe;
        }
        if (!result.count) {
          const terms = cacheDb.buildCommunitySearchTerms(userMsg);
          for (let i = 0; i < terms.length; i++) {
            const term = terms[i];
            if (!term || term.length < 2) continue;
            const termProbe = await cacheDb.findCommunityMaterials({
              query: term,
              userMessage: userMsg,
              gradeId: gradeId,
              limit: 8,
              semanticFallback: enableSemantic,
            });
            if (termProbe.count > 0) {
              result = termProbe;
              break;
            }
          }
        }
      }
    }
    if (result.count > 0 && result.matchMethod) {
      console.log('[community] probe matched via', result.matchMethod, '—', result.count, 'material(s)');
    }
    return result;
  } catch (probeErr) {
    console.warn('[community] probe failed:', probeErr.message || probeErr);
    return { matches: [], count: 0, query: '', matchMethod: 'none' };
  }
}

function attachCommunityMeta(meta, communityProbe) {
  const base = meta && typeof meta === 'object' ? Object.assign({}, meta) : {};
  base.communityMatches = (communityProbe && communityProbe.matches) || [];
  base.communityMatchCount = (communityProbe && communityProbe.count) || 0;
  if (communityProbe && communityProbe.query) base.communityQuery = communityProbe.query;
  if (communityProbe && communityProbe.matchMethod) base.communityMatchMethod = communityProbe.matchMethod;
  return base;
}

/** Core handler — used by Render (server.js) with a pre-parsed JSON body. */
async function handleGeneratePost(parsedBody, requestContext) {
  const ctx = requestContext && typeof requestContext === 'object' ? requestContext : {};

  if (!parsedBody || typeof parsedBody !== 'object') {
    const err = new Error('Missing JSON body');
    err.statusCode = 400;
    throw err;
  }
  if (!parsedBody.phase) {
    const err = new Error('Missing phase');
    err.statusCode = 400;
    throw err;
  }
  if (parsedBody.userInitiated !== true) {
    logBlockedUnauthorizedAccess(resolveClientIp(ctx), buildActionLabel(parsedBody));
    const err = new Error('AI generation requires an explicit user action (userInitiated: true)');
    err.statusCode = 403;
    throw err;
  }
  if (parsedBody.phase === 'grade') {
    cacheDb.normalizeGradeCacheRequest(parsedBody);
  }
  const apiKey = resolveApiKey();
  if (!apiKey) {
    const err = new Error(MISSING_KEY_ERROR);
    err.statusCode = 500;
    throw err;
  }
  const reqShape = {
    method: 'POST',
    headers: ctx.headers || {},
    body: parsedBody,
  };

  let verifiedUser = null;
  try {
    verifiedUser = await authContext.resolveVerifiedUser(reqShape, parsedBody);
  } catch (authErr) {
    console.warn('[generate] verified user resolution failed:', authErr.message || authErr);
  }
  authContext.sanitizeCachedUserFields(parsedBody, verifiedUser);

  const proEmail = typeof subscriptionApi.extractUserEmail === 'function'
    ? subscriptionApi.extractUserEmail(reqShape, parsedBody)
    : '';
  if (proEmail && typeof subscriptionApi.isProUserEmail === 'function' && subscriptionApi.isProUserEmail(proEmail)) {
    parsedBody.userEmail = parsedBody.userEmail || proEmail;
    if (!parsedBody.teacherUser) parsedBody.teacherUser = {};
    parsedBody.teacherUser.email = parsedBody.teacherUser.email || proEmail;
    parsedBody.teacherUser.tier = 'pro';
    console.log('[generate] PRO user — rate limits bypassed for', proEmail);
  }

  if (typeof subscriptionApi.assertSearchAllowedFromRequest === 'function') {
    try {
      await subscriptionApi.assertSearchAllowedFromRequest(reqShape);
    } catch (subErr) {
      if (subErr && subErr.statusCode === 429) throw subErr;
      if (isNonBlockingSubscriptionDbError(subErr)) {
        console.warn('[generate] subscription pre-check skipped (non-blocking):', subErr.message || subErr);
      } else if (subErr && subErr.statusCode === 401) {
        /* unauthenticated — allow generate */
      } else {
        throw subErr;
      }
    }
  }
  const result = await executeGenerate(parsedBody, apiKey, ctx);
  const billable = result &&
    result.meta &&
    !result.meta.fromCache &&
    !result.meta.needsArchiveConfirmation &&
    result.data != null;

  if (billable && typeof subscriptionApi.recordLiveSearchFromRequest === 'function') {
    const billingBody = Object.assign({}, parsedBody);
    if (verifiedUser && verifiedUser.id) {
      billingBody.teacherUser = Object.assign({}, billingBody.teacherUser || {}, {
        id: verifiedUser.id,
        email: verifiedUser.email || '',
        name: verifiedUser.name || verifiedUser.displayName || '',
        displayName: verifiedUser.displayName || verifiedUser.name || '',
        tier: (billingBody.teacherUser && billingBody.teacherUser.tier) || verifiedUser.tier || 'trial',
      });
    }
    const billReq = {
      method: 'POST',
      headers: ctx.headers || {},
      body: billingBody,
    };
    console.log('[generate] billable live search — before recordSearch', {
      phase: parsedBody.phase,
      user_id: verifiedUser && verifiedUser.id,
      has_auth: Boolean(billReq.headers && (billReq.headers.authorization || billReq.headers.Authorization)),
      fromCache: false,
    });
    try {
      const billed = await subscriptionApi.recordLiveSearchFromRequest(billReq, verifiedUser);
      console.log('[generate] billable live search — after recordSearch', {
        user_id: verifiedUser && verifiedUser.id,
        searchBilled: Boolean(billed && billed.usage),
        searchesUsed: billed && billed.usage ? billed.usage.searchesUsed : null,
      });
      if (billed && billed.usage) {
        result.meta = Object.assign({}, result.meta, { usage: billed.usage, searchBilled: true });
      } else if (typeof subscriptionApi.recordSearch === 'function' && verifiedUser && verifiedUser.id) {
        const token = typeof subscriptionApi.extractUserToken === 'function'
          ? subscriptionApi.extractUserToken(billReq)
          : '';
        console.log('[generate] recordSearch direct fallback for user_id', verifiedUser.id);
        const directBill = await subscriptionApi.recordSearch(verifiedUser, token);
        console.log('[generate] direct fallback result searchesUsed', directBill && directBill.usage && directBill.usage.searchesUsed);
        if (directBill && directBill.usage) {
          result.meta = Object.assign({}, result.meta, { usage: directBill.usage, searchBilled: true });
        } else {
          result.meta = Object.assign({}, result.meta, { searchBilled: false });
          console.warn('[generate] live search usage not recorded — no usage payload returned');
        }
      } else {
        result.meta = Object.assign({}, result.meta, { searchBilled: false });
        console.warn('[generate] live search usage not recorded — no verified user', {
          verifiedUser: verifiedUser && verifiedUser.id,
        });
      }
    } catch (billErr) {
      console.error('[generate] billable live search — recordSearch FAILED', {
        user_id: verifiedUser && verifiedUser.id,
        message: billErr && billErr.message,
        code: billErr && billErr.code,
        supabaseBody: billErr && billErr.supabaseBody,
        usage: billErr && billErr.usage,
      });
      if (billErr && billErr.statusCode === 429) {
        throw billErr;
      }
      if (billErr && billErr.usage) {
        result.meta = Object.assign({}, result.meta, { usage: billErr.usage, searchBilled: false });
      } else {
        result.meta = Object.assign({}, result.meta, { searchBilled: false });
      }
    }
  }

  if (billable && typeof searchLogs.logLiveSearchFromRequestAsync === 'function') {
    searchLogs.logLiveSearchFromRequestAsync(reqShape, parsedBody, { fromCache: false });
  }

  return result;
}

/** Parse JSON body from adapters that attach req.body (legacy mock requests). */
function parseRequestBody(req) {
  if (!req) return null;

  let rawBody;
  try {
    rawBody = req.body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message || 'Invalid JSON body');
  }

  if (rawBody === undefined || rawBody === null) return null;
  if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') {
    if (!rawBody.trim()) return null;
    return JSON.parse(rawBody);
  }
  if (Buffer.isBuffer(rawBody)) {
    const text = rawBody.toString('utf8');
    if (!text.trim()) return null;
    return JSON.parse(text);
  }
  return rawBody;
}

async function executeGenerate(body, apiKey, requestContext) {
  if (!body || !body.phase) {
    const err = new Error('Missing phase');
    err.statusCode = 400;
    throw err;
  }

  const logContext = {
    ip: resolveClientIp(requestContext),
    action: buildActionLabel(body),
  };

  // Step A (grade): stable cache key (phase + gradeId only) — always consult Supabase.
  if (body.phase === 'grade') {
    body.skipCache = false;
    cacheDb.normalizeGradeCacheRequest(body);
  }

  // Chat: stateless — skip all cache reads/writes; community repository probe runs first below.
  if (body.phase === 'chat_followup') {
    body.skipCache = true;
  }

  // Chat: remove grade restrictions to ensure global repository search
  let probeBody = { ...body };
  if (body.phase === 'chat_followup') {
    probeBody.currentGrade = null;
    probeBody.gradeId = null;
  }
  const communityProbe = await probeCommunityMaterialsForBody(probeBody);
  if (communityProbe.count > 0) {
    console.log('[community] matched', communityProbe.count, 'material(s) for', body.phase);
  }
  body.communityMaterialsProbe = communityProbe;

  if (!body.skipCache) {
    if (body.phase === 'chat_followup') {
      try {
        const prior = await cacheDb.lookupChatPriorAnswer(body);
        if (prior && cacheDb.extractChatAnswerText(prior.data)) {
          body.priorCachedAnswer = prior;
          console.log(
            '[cached_results] CHAT PRIOR',
            prior.matchType,
            prior.cacheKey.slice(0, 12),
            prior.matchType === 'similar' ? ('sim=' + (prior.similarity || 0).toFixed(2)) : ''
          );
        }
        const gradePrior = await cacheDb.lookupGradeCachedContext(body);
        if (gradePrior) {
          body.priorGradeCache = gradePrior;
          console.log('[cached_results] CHAT GRADE CONTEXT', gradePrior.cacheKey.slice(0, 12));
        }
        const topicPrior = await cacheDb.lookupTopicCachedContext(body);
        if (topicPrior) {
          body.priorTopicCache = topicPrior;
          console.log('[cached_results] CHAT TOPIC CONTEXT', topicPrior.cacheKey.slice(0, 12));
        }
      } catch (priorErr) {
        console.warn('[cached_results] chat prior lookup failed:', priorErr.message || priorErr);
      }
    } else {
      const cached = await cacheDb.getCachedResult(body);
      if (cached) {
        console.log('[cached_results] HIT', body.phase, cached.meta.cacheKey.slice(0, 12), cached.meta.source || '');
        if (!body.skipKnowledgeIngest) {
          knowledgeIngest.ingestFromGenerateResultAsync(body, cached.data);
        }
        cached.meta = attachCommunityMeta(cached.meta, communityProbe);
        return cached;
      }
      if (body.phase === 'topic') {
        const suggestion = await cacheDb.findArchiveTopicSuggestion({
          topic: body.topic,
          gradeId: body.currentGrade ?? body.gradeId,
        });
        if (suggestion && suggestion.matchType === 'exact' && suggestion.resultData) {
          console.log(
            '[cached_results] HIT (consolidated archive ≥99% similarity)',
            suggestion.topic,
            suggestion.cacheKey ? suggestion.cacheKey.slice(0, 12) : '',
            'sim=' + (suggestion.similarity || 1).toFixed(3)
          );
          if (!body.skipKnowledgeIngest) {
            knowledgeIngest.ingestFromGenerateResultAsync(body, suggestion.resultData);
          }
          return {
            data: suggestion.resultData,
            meta: attachCommunityMeta({
              fromCache: true,
              cacheKey: suggestion.cacheKey,
              table: 'cached_results',
              source: 'consolidated_archive',
              similarity: suggestion.similarity,
              requestedTopic: body.topic || suggestion.requestedTopic || null,
            }, communityProbe),
          };
        }
        if (suggestion && suggestion.matchType === 'partial') {
          console.log(
            '[cached_results] PARTIAL archive topic — awaiting confirmation:',
            suggestion.topic,
            suggestion.cacheKey ? suggestion.cacheKey.slice(0, 12) : ''
          );
          return {
            data: null,
            meta: attachCommunityMeta({
              fromCache: false,
              needsArchiveConfirmation: true,
              archiveSuggestion: {
                matchType: 'partial',
                suggestedTopic: suggestion.topic,
                archiveTitle: suggestion.topic,
                requestedTopic: body.topic || null,
                cacheKey: suggestion.cacheKey,
                similarity: suggestion.similarity,
                gradeId: suggestion.gradeId,
                gradeLabel: suggestion.gradeLabel || null,
              },
            }, communityProbe),
          };
        }
      }
      console.log('[cached_results] MISS', body.phase, cacheDb.isSupabaseCacheEnabled() ? '(supabase)' : '(fallback only)');
    }
  }

  let ragMeta = {
    enabled: ragDb.isRagEnabled(),
    chunkCount: 0,
    method: 'skipped',
    contextChars: 0,
    liveDriveRefresh: false,
  };

  // Live Drive archive lookup — runs on every cache miss (no stale RAG cache).
  // Queries knowledge_base in real time so newly ingested "waldrof project" / "waldorf project" files are included.
  if (!body.skipRag && ragDb.shouldRetrieveForPhase(body.phase)) {
    try {
      console.log('[generate] live Drive archive RAG refresh for phase', body.phase);
      const ragResult = await ragDb.retrieveForRequest(body);
      body.ragContext = ragResult.context || '';
      body.ragDriveContext = ragResult.driveContext || '';
      body.ragCommunityContext = ragResult.communityContext || '';
      if (Array.isArray(ragResult.chunkIds)) body.ragChunkIds = ragResult.chunkIds;
      ragMeta = Object.assign({}, ragResult.meta || {}, {
        contextChars: (body.ragContext || '').length,
        driveContextChars: (body.ragDriveContext || '').length,
        communityContextChars: (body.ragCommunityContext || '').length,
        liveDriveRefresh: true,
        threeWayRetrieval: true,
      });
      if (ragMeta.chunkCount > 0) {
        console.log(
          '[rag] hybrid retrieval:', ragMeta.chunkCount, 'chunks',
          '(drive:', ragMeta.driveCount || 0, 'community:', ragMeta.communityCount || 0, ')',
          'via', ragMeta.method || 'unknown'
        );
      } else {
        console.log('[rag] hybrid retrieval: no matching excerpts (web-only generation)');
      }
    } catch (ragErr) {
      console.warn('[rag] retrieval failed:', ragErr.message || ragErr);
      ragMeta = {
        enabled: ragDb.isRagEnabled(),
        chunkCount: 0,
        method: 'error',
        error: ragErr.message || String(ragErr),
        contextChars: String(body.ragContext || '').length,
        liveDriveRefresh: true,
      };
    }
  }

  const gradeLockSystem =
    resolvedGradeId(body) || body.gradeLabel
      ? ' CRITICAL: currentGrade is locked — never mix pedagogical content from other grades.'
      : '';

  const searchPhases = new Set([
    'grade', 'topic', 'pedagogy_deep_dive', 'archive_search', 'archive_summary',
    'chat_followup',
  ]);
  const isChatFollowup = body.phase === 'chat_followup';
  const communityCriticalBlock =
    isChatFollowup && body.communityMaterialsProbe && body.communityMaterialsProbe.count > 0
      ? buildCommunityMatchCriticalSystemBlock(body.communityMaterialsProbe, body)
      : '';
  const extraSystem =
    gradeLockSystem +
    CONTENT_HIERARCHY_INSTRUCTION +
    communityCriticalBlock +
    (body.phase === 'grade' || body.phase === 'topic'
      ? ' CRITICAL JSON OUTPUT: Reply with raw JSON only — first character {, last character }. No ```json fences, no Hebrew/English preamble.'
      : '') +
    (isChatFollowup
      ? (body.communityMaterialsProbe && body.communityMaterialsProbe.count > 0
        ? ' PEDAGOGICAL CHAT — COMMUNITY MATCH: Start verbatim with the CRITICAL INSTRUCTION opening. Announce the community file only — do not invent external plays or commercial productions.'
        : (body.priorCachedAnswer || body.priorGradeCache
          ? ' PEDAGOGICAL CHAT ENRICHMENT: Prior cached grade insights and/or chat answers exist — refine, correct, deepen, and expand using live Steiner/anthroposophic web search. Output must surpass prior versions.'
          : ' PEDAGOGICAL CHAT: No community match — perform live web search for verified Steiner/anthroposophic sources on every question. ' +
            'Answer fully when search and lesson context support it. Decline only when no verified material exists anywhere.'))
      : body.ragContext || body.ragDriveContext || body.ragCommunityContext
        ? ' HYBRID SEARCH: Live web search is PRIMARY. Private Drive and shared community archive excerpts are SECONDARY enrichment — blend them into the web foundation without replacing web breadth.'
        : ' No local Drive or community archive excerpts matched — build the full lesson plan from live web search alone. Do not shorten output.') +
    (searchPhases.has(body.phase)
      ? ' LIVE WEB SEARCH is the core anchor — perform a broad, exhaustive internet search first. ' +
        'Check Alon Yerushalmy, «מסעות בחינוך», and educationpace.com only for genuinely relevant matches — ' +
        'never force a citation; omit entirely when search data offers no substantial topic-specific material.'
      : '');

  const perplexityOptions = isChatFollowup
    ? { systemPrompt: pedagogicalChatSystemPrompt, temperature: 0.2 }
    : {};

  const userPrompt = buildUserPrompt(body);
  const data = await fetchParsedModelWithRetry(
    body,
    apiKey,
    userPrompt,
    extraSystem,
    perplexityOptions,
    isChatFollowup,
    logContext
  );

  if (body.phase === 'chat_followup' && data.chatReply && typeof data.chatReply === 'object') {
    data.chatReply = cacheDb.sanitizeForJsonStorage(data.chatReply);
  }

  let gradeCachePatch = null;
  if (!body.skipCache) {
    try {
      if (body.phase === 'chat_followup' && data.chatReply && typeof data.chatReply === 'object') {
        if (body.priorCachedAnswer) {
          data.chatReply.enrichedFromPrior = true;
          data.chatReply.priorMatchType = body.priorCachedAnswer.matchType || 'exact';
        }
        if (body.priorGradeCache) {
          data.chatReply.enrichedFromGradeCache = true;
        }
      }
      const cachePayload = isChatFollowup ? cacheDb.packChatFollowupForCache(data) : data;
      const savedKey = await cacheDb.setCachedResult(body, cachePayload || data);
      if (savedKey) {
        const merged = ragMeta.chunkCount > 0;
        const action = body.priorCachedAnswer || body.priorGradeCache
          ? 'ENRICHED+SAVED'
          : (merged ? 'CONSOLIDATED+SAVED' : 'SAVED');
        console.log(
          '[cached_results]', action, body.phase, savedKey.slice(0, 12),
          cacheDb.isSupabaseCacheEnabled() ? '(supabase)' : '(fallback)',
          merged ? '(web+Drive merge)' : '(web only)'
        );
      }
      if (body.phase === 'chat_followup' && data.chatReply) {
        gradeCachePatch = await cacheDb.mergeChatEnrichmentIntoGradeCache(body, data);
        if (gradeCachePatch) {
          console.log('[cached_results] GRADE SYNC', gradeCachePatch.cacheKey.slice(0, 12));
        }
      }
    } catch (cacheErr) {
      console.warn('[cached_results] save failed:', cacheErr.message || cacheErr);
    }
  }

  const savedCacheKey = body.skipCache ? null : cacheDb.buildCacheKey(body);
  const priorEnriched = Boolean(body.priorCachedAnswer || body.priorGradeCache);

  if (!body.skipKnowledgeIngest) {
    knowledgeIngest.ingestFromGenerateResultAsync(body, data);
  }

  return {
    data: data,
    meta: attachCommunityMeta({
      fromCache: false,
      priorCacheEnriched: priorEnriched,
      priorMatchType: priorEnriched
        ? ((body.priorCachedAnswer && body.priorCachedAnswer.matchType) || (body.priorGradeCache ? 'grade' : 'exact'))
        : undefined,
      gradeCacheUpdated: Boolean(gradeCachePatch),
      gradeCacheKey: gradeCachePatch ? gradeCachePatch.cacheKey : undefined,
      updatedGradeInsights: gradeCachePatch ? gradeCachePatch.gradeInsights : undefined,
      cacheKey: savedCacheKey || undefined,
      table: cacheDb.TABLE_NAME,
      source: cacheDb.isSupabaseCacheEnabled() ? 'supabase' : 'live',
      consolidatedArchive: ragMeta.chunkCount > 0,
      contentHierarchy: 'web_primary_drive_enrichment',
      liveDriveRefresh: Boolean(ragMeta.liveDriveRefresh),
      rag: ragMeta,
      ragContext: body.ragContext || '',
      ragChunkIds: Array.isArray(body.ragChunkIds) ? body.ragChunkIds : [],
    }, communityProbe),
  };
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(statusCode).send(cacheDb.safeJsonStringify(payload));
}

/** Legacy Node (req, res) handler — used by dev-server.js locally. */
async function legacyHandler(req, res) {
  if (!res || typeof res.status !== 'function') {
    throw new Error('legacyHandler: invalid response object');
  }
  if (!req) {
    return sendJson(res, 500, { error: 'שגיאת שרת פנימית: בקשה לא תקינה.' });
  }

  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    return sendJson(res, 500, { error: MISSING_KEY_ERROR });
  }

  let body;
  try {
    body = parseRequestBody(req);
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return sendJson(res, 400, { error: message || 'Invalid JSON body' });
  }

  try {
    const result = await handleGeneratePost(body, {
      headers: req.headers || {},
      socket: req.socket,
    });
    return sendJson(res, 200, buildGenerateHttpPayload(result));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const statusCode = e && e.statusCode ? e.statusCode : 500;
    console.error(message);
    return sendJson(res, statusCode, {
      error: message,
      code: e && e.code ? e.code : undefined,
      usage: e && e.usage ? e.usage : undefined,
    });
  }
}

/** Web Standard fetch handler — primary export for Vercel serverless production. */
async function fetchHandler(request) {
  const headers = new Headers(corsHeaders);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    return Response.json({ error: MISSING_KEY_ERROR }, { status: 500, headers });
  }

  let body;
  try {
    const text = await request.text();
    body = text && text.trim() ? JSON.parse(text) : null;
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return Response.json({ error: message || 'Invalid JSON body' }, { status: 400, headers });
  }

  try {
    const result = await handleGeneratePost(body, {
      headers: Object.fromEntries(request.headers.entries()),
    });
    const payload = buildGenerateHttpPayload(result);
    return new Response(cacheDb.safeJsonStringify(payload), {
      status: 200,
      headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json; charset=utf-8' }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const statusCode = e && e.statusCode ? e.statusCode : 500;
    console.error(message);
    return Response.json({
      error: message,
      code: e && e.code ? e.code : undefined,
      usage: e && e.usage ? e.usage : undefined,
    }, { status: statusCode, headers });
  }
}

// Default export for Vercel serverless; named props for Render (server.js → handleGeneratePost).
module.exports = fetchHandler;
module.exports.fetch = fetchHandler;
module.exports.legacyHandler = legacyHandler;
module.exports.handleGeneratePost = handleGeneratePost;
module.exports.executeGenerate = executeGenerate;
module.exports.resolveApiKey = resolveApiKey;
module.exports.buildGenerateHttpPayload = buildGenerateHttpPayload;
