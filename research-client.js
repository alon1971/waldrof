/**
 * Browser-side Waldorf research — direct Perplexity API (static hosting / Netlify Drop).
 * TEMPORARY: prompt logic mirrored from api/generate.js.
 */
(function (global) {
  'use strict';

  const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
  const PERPLEXITY_MODEL = 'sonar-pro';

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

  const LAZY_LOAD_NOTE =
    'Do NOT include expansion, contentExpansion, artExpansion, or nested practical-expansion objects — expansions load on-demand via pedagogy_deep_dive.\n';

  // Prompt + parse helpers — keep in sync with api/generate.js
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
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    return raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  function normalizeJsonSmartQuotes(raw) {
    return String(raw || '').replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019\u05f3]/g, "'");
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
    const stripped = stripMarkdownJsonFences(text);
    try { return JSON.parse(stripped); } catch (e) { return JSON.parse(repairTruncatedJson(stripped)); }
  }

  function unwrapParsedModelPayload(parsed) {
    if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object' &&
        !parsed.gradeInsights && !parsed.blockPlan && !parsed.webResearch && !parsed.archiveSearch && !parsed.pedagogyDeepDive) {
      return parsed.data;
    }
    return parsed;
  }

  function buildGradeJsonParseAttempts(text) {
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

  function parseGradeJsonFromModel(text) {
    if (!text || !String(text).trim()) throw new Error('Empty model response');
    const attempts = buildGradeJsonParseAttempts(text);
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      try { return unwrapParsedModelPayload(JSON.parse(attempts[i])); } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('Invalid JSON from model');
  }

  function parseJsonFromModel(text) {
    if (!text || !String(text).trim()) throw new Error('Empty model response');
    return unwrapParsedModelPayload(parseJsonLenient(text));
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
        LAZY_LOAD_NOTE + JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n{"gradeInsights":{"part1AgePictureHtml":"<p>Rich Hebrew HTML</p>","part1DevelopmentBullets":["bullets"],"archivesSynthesisHtml":"<p>synthesis</p>","developmentBullets":["bullets"],"part2ClassroomIdeasHtml":"<p>ideas</p>","part2ClassroomIdeas":[{"title":"Hebrew","detail":"paragraph"}],"part3CommunityExpansionsHtml":"<p>community</p>","part3CommunityIdeas":[{"title":"Hebrew","detail":"paragraph"}],"globalCurricula":["bullets"],"typicalBlocks":["blocks"],"sources":["names only"]},"teacherSummaries":[{"author":"שם","title":"כותרת","body":"2-3 משפטים"}]}\n' +
        'Provide exactly 3 teacherSummaries.';
    }
    if (phase === 'topic') {
      const topic = (body.topic || '').replace(/"/g, '');
      const theoryExtra = body.theoryPrompt ? '\nTHEORY TAB INSTRUCTIONS:\n' + body.theoryPrompt + '\n' : '';
      const inspirationExtra = body.inspirationPrompt ? '\nINSPIRATION TAB INSTRUCTIONS:\n' + body.inspirationPrompt + '\n' : '';
      const curriculumExtra = body.curriculumPrompt ? '\nCURRICULUM TAB INSTRUCTIONS:\n' + body.curriculumPrompt + '\n' : '';
      const bibExtra = body.bibliographyRequirements ? '\nBIBLIOGRAPHY REQUIREMENTS (MANDATORY):\n' + body.bibliographyRequirements + '\n' : '';
      const pedagogyHint = body.pedagogyExpandHint ? '\nINSPIRATION & CURRICULUM FORMAT:\n' + body.pedagogyExpandHint + '\n' : '';
      const noUrls = body.noUrlsInstruction ? '\nNO URLS (MANDATORY):\n' + body.noUrlsInstruction + '\n' : '\nDo NOT include internet URLs.\n';
      return buildGradeLockBlock(body) + buildLanguageBlock(body) + buildNoLatexBlock(body) + noUrls +
        'Live web research: Waldorf main lesson block planning.\ncurrentGrade: ' + resolvedGradeId(body) +
        '\nGrade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\nBlock topic: «' + topic + '»\nGrade context: ' + (body.gradeContext || '') + '\n' +
        theoryExtra + inspirationExtra + curriculumExtra + bibExtra + pedagogyHint + WEB_SEARCH_PRIORITY_INSTRUCTION +
        'Every field in blockPlan MUST be written for currentGrade only.\n' +
        'CRITICAL — blockPlan.curriculum MUST be a JSON ARRAY (not an object) of exactly 15 day objects.\n' +
        'Each day object MUST use these exact keys: "day" (number 1–15), "topic" (Hebrew string), "content" (4–6 Hebrew sentences), "art" (2–4 Hebrew sentences on art/craft), "hint" (optional Hebrew string).\n' +
        'Do NOT nest curriculum under days/items/lessons — use blockPlan.curriculum as a flat array.\n' +
        LAZY_LOAD_NOTE + JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n' +
        '{\n' +
        '  "webResearch": {\n' +
        '    "topic": "' + topic + '",\n' +
        '    "summary": "Rich Hebrew paragraph",\n' +
        '    "connections": ["Hebrew phrases tied to currentGrade"],\n' +
        '    "highlights": ["Hebrew highlights for this grade only"]\n' +
        '  },\n' +
        '  "blockPlan": {\n' +
        '    "theory": { "title": "Hebrew", "sections": [{ "heading": "Hebrew", "icon": "fa-compass", "content": "<p>Rich Hebrew HTML</p>", "quotes": [] }], "bibliography": { "books": [], "articles": [], "websites": [] } },\n' +
        '    "inspiration": { "title": "Hebrew", "global": [{ "title": "Hebrew", "items": ["paragraph"] }], "podcast": { "title": "Hebrew", "episodes": [{ "theme": "Hebrew", "insight": "paragraph" }] }, "narrative": ["paragraph"] },\n' +
        '    "curriculum": [\n' +
        '      { "day": 1, "topic": "Hebrew day title", "content": "4-6 Hebrew sentences", "art": "2-4 Hebrew sentences", "hint": "optional" },\n' +
        '      { "day": 2, "topic": "Hebrew", "content": "...", "art": "...", "hint": "" }\n' +
        '    ]\n' +
        '  },\n' +
        '  "gallery": [{ "board": "Hebrew", "title": "Hebrew", "pin": "Pinterest search phrase", "src": "" }]\n' +
        '}\n' +
        'curriculum array MUST contain exactly 15 entries (days 1 through 15) with distinct topics and rich Hebrew content.\n' +
        'gallery MUST include 4–8 Pinterest visual inspiration entries.';
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
    if (phase === 'archive_search') {
      const q = (body.archiveQuery || '').replace(/"/g, "'");
      return buildGradeLockBlock(body) + buildLanguageBlock(body) + buildNoLatexBlock(body) +
        'Live web search: Anthroposophic archive.\nQuery: «' + q + '»\nGrade: ' + (body.gradeLabel || '') + '\n' +
        WEB_SEARCH_PRIORITY_INSTRUCTION + JSON_ONLY_INSTRUCTION + '\nReturn JSON: {"archiveSearch":{"query":"' + q + '","intro":"Hebrew","sources":[...]}}';
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
    const res = await fetch(PERPLEXITY_URL, fetchInit);
    const responseText = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error('Perplexity API key invalid or unauthorized (HTTP ' + res.status + ').');
      }
      throw new Error('Perplexity API ' + res.status + ': ' + responseText.slice(0, 400));
    }
    let data;
    try { data = responseText ? JSON.parse(responseText) : null; }
    catch (e) { throw new Error('Perplexity API returned non-JSON: ' + responseText.slice(0, 200)); }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('No content in Perplexity response');
    return content;
  }

  async function executeGenerate(body, apiKey, options) {
    if (!body || !body.phase) throw new Error('Missing phase');
    const gradeLockSystem = resolvedGradeId(body) || body.gradeLabel
      ? ' CRITICAL: currentGrade is locked — never mix pedagogical content from other grades.' : '';
    const searchPhases = new Set(['grade', 'topic', 'pedagogy_deep_dive', 'archive_search', 'archive_summary']);
    const extraSystem = gradeLockSystem + (searchPhases.has(body.phase)
      ? ' Perform a broad internet search for general educational and pedagogical answers.'
      : '');
    const userPrompt = buildUserPrompt(body);
    const raw = await callPerplexity(apiKey, userPrompt, extraSystem, options);
    try {
      return body.phase === 'grade' ? parseGradeJsonFromModel(raw) : parseJsonFromModel(raw);
    } catch (parseErr) {
      throw new Error('המודל החזיר תשובה שאינה JSON תקין. נסו שוב בעוד רגע.');
    }
  }

  async function run(payload, apiKey, options) {
    if (!apiKey || !String(apiKey).trim()) throw new Error('Perplexity API key is not configured.');
    return executeGenerate(payload, String(apiKey).trim(), options || {});
  }

  global.WaldorfResearchClient = { run: run };
})(typeof window !== 'undefined' ? window : globalThis);
