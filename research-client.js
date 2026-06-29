/**
 * Browser-side Waldorf research — direct Perplexity API (static hosting / Netlify Drop).
 * TEMPORARY: prompt logic mirrored from api/generate.js.
 */
(function (global) {
  'use strict';

  const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
  const PERPLEXITY_MODEL = 'sonar-reasoning-pro';

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
    'FOR INSPIRATION: run broad open-web searches combining the block topic, current grade, and Waldorf/anthroposophic pedagogy.\n' +
    'NEVER invent URLs or append ?s= / index.asp paths — include url ONLY when copied verbatim from live search citations.\n' +
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
    'PINTEREST VISUAL INSPIRATION (WALDORF PEDAGOGY ONLY — QUALITY OVER QUANTITY):\n' +
    'Return at most 2–4 highly vetted gallery entries. If only 2 perfect matches exist, return 2 — NEVER pad with generic clutter.\n' +
    'STRICT GRADE-TOPIC ISOLATION (NON-NEGOTIABLE): Every "pin" MUST pair the Waldorf pedagogical anchor with the ACTIVE grade only.\n' +
    'BILINGUAL SEARCH ANCHORING — Pinterest pins MUST be clean, unquoted ENGLISH only (NEVER Hebrew exact-match quotes).\n' +
    'Transform Hebrew topics to English educational keywords. Example: «המהפכה הצרפתית כיתה ח» → Waldorf Class 8 revolutions.\n' +
    'Template: Waldorf Class N {englishTopic} — no quotation marks, max 2–4 keywords.\n' +
    'FORBIDDEN: Hebrew quoted pins, pins mentioning any other grade, bare topic-only queries, coloring pages, commercial stationery.\n' +
    'BILINGUAL FALLBACK — map niche Hebrew terms to grade-paired English queries:\n' +
    '- "רישום צורה" → Waldorf Class N form drawing\n' +
    '- "ציור גיר" → Waldorf Class N blackboard drawing\n' +
    '- "מחברת תקופה" → Waldorf Class N main lesson book\n' +
    'Each "pin" MUST be a SHORT search of at most 2–4 high-impact keywords — never one long concatenated string.\n' +
    'Hebrew board titles may be descriptive; "pin" phrases must stay short, grade-locked, and Waldorf-anchored in English.\n' +
    'WALDORF PEDAGOGICAL WEB RESOURCES: open web search for verified Waldorf articles — return empty array if none found.\n' +
    '=== END SOURCES, CITATIONS & VISUAL INSPIRATION ===\n';

  const WALDORF_PEDAGOGICAL_WEB_RESOURCES_INSTRUCTION =
    '\n=== WALDORF PEDAGOGICAL WEB RESOURCES (MANDATORY) ===\n' +
    (typeof WaldorfWebSeed !== 'undefined' && WaldorfWebSeed.ANTI_URL_HALLUCINATION_INSTRUCTION
      ? WaldorfWebSeed.ANTI_URL_HALLUCINATION_INSTRUCTION
      : 'NEVER invent static URLs for Waldorf resources — include url ONLY from live search citations.\n') +
    'Discover verified HTTPS links via open web search — NOT generic education pages.\n' +
    'Use dynamic queries from block topic + grade + Waldorf pedagogy. Do NOT restrict to specific websites or site: operators.\n' +
    'STRICT FILTER: link must match BOTH active subject AND Waldorf/anthroposophic pedagogical context.\n' +
    'If live search returns zero verified deep links, return an empty pedagogicalResources array.\n' +
    'Output pedagogicalResources: [{ title, url, label, source, snippet }] — URLs allowed ONLY in this array, ONLY when verbatim from citations.\n' +
    'Labels: מאמר פדגוגי | מערך שיעור מאתר בית ספר | מקור וולדורף רשמי | כתב עת פדגוגי | מדריך תקופה וולדורפית.\n' +
    '=== END WALDORF PEDAGOGICAL WEB RESOURCES ===\n';

  function getWaldorfWebSeed() {
    if (typeof WaldorfWebSeed !== 'undefined' && WaldorfWebSeed) return WaldorfWebSeed;
    return null;
  }

  function getQueryGen() {
    if (typeof WaldorfQueryGeneration !== 'undefined' && WaldorfQueryGeneration) return WaldorfQueryGeneration;
    return null;
  }

  const PINTEREST_MAX_GALLERY_ITEMS = 4;

  function buildStrictPinterestQuery(rawPin, topic, body) {
    var qg = getQueryGen();
    if (qg) return qg.buildPinterestSearchQuery(rawPin, topic, body);
    return '';
  }

  function passesStrictPinterestItemFilter(item, body) {
    var qg = getQueryGen();
    if (qg) return qg.passesStrictPinterestItemFilter(item, body);
    return false;
  }

  function hasMismatchedGradeInText(text, body) {
    var qg = getQueryGen();
    if (qg) return qg.hasMismatchedGradeInText(text, body);
    return false;
  }

  function sanitizePinterestGalleryItem(item, body, topic) {
    var qg = getQueryGen();
    if (qg) return qg.sanitizePinterestGalleryItem(item, body, topic);
    return null;
  }

  function sanitizePinterestGallery(gallery, body) {
    var qg = getQueryGen();
    if (qg) return qg.sanitizePinterestGallery(gallery, body, PINTEREST_MAX_GALLERY_ITEMS);
    return [];
  }

  const LAZY_LOAD_NOTE =
    'Do NOT include expansion, contentExpansion, artExpansion, or nested practical-expansion objects — expansions load on-demand via pedagogy_deep_dive.\n';

  // Prompt + parse helpers — keep in sync with api/generate.js
  function waldorfSystemPrompt(extra) {
    return (
      'You are an expert Waldorf / Steiner-Waldorf pedagogy researcher and curriculum designer. ' +
      'Use live web search to gather broad, high-quality educational and pedagogical material for every query. ' +
      STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
      WEB_SEARCH_PRIORITY_INSTRUCTION +
      FACTUAL_INTEGRITY_INSTRUCTION +
      ACADEMIC_TONE_INSTRUCTION +
      SOURCES_CITATION_INSTRUCTION +
      WALDORF_PEDAGOGICAL_WEB_RESOURCES_INSTRUCTION +
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

  function stripMarkdownJsonFences(text) {
    let raw = String(text || '').replace(/^\uFEFF/, '').trim();
    const fenced = raw.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
    if (fenced) raw = fenced[1].trim();
    else {
      raw = raw.replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/```\s*$/gi, '').trim();
    }
    raw = raw.replace(/^json\s*:/i, '').trim();
    if (/^["'\u201c\u201d]/.test(raw) && /["'\u201c\u201d]\s*$/.test(raw)) {
      const unwrapped = raw.replace(/^["'\u201c\u201d]+/, '').replace(/["'\u201c\u201d]+\s*$/, '').trim();
      if (unwrapped.indexOf('{') >= 0 || unwrapped.indexOf('[') >= 0) raw = unwrapped;
    }
    return raw;
  }

  function normalizeJsonSmartQuotes(raw) {
    return String(raw || '').replace(/[\u201c\u201d\u05f4]/g, '"').replace(/[\u2018\u2019\u05f3]/g, "'");
  }

  function extractJsonPayload(raw) {
    if (!raw) return '';
    const text = String(raw);
    const objStart = text.indexOf('{');
    const arrStart = text.indexOf('[');
    let start = -1;
    let openChar = '{';
    let closeChar = '}';
    if (objStart >= 0 && (arrStart < 0 || objStart <= arrStart)) start = objStart;
    else if (arrStart >= 0) { start = arrStart; openChar = '['; closeChar = ']'; }
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
      else if (c === closeChar) { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    const end = text.lastIndexOf(closeChar);
    return end > start ? text.slice(start, end + 1) : text.slice(start);
  }

  function repairUnescapedInnerQuotesInJsonStrings(raw) {
    if (!raw) return '';
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inString) {
        if (escaped) { result += c; escaped = false; continue; }
        if (c === '\\') { result += c; escaped = true; continue; }
        if (c === '"') {
          let j = i + 1;
          while (j < raw.length && /[\s\n\r\t]/.test(raw[j])) j++;
          const next = raw[j];
          if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
            inString = false; result += c;
          } else { result += "'"; }
          continue;
        }
        result += c; continue;
      }
      if (c === '"') { inString = true; result += c; continue; }
      result += c;
    }
    return result;
  }

  function repairJsonStringLiterals(raw) {
    if (!raw) return '';
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inString) {
        if (escaped) { result += c; escaped = false; continue; }
        if (c === '\\') { result += c; escaped = true; continue; }
        if (c === '"') { inString = false; result += c; continue; }
        if (c === '\r') { if (raw[i + 1] === '\n') i++; result += '\\n'; continue; }
        if (c === '\n') { result += '\\n'; continue; }
        if (c === '\t') { result += '\\t'; continue; }
        const code = c.charCodeAt(0);
        if (code < 0x20) { result += '\\u' + ('000' + code.toString(16)).slice(-4); continue; }
        result += c; continue;
      }
      if (c === '"') { inString = true; result += c; continue; }
      result += c;
    }
    return result;
  }

  function repairJsonText(raw) {
    let text = String(raw || '');
    text = text.replace(/,\s*([}\]])/g, '$1');
    text = text.replace(/([{\[])\s*,+/g, '$1');
    text = text.replace(/,\s*,+/g, ',');
    text = text.replace(/:\s*,/g, ': null,');
    text = text.replace(/:\s*undefined\b/g, ': null');
    text = text.replace(/:\s*NaN\b/g, ': null');
    text = text.replace(/:\s*-?Infinity\b/g, ': null');
    text = text.replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(\s*:)/g, '$1"$2"$3');
    return repairJsonStringLiterals(text);
  }

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
      else if ((ch === '}' || ch === ']') && closers.length && closers[closers.length - 1] === ch) closers.pop();
    }
    if (escaped) s = s.slice(0, -1);
    if (inString) s += '"';
    s = s.replace(/:\s*$/u, ': null');
    s = s.replace(/,\s*$/u, '');
    if (closers.length && closers[closers.length - 1] === '}') s = s.replace(/,\s*"([^"\\]|\\.)*"\s*$/u, '');
    while (closers.length) s += closers.pop();
    return s;
  }

  function parseJsonLenient(text) {
    const attempts = buildJsonParseAttempts(text);
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      try { return JSON.parse(attempts[i]); } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('Invalid JSON from model');
  }

  function unwrapParsedModelPayload(parsed) {
    if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object' &&
        !parsed.gradeInsights && !parsed.blockPlan && !parsed.webResearch && !parsed.pedagogyDeepDive) {
      return parsed.data;
    }
    return parsed;
  }

  function buildJsonParseAttempts(text) {
    const stripped = stripMarkdownJsonFences(text);
    const normalized = normalizeJsonSmartQuotes(stripped);
    const extracted = extractJsonPayload(normalized) || normalized;
    const quoteFixed = repairUnescapedInnerQuotesInJsonStrings(extracted);
    const literalFixed = repairJsonText(extracted);
    const quoteAndLiteral = repairJsonText(quoteFixed);
    const cores = [extracted, quoteFixed, literalFixed, quoteAndLiteral,
      repairTruncatedJson(extracted), repairTruncatedJson(quoteFixed),
      repairTruncatedJson(literalFixed), repairTruncatedJson(quoteAndLiteral)];
    const seen = new Set();
    const attempts = [];
    for (let i = 0; i < cores.length; i++) {
      if (!cores[i] || seen.has(cores[i])) continue;
      seen.add(cores[i]); attempts.push(cores[i]);
    }
    return attempts;
  }

  function modelTextToHtml(text) {
    const plain = stripMarkdownJsonFences(text);
    const html = String(plain || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n\n+/g, '</p><p>')
      .replace(/\n/g, '<br>');
    return '<p>' + (html || 'לא ניתן לעבד את תשובת המודל.') + '</p>';
  }

  function buildParseFallback(phase, rawText, context) {
    const ctx = context || {};
    const plain = stripMarkdownJsonFences(rawText);
    const wrap = modelTextToHtml(rawText);
    if (phase === 'grade') {
      return {
        gradeInsights: {
          part1AgePictureHtml: wrap,
          part1DevelopmentBullets: [],
          archivesSynthesisHtml: '',
          developmentBullets: [],
          part2ClassroomIdeasHtml: '',
          part2ClassroomIdeas: [],
          part3CommunityExpansionsHtml: '',
          part3CommunityIdeas: [],
          globalCurricula: [],
          typicalBlocks: [],
          sources: [],
        },
        teacherSummaries: [],
        _parseFallback: true,
      };
    }
    if (phase === 'topic') {
      const topic = String(ctx.topic || '').trim();
      return {
        webResearch: { topic: topic, summary: plain.slice(0, 2000), connections: [], highlights: [] },
        blockPlan: {
          theory: { title: topic || 'תוכן שנוצר', sections: [{ heading: 'סיכום', icon: 'fa-compass', content: wrap, quotes: [] }] },
        },
        _parseFallback: true,
      };
    }
    if (phase === 'pedagogy_deep_dive') {
      return { pedagogyDeepDive: { title: String(ctx.activityTitle || ''), contentHtml: wrap }, _parseFallback: true };
    }
    if (phase === 'archive_summary') {
      return { archiveSummary: { title: String(ctx.sourceTitle || ''), summaryHtml: wrap }, _parseFallback: true };
    }
    if (phase === 'drive') {
      return { driveMerge: { summary: plain.slice(0, 2000) }, _parseFallback: true };
    }
    if (phase === 'test') {
      return { ok: true, message: plain || 'fallback', _parseFallback: true };
    }
    return { rawText: plain, _parseFallback: true };
  }

  function cleanAndParseJSON(text, options) {
    const opts = options || {};
    const phase = opts.phase;
    const context = opts.context || {};
    const fallbackOnError = opts.fallbackOnError !== false;
    const raw = String(text || '');
    if (!raw.trim()) {
      if (fallbackOnError && phase) return buildParseFallback(phase, '', context);
      throw new Error('Empty model response');
    }
    try {
      return unwrapParsedModelPayload(parseJsonLenient(raw));
    } catch (err) {
      if (fallbackOnError && phase) return buildParseFallback(phase, raw, context);
      throw err;
    }
  }

  function parseJsonFromModel(text, options) {
    return cleanAndParseJSON(text, options);
  }

  function parseGradeJsonFromModel(text) {
    return parseJsonFromModel(text);
  }

  function buildUserPrompt(body) {
    const phase = body.phase;
    if (phase === 'test') {
      return 'Return JSON only: {"ok":true,"message":"אישור קצר בעברית שהחיבור עובד"}';
    }
    if (phase === 'grade') {
      const gradeExtra = body.gradePrompt ? '\nGRADE INSIGHTS INSTRUCTIONS (MANDATORY):\n' + body.gradePrompt + '\n' : '';
      const noUrls = body.noUrlsInstruction ? '\nNO URLS:\n' + body.noUrlsInstruction + '\n' : '\nDo NOT include internet URLs in sources or HTML.\n';
      return buildGradeLockBlock(body) + buildLanguageBlock(body) + buildNoLatexBlock(body) + noUrls + gradeExtra +
        WEB_SEARCH_PRIORITY_INSTRUCTION +
        'Perform live web research on Waldorf/Steiner anthroposophic child development for:\n' +
        'currentGrade: ' + resolvedGradeId(body) + '\nGrade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\n\n' +
        'All insights MUST match currentGrade only — never mix content from other grades.\nProduce inspiring content — keep response fast. Uniform 16px text in UI.\n' +
        LAZY_LOAD_NOTE + JSON_ONLY_INSTRUCTION + JSON_RESPONSE_ENFORCEMENT + '\nReturn JSON only — reply MUST start with { and end with }:\n{"gradeInsights":{"part1AgePictureHtml":"<p>Rich Hebrew HTML</p>","part1DevelopmentBullets":["bullets"],"archivesSynthesisHtml":"<p>synthesis</p>","developmentBullets":["bullets"],"part2ClassroomIdeasHtml":"<p>ideas</p>","part2ClassroomIdeas":[{"title":"Hebrew","detail":"paragraph"}],"part3CommunityExpansionsHtml":"<p>community</p>","part3CommunityIdeas":[{"title":"Hebrew","detail":"paragraph"}],"globalCurricula":["bullets"],"typicalBlocks":["blocks"],"sources":["names only"]},"teacherSummaries":[{"author":"שם","title":"כותרת","body":"2-3 משפטים"}]}\n' +
        'Provide exactly 3 teacherSummaries.';
    }
    if (phase === 'topic') {
      const topic = (body.topic || '').replace(/"/g, '');
      const theoryExtra = body.theoryPrompt ? '\nTHEORY ESSENCE INSTRUCTIONS:\n' + body.theoryPrompt + '\n' : '';
      const noUrls = body.noUrlsInstruction ? '\nNO URLS (MANDATORY):\n' + body.noUrlsInstruction + '\n' : '\nDo NOT include internet URLs, hyperlinks, or [N] reference brackets.\n';
      return buildGradeLockBlock(body) + buildLanguageBlock(body) + buildNoLatexBlock(body) + noUrls +
        LAZY_LOAD_NOTE +
        'Synthesize PERPLEXITY WEB RESEARCH into Waldorf TOPIC ESSENCE ONLY for currentGrade ' + resolvedGradeId(body) +
        '\nGrade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\nBlock topic: «' + topic + '»\nGrade context: ' + (body.gradeContext || '') + '\n' +
        theoryExtra +
        'FORBIDDEN: inspiration, curriculum/daily breakdown, bibliography, sources, gallery, URLs, [1][4] brackets.\n' +
        'Deep resources load on-demand via pedagogy_deep_dive.\n' +
        JSON_ONLY_INSTRUCTION + JSON_RESPONSE_ENFORCEMENT + '\nReturn JSON only — reply MUST start with { and end with }:\n' +
        '{\n' +
        '  "webResearch": { "topic": "' + topic + '", "summary": "Rich Hebrew paragraph", "connections": ["Hebrew"], "highlights": ["Hebrew"] },\n' +
        '  "blockPlan": { "theory": { "title": "Hebrew", "sections": [{ "heading": "Hebrew", "icon": "fa-compass", "content": "<p>Rich Hebrew HTML essence</p>", "quotes": [] }] } }\n' +
        '}\n' +
        'blockPlan MUST contain ONLY theory — no other keys.';
    }
    if (phase === 'pedagogy_deep_dive') {
      const title = (body.activityTitle || '').replace(/"/g, "'");
      const preview = (body.activityPreview || '').replace(/"/g, "'");
      const expand = body.expandInstruction || 'הרחב לפעילות כיתתית מלאה.';
      return buildGradeLockBlock(body) + buildLanguageBlock(body) + buildNoLatexBlock(body) +
        "Expand a Waldorf teacher's pedagogical suggestion.\nTitle: «" + title + '»\nPreview: ' + preview + '\nEXPAND: ' + expand + '\n' +
        WEB_SEARCH_PRIORITY_INSTRUCTION + JSON_ONLY_INSTRUCTION + '\nReturn JSON: {"pedagogyDeepDive":{...}}';
    }
    if (phase === 'drive') {
      return buildGradeLockBlock(body) + buildLanguageBlock(body) + buildNoLatexBlock(body) +
        'currentGrade: ' + resolvedGradeId(body) + '\nTeacher Drive scan for «' + body.topic + '» in ' + body.gradeLabel + '.\nFiles: ' + (body.personalFiles || []).join('; ') + '\n' +
        JSON_ONLY_INSTRUCTION + '\nReturn JSON: {"driveMerge":{...}}';
    }
    if (phase === 'archive_summary') {
      const title = (body.sourceTitle || '').replace(/"/g, "'");
      const isPedagogy = Boolean(body.pedagogyDeepDive);
      const noUrls = body.noUrlsInstruction ? '\nNO URLS:\n' + body.noUrlsInstruction + '\n' : '\nDo NOT include URLs.\n';
      return buildGradeLockBlock(body) + buildLanguageBlock(body) + buildNoLatexBlock(body) + noUrls +
        'Deep pedagogical summary for: «' + title + '»\nAuthor: ' + (body.sourceAuthor || '') + '\n' +
        WEB_SEARCH_PRIORITY_INSTRUCTION + JSON_ONLY_INSTRUCTION + '\nReturn JSON: ' + (isPedagogy ? '{"pedagogyDeepDive":{...}}' : '{"archiveSummary":{...}}');
    }
    throw new Error('Unknown phase');
  }

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

  function validatePhaseResult(phase, data, body) {
    if (!data || typeof data !== 'object') return false;
    if (phase === 'grade') return Boolean(data.gradeInsights && typeof data.gradeInsights === 'object');
    if (phase === 'topic') {
      const bp = data.blockPlan;
      if (bp && String(bp.rawContent || '').trim()) return true;
      if (!bp || typeof bp !== 'object' || !bp.theory) return false;
      const sections = bp.theory.sections;
      return Array.isArray(sections) && sections.some(function (sec) {
        return sec && String(sec.content || '').trim();
      });
    }
    if (phase === 'pedagogy_deep_dive') return Boolean(data.pedagogyDeepDive);
    if (phase === 'archive_summary') return Boolean(data.archiveSummary || data.pedagogyDeepDive);
    if (phase === 'drive') return Boolean(data.driveMerge);
    if (phase === 'test') return data.ok === true;
    return true;
  }

  async function callPerplexity(apiKey, userPrompt, extraSystem, options) {
    const fetchInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        temperature: 0.35,
        messages: [
          { role: 'system', content: waldorfSystemPrompt(extraSystem) },
          { role: 'user', content: userPrompt },
        ],
      }),
    };
    if (options && options.signal) fetchInit.signal = options.signal;
    let res;
    try {
      res = await fetch(PERPLEXITY_URL, fetchInit);
    } catch (netErr) {
      throw new Error('שגיאת רשת בחיבור ל-Perplexity: ' + (netErr.message || netErr));
    }
    let responseText = '';
    try {
      responseText = await res.text();
    } catch (readErr) {
      throw new Error('לא ניתן לקרוא את תשובת Perplexity: ' + (readErr.message || readErr));
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error('Perplexity API key invalid or unauthorized (HTTP ' + res.status + ').');
      }
      throw new Error('Perplexity API ' + res.status + ': ' + responseText.slice(0, 400));
    }
    let data;
    try { data = responseText ? JSON.parse(responseText) : null; }
    catch (e) { throw new Error('Perplexity API returned non-JSON: ' + responseText.slice(0, 200)); }
    const content = extractPerplexityMessageContent(data);
    if (!content) throw new Error('Perplexity החזיר תשובה ריקה — נסו שוב בעוד רגע.');
    return content;
  }

  async function executeGenerate(body, apiKey, options) {
    if (!body || !body.phase) throw new Error('Missing phase');
    const gradeLockSystem = resolvedGradeId(body) || body.gradeLabel
      ? ' CRITICAL: currentGrade is locked — never mix pedagogical content from other grades.' : '';
    const searchPhases = new Set(['grade', 'topic', 'pedagogy_deep_dive', 'archive_summary']);
    const extraSystem = gradeLockSystem +
      (body.phase === 'grade' || body.phase === 'topic'
        ? ' CRITICAL JSON OUTPUT: Reply with raw JSON only — first character {, last character }. No ```json fences, no Hebrew/English preamble.'
        : '') +
      (searchPhases.has(body.phase)
      ? ' Perform a broad internet search for general educational and pedagogical answers.'
      : '');
    const userPrompt = buildUserPrompt(body);
    let raw;
    try {
      raw = await callPerplexity(apiKey, userPrompt, extraSystem, options);
    } catch (aiErr) {
      throw new Error(aiErr instanceof Error ? aiErr.message : String(aiErr));
    }
    try {
      const parsed = cleanAndParseJSON(raw, {
        phase: body.phase,
        context: body,
        fallbackOnError: true,
      });
      if (!validatePhaseResult(body.phase, parsed, body) && !parsed._parseFallback) {
        return buildParseFallback(body.phase, raw, body);
      }
      return parsed;
    } catch (parseErr) {
      console.warn('[research-client] parse fallback:', parseErr instanceof Error ? parseErr.message : parseErr);
      return buildParseFallback(body.phase, raw, body);
    }
  }

  async function run(payload, apiKey, options) {
    if (!apiKey || !String(apiKey).trim()) throw new Error('Perplexity API key is not configured.');
    return executeGenerate(payload, String(apiKey).trim(), options || {});
  }

  global.WaldorfResearchClient = {
    run: run,
    sanitizePinterestGallery: sanitizePinterestGallery,
    sanitizePinterestGalleryItem: sanitizePinterestGalleryItem,
    buildStrictPinterestQuery: buildStrictPinterestQuery,
    passesStrictPinterestItemFilter: passesStrictPinterestItemFilter,
    hasMismatchedGradeInText: hasMismatchedGradeInText,
    PINTEREST_MAX_GALLERY_ITEMS: PINTEREST_MAX_GALLERY_ITEMS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
