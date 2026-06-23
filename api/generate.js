/**
 * Waldorf research API — strict Perplexity / Gemini separation.
 * PERPLEXITY_API_KEY: ALL core generation (Phase A grade, Phase B topic, Phase C tabs, on-demand expansions).
 * GEMINI_API_KEY: pedagogical chat + enrichment_links (Gemini Google Search) ONLY.
 * enrichment_links (phase_c inspiration): Gemini live search + dynamic Pinterest — no hardcoded domains.
 *
 * Core pipeline (decoupled — Perplexity only):
 *   1. SUPABASE ARCHIVE — return cached_results immediately on hit
 *   2. LIVE WEB SEARCH (Perplexity Sonar) — raw research saved to cached_results (phase perplexity_raw)
 *   3. PERPLEXITY SYNTHESIS (sonar-pro) — structured JSON → cached_results
 *   Phase B (topic / phase_b): theory essence only. Phase C (phase_c + cTab): independent inspiration or curriculum per tab.
 *   On-demand expansions (pedagogy_deep_dive / archive_summary): independent Perplexity Sonar routes per button.
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
const jsonRepair = require('./json-repair');
const env = require('./env');
const perplexityClient = require('./perplexity-client');
const chatApi = require('./chat');
const pedagogicalScope = require('./pedagogical-scope');
const waldorfWebSeed = require('../waldorf-web-seed');
const enrichmentLinksApi = require('./enrichment-links');
const geminiEnrichment = require('./gemini-enrichment');
const waldorfQueryGen = require('../waldorf-query-generation');
const archiveCoerce = require('../archive-coerce');

/** Grade/topic: cache-first from Supabase; on miss run Perplexity-only pipeline. */
const ARCHIVE_ONLY_MODE = process.env.ARCHIVE_ONLY !== 'false';

const {
  cleanAndParseJSON,
  parseJsonLenient,
  parseJsonFromModel,
  unwrapParsedModelPayload,
  buildModelParseFallback,
  stripMarkdownJsonFences,
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

/** Minimum time (ms) the HTTP route stays open for on-demand Perplexity research (pedagogy_deep_dive, archive_summary). */
const GENERATE_ROUTE_TIMEOUT_MS = Math.max(
  90000,
  Number(process.env.GENERATE_ROUTE_TIMEOUT_MS) || 120000
);

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
  'FOR INSPIRATION / PHASE C: run broad open-web searches combining the block topic, current grade, and Waldorf/anthroposophic pedagogy — ' +
  'then collect HTTPS deep links ONLY when verbatim from live citations.\n' +
  'NEVER invent static URLs or site-restricted search URLs — return empty link arrays when live search yields no verified URLs.\n' +
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

const CHAT_NO_COMMUNITY_MATCH_OPENING_HE =
  'לא מצאתי תוכן תואם במאגר הקהילתי, אך הנה הצעה פדגוגית כללית עבורך:';

const PEDAGOGICAL_CHAT_GROUNDING_INSTRUCTION =
  '\n=== PEDAGOGICAL CHAT — GEMINI KNOWLEDGE BASE (MANDATORY) ===\n' +
  'You are the Pedagogical Chat Assistant for Waldorf / Steiner-Waldorf teachers — a supportive, highly accurate pedagogical peer.\n' +
  'This chat pipeline is DECOUPLED from live web search. Do NOT perform or simulate Perplexity, Sonar, or any internet search.\n' +
  'Answer from your native Waldorf pedagogical knowledge base with practical insights and book/article recommendations.\n' +
  'NEVER open with database absence apologies or archive status commentary.\n' +
  'End every reply with: «' + chatApi.CHAT_COMMUNITY_SEARCH_RECOMMENDATION_HE + '»\n' +
  'NEVER fabricate **bold** topic headers, fake archive sections, or [1][2] citations to simulate missing database content.\n' +
  'TONE: Warm, professional, grounded in Waldorf pedagogy. Practical for classroom teachers.\n' +
  '=== END PEDAGOGICAL CHAT — GEMINI KNOWLEDGE BASE ===\n';

const COMMUNITY_FIRST_CHAT_INSTRUCTION =
  '\n=== COMMUNITY FIRST — PEDAGOGICAL CHAT OPENING (MANDATORY WHEN MATCHES EXIST) ===\n' +
  'When the COMMUNITY MATERIALS DATABASE block lists one or more matches (keyword OR semantic), ' +
  'you MUST open your Hebrew reply with the exact celebration line supplied in that block or in CRITICAL INSTRUCTION.\n' +
  'Required opening pattern (use teacher name, grade label, and matched file title from the provided blocks):\n' +
  '«[שם פרטי], הרווחת! מישהו מהקהילה העלה למאגר הקהילתי ל[כיתה] «[שם הקובץ]». אתה יכול להיכנס למאגר הקהילתי באתר, תחת [כיתה] כדי לצפות בקובץ הנוכחי.»\n' +
  'Do NOT paste raw URLs — refer to grade and subject folder in the community catalog only.\n' +
  'When NO community matches are listed, do NOT invent a celebration opening. ' +
  'Jump directly into practical Waldorf guidance — no database absence apologies.\n' +
  '=== END COMMUNITY FIRST — PEDAGOGICAL CHAT OPENING ===\n';

const CHAT_JSON_OUTPUT_INSTRUCTION =
  '\n=== CHAT OUTPUT: RAW JSON ONLY (MANDATORY) ===\n' +
  'Return ONLY one valid JSON object — nothing before or after it.\n' +
  'Required shape: { "text": "<your full Hebrew pedagogical reply>" }\n' +
  'Put the entire warm, professional, Waldorf-focused Hebrew answer inside the "text" string value ' +
  '(plain text or light Markdown allowed inside the string — use \\n for line breaks).\n' +
  'FORBIDDEN: markdown code fences (```json, ```), preamble, postamble, or any characters outside the {…} object.\n' +
  'The server runs JSON.parse() on your full reply — start with { and end with }.\n' +
  'NEVER use **bold** headings or fake archive labels as placeholders when no Supabase match exists.\n' +
  'Write 2–6 rich paragraphs inside "text" when verified sources support a full answer.\n' +
  '=== END CHAT OUTPUT ===\n';

const CHAT_NO_INVENTED_CITATIONS_INSTRUCTION =
  '\n=== CHAT — STRICT GROUNDING WHEN SUPABASE COMMUNITY CONTEXT IS EMPTY OR PARTIAL (ABSOLUTE) ===\n' +
  'You must NEVER invent, hallucinate, or generate fake bold citations or academic references ' +
  '(such as **נושא**, **מקור**, **המלצה**, numbered [1][2] markers, footnotes, or bibliography-style headings) ' +
  'as placeholders for missing data when Supabase vector search and COMMUNITY MATERIALS DATABASE return no direct matches for the user\'s question.\n' +
  'FORBIDDEN: pretending a structured list or bold topic line came from the community archive when it did not.\n' +
  'FORBIDDEN: opening with database absence apologies («לא מצאתי תוכן תואם במאגר הקהילתי…» or similar).\n' +
  'When the community database context is empty OR lacks specific matches, jump directly into warm, practical Waldorf/Steiner pedagogical guidance from your knowledge base.\n' +
  'End every reply with: «' + chatApi.CHAT_COMMUNITY_SEARCH_RECOMMENDATION_HE + '»\n' +
  'When verified community matches DO exist in the provided blocks, use the mandatory community celebration opening instead.\n' +
  '=== END CHAT — STRICT GROUNDING ===\n';

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
  '- "תקופת בנייה" → Waldorf Class N house building main lesson\n' +
  'Each "pin" MUST be a SHORT Pinterest search of at most 2–4 high-impact keywords — never one long concatenated string.\n' +
  'Generate 2–4 DISTINCT grade-locked variations only — Hebrew board titles (can be descriptive) and SHORT English "pin" phrases; no URLs required.\n' +
  'STRICTLY FORBIDDEN: long bundled queries, generic decorative boards, bare topic-only queries, wrong-grade pins, duplicate pin phrases.\n' +
  '=== END SOURCES, CITATIONS & VISUAL INSPIRATION ===\n';

const WALDORF_PEDAGOGICAL_WEB_RESOURCES_INSTRUCTION =
  '\n=== WALDORF PEDAGOGICAL WEB RESOURCES (MANDATORY — INSPIRATION / PHASE C) ===\n' +
  waldorfWebSeed.ANTI_URL_HALLUCINATION_INSTRUCTION +
  'Discover Waldorf pedagogical articles via open web search — NOT generic education blogs.\n' +
  'Use dynamic queries from block topic + grade + Waldorf pedagogy. Do NOT restrict to specific websites or site: operators.\n' +
  'STRICT CONTEXTUAL FILTER — include a link ONLY when the page matches BOTH block subject AND Waldorf pedagogical context.\n' +
  'URL RULE: include url ONLY when copied verbatim from live search citations. If none found, return an empty pedagogicalResources array.\n' +
  'OUTPUT SHAPE — top-level "pedagogicalResources" array (Phase C inspiration ONLY; URLs allowed HERE ONLY):\n' +
  'Each item: { "title": "Hebrew page title", "url": "https://…verified-deep-link-only…", "label": "…", "source": "…", "snippet": "…" }\n' +
  'Populate DISTINCT verified items only — quality over quantity. FORBIDDEN: Pinterest URLs, fabricated paths, site-restricted Google searches.\n' +
  'blockPlan.sources (books/articles/websites) remains name-only — NO url fields there.\n' +
  '=== END WALDORF PEDAGOGICAL WEB RESOURCES ===\n';

const ENRICHMENT_LINKS_MAX = enrichmentLinksApi.ENRICHMENT_LINKS_MAX;

const ENRICHMENT_LINKS_GEMINI_SEARCH_INSTRUCTION =
  '\n=== ENRICHMENT LINKS — GEMINI LIVE SEARCH (MANDATORY) ===\n' +
  'enrichment_links are assembled server-side via Gemini Google Search from dynamic topic + grade queries.\n' +
  'Article URLs must come from verified live search only — no hardcoded domains, site: operators, or model memory.\n' +
  'If search finds no verified URLs, article_links stays empty. Pinterest links are built dynamically from topic + grade.\n' +
  '=== END ENRICHMENT LINKS — GEMINI LIVE SEARCH ===\n';

const PERPLEXITY_PHASE_C_INSPIRATION_NO_LINKS_INSTRUCTION =
  '\n=== PHASE C INSPIRATION — NO SOURCES MODE (TEXT ONLY) ===\n' +
  'Do NOT generate books, articles, websites, bibliography, blockPlan.sources, enrichment_links, or pedagogicalResources.\n' +
  'Do NOT copy, transform, or merge Perplexity citation URLs into any output field.\n' +
  'FORBIDDEN: sources lists, HTTPS URLs, enrichment_links, pedagogicalResources (gallery.src must stay empty; pin = English phrase only).\n' +
  '=== END PHASE C INSPIRATION — NO SOURCES MODE ===\n';

const NO_SOURCES_MODE_INSTRUCTION =
  '\n=== NO SOURCES MODE (MANDATORY) ===\n' +
  'Do NOT generate books, websites, external links, bibliography, blockPlan.sources, or any "מקורות (Sources)" section.\n' +
  'Focus 100% on rich pedagogical narrative content only — zero sources is better than unreliable citations.\n' +
  '=== END NO SOURCES MODE ===\n';

const PEDAGOGICAL_RESOURCE_LABELS = enrichmentLinksApi.PEDAGOGICAL_RESOURCE_LABELS;

const PINTEREST_MAX_GALLERY_ITEMS = waldorfQueryGen.PINTEREST_MAX_GALLERY_ITEMS;

function buildStrictPinterestQuery(rawPin, topic, body) {
  return waldorfQueryGen.buildPinterestSearchQuery(rawPin, topic, body);
}

function passesStrictPinterestItemFilter(item, body) {
  return waldorfQueryGen.passesStrictPinterestItemFilter(item, body);
}

function hasMismatchedGradeInText(text, body) {
  return waldorfQueryGen.hasMismatchedGradeInText(text, body);
}

function sanitizePinterestGalleryItem(item, body, topic) {
  return waldorfQueryGen.sanitizePinterestGalleryItem(item, body, topic);
}

function sanitizePinterestGallery(gallery, body) {
  return waldorfQueryGen.sanitizePinterestGallery(gallery, body, PINTEREST_MAX_GALLERY_ITEMS);
}

function inferPedagogicalResourceMeta(url) {
  return enrichmentLinksApi.inferResourceMetaFromUrl(url);
}

function isWaldorfPedagogicalResourceUrl(url) {
  return enrichmentLinksApi.isVerifiedArticleUrl(url);
}

function normalizePedagogicalResourceItem(item, body) {
  if (!item || typeof item !== 'object') return null;
  const topic = String((body && body.topic) || '').trim();
  const gradeLabel = String((body && body.gradeLabel) || '').trim();
  let url = String(item.url || item.link || item.href || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  if (waldorfQueryGen.isSiteRestrictedGoogleSearchUrl && waldorfQueryGen.isSiteRestrictedGoogleSearchUrl(url)) return null;
  url = waldorfWebSeed.sanitizePedagogicalResourceUrl(url, topic, {
    topic: topic,
    gradeLabel: gradeLabel,
    verified: item._fromCitation === true || item._verified === true,
  });
  if (!url || !isWaldorfPedagogicalResourceUrl(url)) return null;
  const meta = inferPedagogicalResourceMeta(url);
  let label = String(item.label || item.type || item.category || '').trim();
  if (!PEDAGOGICAL_RESOURCE_LABELS.includes(label)) label = meta.label;
  const title = sanitizePedagogicalText(String(item.title || item.name || meta.source || '').trim());
  const snippet = sanitizePedagogicalText(String(item.snippet || item.description || item.summary || '').trim());
  return {
    title: title || meta.source,
    url: url,
    label: label,
    source: String(item.source || item.publisher || meta.source || '').trim() || meta.source,
    snippet: snippet,
  };
}

function normalizePedagogicalResources(raw, body) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
  const seen = Object.create(null);
  const out = [];
  list.forEach(function (item) {
    const norm = normalizePedagogicalResourceItem(item, body);
    if (!norm || seen[norm.url]) return;
    seen[norm.url] = true;
    out.push(norm);
  });
  return applyPedagogicalResourcesFallback(out, body);
}

function isValidPinterestSearchUrl(url) {
  return waldorfQueryGen.isValidPinterestSearchUrl(url);
}

/** Ensure enrichment pipelines always receive explicit topic + grade (including teacher override). */
function normalizeEnrichmentRequestBody(body) {
  if (!body || typeof body !== 'object') return {};
  const normalized = Object.assign({}, body);
  normalized.topic = String(
    normalized.topic || normalized.activityTitle || normalized.archiveQuery || ''
  ).trim();
  const gradeId = String(normalized.currentGrade ?? normalized.gradeId ?? '').trim();
  normalized.currentGrade = gradeId;
  normalized.gradeId = gradeId;
  if (!normalized.gradeLabel && gradeId && waldorfQueryGen.hebrewGradeLabelForId) {
    const derived = waldorfQueryGen.hebrewGradeLabelForId(gradeId);
    if (derived) normalized.gradeLabel = derived;
  }
  pedagogicalScope.normalizePedagogicalScopeOverride(normalized);
  return normalized;
}

async function attachGeminiEnrichmentLinks(data, body) {
  if (!data || typeof data !== 'object') return data;
  if (resolvePhaseCTab(body) !== 'inspiration') return data;
  delete data.enrichment_links;
  delete data.pedagogicalResources;
  if (data.blockPlan && typeof data.blockPlan === 'object') {
    delete data.blockPlan.sources;
  }
  return data;
}

/** @deprecated Use attachGeminiEnrichmentLinks */
async function attachRealtimeEnrichmentLinks(data, body) {
  return attachGeminiEnrichmentLinks(data, body);
}

async function fetchGeminiEnrichmentLinks(body) {
  return geminiEnrichment.fetchGeminiEnrichmentLinks(normalizeEnrichmentRequestBody(body));
}

/** @deprecated Use fetchGeminiEnrichmentLinks */
async function fetchRealtimeEnrichmentLinks(body) {
  const enrichmentBody = normalizeEnrichmentRequestBody(body);
  const links = await fetchGeminiEnrichmentLinks(enrichmentBody);
  if (!links || (!links.pinterest_links || !links.pinterest_links.length) &&
      (!links.article_links || !links.article_links.length)) {
    console.warn('[enrichment] fetchRealtimeEnrichmentLinks returned empty — topic:',
      enrichmentBody.topic || '(empty)', 'grade:', enrichmentBody.currentGrade || '(empty)');
  }
  return links;
}

function normalizeEnrichmentPinterestLink(item, body, geminiOnly) {
  if (!item || typeof item !== 'object') return null;
  const topic = String((body && body.topic) || '').trim();

  if (geminiOnly) {
    let url = String(item.url || '').trim();
    const queryRaw = String(item.query || item.pin || '').trim();
    if (!isValidPinterestSearchUrl(url) && queryRaw && waldorfQueryGen.buildPinterestSearchUrl) {
      url = waldorfQueryGen.buildPinterestSearchUrl(queryRaw);
    }
    if (!isValidPinterestSearchUrl(url)) {
      const galleryStub = sanitizePinterestGalleryItem({
        title: item.title,
        pin: queryRaw,
        url: item.url,
        board: item.title,
        src: '',
      }, body, topic);
      if (galleryStub) {
        url = String(galleryStub.url || '').trim();
      }
    }
    if (!isValidPinterestSearchUrl(url)) return null;
    let query = queryRaw;
    if (!query) {
      try {
        query = decodeURIComponent(String(url).split('q=')[1] || '').replace(/\+/g, ' ').trim();
      } catch (e) {
        query = '';
      }
    }
    if (hasMismatchedGradeInText(query + ' ' + url, body)) return null;
    const title = sanitizePedagogicalText(String(item.title || query || '').trim());
    return { title: title || query, url: url, query: query, pin: query };
  }

  const galleryStub = sanitizePinterestGalleryItem({
    title: item.title,
    pin: item.query || item.pin,
    url: item.url,
    board: item.title,
    src: '',
  }, body, topic);
  if (!galleryStub) return null;
  let url = String(galleryStub.url || item.url || '').trim();
  if (!isValidPinterestSearchUrl(url) && galleryStub.pin && waldorfQueryGen.buildPinterestSearchUrl) {
    url = waldorfQueryGen.buildPinterestSearchUrl(galleryStub.pin);
  }
  if (!isValidPinterestSearchUrl(url)) return null;
  const query = String(galleryStub.pin || item.query || item.pin || '').trim();
  const title = sanitizePedagogicalText(String(item.title || galleryStub.title || query || '').trim());
  return { title: title || query, url: url, query: query, pin: query };
}

function normalizeEnrichmentArticleLinkGemini(item) {
  if (!item || typeof item !== 'object') return null;
  const url = String(item.url || item.link || item.href || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  if (/pinterest\.|facebook\.com|instagram\.com|youtube\.com|tiktok\.com/i.test(url)) return null;
  if (waldorfWebSeed.isBrokenOrGuessedPedagogicalUrl(url)) return null;
  if (!isWaldorfPedagogicalResourceUrl(url)) return null;
  const meta = inferPedagogicalResourceMeta(url);
  let label = String(item.label || item.type || item.category || '').trim();
  if (!PEDAGOGICAL_RESOURCE_LABELS.includes(label)) label = meta.label;
  const title = sanitizePedagogicalText(String(item.title || item.name || meta.source || '').trim());
  return {
    title: title || meta.source,
    url: url,
    source: String(item.source || item.publisher || meta.source || '').trim() || meta.source,
    label: label,
    snippet: sanitizePedagogicalText(String(item.snippet || item.description || item.summary || '').trim()),
  };
}

function normalizeEnrichmentArticleLink(item, body, geminiOnly) {
  if (geminiOnly) return normalizeEnrichmentArticleLinkGemini(item);
  const norm = normalizePedagogicalResourceItem(item, body);
  if (!norm) return null;
  return {
    title: norm.title,
    url: norm.url,
    source: norm.source,
    label: norm.label,
    snippet: norm.snippet,
  };
}

function normalizeEnrichmentLinks(raw, body, options) {
  const geminiSearch = Boolean(options && (options.geminiSearch || options.geminiOnly));
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const seenPin = Object.create(null);
  const seenArt = Object.create(null);
  const pinterest = [];
  const articles = [];

  (Array.isArray(src.pinterest_links) ? src.pinterest_links : []).forEach(function (item) {
    const norm = normalizeEnrichmentPinterestLink(item, body, geminiSearch);
    if (!norm || seenPin[norm.url]) return;
    seenPin[norm.url] = true;
    pinterest.push(norm);
  });

  (Array.isArray(src.article_links) ? src.article_links : []).forEach(function (item) {
    const norm = normalizeEnrichmentArticleLink(item, body, geminiSearch);
    if (!norm || seenArt[norm.url]) return;
    seenArt[norm.url] = true;
    articles.push(norm);
  });

  return {
    pinterest_links: pinterest.slice(0, ENRICHMENT_LINKS_MAX),
    article_links: articles.slice(0, ENRICHMENT_LINKS_MAX),
  };
}

function applyPedagogicalResourcesFallback(resources, body) {
  if (!body || resolvePhaseCTab(body) !== 'inspiration') {
    return (resources || []).slice(0, 12);
  }
  const topic = String(body.topic || '').trim();
  const gradeLabel = String(body.gradeLabel || '').trim();
  const merged = waldorfWebSeed.ensureWebInspirationFallback(resources || [], topic, gradeLabel, {
    maxCount: 12,
  });
  const seen = Object.create(null);
  const out = [];
  merged.forEach(function (item) {
    const norm = normalizePedagogicalResourceItem(item, body);
    if (!norm || seen[norm.url]) return;
    seen[norm.url] = true;
    out.push(norm);
  });
  return out.slice(0, 12);
}

function waldorfSystemPrompt(extra) {
  return (
    'You are an expert Waldorf / Steiner-Waldorf pedagogy researcher and curriculum designer. ' +
    'Use live web search as the CORE ANCHOR to gather broad, exhaustive, high-quality educational material for every query. ' +
    pedagogicalScope.PEDAGOGICAL_SCOPE_GUARDRAIL_INSTRUCTION +
    CONTENT_HIERARCHY_INSTRUCTION +
    STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
    WEB_SEARCH_PRIORITY_INSTRUCTION +
    DRIVE_ARCHIVE_ENRICHMENT_INSTRUCTION +
    COMMUNITY_ARCHIVE_ENRICHMENT_INSTRUCTION +
    FACTUAL_INTEGRITY_INSTRUCTION +
    ACADEMIC_TONE_INSTRUCTION +
    SOURCES_CITATION_INSTRUCTION +
    WALDORF_PEDAGOGICAL_WEB_RESOURCES_INSTRUCTION +
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

/** Perplexity synthesis system prompt — strips link-generation rules for phase_c inspiration (Gemini-only). */
function buildPerplexitySynthesisSystemPrompt(body) {
  return function (extra) {
    let prompt = waldorfSystemPrompt(extra || '');
    if (body && body.phase === 'phase_c' && resolvePhaseCTab(body) === 'inspiration') {
      prompt = prompt.replace(WALDORF_PEDAGOGICAL_WEB_RESOURCES_INSTRUCTION, '');
      prompt += PERPLEXITY_PHASE_C_INSPIRATION_NO_LINKS_INSTRUCTION;
    }
    return prompt;
  };
}

const PHASE_B_TOPIC_FORBIDDEN_OUTPUT =
  '\n=== PHASE B — TOPIC ESSENCE ONLY (MANDATORY — OVERRIDES CONFLICTING RULES) ===\n' +
  'Output ONLY the clean pedagogical essence and overview of the block topic for currentGrade.\n' +
  'FORBIDDEN in JSON output: blockPlan.inspiration, blockPlan.curriculum, blockPlan.sources, theory.bibliography, gallery, ' +
  'expansion / contentExpansion / artExpansion / hintExpansion objects, URLs, hyperlinks, and numeric reference brackets like [1] or [4].\n' +
  'Do NOT generate daily lesson breakdown, inspiration blocks, background resource lists, or bibliography — those load on-demand via pedagogy_deep_dive or pedagogical chat.\n' +
  '=== END PHASE B ===\n';

function resolvePhaseCTab(body) {
  const tab = String((body && (body.cTab || body.productTab || body.phaseCTab)) || '').trim().toLowerCase();
  if (tab === 'inspiration' || tab === 'curriculum') return tab;
  return null;
}

function isPhaseCGeneration(body) {
  return Boolean(body && body.phase === 'phase_c');
}

/** Map API aliases: phase_b → topic (Phase B essence), phase_c stays phase_c with cTab. */
function normalizeRequestPhase(body) {
  if (!body || !body.phase) return;
  if (body.phase === 'phase_b') {
    body.phase = 'topic';
    return;
  }
  if (body.phase === 'phase_c') {
    const cTab = resolvePhaseCTab(body);
    if (cTab) body.cTab = cTab;
  }
}

function isDecoupledGenerationPhase(body) {
  const phase = body && body.phase;
  return phase === 'grade' || phase === 'topic' || phase === 'phase_c';
}

function isOnDemandExpansionPhase(body) {
  const phase = body && body.phase;
  return phase === 'pedagogy_deep_dive' || phase === 'archive_summary';
}

const EXPANSION_SCOPE_AGE = 'age';
const EXPANSION_SCOPE_TOPIC = 'topic';

/** Age-stage (הרחבות גיל) vs topic (הרחבות נושא) — strict separation for on-demand expansions. */
function resolveExpansionScope(body) {
  const explicit = String((body && body.expansionScope) || '').trim().toLowerCase();
  if (explicit === 'age' || explicit === 'grade') return EXPANSION_SCOPE_AGE;
  if (explicit === 'topic') return EXPANSION_SCOPE_TOPIC;
  const activityType = String((body && body.activityType) || '').trim().toLowerCase();
  if (activityType === 'grade') return EXPANSION_SCOPE_AGE;
  return EXPANSION_SCOPE_TOPIC;
}

function isAgeExpansionRequest(body) {
  return body && body.phase === 'pedagogy_deep_dive' && resolveExpansionScope(body) === EXPANSION_SCOPE_AGE;
}

function isTopicExpansionRequest(body) {
  return body && body.phase === 'pedagogy_deep_dive' && resolveExpansionScope(body) === EXPANSION_SCOPE_TOPIC;
}

/** Strip topic from age-stage expansion requests — they must be grade-only. */
function normalizeExpansionRequest(body) {
  if (!body || body.phase !== 'pedagogy_deep_dive') return body;
  body.expansionScope = resolveExpansionScope(body);
  if (isAgeExpansionRequest(body)) {
    body.topic = null;
    body.archiveQuery = null;
  }
  return body;
}

/** On-demand expansion buttons — Perplexity Sonar raw research only (independent cache key per button). */
function isPerplexityRawExpansionPhase(body) {
  if (!body || !body.phase) return false;
  return body.phase === 'pedagogy_deep_dive' || body.phase === 'archive_summary';
}

/** @deprecated alias */
function isPerplexityOnlyOnDemandPhase(body) {
  return isPerplexityRawExpansionPhase(body);
}

/** @deprecated Use isPerplexityRawExpansionPhase */
function isPerplexityOnlyExpansionPhase(body) {
  return isPerplexityRawExpansionPhase(body);
}

function hasPedagogyDeepDiveContent(dive) {
  if (!dive || typeof dive !== 'object') return false;
  return Boolean(
    String(dive.rawContent || '').trim() ||
    String(dive.summaryHtml || '').trim() ||
    String(dive.contentHtml || '').trim() ||
    String(dive.classroomImplementation || '').trim() ||
    String(dive.essence || '').trim()
  );
}

function buildPerplexityExpansionPayload(body, rawPayload) {
  const citations = Array.isArray(rawPayload.citations) ? rawPayload.citations.filter(Boolean) : [];
  return {
    pedagogyDeepDive: {
      title: String(body.activityTitle || body.sourceTitle || '').trim(),
      rawContent: String(rawPayload.content || '').trim(),
      citations: citations,
      source: 'perplexity-sonar',
      model: rawPayload.model || perplexityClient.PERPLEXITY_SEARCH_MODEL,
      searchedAt: rawPayload.searchedAt || new Date().toISOString(),
      expansionScope: body.expansionScope || null,
      expansionItemId: body.expansionItemId || null,
    },
  };
}

function buildPerplexityGradePayload(body, rawPayload) {
  const citations = Array.isArray(rawPayload.citations) ? rawPayload.citations.filter(Boolean) : [];
  return {
    gradeInsights: {
      rawContent: String(rawPayload.content || '').trim(),
      citations: citations,
      source: 'perplexity-sonar',
      model: rawPayload.model || perplexityClient.PERPLEXITY_SEARCH_MODEL,
      searchedAt: rawPayload.searchedAt || new Date().toISOString(),
      gradeLabel: String(body.gradeLabel || '').trim(),
    },
  };
}

function buildPerplexityTopicPayload(body, rawPayload) {
  const citations = Array.isArray(rawPayload.citations) ? rawPayload.citations.filter(Boolean) : [];
  const topic = String(body.topic || '').trim();
  return {
    webResearch: {
      topic: topic,
      summary: '',
      connections: [],
      highlights: [],
    },
    blockPlan: {
      rawContent: String(rawPayload.content || '').trim(),
      citations: citations,
      source: 'perplexity-sonar',
      model: rawPayload.model || perplexityClient.PERPLEXITY_SEARCH_MODEL,
      searchedAt: rawPayload.searchedAt || new Date().toISOString(),
      topic: topic,
    },
    gallery: [],
  };
}

function buildPerplexityArchiveSummaryPayload(body, rawPayload) {
  const citations = Array.isArray(rawPayload.citations) ? rawPayload.citations.filter(Boolean) : [];
  const base = {
    rawContent: String(rawPayload.content || '').trim(),
    citations: citations,
    source: 'perplexity-sonar',
    model: rawPayload.model || perplexityClient.PERPLEXITY_SEARCH_MODEL,
    searchedAt: rawPayload.searchedAt || new Date().toISOString(),
    title: String(body.sourceTitle || '').trim(),
  };
  if (body.pedagogyDeepDive) {
    return { pedagogyDeepDive: Object.assign({ title: base.title }, base) };
  }
  return { archiveSummary: base };
}

function buildPerplexityOnDemandPayload(body, rawPayload) {
  const phase = body.phase;
  if (phase === 'pedagogy_deep_dive') return buildPerplexityExpansionPayload(body, rawPayload);
  if (phase === 'archive_summary') return buildPerplexityArchiveSummaryPayload(body, rawPayload);
  return buildPerplexityExpansionPayload(body, rawPayload);
}

async function fetchPerplexityOnlyOnDemand(body, logContext) {
  const phase = body.phase;
  const startedAt = Date.now();
  console.log('[on-demand] Perplexity-only pipeline for', phase);
  let rawPayload;
  try {
    rawPayload = await fetchOrRunPerplexityResearch(body, logContext);
  } catch (searchErr) {
    const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
    console.error('[on-demand] Perplexity search failed for', phase, ':', msg);
    throw new Error(msg || 'שגיאה בחיפוש Perplexity — נסו שוב בעוד רגע.');
  }
  if (!String(rawPayload.content || '').trim()) {
    throw new Error('Perplexity החזיר תשובה ריקה — נסו שוב בעוד רגע.');
  }
  const payload = buildPerplexityOnDemandPayload(body, rawPayload);

  // On-demand expansions: persist to cached_results before the HTTP handler responds.
  if (isOnDemandExpansionPhase(body) && !body.skipCache) {
    try {
      const cachePayload = cacheDb.stampPerplexityOnlyMetadata(payload);
      const savedKey = await cacheDb.setCachedResult(body, cachePayload);
      if (savedKey) {
        console.log(
          '[on-demand] cached_results SAVED before response',
          phase,
          savedKey.slice(0, 12),
          '(' + Math.round((Date.now() - startedAt) / 1000) + 's)'
        );
        body._onDemandCacheSaved = true;
      }
    } catch (cacheErr) {
      console.warn('[on-demand] cached_results save failed:', cacheErr.message || cacheErr);
    }
  }

  console.log('[on-demand] Perplexity-only complete for', phase, '(' + Math.round((Date.now() - startedAt) / 1000) + 's)');
  return payload;
}

/** @deprecated Use fetchPerplexityOnlyOnDemand */
async function fetchPerplexityOnlyExpansion(body, logContext) {
  return fetchPerplexityOnlyOnDemand(body, logContext);
}

function isArchiveOnlyLookup(body) {
  // Grade/topic only — on-demand expansions (pedagogy_deep_dive / archive_summary) always live-generate on cache miss.
  return ARCHIVE_ONLY_MODE && isDecoupledGenerationPhase(body) && !isOnDemandExpansionPhase(body);
}

function shouldLiveGenerateOnDemandExpansion(body) {
  return isOnDemandExpansionPhase(body);
}

function pedagogicalChatSystemPrompt(extra, mode) {
  return chatApi.pedagogicalChatSystemPrompt(extra, mode);
}

function isPedagogicalChatPhase(body) {
  return Boolean(body && body.phase === 'chat_followup');
}

function isGeminiEnrichmentPhase(body) {
  return Boolean(body && body.phase === 'enrichment_links');
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
  if (b.phase === 'pedagogy_deep_dive' && b.expansionScope) parts.push(String(b.expansionScope));
  if (b.phase === 'phase_c' && b.cTab) parts.push(String(b.cTab));
  const grade = String(b.gradeLabel || b.currentGrade || b.gradeId || '').trim();
  if (grade) parts.push(grade);
  const subject = String(
    (isAgeExpansionRequest(b) ? '' : b.topic) ||
    b.userMessage ||
    b.archiveQuery ||
    b.activityTitle ||
    ''
  ).trim();
  if (subject) parts.push(subject.slice(0, 120));
  if (b.activityTitle && b.activityTitle !== subject) parts.push(String(b.activityTitle).slice(0, 80));
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
    pedagogicalScope.PEDAGOGICAL_SCOPE_GUARDRAIL_INSTRUCTION +
    '\n=== GRADE LOCK (MANDATORY) ===\n' +
    'currentGrade (id): ' + gradeId + '\n' +
    'gradeLabel: ' + gradeLabel + '\n' +
    'age: ' + age + '\n' +
    'INSTRUCTION: ' + lockText + '\n' +
    'Reject or rewrite any idea, story, fairy tale, example, or pedagogical emphasis that belongs to a different grade.\n' +
    '=== END GRADE LOCK ===\n' +
    pedagogicalScope.buildPedagogicalScopeUserBlock(body)
  );
}

function buildRagContextBlock(body) {
  if (isDecoupledGenerationPhase(body)) return '';

  const rag = String(body.ragContext || '').trim();
  const driveCtx = String(body.ragDriveContext || '').trim();
  const communityCtx = String(body.ragCommunityContext || '').trim();
  const isChat = body && body.phase === 'chat_followup';
  const isLessonPhase = body && (body.phase === 'grade' || body.phase === 'topic' || body.phase === 'phase_c' ||
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

function buildChatHistoryBlock(body) {
  const history = Array.isArray(body && body.chatHistory) ? body.chatHistory : [];
  if (!history.length) return '';
  const lines = history.slice(-8).map(function (entry) {
    if (!entry || typeof entry !== 'object') return '';
    const role = chatApi.normalizeChatHistoryRole
      ? chatApi.normalizeChatHistoryRole(entry.role)
      : String(entry.role || '').trim().toLowerCase();
    const content = String(entry.content || entry.text || '').trim();
    if (!content) return '';
    return (role === 'assistant' ? 'Assistant' : 'Teacher') + ': ' + content;
  }).filter(Boolean);
  if (!lines.length) return '';
  return (
    '\n=== CHAT HISTORY (this session only — continuity) ===\n' +
    lines.join('\n\n') +
    '\n=== END CHAT HISTORY ===\n\n'
  );
}

function buildChatCommunityRagBlock(body) {
  const communityCtx = String(body.ragCommunityContext || '').trim();
  if (!communityCtx) return '';
  return (
    '\n=== COMMUNITY ARCHIVE EXCERPTS (matched to teacher question only) ===\n' +
    communityCtx +
    '\n=== END COMMUNITY ARCHIVE EXCERPTS ===\n\n'
  );
}

function buildIsolatedChatUserPrompt(body) {
  const question = String(body.userMessage || '').replace(/"/g, "'");
  if (!question.trim()) {
    throw new Error('Missing userMessage for chat_followup');
  }
  const expansionRequest = isChatPedagogicalExpansionRequest(body);
  const chatContinuation = chatApi.isChatContinuationTurn(body);
  const continuationBlock = chatContinuation
    ? '\n=== CHAT CONTINUATION ===\n' +
      'Jump DIRECTLY into pedagogical content — no archive or מאגר intros.\n' +
      '=== END CHAT CONTINUATION ===\n'
    : '';

  return (
    chatApi.CHAT_STRICT_PROMPT_ISOLATION_INSTRUCTION +
    pedagogicalScope.buildChatInferredGradeBlock(question) +
    buildLanguageBlock(body) +
    buildNoLatexBlock(body) +
    continuationBlock +
    buildChatHistoryBlock(body) +
    CHAT_NO_INVENTED_CITATIONS_INSTRUCTION +
    'You are the Pedagogical Chat Assistant. Answer ONLY the teacher question below.\n' +
    'Do NOT use UI-selected grade, active lesson topic, or site background unless explicitly named in the question.\n' +
    (expansionRequest
      ? 'EXPANSION FOLLOW-UP: The teacher explicitly asked for MORE materials or DEEPER pedagogical ideas. ' +
        'Generate fresh, rich Waldorf pedagogical content — practical classroom ideas, activities, and book/article recommendations.\n'
      : chatContinuation
      ? 'CHAT CONTINUATION: Answer the follow-up directly with rich pedagogical content.\n'
      : 'Answer with clear, professional Waldorf pedagogical guidance grounded in your expertise.\n') +
    '\nTeacher question: «' + question + '»\n\n' +
    'ANSWER STRATEGY (MANDATORY):\n' +
    '1. NEVER use Perplexity, Sonar, live web search, or community archive lookups in this chat pipeline.\n' +
    '2. Stay 100% loyal to the teacher question — no context bleeding from other grades or lesson screens.\n' +
    '3. NEVER fabricate Steiner quotes, GA citations, doctrines, **bold** archive headings, or [1][2] markers.\n' +
    '4. Give a full, warm, practical Hebrew answer (2–6 paragraphs) — no database absence apologies at the start.\n' +
    '5. End with: «' + chatApi.CHAT_COMMUNITY_SEARCH_RECOMMENDATION_HE + '»\n' +
    CHAT_JSON_OUTPUT_INSTRUCTION +
    'Return ONLY: { "text": "<your full Hebrew answer here>" } — no ```json fences, no preamble.'
  );
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

function resolveCommunityMatchGradeLabel(match, body) {
  if (!match) {
    return String(body && body.gradeLabel || '').trim() || ('כיתה ' + (resolvedGradeId(body) || '?'));
  }
  if (match.gradeLabel) return String(match.gradeLabel).trim();
  const fromId = cacheDb.resolveGradeLabelFromId(match.gradeId, null);
  if (fromId) return fromId;
  return 'מאגר הקהילתי';
}

function resolveCommunityRepositoryLabel(match) {
  if (match && match.source === 'cached_archive') {
    return 'ארכיון המחקר השמור';
  }
  return 'מאגר הקהילתי';
}

function buildCommunityCatalogLocationHint(match) {
  if (!match || typeof match !== 'object') return '';
  const gradeLabel = match.gradeLabel || cacheDb.resolveGradeLabelFromId(match.gradeId, null) || '';
  const catalogTopic = cacheDb.resolveCommunityCatalogTopic(match);
  const subject = catalogTopic || String(match.topic || match.bundleTopic || '').trim();
  const title = match.displayTitle || match.title || subject || 'חומר קהילתי';
  const parts = [];
  parts.push('מיקום במערכת: מאגר קהילתי');
  if (gradeLabel) parts.push('→ ' + gradeLabel);
  if (subject) parts.push('→ נושא «' + subject + '»');
  parts.push('→ «' + title + '»');
  return parts.join(' ');
}

function buildCommunityMatchOpening(probe, body) {
  const matches = probe && Array.isArray(probe.matches) ? probe.matches : [];
  if (!matches.length) return '';

  const matchedFile = matches[0];
  const teacherName = resolveTeacherFirstName(body);
  const gradeLabel = resolveCommunityMatchGradeLabel(matchedFile, body);
  const title = matchedFile.displayTitle || matchedFile.title || matchedFile.topic || probe.query || 'חומר קהילתי';
  const repositoryLabel = resolveCommunityRepositoryLabel(matchedFile);

  const locationHint = buildCommunityCatalogLocationHint(matchedFile);

  return (
    teacherName + ', הרווחת! מצאנו ב' + repositoryLabel + ' של ' + gradeLabel + ' את «' + title + '». ' +
    'אתה יכול להיכנס למאגר הקהילתי באתר, תחת «' + gradeLabel + '», כדי לצפות בקובץ.' +
    (locationHint ? ' ' + locationHint + '.' : '')
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
  const gradeLabel = match.gradeLabel || cacheDb.resolveGradeLabelFromId(match.gradeId, null);
  const contributor = match.contributorName || '';
  const description = match.description ? String(match.description).slice(0, 240) : '';
  const preview = match.contentPreview ? String(match.contentPreview).slice(0, 240) : '';
  const locationHint = buildCommunityCatalogLocationHint(match);
  let line = (index + 1) + '. «' + title + '»';
  if (topic && topic !== title) line += ' (נושא: ' + topic + ')';
  if (gradeLabel) line += ' [' + gradeLabel + ']';
  else if (match.gradeId) line += ' [כיתה ' + match.gradeId + ']';
  if (match.source === 'cached_archive') line += ' (ארכיון מחקר שמור)';
  if (contributor) line += ' — תורם: ' + contributor;
  if (description) line += '\n   תיאור: ' + description;
  else if (preview) line += '\n   תקציר: ' + preview;
  if (locationHint) line += '\n   ' + locationHint;
  if (match.matchedInBundle && match.alertText) line += '\n   ' + match.alertText;
  return line;
}

function buildCommunityMatchCriticalSystemBlock(probe, body) {
  const matches = probe && Array.isArray(probe.matches) ? probe.matches : [];
  if (!matches.length) return '';

  const matchedFile = matches[0];
  const openingLine = buildCommunityMatchOpening(probe, body);

  return (
    '\n=== CRITICAL INSTRUCTION — COMMUNITY DATABASE MATCH ===\n' +
    'A relevant file was found in the community database (global scan — keyword/semantic, ignoring UI grade/topic).\n' +
    'You MUST start your Hebrew response verbatim with this exact opening sentence:\n' +
    '«' + openingLine + '»\n' +
    'STRICT RULES WHEN THIS MATCH EXISTS:\n' +
    '- The verified community upload is the primary answer — announce it clearly in the opening, including the grade where it was found.\n' +
    '- Do NOT invent details about commercial plays (e.g. Roee Chen / רואי חן), publishers, or external internet productions.\n' +
    '- Do NOT substitute web-search play or curriculum recommendations when this community file already answers the teacher.\n' +
    '- Focus first on telling the teacher this specific file exists in the community database and the exact catalog path (grade → subject). Do NOT paste raw URLs.\n' +
    '- Only after the mandatory opening, add brief grounded context from matched title/subject/description metadata.\n' +
    '=== END CRITICAL INSTRUCTION — COMMUNITY DATABASE MATCH ===\n'
  );
}

function buildCommunityRagExcerptBlock(body) {
  const communityCtx = String(body && body.ragCommunityContext || '').trim();
  if (!communityCtx) {
    return (
      '\n=== SUPABASE COMMUNITY VECTOR SEARCH (community_knowledge_base — NO EXCERPTS) ===\n' +
      'Vector/keyword search in community_knowledge_base returned no relevant excerpts for this question.\n' +
      'Do NOT invent academic citations ([1], [2], etc.). State clearly that no records were found in the community database.\n' +
      '=== END SUPABASE COMMUNITY VECTOR SEARCH ===\n\n'
    );
  }
  return (
    '\n=== SUPABASE COMMUNITY VECTOR SEARCH (community_knowledge_base — RETRIEVED EXCERPTS) ===\n' +
    'The following excerpts were retrieved from Supabase BEFORE this reply was generated. Ground claims in them when relevant.\n\n' +
    communityCtx +
    '\n=== END SUPABASE COMMUNITY VECTOR SEARCH ===\n\n'
  );
}

function buildCommunityMaterialsContextBlock(probe, body, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const suppressMandatoryOpening = Boolean(opts.suppressMandatoryOpening);
  const matches = probe && Array.isArray(probe.matches) ? probe.matches : [];
  const teacherName = resolveTeacherFirstName(body);
  const query = probe && probe.query ? String(probe.query).trim() : '';

  if (!matches.length) {
    return (
      '\n=== COMMUNITY MATERIALS DATABASE (community_materials + community_knowledge_base + cached_results — GLOBAL SCAN) ===\n' +
      'חיפוש גלובלי במאגר הקהילתי' + (query ? ' עבור «' + query + '»' : '') + ' לא מצא התאמה (ללא סינון לפי כיתה/נושא מהממשק).\n' +
      (suppressMandatoryOpening
        ? 'רקע פנימי בלבד — אל תציין זאת בתשובה (המורה כבר קיבל/ה הודעת מאגר בשיחה זו).\n'
        : 'המשך עם ידע פדגוגי מ-Gemini — אין צורך בפתיחה חגיגית.\n') +
      '=== END COMMUNITY MATERIALS DATABASE ===\n\n'
    );
  }

  const primary = matches[0];
  const primaryTitle = primary.displayTitle || primary.title || primary.topic || 'חומר קהילתי';
  const gradeLabel = resolveCommunityMatchGradeLabel(primary, body);
  const mandatoryOpening = buildCommunityMatchOpening(probe, body);
  const lines = matches.slice(0, 6).map(formatCommunityMatchForPrompt);
  const matchMethod = probe && probe.matchMethod ? String(probe.matchMethod) : '';
  const semanticNote = matchMethod.indexOf('semantic') >= 0
    ? 'Match method: SEMANTIC (' + matchMethod + ') — teacher intent was linked to catalog material even without identical wording.\n'
    : (matchMethod && matchMethod !== 'keyword_fuzzy'
      ? 'Match method: ' + matchMethod + ' (global scan — UI grade/topic ignored).\n'
      : 'Match method: global keyword scan (UI grade/topic ignored).\n');

  const openingLines = suppressMandatoryOpening
    ? 'BACKGROUND ONLY — do NOT repeat archive greetings or catalog intros; the teacher already received them in this session.\n' +
      'Use matched metadata silently to enrich your pedagogical answer.\n\n'
    : 'MANDATORY OPENING (first sentence of your Hebrew reply — ABSOLUTE, keyword OR semantic match):\n' +
      '«' + mandatoryOpening + '»\n' +
      'Do NOT invent commercial plays, external productions, or internet sources when this community file exists. ' +
      'Lead with the community database file and the grade where it was found; only add brief grounded follow-up if supported by matched metadata.\n\n';

  return (
    '\n=== COMMUNITY MATERIALS DATABASE (community_materials + community_knowledge_base + cached_results — GLOBAL SCAN) ===\n' +
    'COMMUNITY MATCH FOUND — ' + matches.length + ' material(s) for this question.\n' +
    semanticNote +
    'Teacher first name for opening: «' + teacherName + '»\n' +
    'Matched grade (from repository, NOT UI selection): «' + gradeLabel + '»\n' +
    'Best match title for opening: «' + primaryTitle + '»\n' +
    openingLines +
    'Matched materials:\n' +
    lines.join('\n') +
    '\n=== END COMMUNITY MATERIALS DATABASE ===\n\n'
  );
}

const LAZY_LOAD_NOTE =
  'Do NOT include expansion, contentExpansion, artExpansion, or nested practical-expansion objects — expansions load on-demand via pedagogy_deep_dive.\n';

const EXPANSION_OBJECT_SCHEMA =
  '{ "classroomImplementation": "1-2 Hebrew paragraphs: practical in-class implementation", ' +
  '"parentCommunityAspects": "Hebrew paragraph on parents/community when relevant", ' +
  '"practicalSteps": ["4-8 concrete classroom steps for the teacher"], ' +
  '"inspirationReferences": ["3-6 named books/articles/Waldorf projects — NO URLs"], ' +
  '"expansionHtml": "<p>Optional rich Hebrew HTML</p>" }';

const CURRICULUM_INLINE_EXPANSION_INSTRUCTION =
  '\n=== CURRICULUM DAY INLINE EXPANSION — «הרחבה ואספקטים פרקטיים» (MANDATORY) ===\n' +
  'Each of the 15 curriculum days MUST include a complete contentExpansion object (and optionally artExpansion, hintExpansion).\n' +
  'Shape: ' + EXPANSION_OBJECT_SCHEMA + '\n' +
  'The UI button toggles this pre-generated pedagogical text — NO second API call.\n' +
  'FORBIDDEN inside content/art/hint/expansion fields: URLs, Pinterest phrases, gallery pins, enrichment_links, raw search queries, or code blocks.\n' +
  'content and art MUST remain clean Waldorf narrative text; expansions hold theoretical + practical teaching depth only.\n' +
  '=== END CURRICULUM INLINE EXPANSION ===\n';

/**
 * chat_followup: expect { "text": "..." } from Gemini JSON mode.
 * Falls back to fence-stripped raw text wrapped as chatReply.answer when parsing fails.
 */
function normalizeChatFollowupFromModel(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return buildModelParseFallback('chat_followup', '', {});
  }

  try {
    const stripped = stripMarkdownJsonFences(text);
    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch (directErr) {
      parsed = cleanAndParseJSON(stripped, {
        phase: 'chat_followup',
        fallbackOnError: false,
        unwrap: true,
      });
    }

    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        return { chatReply: { answer: String(parsed.text).trim() } };
      }
      if (parsed.chatReply && typeof parsed.chatReply === 'object') {
        return parsed;
      }
      if (parsed.reply) {
        return { chatReply: { answer: String(parsed.reply).trim() } };
      }
      if (parsed.answer || parsed.answerHtml) {
        return { chatReply: parsed };
      }
    }
  } catch (parseErr) {
    console.warn(
      '[generate] chat_followup JSON parse failed, packaging raw text:',
      parseErr instanceof Error ? parseErr.message : parseErr
    );
  }

  const fallbackText = stripMarkdownJsonFences(text).trim() || text;
  return {
    chatReply: { answer: fallbackText },
    _parseFallback: true,
  };
}

/** @deprecated alias — grade phase uses the same pipeline as parseJsonFromModel */
function parseGradeJsonFromModel(text) {
  return parseJsonFromModel(text);
}

function buildPhaseCUserPrompt(body) {
  const cTab = resolvePhaseCTab(body);
  const topic = (body.topic || '').replace(/"/g, '');
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
  const prioritySearch = body.prioritySearchInstruction
    ? '\nPRIORITY SEARCH (MANDATORY):\n' + body.prioritySearchInstruction + '\n'
    : '';
  const isInspirationTab = cTab === 'inspiration';
  const noUrls = isInspirationTab
    ? (
      '\n=== URL POLICY (PHASE C INSPIRATION — PERPLEXITY TEXT ONLY) ===\n' +
      'FORBIDDEN: URLs in blockPlan.inspiration HTML/text, blockPlan.sources, gallery.src, enrichment_links, pedagogicalResources, or narrative paragraphs.\n' +
      'Gallery "pin" fields are English search PHRASES only (src must stay empty). Link URLs are generated separately by Gemini.\n' +
      (body.noUrlsInstruction ? body.noUrlsInstruction + '\n' : '') +
      '=== END URL POLICY ===\n'
    )
    : (body.noUrlsInstruction
      ? '\nNO URLS (MANDATORY):\n' + body.noUrlsInstruction + '\n'
      : '\nDo NOT include internet URLs in bibliography, HTML, summaries, or recommendations.\n');
  const theoryContext = String(body.theoryEssence || '').trim();
  const theoryBlock = theoryContext
    ? '\nPHASE B ESSENCE (context only — do NOT copy or paraphrase verbatim into this tab):\n' +
      theoryContext.slice(0, 4000) + '\n'
    : '';

  const sharedHeader =
    buildGradeLockBlock(body) +
    buildLanguageBlock(body) +
    buildNoLatexBlock(body) +
    noUrls +
    theoryBlock +
    '\n=== PHASE C — INDEPENDENT TAB GENERATION (MANDATORY) ===\n' +
    'Synthesize the PERPLEXITY WEB RESEARCH above into rich Waldorf content for the «' + cTab + '» tab ONLY.\n' +
    'Do NOT duplicate, mirror, or lightly rephrase Phase B theory essence — produce unique, tab-specific deep material.\n' +
    'currentGrade: ' + resolvedGradeId(body) + '\n' +
    'Grade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\n' +
    'Block topic: «' + topic + '»\n' +
    'Grade context: ' + (body.gradeContext || '') + '\n' +
    'Every field MUST be written for currentGrade only. Do not mention activities, stories, or developmental themes from other grades.\n' +
    'Produce rich, deeply anthroposophic content. Uniform 16px text in UI.\n' +
    prioritySearch +
    WEB_SEARCH_PRIORITY_INSTRUCTION;

  if (cTab === 'inspiration') {
    return (
      sharedHeader +
      inspirationExtra +
      pedagogyHint +
      NO_SOURCES_MODE_INSTRUCTION +
      PERPLEXITY_PHASE_C_INSPIRATION_NO_LINKS_INSTRUCTION +
      'blockPlan.inspiration.podcast: when priority sources have relevant material, convey themes and insights objectively in episode entries.\n' +
      'PINTEREST (WALDORF ONLY — QUALITY OVER QUANTITY): populate gallery with 2–4 DISTINCT grade-locked visual inspiration pin PHRASES ONLY (English, no URLs).\n' +
      'Each "pin" MUST be clean unquoted English: Waldorf Class N {englishTopic} — e.g. Waldorf Class 8 revolutions.\n' +
      'NEVER include pins from other grades. If only 2–3 perfect matches exist, return only those — do NOT pad with generic clutter.\n' +
      LAZY_LOAD_NOTE +
      'CRITICAL — blockPlan MUST include inspiration object only (NO sources, NO bibliography, NO links).\n' +
      'blockPlan.inspiration MUST be an object with title, global, podcast, and narrative.\n' +
      'FORBIDDEN in this response: blockPlan.sources, blockPlan.theory, blockPlan.curriculum, theory.sections, daily lesson breakdown, enrichment_links, pedagogicalResources, URLs.\n' +
      JSON_ONLY_INSTRUCTION +
      JSON_RESPONSE_ENFORCEMENT +
      '\nReturn JSON only — your reply MUST start with { and end with }:\n' +
      '{\n' +
      '  "blockPlan": {\n' +
      '    "inspiration": { "title": "Hebrew", "global": [{ "title": "Hebrew", "items": [{ "text": "full Hebrew paragraph per item" }] }], "podcast": { "title": "Hebrew", "episodes": [{ "theme": "Hebrew", "insight": "rich Hebrew paragraph" }] }, "narrative": [{ "text": "rich story/metaphor paragraph" }] }\n' +
      '  },\n' +
      '  "gallery": [{ "board": "Hebrew", "title": "Hebrew", "pin": "Waldorf Class 8 revolutions", "src": "" }]\n' +
      '}\n' +
      'blockPlan.inspiration.global: 3–4 blocks with 4–6 paragraph items each.\n' +
      'gallery: 2–4 DISTINCT grade-locked Waldorf Pinterest pin phrases — quality over quantity; no duplicate or wrong-grade pin phrases.'
    );
  }

  return (
    sharedHeader +
    curriculumExtra +
    pedagogyHint +
    NO_SOURCES_MODE_INSTRUCTION +
    CURRICULUM_INLINE_EXPANSION_INSTRUCTION +
    'CRITICAL — blockPlan.curriculum MUST be a JSON ARRAY (not an object) of exactly 15 day objects.\n' +
    'Each day object MUST use these exact keys: "day" (number 1–15), "topic" (Hebrew string), "content" (4–6 rich Hebrew sentences on story/main-lesson flow — shown immediately in UI), "art" (2–4 Hebrew sentences on art/craft/handwork — shown immediately), "hint" (optional Hebrew string), "contentExpansion" (mandatory expansion object).\n' +
    'content and art MUST be complete narrative text in this payload — never empty placeholders. contentExpansion is mandatory per day; artExpansion and hintExpansion optional.\n' +
    'Do NOT nest curriculum under days/items/lessons — use blockPlan.curriculum as a flat array.\n' +
    'FORBIDDEN in this response: blockPlan.theory, blockPlan.inspiration, blockPlan.sources, gallery, bibliography, enrichment_links, pedagogicalResources, URLs.\n' +
    JSON_ONLY_INSTRUCTION +
    JSON_RESPONSE_ENFORCEMENT +
    '\nReturn JSON only — your reply MUST start with { and end with }:\n' +
    '{\n' +
    '  "blockPlan": {\n' +
    '    "curriculum": [{ "day": 1, "topic": "Hebrew", "content": "4-6 sentence guided lesson flow", "art": "2-4 sentences on art/craft", "hint": "optional", "contentExpansion": { "classroomImplementation": "...", "practicalSteps": ["..."], "parentCommunityAspects": "...", "inspirationReferences": ["..."] } }]\n' +
    '  }\n' +
    '}\n' +
    'curriculum MUST be a flat ARRAY of exactly 15 objects (days 1–15) — never wrap in { days: [...] } or similar.\n' +
    'Each curriculum item MUST include day, topic, content, art, and contentExpansion fields using those exact key names.'
  );
}

function buildUserPrompt(body) {
  const phase = body.phase;
  const chatExpansion = phase === 'chat_followup' && chatApi.shouldTreatChatAsPedagogicalExpansion(body);
  const ragBlock = chatExpansion ? '' : buildRagContextBlock(body);

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
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      noUrls +
      gradeExtra +
      WEB_SEARCH_PRIORITY_INSTRUCTION +
      'Synthesize the PERPLEXITY WEB RESEARCH provided above into a rich anthroposophic Waldorf portrait for:\n' +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Grade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\n\n' +
      'All insights MUST match currentGrade only — never mix content from other grades.\n' +
      'Produce inspiring, deeply pedagogical content. Uniform 16px text in UI.\n' +
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
      '    "globalCurricula": [{ "title": "Hebrew", "detail": "Hebrew curriculum bullet" }],\n' +
      '    "typicalBlocks": ["Hebrew main lesson block names"],\n' +
      '    "sources": ["source name only — no URLs"]\n' +
      '  },\n' +
      '  "teacherSummaries": [\n' +
      '    { "author": "שם מורה, עיר", "title": "כותרת", "body": "2-3 משפטים" }\n' +
      '  ]\n' +
      '}\n' +
      'gradeInsights.sources: rich diverse "Sources & Further Reading" (8–12 entries); cite Alon Yerushalmy only if genuinely relevant — merge his platforms into ONE entry, otherwise omit entirely.\n' +
      'Provide exactly 3 teacherSummaries as plausible Waldorf teacher folder summaries.'
    );
  }

  if (phase === 'topic') {
    const topic = (body.topic || '').replace(/"/g, '');
    const theoryExtra = body.theoryPrompt
      ? '\nTHEORY ESSENCE INSTRUCTIONS:\n' + body.theoryPrompt + '\n'
      : '';
    const noUrls = body.noUrlsInstruction
      ? '\nNO URLS (MANDATORY):\n' + body.noUrlsInstruction + '\n'
      : '\nDo NOT include internet URLs, hyperlinks, or href attributes anywhere in the JSON output.\n';

    return (
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      noUrls +
      PHASE_B_TOPIC_FORBIDDEN_OUTPUT +
      'Synthesize the PERPLEXITY WEB RESEARCH provided above into a Waldorf main-lesson TOPIC ESSENCE ONLY — pedagogical core and overview.\n' +
      'currentGrade: ' + resolvedGradeId(body) + '\n' +
      'Grade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\n' +
      'Block topic: «' + topic + '»\n' +
      'Grade context: ' + (body.gradeContext || '') + '\n' +
      theoryExtra +
      'Every field MUST be written for currentGrade only. Do not mention activities, stories, or developmental themes from other grades.\n' +
      'Produce rich, deeply anthroposophic essence content. Uniform 16px text in UI.\n' +
      'STRICTLY FORBIDDEN: daily curriculum / 15-day breakdown, inspiration blocks, bibliography, sources lists, gallery, ' +
      'inline expansion objects, numeric reference brackets like [1][4], and any external links.\n' +
      'Deep dives, inspirations, resources, and daily planning are loaded later on-demand via pedagogy_deep_dive or pedagogical chat.\n' +
      JSON_ONLY_INSTRUCTION +
      JSON_RESPONSE_ENFORCEMENT +
      '\nReturn JSON only — your reply MUST start with { and end with }:\n' +
      '{\n' +
      '  "webResearch": {\n' +
      '    "topic": "' + topic + '",\n' +
      '    "summary": "Rich Hebrew paragraph — pedagogical essence overview for this grade",\n' +
      '    "connections": ["Hebrew phrases tying topic to currentGrade development"],\n' +
      '    "highlights": ["3–6 Hebrew pedagogical highlights for this grade only"]\n' +
      '  },\n' +
      '  "blockPlan": {\n' +
      '    "theory": { "title": "Hebrew", "sections": [{ "heading": "Hebrew", "icon": "fa-compass", "content": "<p>Rich Hebrew HTML paragraphs — essence only, no links, no [N] brackets</p>", "quotes": [{ "text": "Hebrew", "source": "GA" }] }] }\n' +
      '  }\n' +
      '}\n' +
      'blockPlan MUST contain ONLY theory (title + sections). No other blockPlan keys.\n' +
      'theory.sections: 2–4 depth sections on pedagogical essence — NOT daily lessons, NOT inspiration, NOT bibliography.'
    );
  }

  if (phase === 'phase_c') {
    return buildPhaseCUserPrompt(body);
  }

  if (phase === 'pedagogy_deep_dive') {
    const title = (body.activityTitle || '').replace(/"/g, "'");
    const preview = (body.activityPreview || '').replace(/"/g, "'");
    const expand = body.expandInstruction ||
      'הרחב ל: (1) הסבר מלא של מהות הפעילות, (2) הקשר פדגוגי אנתרופוסופי לגיל ולתקופה, (3) שלבי ביצוע פרקטיים שלב-אחר-שלב בכיתה עבור המורה.';
    if (isAgeExpansionRequest(body)) {
      const gradePriorBlock = buildPriorGradeCacheBlock(body.priorGradeCache);
      return (
        gradePriorBlock +
        buildGradeLockBlock(body) +
        buildLanguageBlock(body) +
        buildNoLatexBlock(body) +
        'AGE-STAGE EXTENSION (הרחבת גיל/שלב התפתחותי): Expand ONE anthroposophic age-stage pedagogical idea for currentGrade ONLY.\n' +
        'STRICT: This expansion is 100% independent of any main-lesson block topic — do NOT mention, tailor to, or search for the active topic.\n' +
        'Use the cached grade developmental picture (when provided) plus Perplexity research on Steiner age characteristics for this grade only.\n' +
        'currentGrade: ' + resolvedGradeId(body) + '\n' +
        'Grade: ' + body.gradeLabel + ' (age ' + (body.age || '') + ')\n' +
        'Pedagogical section: ' + (body.activitySubtype || '') + '\n' +
        'Age-stage idea title: «' + title + '»\n' +
        'Preview: ' + preview + '\n\n' +
        'EXPAND INSTRUCTION: ' + expand + '\n\n' +
        WEB_SEARCH_PRIORITY_INSTRUCTION +
        'Return practical age-appropriate guidance grounded in developmental anthroposophy — NOT topic-themed content.\n' +
        JSON_ONLY_INSTRUCTION + '\nReturn JSON only:\n' +
        '{\n' +
        '  "pedagogyDeepDive": {\n' +
        '    "title": "' + title + '",\n' +
        '    "classroomImplementation": "Hebrew: 1-2 paragraphs — age-stage practical implementation only",\n' +
        '    "parentCommunityAspects": "Hebrew: parents/community aspects for this developmental stage",\n' +
        '    "practicalSteps": ["4-8 Hebrew concrete steps for this grade\'s developmental picture"],\n' +
        '    "inspirationReferences": ["3-6 named anthroposophic/Waldorf age-stage sources — NO URLs"],\n' +
        '    "summaryHtml": "<p>Optional rich Hebrew HTML</p>"\n' +
        '  }\n' +
        '}'
      );
    }
    return (
      ragBlock +
      buildGradeLockBlock(body) +
      buildLanguageBlock(body) +
      buildNoLatexBlock(body) +
      "TOPIC EXTENSION (הרחבת נושא): Expand a Waldorf teacher's pedagogical suggestion into a full classroom guide for the active main-lesson block.\n" +
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
      'This is an ON-DEMAND topic expansion for ONE idea only — return practical aspects and inspiration references tied to the block topic.\n' +
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
    return buildIsolatedChatUserPrompt(body);
  }

  throw new Error('Unknown phase');
}

function phaseRequiresStructuredJson(phase) {
  return phase !== 'chat_followup';
}

function getChatFollowupResponseSchema() {
  return {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Full Hebrew pedagogical chat reply — warm prose, plain text or light Markdown.',
      },
    },
    required: ['text'],
  };
}

function getExpansionSchemaProperties() {
  return {
    classroomImplementation: { type: 'string' },
    parentCommunityAspects: { type: 'string' },
    practicalSteps: { type: 'array', items: { type: 'string' } },
    inspirationReferences: { type: 'array', items: { type: 'string' } },
    expansionHtml: { type: 'string' },
  };
}

function getTopicResponseSchema() {
  return {
    type: 'object',
    properties: {
      webResearch: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          summary: { type: 'string' },
          connections: { type: 'array', items: { type: 'string' } },
          highlights: { type: 'array', items: { type: 'string' } },
        },
        required: ['topic', 'summary', 'connections', 'highlights'],
      },
      blockPlan: {
        type: 'object',
        properties: {
          theory: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              sections: { type: 'array', items: { type: 'object' } },
            },
            required: ['title', 'sections'],
          },
        },
        required: ['theory'],
      },
    },
    required: ['webResearch', 'blockPlan'],
  };
}

function getEnrichmentLinksSchemaProperties() {
  return {
    pinterest_links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          query: { type: 'string' },
          pin: { type: 'string' },
        },
        required: ['title', 'url'],
      },
      maxItems: ENRICHMENT_LINKS_MAX,
    },
    article_links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          source: { type: 'string' },
          label: { type: 'string' },
          snippet: { type: 'string' },
        },
        required: ['title', 'url', 'source'],
      },
      maxItems: ENRICHMENT_LINKS_MAX,
    },
  };
}

function getPhaseCResponseSchema(cTab) {
  const expansionProps = getExpansionSchemaProperties();
  const curriculumDaySchema = {
    type: 'object',
    properties: {
      day: { type: 'number' },
      topic: { type: 'string' },
      content: { type: 'string' },
      art: { type: 'string' },
      hint: { type: 'string' },
      contentExpansion: { type: 'object', properties: expansionProps },
      artExpansion: { type: 'object', properties: expansionProps },
      hintExpansion: { type: 'object', properties: expansionProps },
    },
    required: ['day', 'topic', 'content', 'art'],
  };

  if (cTab === 'curriculum') {
    return {
      type: 'object',
      properties: {
        blockPlan: {
          type: 'object',
          properties: {
            curriculum: {
              type: 'array',
              items: curriculumDaySchema,
              minItems: 15,
              maxItems: 15,
            },
          },
          required: ['curriculum'],
        },
      },
      required: ['blockPlan'],
    };
  }

  return {
    type: 'object',
    properties: {
      blockPlan: {
        type: 'object',
        properties: {
          inspiration: { type: 'object' },
        },
        required: ['inspiration'],
      },
      gallery: { type: 'array', items: { type: 'object' } },
    },
    required: ['blockPlan', 'gallery'],
  };
}

function getStructuredResponseSchema(phase, body) {
  if (phase === 'topic') return getTopicResponseSchema();
  if (phase === 'phase_c') return getPhaseCResponseSchema(resolvePhaseCTab(body));
  return undefined;
}

function stripReferenceBrackets(text) {
  return String(text || '')
    .replace(/\[\d+\]/g, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim();
}

var SOURCE_PREFIX_LINE_RES = [
  /^(?:«|"|'|\(|\[|\-\s*)*(?:פודקאסט\s+)?(?:«)?\s*מסעות\s+בחינוך\s*(?:»)?\s*[:–—\-]\s*/i,
  /^(?:«|"|'|\(|\[|\-\s*)*(?:Educational|Learning)\s+[Jj]ourneys?\s*[:–—\-]\s*/i,
  /^(?:«|"|'|\(|\[|\-\s*)*(?:לפי|על\s+פי|מתוך|מ(?:\-|)\s*)?(?:«)?\s*(?:אלון\s+ירושלמי|Alon\s+Yerushalmy)\s*(?:»)?\s*[:–—\-]\s*/i,
  /^(?:«|"|'|\(|\[|\-\s*)*(?:according\s+to|inspired\s+by|from)\s+(?:the\s+)?(?:«)?\s*(?:אלון\s+ירושלמי|Alon\s+Yerushalmy)\s*(?:»)?\s*[:–—\-]\s*/i,
  /^(?:«|"|'|\(|\[|\-\s*)*(?:educationpace\.com|www\.educationpace\.com)\s*[:–—\-]\s*/i,
  /^(?:«|"|'|\(|\[|\-\s*)*(?:לפי|על\s+פי|מתוך|מ(?:\-|)\s*)?(?:«)?\s*(?:פודקאסט\s+)?(?:«)?\s*מסעות\s+בחינוך\s*(?:»)?\s*[:–—\-]\s*/i,
];

function stripSourcePrefixLine(line) {
  var s = String(line || '');
  var changed = true;
  while (changed) {
    changed = false;
    for (var i = 0; i < SOURCE_PREFIX_LINE_RES.length; i++) {
      var next = s.replace(SOURCE_PREFIX_LINE_RES[i], '');
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  return s.replace(/^[\s:–—\-]+/, '').replace(/[^\S\n]{2,}/g, ' ').trimEnd();
}

function stripSourcePrefixes(text) {
  if (!text || typeof text !== 'string') return text;
  return String(text)
    .split(/\n/)
    .map(stripSourcePrefixLine)
    .join('\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
}

function sanitizePedagogicalText(text) {
  return stripSourcePrefixes(stripReferenceBrackets(text));
}

function sanitizePedagogicalTextField(value) {
  return typeof value === 'string' ? sanitizePedagogicalText(value) : value;
}

function sanitizeTopicPhaseOutput(data) {
  if (!data || typeof data !== 'object') return data;
  delete data.gallery;
  if (data.blockPlan && typeof data.blockPlan === 'object') {
    const bp = data.blockPlan;
    delete bp.inspiration;
    delete bp.sources;
    delete bp.curriculum;
    delete bp.gallery;
    if (bp.theory && typeof bp.theory === 'object') {
      delete bp.theory.bibliography;
      if (Array.isArray(bp.theory.sections)) {
        bp.theory.sections = bp.theory.sections.map(function (sec) {
          if (!sec || typeof sec !== 'object') return sec;
          const next = Object.assign({}, sec);
          delete next.expansion;
          if (typeof next.content === 'string') next.content = sanitizePedagogicalText(next.content);
          if (typeof next.heading === 'string') next.heading = sanitizePedagogicalText(next.heading);
          return next;
        });
      }
    }
  }
  if (data.webResearch && typeof data.webResearch === 'object') {
    const wr = data.webResearch;
    if (typeof wr.summary === 'string') wr.summary = sanitizePedagogicalText(wr.summary);
    if (typeof wr.rawContent === 'string') wr.rawContent = sanitizePedagogicalText(wr.rawContent);
    if (Array.isArray(wr.highlights)) {
      wr.highlights = wr.highlights.map(function (h) {
        return sanitizePedagogicalText(typeof h === 'string' ? h : (h && (h.text || h.highlight)) || '');
      }).filter(Boolean);
    }
    if (Array.isArray(wr.connections)) {
      wr.connections = wr.connections.map(sanitizePedagogicalText).filter(Boolean);
    }
  }
  if (typeof data.rawContent === 'string') data.rawContent = sanitizePedagogicalText(data.rawContent);
  if (data.blockPlan && typeof data.blockPlan.rawContent === 'string') {
    data.blockPlan.rawContent = sanitizePedagogicalText(data.blockPlan.rawContent);
  }
  return data;
}

function sanitizeGradePhaseOutput(data) {
  if (!data || typeof data !== 'object') return data;
  var gi = data.gradeInsights;
  if (!gi || typeof gi !== 'object') return data;
  if (typeof gi.rawContent === 'string') gi.rawContent = sanitizePedagogicalText(gi.rawContent);
  ['part1AgePictureHtml', 'archivesSynthesisHtml', 'part2ClassroomIdeasHtml', 'part3CommunityExpansionsHtml'].forEach(function (key) {
    if (typeof gi[key] === 'string') gi[key] = sanitizePedagogicalText(gi[key]);
  });
  ['part1DevelopmentBullets', 'developmentBullets', 'part2ClassroomIdeas', 'part3CommunityIdeas', 'typicalBlocks'].forEach(function (key) {
    if (Array.isArray(gi[key])) {
      gi[key] = gi[key].map(function (item) {
        if (typeof item === 'string') return sanitizePedagogicalText(item);
        if (!item || typeof item !== 'object') return item;
        var next = Object.assign({}, item);
        ['title', 'detail', 'body', 'description', 'text'].forEach(function (field) {
          if (typeof next[field] === 'string') next[field] = sanitizePedagogicalText(next[field]);
        });
        return next;
      });
    }
  });
  if (Array.isArray(gi.globalCurricula)) {
    gi.globalCurricula = gi.globalCurricula.map(function (item) {
      if (typeof item === 'string') return sanitizePedagogicalText(item);
      if (!item || typeof item !== 'object') return item;
      var next = Object.assign({}, item);
      ['title', 'detail', 'body', 'description', 'text'].forEach(function (field) {
        if (typeof next[field] === 'string') next[field] = sanitizePedagogicalText(next[field]);
      });
      return next;
    });
  }
  return data;
}

function coerceServerCurriculumRows(raw) {
  return archiveCoerce.coerceCurriculumRows(raw);
}

function normalizePhaseCInspirationItem(it) {
  if (typeof it === 'string') return { text: sanitizePedagogicalText(it.trim()) };
  if (!it || typeof it !== 'object') return { text: sanitizePedagogicalText(String(it || '').trim()) };
  return {
    text: sanitizePedagogicalText(String(it.text || it.preview || it.detail || it.content || it.body || '').trim()),
    expansion: it.expansion,
  };
}

function normalizePhaseCInspiration(insp, rawFallback) {
  if (typeof insp === 'string' && insp.trim()) {
    return {
      title: 'השראה',
      global: [{ title: 'סיכום', items: [normalizePhaseCInspirationItem(insp)] }],
      podcast: { title: 'תובנות', episodes: [] },
      narrative: [],
    };
  }
  if (!insp || typeof insp !== 'object') {
    if (rawFallback) {
      return normalizePhaseCInspiration({
        title: 'השראה',
        global: [{ title: 'סיכום', items: [{ text: rawFallback }] }],
      });
    }
    return null;
  }

  let global = insp.global;
  if (typeof global === 'string' && global.trim()) {
    global = [{ title: 'סיכום', items: [global.trim()] }];
  } else if (!Array.isArray(global)) {
    if (global && typeof global === 'object') global = [global];
    else global = [];
  }

  global = global.map(function (block, bi) {
    if (typeof block === 'string') {
      return { title: 'בלוק ' + (bi + 1), items: [normalizePhaseCInspirationItem(block)] };
    }
    if (!block || typeof block !== 'object') return { title: '', items: [] };
    let items = block.items;
    if (typeof items === 'string') items = [items];
    if (!Array.isArray(items)) {
      if (items && typeof items === 'object') items = [items];
      else items = [];
    }
    items = items.map(normalizePhaseCInspirationItem).filter(function (it) {
      return String(it.text || '').trim();
    });
    return {
      title: String(block.title || block.heading || ('בלוק ' + (bi + 1))).trim(),
      items: items,
    };
  }).filter(function (b) { return b.items.length; });

  if (!global.length && rawFallback) {
    global = [{ title: 'סיכום', items: [normalizePhaseCInspirationItem(rawFallback)] }];
  }

  const podcastSrc = insp.podcast && typeof insp.podcast === 'object' ? insp.podcast : {};
  const episodes = Array.isArray(podcastSrc.episodes) ? podcastSrc.episodes.map(function (ep) {
    if (!ep || typeof ep !== 'object') {
      const text = String(ep || '').trim();
      return text ? { theme: text, insight: text } : null;
    }
    return {
      theme: sanitizePedagogicalText(String(ep.theme || ep.title || '').trim()),
      insight: sanitizePedagogicalText(String(ep.insight || ep.text || ep.preview || ep.content || '').trim()),
      expansion: ep.expansion,
    };
  }).filter(function (ep) { return ep && (ep.theme || ep.insight); }) : [];

  let narrative = insp.narrative;
  if (typeof narrative === 'string' && narrative.trim()) narrative = [narrative];
  if (!Array.isArray(narrative)) narrative = [];
  narrative = narrative.map(function (n) {
    if (typeof n === 'string') return sanitizePedagogicalText(n.trim());
    if (!n || typeof n !== 'object') return sanitizePedagogicalText(String(n || '').trim());
    return sanitizePedagogicalText(String(n.text || n.preview || n.content || '').trim());
  }).filter(Boolean);

  return {
    title: sanitizePedagogicalText(String(insp.title || 'השראה').trim()),
    global: global,
    podcast: {
      title: sanitizePedagogicalText(String(podcastSrc.title || 'תובנות').trim()),
      episodes: episodes,
    },
    narrative: narrative,
    rawContent: sanitizePedagogicalText(String(insp.rawContent || rawFallback || '').trim()) || undefined,
  };
}

function normalizePhaseCCurriculumRow(row, index, rawFallback) {
  if (row == null) return null;
  if (typeof row === 'string') {
    const text = row.trim();
    if (!text) return null;
    return { day: index + 1, topic: text, content: text, art: '', hint: '' };
  }
  if (typeof row !== 'object') return null;
  let day = parseInt(row.day || row.dayNumber || row.n || row.number || row.index, 10);
  if (!day || isNaN(day)) day = index + 1;
  const topic = sanitizePedagogicalText(String(
    row.topic || row.title || row.theme || row.heading || row.subject || row.name || ''
  ).trim());
  const content = sanitizePedagogicalText(String(
    row.content || row.story || row.lesson || row.lessonContent ||
    row.text || row.body || row.description || row.narrative ||
    row['תוכן וסיפור'] || row.tochen || row.mainLesson || ''
  ).trim());
  const art = sanitizePedagogicalText(String(
    row.art || row.artActivity || row.craft || row.artAndCraft ||
    row.handwork || row.artCraft || row['אמנות ומעשה'] || row.amanut || ''
  ).trim());
  const split = archiveCoerce.splitCurriculumDayNarrativeFields(
    archiveCoerce.curriculumPlainForSplit(content),
    archiveCoerce.curriculumPlainForSplit(art)
  );
  const hint = sanitizePedagogicalText(String(row.hint || row.journey || row.note || row.notes || row.pedagogyHint || '').trim());
  if (!topic && !split.content && !split.art && !hint) {
    if (rawFallback) {
      return { day: day, topic: 'יום ' + day, content: rawFallback, art: '', hint: '' };
    }
    return null;
  }
  return {
    day: day,
    topic: topic || ('יום ' + day),
    content: split.content || content || rawFallback || '',
    art: split.art || '',
    hint: hint,
    contentExpansion: row.contentExpansion && typeof row.contentExpansion === 'object' ? row.contentExpansion : undefined,
    artExpansion: row.artExpansion && typeof row.artExpansion === 'object' ? row.artExpansion : undefined,
    hintExpansion: row.hintExpansion && typeof row.hintExpansion === 'object' ? row.hintExpansion : undefined,
  };
}

function normalizePhaseCCurriculum(raw, rawFallback) {
  let rows = coerceServerCurriculumRows(raw);
  if (!rows.length && typeof raw === 'string' && raw.trim()) {
    rows = archiveCoerce.parseCurriculumFromText(raw);
    if (!rows.length) rows = [{ content: raw.trim() }];
  }
  if (!rows.length && rawFallback) {
    rows = archiveCoerce.parseCurriculumFromText(rawFallback);
  }
  rows = rows.map(function (row, i) {
    return normalizePhaseCCurriculumRow(row, i, rawFallback);
  }).filter(Boolean).slice(0, 15);

  while (rows.length < 15) {
    const day = rows.length + 1;
    rows.push({
      day: day,
      topic: 'יום ' + day,
      content: rawFallback || '',
      art: '',
      hint: '',
    });
  }
  return rows;
}

function normalizePhaseCSources(sources) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    return { books: [], articles: [], websites: [] };
  }
  return {
    books: Array.isArray(sources.books) ? sources.books : [],
    articles: Array.isArray(sources.articles) ? sources.articles : [],
    websites: Array.isArray(sources.websites) ? sources.websites : [],
  };
}

function sanitizePhaseCOutput(data, body) {
  if (!data || typeof data !== 'object') return data;
  const cTab = resolvePhaseCTab(body || {});
  const rawFallback = String(
    (data.blockPlan && data.blockPlan.rawContent) ||
    data.rawText ||
    data.rawContent ||
    ''
  ).trim();

  if (!data.blockPlan || typeof data.blockPlan !== 'object') {
    data.blockPlan = {};
  }
  const bp = data.blockPlan;

  if (cTab === 'inspiration') {
    delete bp.theory;
    delete bp.curriculum;
    delete bp.sources;
    bp.inspiration = normalizePhaseCInspiration(bp.inspiration, rawFallback);
    if (!Array.isArray(data.gallery)) data.gallery = [];
    data.gallery = sanitizePinterestGallery(data.gallery, body);
    delete data.enrichment_links;
    delete data.pedagogicalResources;
  } else if (cTab === 'curriculum') {
    delete bp.theory;
    delete bp.inspiration;
    delete bp.sources;
    delete data.gallery;
    delete data.pedagogicalResources;
    delete data.enrichment_links;
    bp.curriculum = normalizePhaseCCurriculum(bp.curriculum, rawFallback);
  }

  return data;
}

function validateTopicBlockPlan(blockPlan) {
  if (!blockPlan || typeof blockPlan !== 'object') return false;
  if (String(blockPlan.rawContent || '').trim()) return true;
  if (!blockPlan.theory || typeof blockPlan.theory !== 'object') return false;
  if (!Array.isArray(blockPlan.theory.sections) || !blockPlan.theory.sections.length) return false;
  return blockPlan.theory.sections.some(function (sec) {
    return sec && typeof sec === 'object' && (
      String(sec.content || '').trim() || String(sec.heading || '').trim()
    );
  });
}

function validatePhaseCBlockPlan(blockPlan, cTab) {
  if (!blockPlan || typeof blockPlan !== 'object') return false;
  if (String(blockPlan.rawContent || '').trim()) return true;
  if (cTab === 'inspiration') {
    if (!blockPlan.inspiration || typeof blockPlan.inspiration !== 'object') return false;
    if (String(blockPlan.inspiration.rawContent || '').trim()) return true;
    if (!Array.isArray(blockPlan.inspiration.global) || !blockPlan.inspiration.global.length) return false;
    return blockPlan.inspiration.global.some(function (block) {
      return block && Array.isArray(block.items) && block.items.length;
    });
  }
  if (!Array.isArray(blockPlan.curriculum) || blockPlan.curriculum.length !== 15) return false;
  for (let i = 0; i < blockPlan.curriculum.length; i++) {
    const day = blockPlan.curriculum[i];
    if (!day || typeof day !== 'object') return false;
    if (!day.topic && !day.content && !day.art) return false;
  }
  return true;
}

function buildPerplexitySearchSystemPrompt() {
  return (
    'You are a factual Waldorf / Steiner-Waldorf pedagogy research assistant. ' +
    'Perform live web search and return accurate, well-sourced pedagogical research in Hebrew. ' +
    'Include HTTPS reference links for major claims from open web search results only. ' +
    'Be comprehensive — cover child development, main-lesson structure, classroom practice, and curriculum context.'
  );
}

function finalizePerplexitySearchUserPrompt(body, prompt) {
  if (!pedagogicalScope.isPedagogicalScopeOverridden(body)) return prompt;
  const blocks = pedagogicalScope.buildScopeOverridePromptBlocks(body);
  return String(prompt || '') + (blocks.searchUser || '');
}

function buildPerplexitySearchUserPrompt(body) {
  const phase = body.phase;
  const gradeId = resolvedGradeId(body);
  const gradeLabel = body.gradeLabel || '';
  const age = body.age || '';
  const topic = String(body.topic || body.gradeLabel || '').trim();

  if (phase === 'grade') {
    return (
      'Perform a factual web search on Waldorf/Steiner anthroposophic child development.\n' +
      'Grade: ' + gradeLabel + ' (id: ' + gradeId + ', age ' + age + ')\n\n' +
      'Return a detailed Hebrew research report with:\n' +
      '1. Age picture and developmental characteristics (body/soul/spirit)\n' +
      '2. Pedagogical emphases and typical main-lesson blocks for this grade\n' +
      '3. Classroom practice and community/parent aspects\n' +
      '4. Global Waldorf curriculum references\n' +
      '5. A numbered "Sources" section with HTTPS reference URLs for every major claim'
    );
  }

  if (phase === 'chat_followup') {
    const question = String(body.userMessage || '').trim();
    return (
      'Perform a factual web search to answer a Waldorf teacher question.\n' +
      'Teacher question: «' + question + '»\n\n' +
      'Return a detailed Hebrew research report grounded in verified Rudolf Steiner, anthroposophic, and Waldorf pedagogical sources.\n' +
      'Do NOT restrict the search to any particular grade unless the teacher explicitly mentions one in the question.\n' +
      'Cover practical classroom guidance relevant to the question.\n' +
      'Include a numbered "Sources" section with HTTPS reference URLs for every major claim.'
    );
  }

  if (phase === 'pedagogy_deep_dive') {
    const title = String(body.activityTitle || '').trim();
    const preview = String(body.activityPreview || '').trim();
    if (isAgeExpansionRequest(body)) {
      return (
        'Perform a focused factual web search on Waldorf/Steiner anthroposophic developmental-age characteristics.\n' +
        'Grade: ' + gradeLabel + ' (id: ' + gradeId + ', age ' + age + ')\n' +
        'STRICT: Do NOT search for, mention, or tailor to any main-lesson block topic — age-stage developmental framework ONLY.\n' +
        'Age-stage pedagogical idea to expand: «' + title + '»\n' +
        'Preview / teacher context: ' + preview + '\n' +
        'Pedagogical section: ' + (body.activitySubtype || '') + '\n\n' +
        'Return a detailed Hebrew research report with:\n' +
        '1. Anthroposophic developmental picture for THIS grade (body/soul/spirit) as it relates to this single idea\n' +
        '2. Practical classroom implementation for this age stage only — no block-topic framing\n' +
        '3. Concrete step-by-step teacher guidance, materials, and classroom rhythm\n' +
        '4. Named anthroposophic/Waldorf age-stage books and lectures for inspiration\n' +
        '5. Parent/community aspects for this developmental stage when relevant\n' +
        '6. A numbered "Sources" section with HTTPS reference URLs for every major claim'
      );
    }
    return (
      'Perform a focused factual web search for a Waldorf/Steiner pedagogical deep-dive expansion on ONE specific classroom idea.\n' +
      'Grade: ' + gradeLabel + ' (id: ' + gradeId + ', age ' + age + ')\n' +
      'Main-lesson block topic: «' + topic + '»\n' +
      'Sub-topic / activity to expand: «' + title + '»\n' +
      'Preview / teacher context: ' + preview + '\n' +
      'Activity type: ' + (body.activityType || '') + ' / ' + (body.activitySubtype || '') + '\n' +
      'Day in block (if any): ' + (body.dayNumber || 'n/a') + '\n\n' +
      'Return a detailed Hebrew research report with:\n' +
      '1. Practical classroom implementation for THIS single idea at this grade, tied to the block topic\n' +
      '2. Anthroposophic developmental context (Steiner age picture — grade-locked)\n' +
      '3. Concrete step-by-step teacher guidance, materials, and classroom rhythm\n' +
      '4. Named books, articles, and Waldorf projects for inspiration\n' +
      '5. Parent/community aspects when relevant\n' +
      '6. A numbered "Sources" section with HTTPS reference URLs for every major claim'
    );
  }

  if (phase === 'archive_summary') {
    const title = String(body.sourceTitle || '').trim();
    const author = String(body.sourceAuthor || '').trim();
    const description = String(body.sourceDescription || '').trim();
    return (
      'Perform a focused factual web search for a deep pedagogical summary of ONE Waldorf/anthroposophic source.\n' +
      'Grade context: ' + gradeLabel + ' (id: ' + gradeId + ', age ' + age + ')\n' +
      'Block topic: «' + topic + '»\n' +
      'Source title: «' + title + '»\n' +
      'Author/publisher: ' + author + '\n' +
      'Source type: ' + (body.sourceType || 'article') + '\n' +
      'Description: ' + description + '\n\n' +
      'Return a detailed Hebrew research report with:\n' +
      '1. Core pedagogical message of this source for Waldorf teachers\n' +
      '2. Relevance to the current grade and block topic\n' +
      '3. Practical classroom angles and lesson applications\n' +
      '4. Key pedagogical points and Steiner/anthroposophic connections\n' +
      '5. A numbered "Sources" section with HTTPS reference URLs for every major claim'
    );
  }

  if (phase === 'phase_c') {
    const cTab = resolvePhaseCTab(body);
    if (cTab === 'inspiration') {
      const siteQueries = waldorfWebSeed.buildWaldorfSiteSearchQueries(topic, gradeLabel);
      return (
        'Perform a deep, exhaustive factual web search for Waldorf/Steiner INSPIRATION & BACKGROUND MATERIAL.\n' +
        'Grade: ' + gradeLabel + ' (id: ' + gradeId + ', age ' + age + ')\n' +
        'Block topic: «' + topic + '»\n' +
        'Grade context: ' + (body.gradeContext || '') + '\n\n' +
        waldorfWebSeed.buildWaldorfWebSeedInstruction(topic, gradeLabel) + '\n\n' +
        'SUGGESTED OPEN-WEB SEARCH QUERIES:\n' +
        siteQueries.map(function (q, i) { return (i + 1) + '. ' + q; }).join('\n') + '\n\n' +
        'Return a detailed Hebrew research report with:\n' +
        '1. Rich inspiration themes: stories, metaphors, global Waldorf perspectives, podcast-worthy insights\n' +
        '2. Narrative/metaphor material suited to currentGrade main-lesson consciousness\n' +
        '3. Pinterest/visual inspiration search phrases — clean unquoted English only: Waldorf Class N {topic}; max 2–4 vetted entries (e.g. Waldorf Class 8 revolutions)\n' +
        '4. Priority: «מסעות בחינוך», Alon Yerushalmy, educationpace.com only when genuinely relevant — weave insights into narrative, never as a sources list\n' +
        'Do NOT produce a 15-day daily breakdown, bibliography, book lists, website lists, or any "מקורות (Sources)" section — curriculum is a separate Phase C tab.'
      );
    }
    return (
      'Perform a deep, exhaustive factual web search for a Waldorf 15-DAY MAIN-LESSON BLOCK CURRICULUM.\n' +
      'Grade: ' + gradeLabel + ' (id: ' + gradeId + ', age ' + age + ')\n' +
      'Block topic: «' + topic + '»\n' +
      'Grade context: ' + (body.gradeContext || '') + '\n\n' +
      'Return a detailed Hebrew research report with:\n' +
      '1. A complete 15-day arc (days 1–15) with daily themes, lesson flows, and artistic activities\n' +
      '2. Age-appropriate main-lesson rhythm, recall, and closing for each day\n' +
      '3. Hands-on art/craft, movement, and chalkboard imagery per day\n' +
      '4. Anthroposophic developmental framing for currentGrade only\n' +
      'Focus on rich pedagogical narrative for תוכן וסיפור and אמנות ומעשה per day — NO bibliography, book lists, website lists, or "מקורות (Sources)" section.\n' +
      'Do NOT produce inspiration anthology — that is a separate Phase C tab.'
    );
  }

  if (phase === 'topic') {
    return (
      'Perform a factual web search on Waldorf main-lesson block planning — PEDAGOGICAL ESSENCE ONLY.\n' +
      'Grade: ' + gradeLabel + ' (id: ' + gradeId + ', age ' + age + ')\n' +
      'Block topic: «' + topic + '»\n' +
      'Grade context: ' + (body.gradeContext || '') + '\n\n' +
      'Return a detailed Hebrew research report with:\n' +
      '1. Waldorf pedagogical principles and anthroposophic developmental context for this topic at this grade level\n' +
      '2. Core pedagogical essence and overview of the main-lesson block (biography, artistic integration, classroom rhythm)\n' +
      '3. Grade-specific connections and pedagogical highlights\n' +
      'Do NOT structure as a 15-day curriculum, inspiration anthology, or teacher resource bibliography — those load via phase_c.\n' +
      '4. A numbered "Sources" section with HTTPS reference URLs for every major claim (for internal synthesis only — not copied into Phase B user output)'
    );
  }

  return (
    'Perform a factual web search on Waldorf main-lesson block planning.\n' +
    'Grade: ' + gradeLabel + ' (id: ' + gradeId + ', age ' + age + ')\n' +
    'Block topic: «' + topic + '»\n' +
    'Grade context: ' + (body.gradeContext || '') + '\n\n' +
    'Return a detailed Hebrew research report grounded in verified Waldorf/anthroposophic sources.'
  );
}

function buildPerplexityResearchBlock(rawPayload) {
  if (!rawPayload || !String(rawPayload.content || '').trim()) return '';
  const citations = Array.isArray(rawPayload.citations) ? rawPayload.citations : [];
  return (
    '\n=== PERPLEXITY WEB RESEARCH (PRIMARY FACTUAL SOURCE — MANDATORY) ===\n' +
    'The following live web research was retrieved via Perplexity Sonar. Use it as the factual foundation.\n\n' +
    String(rawPayload.content).trim() + '\n' +
    (citations.length
      ? '\nReference URLs from Perplexity:\n' + citations.map(function (url, i) {
        return (i + 1) + '. ' + url;
      }).join('\n') + '\n'
      : '') +
    '=== END PERPLEXITY WEB RESEARCH ===\n\n'
  );
}

async function fetchOrRunPerplexityResearch(body, logContext) {
  const cachedRaw = await cacheDb.getRawPerplexityCache(body);
  if (cachedRaw && String(cachedRaw.content || '').trim()) {
    console.log('[hybrid] raw Perplexity cache HIT for', body.phase);
    return cachedRaw;
  }

  const ip = (logContext && logContext.ip) || 'unknown';
  const action = (logContext && logContext.action) || buildActionLabel(body);
  logPerplexityCall(ip, action, 'Initiated');

  // SSE streaming keeps reverse proxies alive during long Sonar research (on-demand expansions often exceed 60s).
  const usePerplexityStream = isOnDemandExpansionPhase(body) || isDecoupledGenerationPhase(body);

  let searchResult;
  try {
    searchResult = await perplexityClient.callPerplexitySearch({
      messages: [
        { role: 'system', content: buildPerplexitySearchSystemPrompt() },
        { role: 'user', content: finalizePerplexitySearchUserPrompt(body, buildPerplexitySearchUserPrompt(body)) },
      ],
      stream: usePerplexityStream,
    });
    logPerplexityCall(ip, action, 'Success');
  } catch (searchErr) {
    logPerplexityCall(ip, action, 'Failed');
    throw searchErr;
  }

  const rawPayload = {
    content: searchResult.content,
    citations: searchResult.citations || [],
    searchedAt: new Date().toISOString(),
    topic: body.topic || null,
    gradeId: resolvedGradeId(body) || null,
    model: perplexityClient.PERPLEXITY_SEARCH_MODEL,
  };

  try {
    const savedKey = await cacheDb.setRawPerplexityCache(body, rawPayload);
    if (savedKey) {
      console.log('[hybrid] raw Perplexity SAVED', body.phase, savedKey.slice(0, 12));
    }
  } catch (saveErr) {
    console.warn('[hybrid] raw Perplexity save failed:', saveErr.message || saveErr);
  }

  return rawPayload;
}

/** Perplexity sonar-pro chat completions — structured JSON synthesis from Sonar research. */
async function callPerplexity(apiKey, userPrompt, extraSystem, options) {
  const opts = options || {};
  const systemBuilder = typeof opts.systemPrompt === 'function' ? opts.systemPrompt : waldorfSystemPrompt;
  const systemContent = systemBuilder(extraSystem || '');
  const temperature = opts.temperature !== undefined ? opts.temperature : 0.35;
  const key = apiKey || perplexityClient.resolveApiKey();
  if (!key) {
    throw new Error('PERPLEXITY_API_KEY is not configured');
  }

  return perplexityClient.callPerplexityChat({
    apiKey: key,
    temperature: temperature,
    stream: opts.stream,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userPrompt },
    ],
  });
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

function validatePhaseResult(phase, data, body) {
  if (!data || typeof data !== 'object') return false;
  if (phase === 'grade') {
    if (!data.gradeInsights || typeof data.gradeInsights !== 'object') return false;
    if (String(data.gradeInsights.rawContent || '').trim()) return true;
    return Boolean(cacheDb.normalizeGradeResultForCache(data));
  }
  if (phase === 'topic') {
    if (data.blockPlan && String(data.blockPlan.rawContent || '').trim()) return true;
    if (validateTopicBlockPlan(data.blockPlan)) return true;
    if (data.webResearch && String(data.webResearch.summary || '').trim()) return true;
    return false;
  }
  if (phase === 'phase_c') {
    const cTab = resolvePhaseCTab(body || {});
    if (!cTab || !data.blockPlan) return false;
    return validatePhaseCBlockPlan(data.blockPlan, cTab);
  }
  if (phase === 'chat_followup') {
    return Boolean(cacheDb.extractChatAnswerText(data));
  }
  if (phase === 'pedagogy_deep_dive') return hasPedagogyDeepDiveContent(data.pedagogyDeepDive);
  if (phase === 'archive_search') return Boolean(data.archiveSearch);
  if (phase === 'archive_summary') return Boolean(data.archiveSummary || data.pedagogyDeepDive);
  if (phase === 'drive') return Boolean(data.driveMerge);
  if (phase === 'test') return data.ok === true;
  return true;
}

const MODEL_PARSE_MAX_ATTEMPTS = 2;
const JSON_RETRY_SYSTEM_SUFFIX_TOPIC =
  ' CRITICAL RETRY: Your previous reply was rejected — invalid JSON or missing required fields. ' +
  'For topic phase (Phase B): blockPlan MUST contain ONLY theory (title + sections with content). ' +
  'Do NOT include inspiration, curriculum, sources, bibliography, gallery, URLs, or [N] reference brackets. ' +
  'Reply with raw JSON only. First character MUST be { and last character MUST be }. ' +
  'No ```json fences, no Hebrew/English preamble, no trailing commas.';
const JSON_RETRY_SYSTEM_SUFFIX_PHASE_C =
  ' CRITICAL RETRY: Your previous reply was rejected — invalid JSON or missing required fields. ' +
  'For phase_c inspiration: return blockPlan.inspiration + gallery pin phrases ONLY — NO sources, NO enrichment_links, NO pedagogicalResources, NO URLs. ' +
  'For phase_c curriculum: return curriculum 15 days only. ' +
  'Do NOT include theory.sections or duplicate Phase B essence text. ' +
  'Reply with raw JSON only. First character MUST be { and last character MUST be }. ' +
  'No ```json fences, no Hebrew/English preamble, no trailing commas.';
const JSON_RETRY_SYSTEM_SUFFIX =
  JSON_RETRY_SYSTEM_SUFFIX_TOPIC;
const GENERIC_GENERATION_ERROR = 'לא הצלחנו ליצור את התוכן הפדגוגי. נסו שוב בעוד רגע.';

function isNonRetriableApiClientError(err) {
  const msg = err instanceof Error ? err.message : String(err || '');
  const statusCode = err && err.statusCode;
  if (statusCode === 429 || statusCode === 400 || statusCode === 403) return true;
  return /Gemini error (429|400|403)\b/i.test(msg)
    || /\berror 429\b/i.test(msg)
    || /\berror 400\b/i.test(msg)
    || /rate limit|quota exceeded|resource exhausted|too many requests|high demand|retry in [0-9.]+s/i.test(msg)
    || /invalid argument|INVALID_ARGUMENT|bad request/i.test(msg);
}

function isRetriablePerplexityCallError(err) {
  if (isNonRetriableApiClientError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err || '');
  return !/API key|unauthorized|GEMINI_API_KEY|PERPLEXITY_API_KEY|not configured|Method not allowed/i.test(msg);
}

function rethrowApiClientError(err, fallbackMessage) {
  const msg = err instanceof Error ? err.message : String(err || '');
  if (err instanceof Error && err.statusCode) throw err;
  const next = new Error(msg || fallbackMessage);
  if (isNonRetriableApiClientError(err)) {
    if (/Gemini error 429|\berror 429\b|rate limit|quota exceeded|too many requests|high demand/i.test(msg)) {
      next.statusCode = 429;
    } else if (/Gemini error 400|\berror 400\b|invalid argument|INVALID_ARGUMENT|bad request/i.test(msg)) {
      next.statusCode = 400;
    }
  }
  throw next;
}

/**
 * Core phases (grade / topic / phase_c): Perplexity Sonar research → Perplexity JSON synthesis.
 */
async function fetchPerplexityStructuredWithRetry(body, apiKey, userPrompt, extraSystem, perplexityOptions, logContext) {
  const phase = body.phase;
  const ip = (logContext && logContext.ip) || 'unknown';
  const action = (logContext && logContext.action) || buildActionLabel(body);
  let lastRaw = '';

  let rawPayload;
  try {
    rawPayload = await fetchOrRunPerplexityResearch(body, logContext);
  } catch (searchErr) {
    const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
    console.error('[perplexity] Sonar research failed for phase', phase, ':', msg);
    throw new Error(msg || 'שגיאה בחיפוש Perplexity — נסו שוב בעוד רגע.');
  }

  const synthesisPrompt = buildPerplexityResearchBlock(rawPayload) + userPrompt;

  for (let attempt = 1; attempt <= MODEL_PARSE_MAX_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    const retrySuffix = isRetry
      ? (phase === 'phase_c' ? JSON_RETRY_SYSTEM_SUFFIX_PHASE_C : JSON_RETRY_SYSTEM_SUFFIX_TOPIC)
      : '';
    const useParseFallback = attempt >= MODEL_PARSE_MAX_ATTEMPTS;

    let raw;
    try {
      if (isRetry) {
        console.warn('[perplexity] Silent retry for phase', phase, '(attempt', attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + ')');
      }
      console.log('[perplexity] Structured synthesis for phase', phase, '(attempt', attempt + ')');
      logPerplexityCall(ip, action, 'Initiated');
      raw = await callPerplexity(apiKey, synthesisPrompt, extraSystem + retrySuffix, {
        temperature: isRetry ? 0.2 : 0.35,
        systemPrompt: buildPerplexitySynthesisSystemPrompt(body),
      });
      lastRaw = raw;
      logPerplexityCall(ip, action, 'Success');
    } catch (aiErr) {
      logPerplexityCall(ip, action, 'Failed');
      const msg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      console.error('[perplexity] synthesis failed for phase', phase, '(attempt', attempt + '):', msg);
      if (attempt < MODEL_PARSE_MAX_ATTEMPTS && isRetriablePerplexityCallError(aiErr)) {
        continue;
      }
      rethrowApiClientError(aiErr, 'שגיאה בקריאה ל-Perplexity — נסו שוב בעוד רגע.');
    }

    let data;
    try {
      data = cleanAndParseJSON(raw, {
        phase: phase,
        context: body,
        fallbackOnError: useParseFallback,
      });
    } catch (parseErr) {
      const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      console.error(
        '[perplexity] JSON parse failed for phase',
        phase,
        '(attempt ' + attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + '):',
        parseMsg
      );
      console.error('Model output preview:', String(raw).slice(0, 600));
      if (!useParseFallback) continue;
      data = buildModelParseFallback(phase, raw, body);
    }

    if (data && data._parseFallback) {
      console.warn('[perplexity] Using parse fallback for phase', phase);
      return cacheDb.stampPerplexityOnlyMetadata(data);
    }

    if (phase === 'topic' && data && !data._parseFallback) {
      data = sanitizeTopicPhaseOutput(data);
    }
    if (phase === 'grade' && data && !data._parseFallback) {
      data = sanitizeGradePhaseOutput(data);
    }
    if (phase === 'phase_c' && data && !data._parseFallback) {
      data = sanitizePhaseCOutput(data, body);
      if (resolvePhaseCTab(body) === 'inspiration') {
        data = await attachGeminiEnrichmentLinks(data, body);
      }
    }

    if (!validatePhaseResult(phase, data, body)) {
      console.error(
        '[perplexity] Parsed JSON missing required fields for phase',
        phase,
        '(attempt ' + attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + ')'
      );
      console.error('Model output preview:', String(raw).slice(0, 600));
      if (!useParseFallback) continue;
      console.warn('[perplexity] Validation failed — returning parse fallback for phase', phase);
      return cacheDb.stampPerplexityOnlyMetadata(buildModelParseFallback(phase, raw, body));
    }

    if (isRetry) {
      console.log('[perplexity] Silent retry succeeded for phase', phase);
    }
    return cacheDb.stampPerplexityOnlyMetadata(data);
  }

  return cacheDb.stampPerplexityOnlyMetadata(buildModelParseFallback(phase, lastRaw || '', body));
}

/**
 * Fetch from Perplexity, parse model JSON, and validate phase shape.
 * On parse/validation failure, silently retries once with a stricter JSON system prompt
 * while the client request stays open (spinner remains active).
 */
async function fetchParsedModelWithRetry(body, apiKey, userPrompt, extraSystem, perplexityOptions, isChatFollowup, logContext) {
  if (isPedagogicalChatPhase(body)) {
    return chatApi.fetchPedagogicalChat(body, userPrompt, extraSystem);
  }
  if (isPerplexityRawExpansionPhase(body)) {
    return fetchPerplexityOnlyOnDemand(body, logContext);
  }
  if (isDecoupledGenerationPhase(body)) {
    return fetchPerplexityStructuredWithRetry(
      body, apiKey, userPrompt, extraSystem, perplexityOptions, logContext
    );
  }

  const phase = body.phase;
  const baseOpts = perplexityOptions || {};
  const ip = (logContext && logContext.ip) || 'unknown';
  const action = (logContext && logContext.action) || buildActionLabel(body);
  let lastPreview = '';
  let lastRaw = '';

  for (let attempt = 1; attempt <= MODEL_PARSE_MAX_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    const retrySuffix = isRetry && !isChatFollowup
      ? (phase === 'phase_c' ? JSON_RETRY_SYSTEM_SUFFIX_PHASE_C : JSON_RETRY_SYSTEM_SUFFIX_TOPIC)
      : '';
    const useParseFallback = attempt >= MODEL_PARSE_MAX_ATTEMPTS;

    let raw;
    try {
      if (isRetry) {
        console.warn('[generate] Silent Perplexity retry for phase', phase, '(attempt', attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + ')');
      }
      logPerplexityCall(ip, action, 'Initiated');
      raw = await callPerplexity(apiKey, userPrompt, extraSystem + retrySuffix, {
        temperature: isRetry ? 0.2 : 0.35,
        systemPrompt: typeof baseOpts.systemPrompt === 'function' ? baseOpts.systemPrompt : waldorfSystemPrompt,
      });
      lastRaw = raw;
      logPerplexityCall(ip, action, 'Success');
    } catch (aiErr) {
      logPerplexityCall(ip, action, 'Failed');
      const msg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      console.error('[generate] Perplexity call failed for phase', phase, '(attempt', attempt + '):', msg);
      if (attempt < MODEL_PARSE_MAX_ATTEMPTS && isRetriablePerplexityCallError(aiErr)) {
        continue;
      }
      rethrowApiClientError(aiErr, 'שגיאה בקריאה ל-AI — נסו שוב בעוד רגע.');
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

    if (phase === 'topic' && data && !data._parseFallback) {
      data = sanitizeTopicPhaseOutput(data);
    }
    if (phase === 'grade' && data && !data._parseFallback) {
      data = sanitizeGradePhaseOutput(data);
    }
    if (phase === 'phase_c' && data && !data._parseFallback) {
      data = sanitizePhaseCOutput(data, body);
    }

    if (!validatePhaseResult(phase, data, body)) {
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

function resolveApiKey(body) {
  if (body && isPedagogicalChatPhase(body)) {
    return chatApi.resolveChatApiKey();
  }
  return perplexityClient.resolveApiKey() || null;
}

function missingKeyError(body) {
  if (body && isPedagogicalChatPhase(body)) {
    return chatApi.missingChatApiKeyError();
  }
  return 'מפתח Perplexity לא מוגדר. הוסיפו PERPLEXITY_API_KEY ב-Render → Environment ופרסמו מחדש.';
}

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
  });
}

const MISSING_KEY_ERROR =
  'מפתח Perplexity לא מוגדר. הוסיפו PERPLEXITY_API_KEY ב-Render → Environment ופרסמו מחדש.';

function isNonBlockingSubscriptionDbError(err) {
  const msg = String((err && err.message) || err || '');
  if (authContext.isLocalDevServer() && /invalid input syntax for type uuid/i.test(msg)) {
    return true;
  }
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
  return phase === 'topic';
}

/** Follow-up asks for more materials / deeper ideas — skip community re-match and alert loop. */
function isChatPedagogicalExpansionRequest(body) {
  return chatApi.shouldTreatChatAsPedagogicalExpansion(body);
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

/** Pedagogical chat: global community pre-check — uses only the teacher's message, not UI grade/topic. */
async function probeGlobalCommunityForChat(body) {
  const userMsg = String((body && body.userMessage) || '').trim();
  if (!userMsg) {
    return { matches: [], count: 0, query: '', matchMethod: 'none', scope: 'global' };
  }

  try {
    const result = await cacheDb.probeCommunityGlobalSearch(userMsg, {
      userMessage: userMsg,
      includeFolderBrief: false,
      limit: 8,
    });

    if (result.count > 0 && result.matchMethod) {
      console.log('[chat] global community match via', result.matchMethod, '—', result.count, 'hit(s)');
    } else {
      console.log('[chat] global community scan — no match for «' + userMsg.slice(0, 80) + '»');
    }

    return Object.assign({}, result, { scope: 'global', query: userMsg });
  } catch (probeErr) {
    console.warn('[chat] global community probe failed:', probeErr.message || probeErr);
    return { matches: [], count: 0, query: userMsg, matchMethod: 'none', scope: 'global' };
  }
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
  const enableSemantic = false;
  const baseOpts = {
    query: resolved.query,
    topic: resolved.topic,
    userMessage: resolved.userMessage,
    gradeId: gradeId,
    limit: 8,
    semanticFallback: enableSemantic,
    globalSemantic: false,
    recursiveDeepScan: true,
    includeFolderBrief: body.phase !== 'chat_followup',
    phase: body.phase || '',
  };
  try {
    let result = await cacheDb.findCommunityMaterials(baseOpts);
    if (result.count > 0 && result.matchMethod) {
      console.log('[community] probe matched via', result.matchMethod, '—', result.count, 'material(s)');
    }
    return result;
  } catch (probeErr) {
    console.warn('[community] probe failed:', probeErr.message || probeErr);
    return { matches: [], count: 0, query: '', matchMethod: 'none' };
  }
}

function attachCommunityMeta(meta, communityProbe, options) {
  const base = meta && typeof meta === 'object' ? Object.assign({}, meta) : {};
  const opts = options && typeof options === 'object' ? options : {};
  const rawMatches = (communityProbe && communityProbe.matches) || [];
  base.communityMatches = rawMatches.map(function (match) {
    return cacheDb.withCatalogNavigationFields(match);
  });
  base.communityMatchCount = (communityProbe && communityProbe.count) || 0;
  if (communityProbe && communityProbe.query) base.communityQuery = communityProbe.query;
  if (communityProbe && communityProbe.matchMethod) base.communityMatchMethod = communityProbe.matchMethod;
  if (opts.chatPromptMode) {
    base.chatPromptMode = opts.chatPromptMode;
    base.skipCommunityAlert = true;
  } else if (
    opts.chatContinuation === true ||
    (communityProbe && communityProbe.matchMethod === 'skipped_expansion')
  ) {
    base.skipCommunityAlert = true;
  }
  if (opts.isFirstChatTurn === false) {
    base.isFirstChatTurn = false;
    base.chatContinuation = true;
    base.skipCommunityAlert = true;
  } else if (opts.isFirstChatTurn === true) {
    base.isFirstChatTurn = true;
    base.chatContinuation = false;
  }
  return base;
}

/** Quick cache probe — free-tier limits apply only on live (cache-miss) searches. */
async function probeWouldServeFromCache(body) {
  if (!body || body.skipCache || body.phase === 'chat_followup' || body.phase === 'test') {
    return false;
  }
  try {
    if (body.phase === 'grade') {
      cacheDb.normalizeGradeCacheRequest(body);
    }
    const cacheOpts = isArchiveOnlyLookup(body) ? { requireEnhanced: false } : {};
    const cached = await cacheDb.getCachedResult(body, cacheOpts);
    if (cached) return true;
    if (body.phase === 'topic') {
      const suggestion = await cacheDb.findArchiveTopicSuggestion({
        topic: body.topic,
        gradeId: body.currentGrade ?? body.gradeId,
      });
      if (suggestion && suggestion.matchType === 'exact' && suggestion.resultData) {
        const serveArchive = isArchiveOnlyLookup(body)
          || cacheDb.isEnhancedCachedPayload('topic', suggestion.resultData);
        if (serveArchive) return true;
      }
    }
  } catch (probeErr) {
    console.warn('[generate] cache probe failed:', probeErr.message || probeErr);
  }
  return false;
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
  normalizeRequestPhase(parsedBody);
  if (parsedBody.phase === 'pedagogy_deep_dive') {
    normalizeExpansionRequest(parsedBody);
  }
  if (parsedBody.phase === 'phase_c' && !resolvePhaseCTab(parsedBody)) {
    const err = new Error('phase_c requires cTab: inspiration or curriculum');
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
  const archiveOnlyLookup = isArchiveOnlyLookup(parsedBody);
  const apiKey = resolveApiKey(parsedBody);
  if (!apiKey && !archiveOnlyLookup && !isGeminiEnrichmentPhase(parsedBody)) {
    const err = new Error(missingKeyError(parsedBody));
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
      const cacheWillHit = await probeWouldServeFromCache(parsedBody);
      if (!cacheWillHit) {
        await subscriptionApi.assertSearchAllowedFromRequest(reqShape);
      }
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
    !result.meta.communityRouted &&
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
  normalizeRequestPhase(body);
  pedagogicalScope.normalizePedagogicalScopeOverride(body);
  if (body.phase === 'phase_c' && !resolvePhaseCTab(body)) {
    const err = new Error('phase_c requires cTab: inspiration or curriculum');
    err.statusCode = 400;
    throw err;
  }
  if (body.phase === 'pedagogy_deep_dive') {
    normalizeExpansionRequest(body);
    if (isAgeExpansionRequest(body)) {
      try {
        const gradePrior = await cacheDb.lookupGradeCachedContext(body);
        if (gradePrior) {
          body.priorGradeCache = gradePrior;
          console.log('[age_extension] grade context loaded', gradePrior.cacheKey.slice(0, 12));
        }
      } catch (gradeCtxErr) {
        console.warn('[age_extension] grade context lookup failed:', gradeCtxErr.message || gradeCtxErr);
      }
    }
  }

  const scopeMismatch = pedagogicalScope.isPedagogicalScopeOverridden(body)
    ? null
    : pedagogicalScope.checkPedagogicalScopeForBody(body);
  if (scopeMismatch) {
    console.log(
      '[pedagogical-scope] SOFT WARNING',
      body.phase,
      '«' + scopeMismatch.requestedTopic + '»',
      '—',
      scopeMismatch.currentGradeLabel,
      '≠',
      scopeMismatch.canonicalGradeLabel
    );
    return pedagogicalScope.buildScopeMismatchGenerateResult(body, scopeMismatch);
  }
  if (pedagogicalScope.isPedagogicalScopeOverridden(body)) {
    console.log(
      '[pedagogical-scope] TEACHER OVERRIDE',
      body.phase,
      '«' + (body.topic || '') + '»',
      '@',
      body.gradeLabel || body.currentGrade
    );
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

  if (body.phase === 'enrichment_links') {
    body.skipCache = true;
    body.skipRag = true;
  }

  if (body.phase === 'chat_followup') {
    chatApi.clearCommunityArchiveContextForExpansion(body);
  }

  const communityProbe = await probeCommunityMaterialsForBody(body);

  if (body.phase === 'enrichment_links') {
    const enrichmentBody = normalizeEnrichmentRequestBody(body);
    if (!enrichmentBody.topic || !enrichmentBody.currentGrade) {
      const err = new Error('enrichment_links requires topic and currentGrade');
      err.statusCode = 400;
      throw err;
    }
    let links;
    try {
      links = await fetchGeminiEnrichmentLinks(enrichmentBody);
    } catch (enrichErr) {
      const msg = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
      console.warn('[enrichment_links] Gemini search failed, Pinterest fallback:', msg);
      links = {
        pinterest_links: geminiEnrichment.buildDynamicPinterestLinks(enrichmentBody),
        article_links: [],
      };
    }
    const normalized = normalizeEnrichmentLinks(links, enrichmentBody, { geminiSearch: true });
    return {
      data: { enrichment_links: normalized },
      meta: attachCommunityMeta({
        fromCache: false,
        source: 'gemini_enrichment',
        contentHierarchy: 'gemini-google-search',
      }, communityProbe),
    };
  }
  if (communityProbe.count > 0) {
    console.log('[community] matched', communityProbe.count, 'material(s) for', body.phase);
  }
  body.communityMaterialsProbe = communityProbe;

  if (body.phase === 'chat_followup') {
    body.chatStrictIsolation = true;
    body.skipRag = true;
    body.chatForceGeminiOnly = true;
  }

  if (!body.skipCache) {
    if (body.phase === 'chat_followup') {
      // Strict isolation: no prior grade/topic/answer cache injection into chat prompts.
    } else {
      const cacheOpts = isArchiveOnlyLookup(body) ? { requireEnhanced: false } : {};
      const cached = await cacheDb.getCachedResult(body, cacheOpts);
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
          gradeLabel: body.gradeLabel || null,
        });
        if (suggestion && suggestion.matchType === 'grade_mismatch' && suggestion.gradeMismatch &&
            !pedagogicalScope.isPedagogicalScopeOverridden(body)) {
          console.log(
            '[cached_results] GRADE GUARDRAIL blocked topic search:',
            suggestion.requestedTopic || body.topic
          );
          return pedagogicalScope.buildScopeMismatchGenerateResult(body, suggestion.gradeMismatch, communityProbe);
        }
        if (suggestion && suggestion.matchType === 'exact' && suggestion.resultData) {
          const serveArchive = isArchiveOnlyLookup(body)
            || cacheDb.isEnhancedCachedPayload('topic', suggestion.resultData);
          if (!serveArchive) {
            console.log(
              '[cached_results] SKIP non-enhanced archive exact match — Perplexity regeneration:',
              suggestion.topic
            );
          } else {
            console.log(
              '[cached_results] HIT (consolidated archive ≥99% similarity)',
              suggestion.topic,
              suggestion.cacheKey ? suggestion.cacheKey.slice(0, 12) : '',
              'sim=' + (suggestion.similarity || 1).toFixed(3)
            );
            if (!body.skipKnowledgeIngest) {
              knowledgeIngest.ingestFromGenerateResultAsync(body, suggestion.resultData);
            }
            const archivePayload = enrichmentLinksApi.stripNonPinterestLinksFromArchiveData(
              JSON.parse(JSON.stringify(suggestion.resultData))
            ).data;
            return {
              data: archivePayload,
              meta: attachCommunityMeta({
                fromCache: true,
                cacheKey: suggestion.cacheKey,
                table: 'cached_results',
                source: 'consolidated_archive',
                similarity: suggestion.similarity,
                requestedTopic: body.topic || suggestion.requestedTopic || null,
                enhanced: cacheDb.isEnhancedCachedPayload('topic', suggestion.resultData),
              }, communityProbe),
            };
          }
        }
        if (!isArchiveOnlyLookup(body) && suggestion && suggestion.matchType === 'partial') {
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
      if (shouldLiveGenerateOnDemandExpansion(body)) {
        console.log('[on-demand] expansion cache MISS — live Perplexity pipeline (no archive error):', body.phase);
      } else if (isPerplexityRawExpansionPhase(body)) {
        console.log('[on-demand] pipeline: Perplexity Sonar only (independent expansion) for', body.phase);
      } else if (isDecoupledGenerationPhase(body)) {
        console.log('[perplexity] pipeline: Sonar research → Perplexity structured synthesis for', body.phase);
      }
    }
  }

  let ragMeta = {
    enabled: ragDb.isRagEnabled(),
    chunkCount: 0,
    method: 'skipped',
    contextChars: 0,
    liveDriveRefresh: false,
  };

  // Main generation: grade/topic/phase_c → Perplexity Sonar + synthesis; phase_c inspiration enrichment_links → Gemini Google Search; chat → Gemini.
  if (isDecoupledGenerationPhase(body) || isOnDemandExpansionPhase(body)) {
    body.skipRag = true;
  }

  // Live Drive archive lookup — runs on every cache miss (no stale RAG cache).
  // Queries knowledge_base in real time so newly ingested "waldrof project" / "waldorf project" files are included.
  if (!body.skipRag && ragDb.shouldRetrieveForPhase(body.phase)) {
    try {
      console.log('[generate] Supabase RAG/vector search for phase', body.phase);
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
    body.phase !== 'chat_followup' && (resolvedGradeId(body) || body.gradeLabel)
      ? ' CRITICAL: currentGrade is locked — never mix pedagogical content from other grades.'
      : '';
  const scopeOverrideBlocks = pedagogicalScope.isPedagogicalScopeOverridden(body)
    ? pedagogicalScope.buildScopeOverridePromptBlocks(body)
    : null;
  const scopeGuardSystem = pedagogicalScope.shouldValidatePedagogicalScope(body)
    ? (scopeOverrideBlocks
      ? scopeOverrideBlocks.synthesisSystem
      : ' CRITICAL: Enforce Waldorf pedagogical scope — surface soft warnings for cross-grade topics; never hallucinate justifications.')
    : '';

  const searchPhases = new Set([
    'grade', 'topic', 'pedagogy_deep_dive', 'archive_search', 'archive_summary',
    'chat_followup',
  ]);
  const isChatFollowup = body.phase === 'chat_followup';
  const isDecoupledGen = isDecoupledGenerationPhase(body);
  const isOnDemandExpansion = isOnDemandExpansionPhase(body);
  const isChatExpansion = chatApi.isChatPedagogicalExpansionRequest(body);
  const isFirstChatTurn = isChatFollowup ? chatApi.isFirstChatTurnInSession(body) : undefined;
  const chatContinuation = isChatFollowup ? chatApi.isChatContinuationTurn(body) : false;
  const communityCriticalBlock = '';
  const extraSystem =
    gradeLockSystem +
    scopeGuardSystem +
    (isDecoupledGen || isOnDemandExpansion ? '' : CONTENT_HIERARCHY_INSTRUCTION) +
    communityCriticalBlock +
    (body.phase === 'grade' || body.phase === 'topic' || body.phase === 'phase_c'
      ? ' CRITICAL JSON OUTPUT: Reply with raw JSON only — first character {, last character }. No ```json fences, no Hebrew/English preamble.'
      : '') +
    (body.phase === 'topic'
      ? PHASE_B_TOPIC_FORBIDDEN_OUTPUT
      : '') +
    (body.phase === 'phase_c'
      ? ' PHASE C — INDEPENDENT TAB («' + body.cTab + '»): Do NOT duplicate or paraphrase Phase B theory essence. Generate unique, deep tab-specific content from Perplexity research only. NO sources, bibliography, or external links in output.'
      : '') +
    (isOnDemandExpansion
      ? (isAgeExpansionRequest(body)
        ? ' ON-DEMAND AGE EXTENSION: Perplexity Sonar raw research — grade developmental framework ONLY, zero topic coupling. Independent cache route.'
        : ' ON-DEMAND TOPIC EXTENSION: Perplexity Sonar raw research — deep-dive for the single requested idea within the active block topic. Independent cache route.')
      : isDecoupledGen
      ? ' DECOUPLED MAIN GENERATION: Perplexity Sonar research → Perplexity text synthesis. enrichment_links → Gemini Google Search. No Drive/community RAG injection.'
      : isChatFollowup
      ? (isChatExpansion || chatContinuation
        ? ' PEDAGOGICAL CHAT — CONTINUATION: Jump directly into pedagogical content. ' +
          'Do NOT repeat archive greetings, community-match openings, catalog redirects, or database status.'
        : ' PEDAGOGICAL CHAT — GEMINI KNOWLEDGE BASE: Answer from your Waldorf pedagogical expertise. ' +
          'Do NOT mention community archive, מאגר, folder counts, or catalog redirects. No Perplexity or live web search.')
      : body.ragContext || body.ragDriveContext || body.ragCommunityContext
          ? ' HYBRID SEARCH: Live web search is PRIMARY. Private Drive and shared community archive excerpts are SECONDARY enrichment — blend them into the web foundation without replacing web breadth.'
          : ' No local Drive or community archive excerpts matched — build the full lesson plan from live web search alone. Do not shorten output.') +
    (searchPhases.has(body.phase) && !isDecoupledGen && !isOnDemandExpansion && !isChatFollowup
      ? ' LIVE WEB SEARCH is the core anchor — perform a broad, exhaustive internet search first. ' +
        'Check Alon Yerushalmy, «מסעות בחינוך», and educationpace.com only for genuinely relevant matches — ' +
        'never force a citation; omit entirely when search data offers no substantial topic-specific material.'
      : '');

  const perplexityOptions = {};

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
    if (typeof data.chatReply.answer === 'string') {
      data.chatReply.answer = chatApi.stripRawUrlsFromChatText(data.chatReply.answer);
      data.chatReply.answer = chatApi.stripCommunityGreetingFromChatText(data.chatReply.answer);
      data.chatReply.answer = chatApi.appendCommunitySearchRecommendation(data.chatReply.answer);
    }
    if (typeof data.chatReply.answerHtml === 'string') {
      data.chatReply.answerHtml = chatApi.stripRawUrlsFromChatText(data.chatReply.answerHtml);
      data.chatReply.answerHtml = chatApi.stripCommunityGreetingFromChatText(data.chatReply.answerHtml);
      data.chatReply.answerHtml = chatApi.appendCommunitySearchRecommendation(data.chatReply.answerHtml);
    }
  }

  // Gemini chat_followup is READ-ONLY — never persist chat replies or merge into grade/topic archive.
  let gradeCachePatch = null;
  if (!body.skipCache && !body._onDemandCacheSaved && body.phase !== 'chat_followup') {
    try {
      const cachePayload = cacheDb.stampPerplexityOnlyMetadata(data);
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
    } catch (cacheErr) {
      console.warn('[cached_results] save failed:', cacheErr.message || cacheErr);
    }
  } else if (body.phase === 'chat_followup') {
    if (body.priorCachedAnswer) {
      data.chatReply = data.chatReply || {};
      data.chatReply.enrichedFromPrior = true;
      data.chatReply.priorMatchType = body.priorCachedAnswer.matchType || 'exact';
    }
    if (body.priorGradeCache) {
      data.chatReply = data.chatReply || {};
      data.chatReply.enrichedFromGradeCache = true;
    }
    console.log('[cached_results] chat_followup READ-ONLY — no archive writes');
  }

  const savedCacheKey = body.skipCache ? null : cacheDb.buildCacheKey(body);
  const priorEnriched = Boolean(body.priorCachedAnswer || body.priorGradeCache);

  if (!body.skipKnowledgeIngest) {
    knowledgeIngest.ingestFromGenerateResultAsync(body, data);
  }

  const chatPromptMode = isChatFollowup ? chatApi.resolveChatPromptMode(body) : undefined;
  const chatPipelineLabel = !isChatFollowup
    ? undefined
    : chatPromptMode === 'expansion'
    ? 'gemini_expansion'
    : chatContinuation
    ? 'gemini_continuation'
    : 'gemini_pedagogical_kb';

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
      hybridPipeline: false,
      perplexityOnly: !isChatFollowup,
      chatPipeline: chatPipelineLabel,
      chatPromptMode: chatPromptMode,
      isFirstChatTurn: isFirstChatTurn,
      chatContinuation: chatContinuation,
      consolidatedArchive: ragMeta.chunkCount > 0,
      contentHierarchy: chatPipelineLabel || (isPerplexityRawExpansionPhase(body)
          ? 'perplexity-sonar-expansion'
          : (isDecoupledGen
            ? 'perplexity-sonar+perplexity-synthesis'
            : 'perplexity-direct')),
      liveDriveRefresh: Boolean(ragMeta.liveDriveRefresh),
      rag: ragMeta,
      ragContext: body.ragContext || '',
      ragChunkIds: Array.isArray(body.ragChunkIds) ? body.ragChunkIds : [],
    }, communityProbe, {
      chatPromptMode: chatPromptMode,
      isFirstChatTurn: isFirstChatTurn,
      chatContinuation: chatContinuation,
    }),
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

  let body;
  try {
    body = parseRequestBody(req);
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return sendJson(res, 400, { error: message || 'Invalid JSON body' });
  }

  const apiKey = resolveApiKey(body);
  if (!apiKey && !isArchiveOnlyLookup(body) && !isGeminiEnrichmentPhase(body)) {
    return sendJson(res, 500, { error: missingKeyError(body) });
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

  let body;
  try {
    const text = await request.text();
    body = text && text.trim() ? JSON.parse(text) : null;
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return Response.json({ error: message || 'Invalid JSON body' }, { status: 400, headers });
  }

  const apiKey = resolveApiKey(body);
  if (!apiKey && !isArchiveOnlyLookup(body) && !isGeminiEnrichmentPhase(body)) {
    return Response.json({ error: missingKeyError(body) }, { status: 500, headers });
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
module.exports.isArchiveOnlyMode = function () { return ARCHIVE_ONLY_MODE; };
module.exports.isArchiveOnlyLookup = isArchiveOnlyLookup;
module.exports.isOnDemandExpansionPhase = isOnDemandExpansionPhase;
module.exports.shouldLiveGenerateOnDemandExpansion = shouldLiveGenerateOnDemandExpansion;
module.exports.resolveExpansionScope = resolveExpansionScope;
module.exports.sanitizePinterestGallery = sanitizePinterestGallery;
module.exports.buildStrictPinterestQuery = buildStrictPinterestQuery;
module.exports.passesStrictPinterestItemFilter = passesStrictPinterestItemFilter;
module.exports.hasMismatchedGradeInText = hasMismatchedGradeInText;
module.exports.PINTEREST_MAX_GALLERY_ITEMS = PINTEREST_MAX_GALLERY_ITEMS;
module.exports.ENRICHMENT_LINKS_MAX = ENRICHMENT_LINKS_MAX;
module.exports.normalizeEnrichmentLinks = normalizeEnrichmentLinks;
module.exports.normalizeEnrichmentRequestBody = normalizeEnrichmentRequestBody;
module.exports.fetchRealtimeEnrichmentLinks = fetchRealtimeEnrichmentLinks;
module.exports.attachRealtimeEnrichmentLinks = attachRealtimeEnrichmentLinks;
module.exports.attachGeminiEnrichmentLinks = attachGeminiEnrichmentLinks;
module.exports.fetchGeminiEnrichmentLinks = fetchGeminiEnrichmentLinks;
module.exports.geminiEnrichment = geminiEnrichment;
module.exports.isAgeExpansionRequest = isAgeExpansionRequest;
module.exports.normalizeExpansionRequest = normalizeExpansionRequest;
module.exports.GENERATE_ROUTE_TIMEOUT_MS = GENERATE_ROUTE_TIMEOUT_MS;
