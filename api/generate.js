/**
 * Waldorf research API — secure Perplexity proxy.
 * Perplexity API key is read server-side only (never exposed to the browser).
 * Set AI_API_KEY or PERPLEXITY_API_KEY in the host environment (Render, Vercel, .env for local).
 *
 * Exports:
 * - legacyHandler(req, res) — Node HTTP servers (server.js, Render)
 * - fetch(request) — Vercel serverless (Web Standard)
 */

const fs = require('fs');
const path = require('path');
const cacheDb = require('./cache');
const ragDb = require('./rag');
const knowledgeIngest = require('./knowledge-ingest');
const env = require('./env');

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

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar-pro';

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
  '\n=== PEDAGOGICAL CHAT — STRICT GROUNDING (ABSOLUTE — MANDATORY) ===\n' +
  'You are the Pedagogical Chat Assistant for Waldorf / Steiner-Waldorf teachers — a supportive, highly accurate pedagogical peer.\n' +
  'ANTI-GUESSING / NO FABRICATION:\n' +
  'NEVER fabricate, infer, extrapolate, or "fill in" pedagogical connections, concepts, theories, temperament claims, ' +
  'curriculum integrations, or Steiner/Waldorf methodology details.\n' +
  'NEVER answer from general model knowledge, plausible pedagogy, or vague Waldorf associations when verified material is missing.\n' +
  'TRUTH & VERIFICATION:\n' +
  'Answer ONLY when EVERY substantive claim is explicitly grounded in at least one of:\n' +
  '(1) WALDORF KNOWLEDGE BASE excerpts in the user message (Supabase knowledge_base / RAG),\n' +
  '(2) ORIGINAL RESEARCH & LESSON CONTEXT in the user message,\n' +
  '(3) a narrowly verified fact from web search for this specific question — never use web search to invent connections.\n' +
  'If the teacher asks about a connection, integration, doctrine, temperament link, or curriculum detail and NONE of the above ' +
  'contain explicit supporting material, you MUST NOT attempt an answer or extrapolate.\n' +
  'SAFE FALLBACK (Hebrew — mandatory when declining):\n' +
  'When uncertain or lacking verified material, respond ONLY with a humble, professional Hebrew decline. ' +
  'Use this template (replace the bracketed phrase with the specific topic):\n' +
  '"אין בידיי חומר מוסמך או מבוסס במאגר לגבי [נושא השאלה], ולכן לא אוכל להשיב כדי לא להטעות. אנא שתפו חומרים בנושא במאגר הקהילתי כדי שאוכל ללמוד."\n' +
  'For fallback replies: set answer and answerHtml to the same Hebrew text; suggestedFollowUps may be [] or invite sharing materials.\n' +
  'TONE: Grounded, authentic, authoritative yet humble. Warm and practical only when verified material supports the answer.\n' +
  '=== END PEDAGOGICAL CHAT — STRICT GROUNDING ===\n';

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
    WEB_SEARCH_PRIORITY_INSTRUCTION +
    FACTUAL_INTEGRITY_INSTRUCTION +
    ACADEMIC_TONE_INSTRUCTION +
    SOURCES_CITATION_INSTRUCTION +
    JSON_ONLY_INSTRUCTION +
    JSON_VALID_SYNTAX_INSTRUCTION +
    ' Write pedagogical content in Hebrew. ' +
    'Base claims on real Waldorf principles: child development (body/soul/spirit), main lesson blocks, biography, artistic integration. ' +
    'Cite Steiner/GA when appropriate. Be specific, warm, and practical for classroom teachers.' +
    NO_LATEX_BLOCK +
    (extra || '')
  );
}

function pedagogicalChatSystemPrompt(extra) {
  return (
    'You are the Pedagogical Chat Assistant for Waldorf / Steiner-Waldorf teachers. ' +
    'Help teachers with follow-up questions about their generated lesson plan as a supportive, highly accurate pedagogical peer. ' +
    PEDAGOGICAL_CHAT_GROUNDING_INSTRUCTION +
    FACTUAL_INTEGRITY_INSTRUCTION +
    JSON_ONLY_INSTRUCTION +
    JSON_VALID_SYNTAX_INSTRUCTION +
    ' Write all chat replies in Hebrew. ' +
    'Do NOT perform broad web research or synthesize general Waldorf pedagogy — ground every answer in provided sources only.' +
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
      '\n=== WALDORF KNOWLEDGE BASE (RAG — NO EXCERPTS RETRIEVED) ===\n' +
      'No knowledge base excerpts were retrieved for this question. ' +
      'You may answer ONLY if the lesson context below explicitly contains verified material that directly answers the question. ' +
      'Otherwise you MUST use the Hebrew fallback decline — do NOT rely on general Waldorf, Steiner, or temperament knowledge.\n' +
      '=== END KNOWLEDGE BASE ===\n\n'
    );
  }

  if (!rag) return '';

  if (isChat) {
    return (
      '\n=== WALDORF KNOWLEDGE BASE (RAG — PRIMARY AUTHORITATIVE SOURCE) ===\n' +
      'The excerpts below are from curated Anthroposophical articles, Waldorf lectures, pedagogical texts, ' +
      'and materials shared by teachers in the community (Supabase knowledge_base). ' +
      'These excerpts are your PRIMARY authority. Answer ONLY from these excerpts plus the lesson context when they apply. ' +
      'If the question cannot be answered from these sources and the lesson context, use the Hebrew fallback decline — never guess.\n' +
      'Reference document titles when citing. Do not contradict these sources. Do not add unstated Steiner/Waldorf connections.\n\n' +
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

const LAZY_LOAD_NOTE =
  'Do NOT include expansion, contentExpansion, artExpansion, or nested practical-expansion objects — expansions load on-demand via pedagogy_deep_dive.\n';

/** Strip ```json ... ``` markdown fences if the model wrapped the response. */
function stripMarkdownJsonFences(text) {
  let raw = String(text || '').replace(/^\uFEFF/, '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

/** Normalize curly/smart quotes; keep Hebrew gershayim (״) out of ASCII ". */
function normalizeJsonSmartQuotes(raw) {
  return String(raw || '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019\u05f3]/g, "'");
}

/** Slice the outermost balanced {…} or […] payload from noisy model text. */
function extractJsonPayload(raw) {
  if (!raw) return '';
  const text = String(raw);
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  let start = -1;
  let openChar = '{';
  let closeChar = '}';
  if (objStart >= 0 && (arrStart < 0 || objStart <= arrStart)) {
    start = objStart;
  } else if (arrStart >= 0) {
    start = arrStart;
    openChar = '[';
    closeChar = ']';
  }
  if (start < 0) return text;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  const end = text.lastIndexOf(closeChar);
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

/**
 * Inside JSON string values, replace unescaped inner " with ' so Hebrew
 * quotations like אמר "שלום" do not terminate the string early.
 */
function repairUnescapedInnerQuotesInJsonStrings(raw) {
  if (!raw) return '';
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) {
        result += c;
        escaped = false;
        continue;
      }
      if (c === '\\') {
        result += c;
        escaped = true;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < raw.length && /[\s\n\r\t]/.test(raw[j])) j++;
        const next = raw[j];
        if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
          inString = false;
          result += c;
        } else {
          result += "'";
        }
        continue;
      }
      result += c;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
      continue;
    }
    result += c;
  }
  return result;
}

/** Escape raw newlines/tabs/control chars inside JSON string literals. */
function repairJsonStringLiterals(raw) {
  if (!raw) return '';
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) {
        result += c;
        escaped = false;
        continue;
      }
      if (c === '\\') {
        result += c;
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        result += c;
        continue;
      }
      if (c === '\r') {
        if (raw[i + 1] === '\n') i++;
        result += '\\n';
        continue;
      }
      if (c === '\n') {
        result += '\\n';
        continue;
      }
      if (c === '\t') {
        result += '\\t';
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        result += '\\u' + ('000' + code.toString(16)).slice(-4);
        continue;
      }
      result += c;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
      continue;
    }
    result += c;
  }
  return result;
}

function repairJsonText(raw) {
  let text = String(raw || '');
  text = text.replace(/,\s*([}\]])/g, '$1');
  text = text.replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(\s*:)/g, '$1"$2"$3');
  return repairJsonStringLiterals(text);
}

/** Append missing quotes/brackets when model output is truncated mid-field. */
function repairTruncatedJson(raw) {
  let s = String(raw).trim();
  if (!s) return s;

  let inString = false;
  let escaped = false;
  const closers = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') closers.push('}');
    else if (ch === '[') closers.push(']');
    else if ((ch === '}' || ch === ']') && closers.length && closers[closers.length - 1] === ch) {
      closers.pop();
    }
  }

  if (escaped) s = s.slice(0, -1);
  if (inString) s += '"';

  s = s.replace(/:\s*$/u, ': null');
  s = s.replace(/,\s*$/u, '');
  if (closers.length && closers[closers.length - 1] === '}') {
    s = s.replace(/,\s*"([^"\\]|\\.)*"\s*$/u, '');
  }

  while (closers.length) s += closers.pop();
  return s;
}

function parseJsonLenient(text) {
  const stripped = stripMarkdownJsonFences(text);
  try {
    return JSON.parse(stripped);
  } catch (firstErr) {
    return JSON.parse(repairTruncatedJson(stripped));
  }
}

function unwrapParsedModelPayload(parsed) {
  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.data &&
    typeof parsed.data === 'object' &&
    !parsed.gradeInsights &&
    !parsed.blockPlan &&
    !parsed.webResearch &&
    !parsed.archiveSearch &&
    !parsed.pedagogyDeepDive
  ) {
    return parsed.data;
  }
  return parsed;
}

/** Build repair candidates for grade / age-picture (תמונת גיל) model output. */
function buildGradeJsonParseAttempts(text) {
  const stripped = stripMarkdownJsonFences(text);
  const normalized = normalizeJsonSmartQuotes(stripped);
  const extracted = extractJsonPayload(normalized) || normalized;
  const quoteFixed = repairUnescapedInnerQuotesInJsonStrings(extracted);
  const literalFixed = repairJsonText(extracted);
  const quoteAndLiteral = repairJsonText(quoteFixed);

  const cores = [
    extracted,
    quoteFixed,
    literalFixed,
    quoteAndLiteral,
    repairTruncatedJson(extracted),
    repairTruncatedJson(quoteFixed),
    repairTruncatedJson(literalFixed),
    repairTruncatedJson(quoteAndLiteral),
  ];

  const seen = new Set();
  const attempts = [];
  for (let i = 0; i < cores.length; i++) {
    const candidate = cores[i];
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    attempts.push(candidate);
  }
  return attempts;
}

/**
 * Bulletproof JSON parse for phase === 'grade' (תמונת גיל / Age/Class).
 * Sanitizes Hebrew inner quotes, repairs literals, and closes truncated brackets.
 */
function parseGradeJsonFromModel(text) {
  if (!text || !String(text).trim()) throw new Error('Empty model response');
  const attempts = buildGradeJsonParseAttempts(text);
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return unwrapParsedModelPayload(JSON.parse(attempts[i]));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Invalid JSON from model');
}

function parseJsonFromModel(text) {
  if (!text || !String(text).trim()) throw new Error('Empty model response');
  const parsed = parseJsonLenient(text);
  return unwrapParsedModelPayload(parsed);
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
      JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n' +
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
      JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n' +
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
      'curriculum MUST have exactly 15 days with distinct topics and rich Hebrew content appropriate to currentGrade.\n' +
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

    return (
      ragBlock +
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
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
      'STRICT GROUNDING RULES (MANDATORY):\n' +
      '1. Answer ONLY from KNOWLEDGE BASE excerpts and/or explicit lesson context above — never from general Waldorf/Steiner training.\n' +
      '2. NEVER fabricate connections (temperaments, curriculum integrations, anthroposophic links, GA citations) not stated in those sources.\n' +
      '3. If the question cannot be answered from verified material, respond ONLY with the Hebrew fallback decline from system instructions.\n' +
      '4. When grounded: be practical, warm, specific to grade and topic; honor recent chat for continuity. Do not invent sources.\n' +
      '5. When declining: use ONLY the fallback sentence — no partial guesses, no "likely" or "typically in Waldorf" filler.\n' +
      JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n' +
      '{\n' +
      '  "chatReply": {\n' +
      '    "answer": "Full Hebrew answer when grounded (2-6 paragraphs), OR the Hebrew fallback decline when not grounded",\n' +
      '    "answerHtml": "<p>HTML matching answer</p>",\n' +
      '    "suggestedFollowUps": ["2-3 short Hebrew follow-ups when grounded, or [] when using fallback"]\n' +
      '  }\n' +
      '}'
    );
  }

  throw new Error('Unknown phase');
}

async function callPerplexity(apiKey, userPrompt, extraSystem, options) {
  const opts = options || {};
  const systemBuilder = typeof opts.systemPrompt === 'function' ? opts.systemPrompt : waldorfSystemPrompt;
  const temperature = opts.temperature !== undefined ? opts.temperature : 0.35;

  const res = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      temperature: temperature,
      messages: [
        { role: 'system', content: systemBuilder(extraSystem) },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const responseText = await res.text();
  if (!res.ok) {
    console.error('Perplexity error', res.status, responseText.slice(0, 400));
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Perplexity API key invalid or unauthorized (HTTP ' + res.status + '). ' +
        'Verify PERPLEXITY_API_KEY in .env or Vercel Environment Variables.'
      );
    }
    throw new Error('Perplexity API ' + res.status + ': ' + responseText.slice(0, 400));
  }

  let data;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch (parseErr) {
    throw new Error(
      'Perplexity API returned non-JSON (HTTP ' + res.status + '): ' + responseText.slice(0, 200)
    );
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('No content in Perplexity response');
  return content;
}

function resolveApiKey() {
  const key = env.getPerplexityApiKey();
  return key || null;
}

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

const MISSING_KEY_ERROR =
  'מפתח Perplexity לא מוגדר. הוסיפו AI_API_KEY או PERPLEXITY_API_KEY ב-Vercel (Settings → Environment Variables) ופרסמו מחדש.';

/** Parse JSON body from Vercel/Node request helpers (req.body getter can throw). */
function parseRequestBody(req) {
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

  if (!body.skipCache) {
    const cached = await cacheDb.getCachedResult(body);
    if (cached) {
      console.log('[cached_results] HIT', body.phase, cached.meta.cacheKey.slice(0, 12), cached.meta.source || '');
      if (!body.skipKnowledgeIngest) {
        knowledgeIngest.ingestFromGenerateResultAsync(body, cached.data);
      }
      return cached;
    }
    console.log('[cached_results] MISS', body.phase, cacheDb.isSupabaseCacheEnabled() ? '(supabase)' : '(fallback only)');
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
  ]);
  const isChatFollowup = body.phase === 'chat_followup';
  const extraSystem =
    gradeLockSystem +
    (isChatFollowup
      ? ' STRICT PEDAGOGICAL CHAT: Do NOT use broad web search to fabricate answers. ' +
        'Ground every claim in knowledge_base excerpts and/or lesson context only. ' +
        'When material is missing, use the Hebrew fallback decline — never extrapolate Steiner/Waldorf doctrine.'
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
  const raw = await callPerplexity(apiKey, userPrompt, extraSystem, perplexityOptions);
  let data;
  try {
    data = body.phase === 'grade'
      ? parseGradeJsonFromModel(raw)
      : parseJsonFromModel(raw);
  } catch (parseErr) {
    console.error('JSON parse failed for phase', body.phase, parseErr instanceof Error ? parseErr.message : parseErr);
    console.error('Model output preview:', String(raw).slice(0, 600));
    throw new Error('המודל החזיר תשובה שאינה JSON תקין. נסו שוב בעוד רגע.');
  }

  if (!body.skipCache) {
    cacheDb.saveCachedResultAsync(body, data);
  }

  const savedCacheKey = body.skipCache ? null : cacheDb.buildCacheKey(body);

  if (!body.skipKnowledgeIngest) {
    knowledgeIngest.ingestFromGenerateResultAsync(body, data);
  }

  return {
    data: data,
    meta: {
      fromCache: false,
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
  return res.status(statusCode).json(payload);
}

/** Legacy Node (req, res) handler — used by dev-server.js locally. */
async function legacyHandler(req, res) {
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
    const result = await executeGenerate(body, apiKey);
    const payload = result && result.data !== undefined
      ? { data: result.data, meta: result.meta || { fromCache: false } }
      : { data: result, meta: { fromCache: false } };
    return sendJson(res, 200, payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const statusCode = e && e.statusCode ? e.statusCode : 500;
    console.error(message);
    return sendJson(res, statusCode, { error: message });
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
    const result = await executeGenerate(body, apiKey);
    const payload = result && result.data !== undefined
      ? { data: result.data, meta: result.meta || { fromCache: false } }
      : { data: result, meta: { fromCache: false } };
    return Response.json(payload, { status: 200, headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const statusCode = e && e.statusCode ? e.statusCode : 500;
    console.error(message);
    return Response.json({ error: message }, { status: statusCode, headers });
  }
}

module.exports = { fetch: fetchHandler, legacyHandler };
