/**
 * POST /api/pure-general-search — Phase A Perplexity web search + parallel community/Drive probe.
 * Community matches are returned in meta (communityMatches / communityStatus) for a separate UI block.
 * Body: { query, periodBlock?: boolean, gradeId?: string, gradeLabel?: string }
 */
const shared = require('./pure-api-shared');
const cache = require('./cache');
const authContext = require('./auth-context');
const subscriptionApi = require('./subscription');
const hebrewGuardrails = require('./perplexity-hebrew-guardrails');
const keyboardLayout = require('./keyboard-layout');
const env = require('./env');
const geminiJson = require('./gemini-json');
const jsonRepair = require('./json-repair');

/** Absolute Hebrew-only body text — no English prose, footnotes, or citation markers. */
const HEBREW_ONLY_BODY_INSTRUCTION = [
  '=== עברית נקייה בלבד (איסור מוחלט) ===',
  'חל איסור מוחלט לכלול מילים באנגלית, הערות שוליים, סימוני מקורות (כמו [1], [2] או [cite]) או ביטויים זרים בגוף הטקסט.',
  'כל התוכן חייב להיות בעברית נקייה, פדגוגית ומקצועית בלבד.',
  'שמות ספרים/מחברים באנגלית מותרים רק בתוך recommended_literature.title / author וכתובות URL בתוך relevant_links.url — לא בגוף developmental_axis, core_pedagogical_emphases או curriculum.',
  '=== סוף עברית נקייה ===',
].join(' ');

/**
 * In-depth Grade 1–8 anthroposophical developmental breakdown for General Search overviews.
 * Used in both Gemini system prompts and user prompts.
 */
const WALDORF_ELEMENTARY_SCOPE_INSTRUCTION = [
  '=== קשת התפתחותית מלאה — כיתות א׳–ח׳ (חובה: עומק אנתרופוסופי מקצועי) ===',
  'developmental_axis ו-core_pedagogical_emphases חייבים להיות פירוט מעמיק, רב-פסקאות, מקצועי — בסגנון מדריך מורה אנתרופוסופי — ולא סיכומים גנריים קצרים.',
  'כסה את כל תכנית היסוד הוולדורפית של הנושא לפי חגורות הגיל הבאות, עם רציונל נפשי-רוחני, מצפן התפתחותי, ודינמיקה פדגוגית לכל שלב:',
  'כיתות א׳–ג׳: החוויה החושית, הטבע דרך סיפורים ודימויים, עבודת כפיים והתשתית הגופנית.',
  'כיתות ד׳–ה׳: המעבר אל תצפית חיה (זואולוגיה, בוטניקה), קשר בין האדם לעולם החי והצומח.',
  'כיתה ו׳: חציית הרוביקון השנייה (גיל 12), התגשמות מלאה במערכת השלד והשרירים, כניסת הפנומנולוגיה המדעית (אקוסטיקה, אופטיקה, חום, מגנטיות וחשמל סטטי).',
  'כיתות ז׳–ח׳: המעבר למדעים מורכבים יותר (מכניקה פשוטה, כימיה של שריפה, הידרוליקה, חשמל דינמי) והנחת היסודות לחשיבה סיבתית ומדעית עצמאית בגיל ההתבגרות.',
  'כתוב מספר פסקאות עבריות עשירות לכל חגורת גיל (לא משפט או שניים). חבר את הנושא המבוקש לקשת זו במפורש.',
  '=== סוף קשת התפתחותית ===',
].join(' ');

/**
 * Period-block depth: rich Grade 1–8 overview + focused 15-day bullets so JSON closes fully.
 */
const PERIOD_BLOCK_DEPTH_AND_JSON_INSTRUCTION = [
  '=== תוכנית תקופה מלאה + JSON קשיח (חובה) ===',
  'בנה תוכנית לימודים מלאה, עמוקה ומפורטת ל-15 ימי תקופה מלאים (3 שבועות × 5 ימים) — לעולם אל תבקש/תייצר חומר קצר או מקוצר.',
  'התשובה כולה חייבת להיות אובייקט JSON תקין אחד בלבד, במבנה המדויק שה-Frontend מצפה לקבל — ללא טקסט חופשי, ללא הקדמה, ללא Markdown, ללא ```.',
  'כדי שה-JSON לא יישבר בגלל אורך: בנה את מהלך 15 הימים באמצעות נקודות (bullet points) ממוקדות, נושאי ליבה יומיים ומערכי שיעור מובנים — לא פסקאות טקסט ארוכות ומסורבלות.',
  'כל יום ב-curriculum חייב להיות מלא פדגוגית (נושא + תוכן + אמנות) אך מנוסח כנקודות/משפטים ממוקדים עם \\n בין שורות — לא חיבורי פרוזה ארוכים.',
  WALDORF_ELEMENTARY_SCOPE_INSTRUCTION,
  'חובה להשלים את כל 15 הימים עד סוף האובייקט — אל תחתוך באמצע מערך, אל תשמיט ימים, אל תסיים ביום 8–12.',
  '=== סוף תוכנית תקופה ===',
].join(' ');

/** Approved homepage hosts for relevant_links — never invent deep CMS/article slugs on these. */
const APPROVED_RELEVANT_LINK_DOMAINS = [
  'anadom.co.il',
  'harduf.org.il',
  'adamolam.co.il',
  'waldorflibrary.org',
  'rsarchive.org',
];

/** Known-safe path prefixes per host. Anything deeper is treated as a guessed slug and rewritten. */
const KNOWN_SAFE_PATHS_BY_HOST = {
  'anadom.co.il': ['/'],
  'harduf.org.il': ['/'],
  'adamolam.co.il': ['/'],
  'waldorflibrary.org': ['/'],
  'rsarchive.org': ['/'],
};

const DEFAULT_SITE_SEARCH_DOMAIN = 'waldorflibrary.org';

const RELEVANT_LINKS_NO_HALLUCINATION_INSTRUCTION = [
  '=== קישורים רלוונטיים — איסור מוחלט על ניחוש URL ===',
  'NEVER invent, guess, or fabricate deep URLs (internal paths, encoded Hebrew slugs, /articles/..., CMS permalinks) — those 404.',
  'relevant_links.url may ONLY be one of:',
  '(1) the official homepage of an approved domain: ' + APPROVED_RELEVANT_LINK_DOMAINS.join(', ') + '.',
  '(2) a dedicated Google site-search for a specific article or topic, for example: https://www.google.com/search?q=site:waldorflibrary.org+TOPIC',
  'If you want to point to a specific article, emit the site-search URL or the source homepage — NEVER a guessed deep path.',
  '=== סוף איסור ניחוש URL ===',
].join(' ');

/** Phase A only — exact JSON keys the Frontend expects. No Phase B / citation scan. */
const SYSTEM_PROMPT = [
  hebrewGuardrails.PERPLEXITY_HEBREW_GUARDRAILS,
  HEBREW_ONLY_BODY_INSTRUCTION,
  WALDORF_ELEMENTARY_SCOPE_INSTRUCTION,
  RELEVANT_LINKS_NO_HALLUCINATION_INSTRUCTION,
  'You are a Waldorf / anthroposophical pedagogy expert.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'developmental_axis (string: rich multi-paragraph Hebrew covering the FULL elementary arc Grades 1–8 by age bands א׳–ג׳, ד׳–ה׳, ו׳, ז׳–ח׳ — sensory-imaginative years, living observation, second Rubicon / phenomenology, then causal scientific thinking; never brief generic summaries),',
  'core_pedagogical_emphases (string: rich multi-paragraph Hebrew with Developmental Compass — רציונל התפתחותי ומצפן למורה — for each age band above, plus lesson dynamics; professional Anthroposophical depth, never superficial),',
  'recommended_literature (array of 5-8 objects: {title, author, note} — note MUST be 1-2 sentences on what the source covers and why it matters),',
  'relevant_links (array of 6-8 objects: {title, url} — title MUST include short context after em dash/colon; url MUST be an approved homepage or a Google site: search — NEVER a guessed deep path).',
  'Strictly exclude any sources, domains, or web links from Russian websites, Russian academic databases (e.g., CyberLeninka, KPFU), or Russian social networks (e.g., VK). All returned sources and citations MUST be exclusively from reputable English or Hebrew websites and domains (.com, .org, .edu, .gov, .co.il, etc.).',
  'CRITICAL: return exactly one valid JSON object — no free text, no preamble, no Markdown outside the JSON.',
].join(' ');

const PERIOD_BLOCK_SYSTEM_PROMPT_BASE = [
  hebrewGuardrails.PERPLEXITY_HEBREW_GUARDRAILS,
  HEBREW_ONLY_BODY_INSTRUCTION,
  WALDORF_ELEMENTARY_SCOPE_INSTRUCTION,
  PERIOD_BLOCK_DEPTH_AND_JSON_INSTRUCTION,
  RELEVANT_LINKS_NO_HALLUCINATION_INSTRUCTION,
  'You are a Waldorf / anthroposophical pedagogy expert specializing in main-lesson block planning.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'developmental_axis (string: rich multi-paragraph Hebrew tracing how THIS SUBJECT evolves across the entire Waldorf elementary curriculum Grades 1–8 by age bands א׳–ג׳, ד׳–ה׳, ו׳, ז׳–ח׳ — never lock this overview to the selected grade, never brief generic summaries),',
  'core_pedagogical_emphases (string: rich multi-paragraph Hebrew — Waldorf emphases, Developmental Compass / מצפן התפתחותי, and teacher compass for this SUBJECT across the same Grades 1–8 age bands),',
  'recommended_literature (array of 3-6 objects: {title, author, note} — note in clean Hebrew explaining relevance to this block),',
  'relevant_links (array of 4-6 objects: {title, url} — approved homepage or Google site: search only; title in Hebrew with short context; NEVER a guessed deep path),',
  'curriculum (array of EXACTLY 15 objects — one per school day — each with: day (integer 1-15), week (integer 1-3), topic (Hebrew core daily topic), content (Hebrew focused bullet points for main narrative/story/new material, separated by \\n — NOT long essays), art (Hebrew focused bullet points for notebook/drawing/painting/handwork)).',
  'The 15-day curriculum table MUST be tailored STRICTLY to the selected grade only (e.g. Physics Grade 6, Form Drawing Grade 3). Never mix other grades into the daily rows.',
  'The Grades 1–8 developmental arc applies ONLY to developmental_axis and core_pedagogical_emphases. The curriculum table must never borrow a different subject family (history into science, science into form drawing, etc.).',
  'NEVER shorten the 15-day plan. NEVER omit days. Prefer structured bullets over long paragraphs so the FULL JSON closes cleanly.',
  'Strictly exclude any sources, domains, or web links from Russian websites, Russian academic databases (e.g., CyberLeninka, KPFU), or Russian social networks (e.g., VK). All returned sources and citations MUST be exclusively from reputable English or Hebrew websites and domains (.com, .org, .edu, .gov, .co.il, etc.).',
  'CRITICAL: return exactly one valid JSON object — no free text, no preamble, no Markdown outside the JSON. First char { last char }.',
].join(' ');

const SUBJECT_LOCK_HEBREW = 'טבלת 15 הימים חייבת להישאר ב-100% בתוך תחום הדעת שנחקר. שאילתות בנושאי מדעים יפיקו שיעורי מדעים בלבד, ללא גלישה לנושאי היסטוריה.';

const SUBJECT_DAILY_MATCH_HEBREW = 'נושא השיעור והמיקוד הסיפורי בכל יום חייבים לשקף במדויק את המערכים הנלמדים באותה תקופה בכיתה שנבחרה.';

const SCIENCE_QUERY_MARKERS = [
  'התפתחות המדעים', 'התפתחות המדע', 'התפתחות מדע', 'התפתחות מדעים',
  'מדעים', 'מדע', 'פיזיקה', 'כימיה', 'מכניקה', 'ביולוגיה', 'פיזיולוגיה',
  'תזונה', 'אקוסטיקה', 'אופטיקה', 'שריפה', 'הידרוליקה', 'מגנטיות', 'חשמל',
  'science', 'sciences', 'physics', 'chemistry', 'mechanics', 'biology',
  'physiology', 'nutrition', 'acoustics', 'optics',
  'development of the sciences', 'development of science', 'development of sciences',
];

const BROAD_SCIENCE_QUERY_MARKERS = [
  'התפתחות המדעים', 'התפתחות המדע', 'התפתחות מדע', 'התפתחות מדעים',
  'מדעים', 'מדע', 'science', 'sciences',
  'development of the sciences', 'development of science', 'development of sciences',
];

const HISTORY_QUERY_MARKERS = [
  'היסטוריה', 'רנסנס', 'מגלי עולם', 'עידן התגליות', 'גילוי העולם', 'גילוי ארצות',
  'מסעות גילוי', 'רומא', 'יוון', 'ימי ביניים', 'מהפכה', 'מהפכות',
  'history', 'renaissance', 'age of discovery', 'age of exploration', 'explorers',
];

const FORM_DRAWING_QUERY_MARKERS = [
  'רישום צורה', 'form drawing',
];

/** Grade 1–8 science main-lesson content from the in-file Waldorf scope + grade-7 teacher lock. */
const SCIENCE_BLOCK_BY_GRADE = {
  '1': 'סיפורי טבע וחוויה חושית — מפגש עם תופעות הטבע דרך סיפור ודימוי, לא מדעים פורמליים ולא היסטוריה.',
  '2': 'סיפורי טבע ומשלי חיות כחוויה חיה של העולם — לא מעבדה פורמלית ולא היסטוריה כללית.',
  '3': 'חקלאות, עונות ומלאכת כפיים כמפגש עם הטבע — לא היסטוריה כללית.',
  '4': 'זואולוגיה / האדם וממלכת החי — תצפית חיה בבעלי חיים. אסור להחליף בהיסטוריה.',
  '5': 'בוטניקה — עולם הצומח. אסור להחליף בהיסטוריה (יוון וכו׳).',
  '6': 'פנומנולוגיה מדעית: אקוסטיקה, אופטיקה, חום, מגנטיות וחשמל סטטי; וגיאולוגיה/מינרלוגיה לפי תכנית וולדורף לכיתה ו׳. אסור רנסנס/מגלי עולם.',
  '7': 'אך ורק נושאי המדעים של כיתה ז׳ בחינוך ולדורף: מכניקה, כימיה של שריפה, פיזיולוגיה/תזונה.',
  '8': 'מדעים של כיתה ח׳: הידרוליקה, חשמל דינמי, כימיה (אורגנית לפי התכנית). אסור מהפכות/היסטוריה מודרנית.',
};

const HISTORY_BLOCK_BY_GRADE = {
  '1': 'אגדות וסיפורי טבע',
  '2': 'משלי חיות וסיפורי צדיקים',
  '3': 'תנ״ך וסיפורי מקרא',
  '4': 'מיתולוגיה נורדית',
  '5': 'יוון העתיקה',
  '6': 'רומא וימי הביניים',
  '7': 'תקופת מגלי עולם ורנסנס',
  '8': 'מהפכות והיסטוריה מודרנית',
};

const SCIENCE_HISTORY_LEAK_RE =
  /רנסנס|renaissance|עידן התגליות|מגלי עולם|גילוי העולם|גילוי ארצות|מסעות גילוי|קולומבוס|מגלן|תקופת המגלים|age of (?:exploration|discovery)|columbus|magellan/i;

const FORM_DRAWING_LEAK_RE =
  /רנסנס|מגלי עולם|עידן התגליות|מכניקה|כימיה של שריפה|יוון העתיקה|היסטוריה כללית/i;

function normalizeSubjectQuery(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u05F3\u05F4׳״`'"]/g, '')
    .replace(/[-–—_/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function queryHasMarker(query, markers) {
  const q = normalizeSubjectQuery(query);
  if (!q) return false;
  const list = Array.isArray(markers) ? markers : [];
  for (let i = 0; i < list.length; i++) {
    const marker = normalizeSubjectQuery(list[i]);
    if (marker && q.indexOf(marker) >= 0) return true;
  }
  return false;
}

function classifyPeriodSubjectFamily(query) {
  if (queryHasMarker(query, FORM_DRAWING_QUERY_MARKERS)) return 'form_drawing';
  if (queryHasMarker(query, SCIENCE_QUERY_MARKERS)) return 'sciences';
  if (queryHasMarker(query, HISTORY_QUERY_MARKERS)) return 'history';
  return 'query';
}

function resolveSubjectLockGradeId(gradeInfo) {
  const src = gradeInfo && typeof gradeInfo === 'object' ? gradeInfo : {};
  const id = String(src.gradeId || '').trim();
  if (id && /^[1-8]$/.test(id)) return id;
  const label = String(src.gradeLabel || '').trim();
  const letterMap = { א: '1', ב: '2', ג: '3', ד: '4', ה: '5', ו: '6', ז: '7', ח: '8' };
  const match = label.match(/[א-ח]/);
  return match && letterMap[match[0]] ? letterMap[match[0]] : '';
}

function buildSubjectFamilyLines(query, gradeInfo) {
  const family = classifyPeriodSubjectFamily(query);
  const gradeId = resolveSubjectLockGradeId(gradeInfo);
  const q = String(query || '').trim();
  const lines = [];
  if (family === 'sciences') {
    lines.push('תחום דעת נעול: מדעים.');
    if (queryHasMarker(q, BROAD_SCIENCE_QUERY_MARKERS) && gradeId && SCIENCE_BLOCK_BY_GRADE[gradeId]) {
      lines.push('מערכי התקופה בכיתה זו: ' + SCIENCE_BLOCK_BY_GRADE[gradeId]);
    } else {
      lines.push('נעל את כל 15 הימים למונח המדעים שנחקר («' + q + '») במערכי המדעים של הכיתה שנבחרה בלבד.');
      if (gradeId && SCIENCE_BLOCK_BY_GRADE[gradeId]) {
        lines.push('מסגרת המדעים של הכיתה (אין לצאת ממנה): ' + SCIENCE_BLOCK_BY_GRADE[gradeId]);
      }
    }
    if (gradeId === '7') {
      lines.push('אם הכיתה היא ז׳: הטבלה חייבת לכלול אך ורק את נושאי המדעים של כיתה ז׳ בחינוך ולדורף (מכניקה, כימיה של שריפה, פיזיולוגיה/תזונה).');
      lines.push('אסור בשום אופן לסטות להיסטוריה כללית (כמו תקופת הרנסנס או עידן התגליות / מגלי עולם).');
    } else {
      lines.push('אסור בשום אופן לסטות להיסטוריה כללית (רנסנס, עידן התגליות, מגלי עולם, יוון, רומא, מהפכות).');
    }
    lines.push('כל יום: topic ו-content הם מערך מדעים (תופעה, ניסוי, עיכול סיפורי מדעי) — לא סיפור היסטורי על מגלים, רנסנס או גילוי העולם.');
  } else if (family === 'history') {
    lines.push('תחום דעת נעול: היסטוריה.');
    if (gradeId && HISTORY_BLOCK_BY_GRADE[gradeId]) {
      lines.push('מערכי ההיסטוריה של הכיתה שנבחרה: ' + HISTORY_BLOCK_BY_GRADE[gradeId] + '.');
    }
    lines.push('נעל את כל 15 הימים לתקופה ההיסטורית שנחקרה בכיתה זו — אל תחליף במערכי מדעים (מכניקה, כימיה של שריפה, פיזיולוגיה) אלא אם המונח עצמו הוא אותו מערך היסטורי.');
  } else if (family === 'form_drawing') {
    lines.push('תחום דעת נעול: רישום צורה.');
    lines.push('כל 15 הימים הם מערכי רישום צורה של הכיתה שנבחרה בלבד — קו, ריתמוס, סימטריה ותרגול מחברת. אסור לגלוש להיסטוריה או למדעים.');
  } else {
    lines.push('תחום דעת נעול: המונח שנחקר «' + q + '».');
    lines.push('כל שורת יום חייבת להישאר באותו תחום דעת — אל תחליף בנושא קטלוגי אחר רק כי הוא נלמד באותה כיתה.');
  }
  return lines;
}

function buildSubjectLockInstruction(query, gradeInfo) {
  const q = String(query || '').trim();
  const gradeLabel = gradeInfo && String(gradeInfo.gradeLabel || '').trim();
  const gradeId = resolveSubjectLockGradeId(gradeInfo);
  const gradeBit = gradeLabel
    ? gradeLabel
    : (gradeId ? ('כיתה ' + gradeId) : 'הכיתה שנבחרה');
  return [
    '=== נעילת תחום דעת קשיחה — טבלת 15 הימים (חובה מוחלטת) ===',
    SUBJECT_LOCK_HEBREW,
    SUBJECT_DAILY_MATCH_HEBREW,
    'הנושא שנחקר: «' + q + '». הכיתה: «' + gradeBit + '».',
    buildSubjectFamilyLines(query, gradeInfo).join(' '),
    '=== סוף נעילת תחום דעת ===',
  ].join(' ');
}

function buildSubjectDriftRetryInstruction(query, gradeInfo) {
  return [
    'תיקון חובה: הטבלה הקודמת סטתה מתחום הדעת הנעול.',
    buildSubjectLockInstruction(query, gradeInfo),
    'כתוב מחדש את curriculum כולו (15 ימים) בתוך תחום הדעת הנעול בלבד.',
  ].join(' ');
}

function collectCurriculumText(parsed) {
  const days = parsed && Array.isArray(parsed.curriculum) ? parsed.curriculum : [];
  return days.map(function (row) {
    if (!row || typeof row !== 'object') return '';
    return [row.topic, row.content, row.art, row.title, row.narrative].join(' ');
  }).join('\n');
}

function curriculumDriftsFromLockedSubject(parsed, query, gradeInfo) {
  const family = classifyPeriodSubjectFamily(query);
  const text = collectCurriculumText(parsed);
  if (!text) return false;
  if (family === 'sciences') return SCIENCE_HISTORY_LEAK_RE.test(text);
  if (family === 'form_drawing') return FORM_DRAWING_LEAK_RE.test(text);
  return false;
}

function buildPeriodBlockSystemPrompt(query, gradeInfo) {
  return PERIOD_BLOCK_SYSTEM_PROMPT_BASE + ' ' + buildSubjectLockInstruction(query, gradeInfo);
}

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

function normalizeHost(host) {
  return String(host || '').replace(/^www\./i, '').toLowerCase();
}

function isApprovedRelevantLinkHost(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  return APPROVED_RELEVANT_LINK_DOMAINS.some(function (domain) {
    return h === domain || h.endsWith('.' + domain);
  });
}

function sanitizeSearchTopic(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[<>"'\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function buildApprovedSiteSearchUrl(domain, topic) {
  const host = isApprovedRelevantLinkHost(domain) ? normalizeHost(domain) : DEFAULT_SITE_SEARCH_DOMAIN;
  const q = sanitizeSearchTopic(topic);
  const encodedTopic = q ? encodeURIComponent(q).replace(/%20/g, '+') : '';
  return 'https://www.google.com/search?q=site:' + host + (encodedTopic ? '+' + encodedTopic : '');
}

function isKnownSafePathForHost(host, pathname, search) {
  const h = normalizeHost(host);
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (String(search || '').replace(/^\?/, '').trim()) return false;
  const known = KNOWN_SAFE_PATHS_BY_HOST[h] || ['/'];
  return known.some(function (allowed) {
    const a = String(allowed || '/').replace(/\/+$/, '') || '/';
    return path === a || path === a + '/index.html' || path === a + '/index.php';
  });
}

function extractGoogleSiteSearchHost(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const host = normalizeHost(parsed.hostname);
    if (host !== 'google.com' && host !== 'google.co.il') return '';
    if (!/search/i.test(parsed.pathname || '')) return '';
    const q = String(parsed.searchParams.get('q') || '');
    const match = q.match(/(?:^|\s)site:([a-z0-9.-]+)/i);
    return match ? normalizeHost(match[1]) : '';
  } catch (e) {
    return '';
  }
}

function ensureHttpsUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(raw)) return 'https://' + raw.replace(/^\/+/, '');
  return raw;
}

function linkSearchTopic(item, query) {
  const q = sanitizeSearchTopic(query);
  const title = sanitizeSearchTopic(item && item.title);
  if (title && title.length >= 8) {
    if (q && title.toLowerCase().indexOf(q.toLowerCase()) === -1) {
      return (q + ' ' + title).slice(0, 100);
    }
    return title;
  }
  return q || title;
}

/**
 * Fallback validation: keep approved homepages / known-safe paths;
 * rewrite invented deep paths and foreign hosts to a focused site: search.
 */
function sanitizeRelevantLinkUrl(rawUrl, topic, preferredHost) {
  const fallbackHost = isApprovedRelevantLinkHost(preferredHost) ? normalizeHost(preferredHost) : DEFAULT_SITE_SEARCH_DOMAIN;
  const fallback = buildApprovedSiteSearchUrl(fallbackHost, topic);
  const raw = ensureHttpsUrl(rawUrl);
  if (!raw) return fallback;

  const siteHost = extractGoogleSiteSearchHost(raw);
  if (siteHost) {
    return isApprovedRelevantLinkHost(siteHost)
      ? buildApprovedSiteSearchUrl(siteHost, topic)
      : fallback;
  }

  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) return fallback;
    const host = parsed.hostname;
    if (isApprovedRelevantLinkHost(host) && isKnownSafePathForHost(host, parsed.pathname, parsed.search)) {
      return 'https://' + normalizeHost(host) + '/';
    }
    if (isApprovedRelevantLinkHost(host)) {
      return buildApprovedSiteSearchUrl(host, topic);
    }
    return fallback;
  } catch (e) {
    return fallback;
  }
}

function sanitizeRelevantLinks(list, query) {
  const seen = Object.create(null);
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    const title = sanitizePedagogicalText(item.title) || String(item.title || '').trim();
    const topic = linkSearchTopic({ title: title }, query);
    const url = sanitizeRelevantLinkUrl(item.url, topic);
    if (!url || seen[url]) return;
    seen[url] = true;
    out.push({
      title: title || url,
      url: url,
    });
  });
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
    relevant_links: sanitizeRelevantLinks(shared.coerceLinks(data.relevant_links), opts.query || ''),
  };
  if (periodBlock) {
    normalized.periodBlock = true;
    if (opts.gradeId) normalized.gradeId = String(opts.gradeId).trim();
    normalized.curriculum = padCurriculumToFifteen(
      coerceCurriculumDays(
        data.curriculum || data.days || (data.blockPlan && data.blockPlan.curriculum)
      ),
      opts.query || data.query || ''
    );
  }
  return normalized;
}

function getGeneralSearchResponseSchema(periodBlock) {
  const schema = {
    type: 'object',
    properties: {
      developmental_axis: { type: 'string' },
      core_pedagogical_emphases: { type: 'string' },
      recommended_literature: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            author: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['title'],
        },
      },
      relevant_links: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
          },
          required: ['title', 'url'],
        },
      },
    },
    required: ['developmental_axis', 'core_pedagogical_emphases'],
  };
  if (periodBlock) {
    schema.properties.curriculum = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'integer' },
          week: { type: 'integer' },
          topic: { type: 'string' },
          content: { type: 'string' },
          art: { type: 'string' },
        },
        required: ['day', 'topic', 'content', 'art'],
      },
    };
    schema.required.push('curriculum');
  }
  return schema;
}

function padCurriculumToFifteen(days, query) {
  const byDay = {};
  (Array.isArray(days) ? days : []).forEach(function (row, i) {
    if (!row || typeof row !== 'object') return;
    const day = parseInt(row.day, 10) || (i + 1);
    if (day < 1 || day > 15) return;
    byDay[day] = row;
  });
  const topicHint = String(query || 'התקופה').trim();
  const out = [];
  for (let day = 1; day <= 15; day++) {
    if (byDay[day]) {
      out.push(byDay[day]);
      continue;
    }
    out.push({
      day: day,
      week: Math.ceil(day / 5),
      topic: 'יום ' + day + ' — ' + topicHint,
      content: 'המשך קשת התקופה: היזכרות, חומר חדש, וחיבור ליום הקודם בנושא «' + topicHint + '».',
      art: 'עבודה במחברת / ציור / צביעה הקשורים לנושא היום.',
    });
  }
  return out;
}

function usableGeneralSearchParsed(parsed, periodBlock) {
  if (!parsed || typeof parsed !== 'object' || isUnusableGeneralSearchParse(parsed, periodBlock)) {
    return false;
  }
  if (periodBlock) {
    const days = Array.isArray(parsed.curriculum) ? parsed.curriculum.length : 0;
    if (days < 10 && parsed._parseFallback) return false;
  }
  return true;
}

function buildSmoothGeneralSearchFallback(periodBlock, rawText, options) {
  const opts = options || {};
  const phase = periodBlock ? 'general_search_period' : 'general_search';
  const fallback = jsonRepair.buildModelParseFallback(phase, rawText || '', {
    query: opts.query || '',
    topic: opts.query || '',
    grade: opts.gradeLabel || '',
    gradeLabel: opts.gradeLabel || '',
  });
  if (periodBlock) {
    fallback.periodBlock = true;
    fallback.curriculum = padCurriculumToFifteen(fallback.curriculum, opts.query);
  }
  return fallback;
}

/**
 * Gemini JSON mode first (responseMimeType application/json, maxOutputTokens >= 4096),
 * then Perplexity, then a Gemini repair pass. Never throw a raw parse error to the UI.
 */
async function callGeneralSearchJson(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const periodBlock = Boolean(opts.periodBlock);
  const phase = opts.phase || (periodBlock ? 'general_search_period' : 'general_search');
  const maxOutputTokens = periodBlock
    ? geminiJson.PERIOD_MAX_OUTPUT_TOKENS
    : geminiJson.DEFAULT_MAX_OUTPUT_TOKENS;
  const parseContext = {
    query: opts.query || '',
    topic: opts.query || '',
    grade: opts.gradeLabel || '',
    gradeLabel: opts.gradeLabel || '',
  };
  const geminiOpts = {
    phase: phase,
    context: parseContext,
    periodBlock: periodBlock,
    maxOutputTokens: maxOutputTokens,
    googleSearch: true,
    responseSchema: getGeneralSearchResponseSchema(periodBlock),
    temperature: 0.25,
  };

  let raw = '';
  let parsed = null;

  if (env.getGeminiApiKey()) {
    try {
      const geminiResult = await geminiJson.generateJson(systemPrompt, userPrompt, geminiOpts);
      raw = geminiResult.raw || '';
      parsed = geminiResult.parsed;
      if (usableGeneralSearchParsed(parsed, periodBlock)) {
        return parsed;
      }
    } catch (geminiErr) {
      console.warn(
        '[pure-general-search] Gemini JSON generate failed:',
        geminiErr && geminiErr.message ? geminiErr.message : geminiErr
      );
    }
  }

  try {
    const pplx = await shared.callPerplexityJsonSafe(systemPrompt, userPrompt, {
      phase: phase,
      query: opts.query || '',
      max_tokens: maxOutputTokens,
      temperature: opts.temperature,
    });
    if (pplx && pplx.raw) raw = raw || pplx.raw;
    if (pplx && usableGeneralSearchParsed(pplx.parsed, periodBlock)) {
      return pplx.parsed;
    }
    if (pplx && pplx.parsed && !parsed) parsed = pplx.parsed;
  } catch (pplxErr) {
    console.warn(
      '[pure-general-search] Perplexity JSON generate failed:',
      pplxErr && pplxErr.message ? pplxErr.message : pplxErr
    );
  }

  if (raw && env.getGeminiApiKey()) {
    try {
      const repaired = await geminiJson.repairToJson(raw, Object.assign({}, geminiOpts, {
        googleSearch: false,
        temperature: 0,
      }));
      if (repaired && usableGeneralSearchParsed(repaired.parsed, periodBlock)) {
        return repaired.parsed;
      }
      if (repaired && repaired.parsed) parsed = repaired.parsed;
    } catch (repairErr) {
      console.warn(
        '[pure-general-search] Gemini JSON repair failed:',
        repairErr && repairErr.message ? repairErr.message : repairErr
      );
    }
  }

  return parsed && typeof parsed === 'object'
    ? parsed
    : buildSmoothGeneralSearchFallback(periodBlock, raw, opts);
}

async function callGeneralSearchJsonWithSubjectLock(systemPrompt, userPrompt, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const parsed = await callGeneralSearchJson(systemPrompt, userPrompt, opts);
  if (!opts.periodBlock) return parsed;
  if (!curriculumDriftsFromLockedSubject(parsed, opts.query, opts.gradeInfo)) return parsed;
  console.warn(
    '[pure-general-search] 15-day curriculum drifted from locked subject; retrying',
    String(opts.query || '').slice(0, 80)
  );
  const retryPrompt = String(userPrompt || '') + '\n\n' + buildSubjectDriftRetryInstruction(opts.query, opts.gradeInfo);
  return callGeneralSearchJson(systemPrompt, retryPrompt, opts);
}

function resolvePeriodGrade(body) {
  const src = body && typeof body === 'object' ? body : {};
  const gradeId = String(src.gradeId || src.currentGrade || '').trim();
  const gradeLabel = String(src.gradeLabel || '').trim();
  return {
    gradeId: gradeId,
    gradeLabel: gradeLabel,
  };
}

function buildPeriodContextLine(query, gradeInfo) {
  const q = String(query || '').trim();
  const gradeLabel = gradeInfo && String(gradeInfo.gradeLabel || '').trim();
  if (gradeLabel) return 'נושא: ' + q + ', כיתה: ' + gradeLabel;
  return q;
}

function buildPeriodBlockUserPrompt(query, gradeInfo) {
  const gradeLabel = gradeInfo && String(gradeInfo.gradeLabel || '').trim();
  const contextLine = buildPeriodContextLine(query, gradeInfo);
  const gradeLock = gradeLabel
    ? [
        'הכיתה שנבחרה במפורש לטבלת 15 הימים: «' + gradeLabel + '».',
        'בנה את כל 15 הימים אך ורק לגיל ולשכבה זו — שפה, סיפור, קצב ואמנות מותאמים לכיתה זו בלבד.',
        'אל תסיק כיתה אחרת ואל תערבב דוגמאות מכיתות אחרות בתוך שורות הימים.',
      ].join(' ')
    : 'חלץ את הכיתה ואת נושא התקופה מהשאילתה. אם הכיתה אינה מפורשת — הסיק את הכיתה הקנונית בחינוך וולדרוף לנושא זה.';
  return [
    'בנה תוכנית תקופה מלאה בחינוך וולדרוף: 3 שבועות × 5 ימי לימוד = 15 ימים במלואם.',
    'אל תייצר חומר קצר או מקוצר — התוכנית חייבת להיות מלאה, עמוקה ומפורטת לכל 15 הימים.',
    contextLine,
    gradeLock,
    buildSubjectLockInstruction(query, gradeInfo),
    '',
    HEBREW_ONLY_BODY_INSTRUCTION,
    '',
    PERIOD_BLOCK_DEPTH_AND_JSON_INSTRUCTION,
    '',
    WALDORF_ELEMENTARY_SCOPE_INSTRUCTION,
    '',
    'שני תפקידים פדגוגיים נפרדים (חובה מוחלטת):',
    '1) הסקירה העליונה (developmental_axis + core_pedagogical_emphases) חייבת תמיד לתאר את קשת ההתפתחות של הנושא לאורך כל תכנית הלימודים הוולדורפית מכיתה א׳ עד כיתה ח׳ לפי חגורות א׳–ג׳, ד׳–ה׳, ו׳, ז׳–ח׳ — עומק אנתרופוסופי רב-פסקאות, לא סיכום גנרי. אין לנעול את הסקירה לכיתה שנבחרה.',
    '2) טבלת 15 הימים (curriculum) חייבת תמיד להיות מותאמת אך ורק לכיתה שנבחרה ברשימה ולתחום הדעת שנחקר — למשל מדעי כיתה ז׳ (מכניקה / כימיה של שריפה / פיזיולוגיה) או רישום צורה כיתה ג׳. הקשת ההתפתחותית של א׳–ח׳ אינה מתירה לגלוש לנושא אחר בטבלה.',
    '',
    'דרישות מבנה JSON (מפתחות מדויקים בלבד):',
    '- developmental_axis: קשת התפתחותית עשירה של הנושא מכיתה א׳ עד כיתה ח׳ — מספר פסקאות לכל חגורת גיל (א׳–ג׳ חוויה חושית וסיפור; ד׳–ה׳ תצפית חיה; ו׳ רוביקון שני ופנומנולוגיה; ז׳–ח׳ מדעים סיבתיים).',
    '- core_pedagogical_emphases: דגשים פדגוגיים, מצפן התפתחותי ומצפן למורה לפי אותן חגורות גיל — פירוט מקצועי רב-פסקאות.',
    '- recommended_literature: מקורות מקצועיים לתקופה (הערות בעברית נקייה).',
    '- relevant_links: דפי בית מאושרים או חיפוש Google מסוג site:DOMAIN+TOPIC בלבד — אסור לנחש נתיבים פנימיים.',
    RELEVANT_LINKS_NO_HALLUCINATION_INSTRUCTION,
    '',
    'curriculum (תוכנית 15 ימים) — חובה מוחלטת:',
    '- בדיוק 15 אובייקטים: day 1 עד day 15.',
    '- week 1 = ימים 1–5, week 2 = ימים 6–10, week 3 = ימים 11–15.',
    '- בכל יום: topic (נושא ליבה יומי), content (נקודות ממוקדות לסיפור/תוכן חדש — מופרדות ב-\\n), art (נקודות ממוקדות למחברת/ציור/צביעה/עבודת יד).',
    '- אין פסקאות ארוכות ב-content/art — רק נקודות/משפטים ממוקדים ששומרים על JSON שלם עד יום 15.',
    '- קשת נרטיבית רציפה לאורך כל 15 הימים: פתיחה, העמקה, שיא, שילוב.',
    '- מקצב שיעור ראשי: סיפור/דקלום, היזכרות, חומר חדש, עבודה אמנותית.',
    '- שפה ופעילויות בטבלה מותאמות לגיל הכיתה שנבחרה בלבד.',
    '- ' + SUBJECT_LOCK_HEBREW,
    '- ' + SUBJECT_DAILY_MATCH_HEBREW,
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
    WALDORF_ELEMENTARY_SCOPE_INSTRUCTION,
    '',
    shared.PROFESSIONAL_LINKS_INSTRUCTION,
    '',
    RELEVANT_LINKS_NO_HALLUCINATION_INSTRUCTION,
    '',
    shared.PEDAGOGICAL_DEPTH_INSTRUCTION,
    '',
    'Section requirements:',
    '- developmental_axis (ציר התפתחותי): rich multi-paragraph Hebrew covering Grades 1–8 age bands — א׳–ג׳ sensory/story/handwork; ד׳–ה׳ living observation (zoology/botany); ו׳ second Rubicon and scientific phenomenology; ז׳–ח׳ causal sciences and adolescent thinking. Never brief generic summaries.',
    '- core_pedagogical_emphases (דגשים פדגוגיים מרכזיים): rich professional Anthroposophical depth with Developmental Compass for each of those age bands.',
    '- recommended_literature: each entry with contextual note explaining coverage and relevance.',
    '- relevant_links (קישורים): 6-8 items whose url is an approved homepage (' + APPROVED_RELEVANT_LINK_DOMAINS.join(', ') + ') or a Google site: search such as https://www.google.com/search?q=site:waldorflibrary.org+TOPIC — never a guessed deep path.',
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
  const gradeInfo = resolvePeriodGrade(body);
  if (gradeInfo.gradeId) archiveOpts.gradeId = gradeInfo.gradeId;
  if (gradeInfo.gradeLabel) archiveOpts.gradeLabel = gradeInfo.gradeLabel;
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
  const gradeInfo = resolvePeriodGrade(body);
  const archiveText = buildGeneralSearchArchiveText(historic) || JSON.stringify(historic).slice(0, 16000);
  const upgradeIntro = buildArchiveUpgradeIntro(archiveText, buildPeriodContextLine(query, periodBlock ? gradeInfo : null));
  const systemPrompt = periodBlock ? buildPeriodBlockSystemPrompt(query, gradeInfo) : SYSTEM_PROMPT;
  const basePrompt = periodBlock ? buildPeriodBlockUserPrompt(query, gradeInfo) : buildStandardUserPrompt(query);
  const userPrompt = upgradeIntro + '\n\n' + basePrompt;

  await enforceLiveSearchQuota(body, requestContext);
  try {
    const parsed = await callGeneralSearchJsonWithSubjectLock(systemPrompt, userPrompt, {
      phase: periodBlock ? 'general_search_period' : 'general_search',
      query: query,
      periodBlock: periodBlock,
      gradeLabel: (typeof gradeInfo !== 'undefined' && gradeInfo.gradeLabel) || '',
      gradeInfo: gradeInfo,
    });
    const normalized = normalizeGeneralSearchResponse(parsed, { periodBlock: periodBlock, query: query });

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
  const gradeInfo = resolvePeriodGrade(body);
  const archiveText = buildGeneralSearchArchiveText(historic) || JSON.stringify(historic).slice(0, 16000);
  const expandIntro = buildResearchExpandIntro(archiveText, buildPeriodContextLine(query, periodBlock ? gradeInfo : null));
  const systemPrompt = periodBlock ? buildPeriodBlockSystemPrompt(query, gradeInfo) : SYSTEM_PROMPT;
  const basePrompt = periodBlock ? buildPeriodBlockUserPrompt(query, gradeInfo) : buildStandardUserPrompt(query);
  const userPrompt = expandIntro + '\n\n' + basePrompt;

  await enforceLiveSearchQuota(body, requestContext);
  try {
    const parsed = await callGeneralSearchJsonWithSubjectLock(systemPrompt, userPrompt, {
      phase: periodBlock ? 'general_search_period' : 'general_search',
      query: query,
      periodBlock: periodBlock,
      gradeLabel: (typeof gradeInfo !== 'undefined' && gradeInfo.gradeLabel) || '',
      gradeInfo: gradeInfo,
    });
    const normalized = normalizeGeneralSearchResponse(parsed, { periodBlock: periodBlock, query: query });

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
  const gradeInfo = resolvePeriodGrade(body);
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
  // 15-day confirm only accepts a period15 row for the same gradeId — never a standard overview.
  const confirmArchiveKey = String(body.confirmArchiveKey || body.archiveCacheKey || '').trim();
  if (confirmArchiveKey && !bypassCache) {
    const confirmed = await cache.getGeneralSearchByCacheKey(confirmArchiveKey, {
      periodBlock: periodBlock,
      gradeId: periodBlock ? (gradeInfo.gradeId || undefined) : undefined,
    });
    if (confirmed && confirmed.data) {
      return {
        data: normalizeGeneralSearchResponse(confirmed.data, {
          periodBlock: periodBlock,
          query: query,
          gradeId: gradeInfo.gradeId || '',
        }),
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
    // 15-day lookups use key [general_search, query, period15, gradeId] and reject standard overviews.
    const cached = await cache.safeArchiveLookup(
      'general_search_cache:' + query.slice(0, 40),
      function () {
        return cache.getGeneralSearchCache(query, {
          periodBlock: periodBlock,
          gradeId: gradeInfo.gradeId || undefined,
          gradeLabel: gradeInfo.gradeLabel || undefined,
        });
      },
      { phase: 'general_search', budgetMs: cache.ARCHIVE_LOOKUP_BUDGET_MS }
    );
    if (cached && cached.data) {
      const cacheKey = cached.meta && cached.meta.cacheKey ? cached.meta.cacheKey : null;
      return {
        data: normalizeGeneralSearchResponse(cached.data, {
          periodBlock: periodBlock,
          query: query,
          gradeId: gradeInfo.gradeId || '',
        }),
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
    // No matching archive row — go straight to live generation (Gemini).
  }

  const systemPrompt = periodBlock ? buildPeriodBlockSystemPrompt(query, gradeInfo) : SYSTEM_PROMPT;
  const userPrompt = periodBlock ? buildPeriodBlockUserPrompt(query, gradeInfo) : buildStandardUserPrompt(query);

  await enforceLiveSearchQuota(body, requestContext);
  console.log(
    '[pure-general-search] live web search',
    periodBlock ? '(15-day cache miss — Gemini generation)' : '(community summary decoupled)'
  );
  try {
    const parsed = await callGeneralSearchJsonWithSubjectLock(systemPrompt, userPrompt, {
      phase: periodBlock ? 'general_search_period' : 'general_search',
      query: query,
      periodBlock: periodBlock,
      gradeLabel: (typeof gradeInfo !== 'undefined' && gradeInfo.gradeLabel) || '',
      gradeInfo: gradeInfo,
    });
    const normalized = normalizeGeneralSearchResponse(parsed, {
      periodBlock: periodBlock,
      query: query,
      gradeId: gradeInfo.gradeId || '',
    });

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
        source: 'gemini-json',
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
  classifyPeriodSubjectFamily,
  buildSubjectLockInstruction,
  buildPeriodBlockSystemPrompt,
  buildPeriodBlockUserPrompt,
  buildStandardUserPrompt,
  curriculumDriftsFromLockedSubject,
  sanitizeRelevantLinks,
  sanitizeRelevantLinkUrl,
  buildApprovedSiteSearchUrl,
  APPROVED_RELEVANT_LINK_DOMAINS,
  RELEVANT_LINKS_NO_HALLUCINATION_INSTRUCTION,
};
