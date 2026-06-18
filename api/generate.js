/**
 * Waldorf research API — secure Perplexity proxy.
 * Perplexity API key is read server-side only (never exposed to the browser).
 * Set PERPLEXITY_API_KEY or AI_API_KEY in Render Environment (or .env locally).
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
  parseJsonLenient,
  parseJsonFromModel,
  unwrapParsedModelPayload,
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
  '\n=== WEB SEARCH STRATEGY (MANDATORY) ===\n' +
  'Perform a BROAD internet search for the best general educational and pedagogical information relevant to the query. ' +
  'Synthesize Waldorf/anthroposophic perspectives together with wider pedagogical insights from live web sources ' +
  '(AWSNA, IASWECE, Waldorf Library, Steiner Archive, international teacher resources, classroom practice, and more).\n' +
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

const STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION =
  '\n=== STEINER / ANTHROPOSOPHIC SOURCE FIDELITY (CRITICAL — ABSOLUTE — ALL OUTPUTS) ===\n' +
  'This rule binds EVERY response in the application: Step A (age portrait / תמונת גיל), Step B (topic research / מחקר נושא), ' +
  'Step C (period planning / תכנון תקופה), and the Pedagogical AI Chat Assistant (עוזר ה-AI).\n' +
  'AUTHORITATIVE SOURCES ONLY:\n' +
  'Base ALL pedagogical and anthroposophic content EXCLUSIVELY on reliable, established, proven material from Rudolf Steiner\'s anthroposophy and Waldorf pedagogy — ' +
  'including foundation lectures (GA / Gesamtausgabe), core pedagogical writings, and verified anthroposophic literature faithfully grounded in Steiner\'s corpus.\n' +
  'Primary anchors: Steiner Archive, official GA education lecture cycles (e.g. The Foundations of Human Experience, Practical Advice to Teachers, Discussions with Teachers), ' +
  'and recognized anthroposophic pedagogical scholarship derived directly from Steiner — not popular summaries or unverified reinterpretations.\n' +
  'When WALDORF KNOWLEDGE BASE (RAG) excerpts or retrieved web sources are provided, treat them as the ONLY permissible basis for substantive claims; ' +
  'Steiner/GA material takes precedence over secondary sources when they conflict.\n' +
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
  '\n=== PEDAGOGICAL CHAT — STEINER-GROUNDED + LIVE WEB SEARCH (MANDATORY) ===\n' +
  'You are the Pedagogical Chat Assistant for Waldorf / Steiner-Waldorf teachers — a supportive, highly accurate pedagogical peer.\n' +
  'RESEARCH STRATEGY (every question):\n' +
  'Perform LIVE internet search via Perplexity. Primary authorities: Rudolf Steiner (GA lectures, Steiner Archive), ' +
  'core anthroposophic pedagogical writings, AWSNA, IASWECE, Waldorf Research Institute Library (waldorflibrary.org).\n' +
  'Supplement with lesson context and any KNOWLEDGE BASE excerpts in the user message — local community materials help but are NOT the only source.\n' +
  'ANTI-HALLUCINATION:\n' +
  'NEVER fabricate Steiner quotes, GA numbers, doctrines, temperament links, or curriculum details absent from search or provided sources.\n' +
  'NEVER answer from vague model knowledge or free personal anthroposophic interpretation.\n' +
  'WHEN TO ANSWER:\n' +
  'Give a full, warm, practical Hebrew answer when live search and/or lesson context provide verified Steiner-based material.\n' +
  'FALLBACK (rare — only when live search + lesson context + knowledge base all lack verified material on the specific question):\n' +
  'Respond humbly in Hebrew that you could not locate verified Steiner/anthroposophic sources on this point — invite reframing or sharing sources.\n' +
  'Do NOT default to "אין חומר במאגר הקהילתי" when web search can answer from Steiner/core anthroposophic sources.\n' +
  'For fallback replies: write the same humble Hebrew decline as plain prose.\n' +
  'TONE: Grounded, authentic, authoritative yet humble. Practical for classroom teachers when sources support it.\n' +
  '=== END PEDAGOGICAL CHAT — STEINER-GROUNDED + LIVE WEB SEARCH ===\n';

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
    'Use live web search to gather broad, high-quality educational and pedagogical material for every query. ' +
    STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
    WEB_SEARCH_PRIORITY_INSTRUCTION +
    FACTUAL_INTEGRITY_INSTRUCTION +
    ACADEMIC_TONE_INSTRUCTION +
    SOURCES_CITATION_INSTRUCTION +
    JSON_ONLY_INSTRUCTION +
    JSON_RESPONSE_ENFORCEMENT +
    JSON_VALID_SYNTAX_INSTRUCTION +
    ' Write pedagogical content in Hebrew. ' +
    'Ground every claim in verified Steiner/anthroposophic sources — never general model knowledge or invented pedagogy. ' +
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
    'Use live web search on EVERY question to retrieve verified Rudolf Steiner and anthroposophic pedagogical material. ' +
    STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
    PEDAGOGICAL_CHAT_GROUNDING_INSTRUCTION +
    WEB_SEARCH_PRIORITY_INSTRUCTION +
    FACTUAL_INTEGRITY_INSTRUCTION +
    CHAT_FREE_TEXT_OUTPUT_INSTRUCTION +
    ' Write all chat replies in Hebrew. ' +
    'Deliver full, practical answers when Steiner-based sources support them — do not decline when live search can answer.' +
    NO_LATEX_BLOCK +
    (extra || '')
  );
}

function resolvedGradeId(body) {
  return String(body.currentGrade ?? body.gradeId ?? '').trim();
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
  const isChat = body && body.phase === 'chat_followup';

  if (!rag && isChat) {
    return (
      '\n=== WALDORF KNOWLEDGE BASE (RAG — NO LOCAL EXCERPTS) ===\n' +
      'No local knowledge_base excerpts matched this question — this is normal. ' +
      'Proceed with LIVE WEB SEARCH for Rudolf Steiner (GA lectures), Steiner Archive, waldorflibrary.org, AWSNA, IASWECE, ' +
      'and verified anthroposophic pedagogy. Also use lesson context below when relevant. ' +
      'Do NOT decline solely because local RAG is empty.\n' +
      '=== END KNOWLEDGE BASE ===\n\n'
    );
  }

  if (!rag) return '';

  if (isChat) {
    return (
      '\n=== WALDORF KNOWLEDGE BASE (RAG — SUPPLEMENTARY LOCAL EXCERPTS) ===\n' +
      'The excerpts below are from the local knowledge_base (community materials and prior research). ' +
      'Treat them as valuable supplementary context. ALSO perform live web search for core Steiner/anthroposophic sources — ' +
      'do not limit answers to these excerpts alone.\n' +
      'Reference document titles when citing. Do not contradict verified Steiner sources. Do not add unstated connections.\n\n' +
      rag + '\n=== END KNOWLEDGE BASE ===\n\n'
    );
  }

  return (
    '\n=== WALDORF KNOWLEDGE BASE (RAG — MANDATORY GROUNDING) ===\n' +
    'The excerpts below are from curated Anthroposophical articles, Waldorf lectures, pedagogical texts, ' +
    'and materials shared by teachers in the community. ' +
    'Treat them as authoritative for tone and doctrine. Prioritize them over general web search when they apply. ' +
    'Reference document titles when citing. Do not contradict these sources.\n\n' +
    rag + '\n=== END KNOWLEDGE BASE ===\n\n'
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

const LAZY_LOAD_NOTE =
  'Do NOT include expansion, contentExpansion, artExpansion, or nested practical-expansion objects — expansions load on-demand via pedagogy_deep_dive.\n';

/**
 * chat_followup: accept free text / Markdown from the model.
 * If the model still returns JSON, unwrap it; otherwise treat the full reply as the answer.
 */
function normalizeChatFollowupFromModel(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Empty model response');

  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = unwrapParsedModelPayload(parseJsonLenient(text));
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
      WEB_SEARCH_PRIORITY_INSTRUCTION +
      'Perform live web research on Waldorf/Steiner anthroposophic child development for:\n' +
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
      WEB_SEARCH_PRIORITY_INSTRUCTION +
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
    const history = Array.isArray(body.chatHistory) ? body.chatHistory.slice(-6) : [];
    const historyBlock = history.length
      ? '\nRECENT CHAT (for continuity):\n' + history.map(function (m) {
          return (m.role || 'user') + ': ' + String(m.content || '').slice(0, 800);
        }).join('\n') + '\n'
      : '';

    const hasContext = Boolean(context.trim());
    const hasRag = Boolean(String(body.ragContext || '').trim());
    const priorBlock = buildPriorChatAnswerBlock(body.priorCachedAnswer);
    const gradePriorBlock = buildPriorGradeCacheBlock(body.priorGradeCache);
    const topicPriorBlock = buildPriorTopicCacheBlock(body.priorTopicCache);

    return (
      ragBlock +
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      gradePriorBlock +
      topicPriorBlock +
      priorBlock +
      'You are the Pedagogical Chat Assistant helping a teacher with follow-up questions about their generated lesson plan.\n' +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Grade: ' + (body.gradeLabel || '') + ' (age ' + (body.age || '') + ')\n' +
      'Block topic: ' + (body.topic || '') + '\n' +
      'Verified sources available: knowledge_base=' + (hasRag ? 'yes' : 'no') + ', lesson_context=' + (hasContext ? 'yes' : 'no') + '\n\n' +
      '=== ORIGINAL RESEARCH & LESSON CONTEXT (ground answers here when explicit) ===\n' +
      (hasContext ? context : '(empty — no lesson context provided)') + '\n' +
      '=== END CONTEXT ===\n' +
      historyBlock +
      'Teacher follow-up question: «' + question + '»\n\n' +
      'ANSWER STRATEGY (MANDATORY):\n' +
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
      '2. Integrate lesson context and any knowledge_base excerpts when they add verified detail.\n' +
      '3. NEVER fabricate Steiner quotes, GA citations, or doctrines — only state what search and context support.\n' +
      '4. Give a full, warm, practical Hebrew answer (2–6 paragraphs) when verified material exists.\n' +
      '5. Use the Hebrew fallback decline ONLY when live search + context all lack verified material on this specific question.\n' +
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
async function fetchParsedModelWithRetry(body, apiKey, userPrompt, extraSystem, perplexityOptions, isChatFollowup) {
  const phase = body.phase;
  const baseOpts = perplexityOptions || {};
  let lastPreview = '';

  for (let attempt = 1; attempt <= MODEL_PARSE_MAX_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    const retrySuffix = isRetry && !isChatFollowup ? JSON_RETRY_SYSTEM_SUFFIX : '';
    const callOpts = Object.assign({}, baseOpts, {
      temperature: isRetry
        ? 0.2
        : (baseOpts.temperature !== undefined ? baseOpts.temperature : 0.35),
    });

    let raw;
    try {
      if (isRetry) {
        console.warn('[generate] Silent Perplexity retry for phase', phase, '(attempt', attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + ')');
      }
      raw = await callPerplexity(apiKey, userPrompt, extraSystem + retrySuffix, callOpts);
    } catch (aiErr) {
      const msg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      console.error('[generate] Perplexity call failed for phase', phase, '(attempt', attempt + '):', msg);
      if (attempt < MODEL_PARSE_MAX_ATTEMPTS && isRetriablePerplexityCallError(aiErr)) {
        continue;
      }
      throw new Error(msg || 'שגיאה בקריאה ל-AI — נסו שוב בעוד רגע.');
    }

    let data;
    try {
      data = isChatFollowup ? normalizeChatFollowupFromModel(raw) : parseJsonFromModel(raw);
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
      if (!isChatFollowup && attempt < MODEL_PARSE_MAX_ATTEMPTS) {
        continue;
      }
      if (isChatFollowup) {
        throw new Error('המודל לא החזיר תשובה. נסו שוב בעוד רגע.');
      }
      throw new Error(GENERIC_GENERATION_ERROR);
    }

    if (!validatePhaseResult(phase, data)) {
      lastPreview = String(raw).slice(0, 600);
      console.error(
        '[generate] Parsed JSON missing required fields for phase',
        phase,
        '(attempt ' + attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + ')'
      );
      console.error('Model output preview:', lastPreview);
      if (!isChatFollowup && attempt < MODEL_PARSE_MAX_ATTEMPTS) {
        continue;
      }
      throw new Error(GENERIC_GENERATION_ERROR);
    }

    if (isRetry) {
      console.log('[generate] Silent retry succeeded for phase', phase);
    }
    return data;
  }

  throw new Error(GENERIC_GENERATION_ERROR);
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

/** Core handler — used by Render (server.js) with a pre-parsed JSON body. */
async function handleGeneratePost(parsedBody, requestContext) {
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
  if (parsedBody.phase === 'grade') {
    cacheDb.normalizeGradeCacheRequest(parsedBody);
  }
  const apiKey = resolveApiKey();
  if (!apiKey) {
    const err = new Error(MISSING_KEY_ERROR);
    err.statusCode = 500;
    throw err;
  }
  const ctx = requestContext && typeof requestContext === 'object' ? requestContext : {};
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
  const result = await executeGenerate(parsedBody, apiKey);
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

async function executeGenerate(body, apiKey) {
  if (!body || !body.phase) {
    const err = new Error('Missing phase');
    err.statusCode = 400;
    throw err;
  }

  // Step A (grade): stable cache key (phase + gradeId only) — always consult Supabase.
  if (body.phase === 'grade') {
    body.skipCache = false;
    cacheDb.normalizeGradeCacheRequest(body);
  }

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
        return cached;
      }
      if (body.phase === 'topic') {
        const suggestion = await cacheDb.findArchiveTopicSuggestion({
          topic: body.topic,
          gradeId: body.currentGrade ?? body.gradeId,
        });
        if (suggestion && suggestion.matchType === 'partial') {
          console.log(
            '[cached_results] PARTIAL archive topic — awaiting confirmation:',
            suggestion.topic,
            suggestion.cacheKey ? suggestion.cacheKey.slice(0, 12) : ''
          );
          return {
            data: null,
            meta: {
              fromCache: false,
              needsArchiveConfirmation: true,
              archiveSuggestion: {
                matchType: 'partial',
                suggestedTopic: suggestion.topic,
                archiveTitle: suggestion.topic,
                cacheKey: suggestion.cacheKey,
                similarity: suggestion.similarity,
                gradeId: suggestion.gradeId,
                gradeLabel: suggestion.gradeLabel || null,
              },
            },
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
  };

  if (!body.skipRag && ragDb.shouldRetrieveForPhase(body.phase)) {
    try {
      const ragResult = await ragDb.retrieveForRequest(body);
      body.ragContext = ragResult.context || '';
      if (Array.isArray(ragResult.chunkIds)) body.ragChunkIds = ragResult.chunkIds;
      ragMeta = Object.assign({}, ragResult.meta || {}, {
        contextChars: (body.ragContext || '').length,
      });
      if (ragMeta.chunkCount > 0) {
        console.log('[rag] retrieved', ragMeta.chunkCount, 'chunks via', ragMeta.method || 'unknown');
      }
    } catch (ragErr) {
      console.warn('[rag] retrieval failed:', ragErr.message || ragErr);
      ragMeta = {
        enabled: ragDb.isRagEnabled(),
        chunkCount: 0,
        method: 'error',
        error: ragErr.message || String(ragErr),
        contextChars: String(body.ragContext || '').length,
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
  const extraSystem =
    gradeLockSystem +
    (body.phase === 'grade' || body.phase === 'topic'
      ? ' CRITICAL JSON OUTPUT: Reply with raw JSON only — first character {, last character }. No ```json fences, no Hebrew/English preamble.'
      : '') +
    (isChatFollowup
      ? (body.priorCachedAnswer || body.priorGradeCache
        ? ' PEDAGOGICAL CHAT ENRICHMENT: Prior cached grade insights and/or chat answers exist — refine, correct, deepen, and expand using live Steiner/anthroposophic web search. Output must surpass prior versions.'
        : ' PEDAGOGICAL CHAT: Perform live web search for verified Steiner/anthroposophic sources on every question. ' +
          'Answer fully when search and lesson context support it. Decline only when no verified material exists anywhere.')
      : body.ragContext
        ? ' When WALDORF KNOWLEDGE BASE excerpts are provided in the user message, treat them as primary authoritative context.'
        : '') +
    (searchPhases.has(body.phase)
      ? ' Perform a broad internet search for general educational and pedagogical answers. ' +
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
    isChatFollowup
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
        const action = body.priorCachedAnswer || body.priorGradeCache ? 'ENRICHED+SAVED' : 'SAVED';
        console.log('[cached_results]', action, body.phase, savedKey.slice(0, 12), cacheDb.isSupabaseCacheEnabled() ? '(supabase)' : '(fallback)');
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
    meta: {
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
      rag: ragMeta,
      ragContext: body.ragContext || '',
      ragChunkIds: Array.isArray(body.ragChunkIds) ? body.ragChunkIds : [],
    },
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
    const result = await handleGeneratePost(body, { headers: req.headers || {} });
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
