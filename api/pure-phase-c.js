/**
 * POST /api/pure-phase-c — unified Step B→C synthesis via Perplexity with topic_master archive cache.
 * Body: { grade, gradeId, topic }
 */
const shared = require('./pure-api-shared');
const cache = require('./cache');
const perplexityClient = require('./perplexity-client');
const jsonRepair = require('./json-repair');
const waldorfWebSeed = require('../waldorf-web-seed');

/** Structural JSON keys that must never appear in pedagogical fallback text. */
const PHASE_C_JSON_KEY_PATTERN = /["']?(?:theory|inspiration|sections|heading|headings|content|title|text|body|summary|bibliography|books|articles|websites|global|items|podcast|episodes|theme|insight|narrative|pinterest_links|pedagogical_resources|core_emphases|key_points|recommended_reading|relevant_links|icon|url|board|label|source|snippet|author|note|pin|quotes|fa-compass|theory_background|pedagogical_inspiration|developmental_compass|pedagogical_emphases)["']?\s*:/gi;

function isPhaseCParseFallback(parsed) {
  return Boolean(parsed && typeof parsed === 'object' && parsed._parseFallback);
}

function stripHtmlToPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/li>\s*<li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Known JSON key tokens — discard if a quoted value equals one of these exactly. */
const PHASE_C_JSON_KEY_TOKENS = new Set([
  'theory', 'inspiration', 'sections', 'heading', 'headings', 'content', 'title', 'text', 'body',
  'summary', 'bibliography', 'books', 'articles', 'websites', 'global', 'items', 'podcast', 'episodes',
  'theme', 'insight', 'narrative', 'pinterest_links', 'pedagogical_resources', 'core_emphases',
  'key_points', 'recommended_reading', 'relevant_links', 'icon', 'url', 'board', 'label', 'source',
  'snippet', 'author', 'note', 'pin', 'quotes', 'fa-compass', 'theory_background',
  'pedagogical_inspiration', 'developmental_compass', 'pedagogical_emphases',
]);

function unescapeJsonStringFragment(fragment) {
  return String(fragment || '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\')
    .trim();
}

function isSubstantiveFallbackFragment(text) {
  const s = String(text || '').trim();
  if (!s || s.length < 4) return false;
  if (PHASE_C_JSON_KEY_TOKENS.has(s.toLowerCase())) return false;
  if (/^fa-[a-z0-9-]+$/i.test(s)) return false;
  if (/^https?:\/\//i.test(s) && s.length < 80) return false;
  if (/^[\w_\-]+$/i.test(s) && s.length < 40) return false;
  if (/[\u0590-\u05FF]/.test(s)) return true;
  return s.split(/\s+/).length >= 4;
}

/** Pull human prose out of malformed JSON by harvesting quoted string literals. */
function extractQuotedProseFromJsonDebris(text) {
  const values = [];
  const seen = new Set();
  const re = /"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const inner = unescapeJsonStringFragment(match[1]);
    if (!isSubstantiveFallbackFragment(inner)) continue;
    const key = inner.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(inner);
  }
  return values;
}

function mergeProseFragments(fragments) {
  const seen = new Set();
  const unique = [];
  fragments.forEach(function (part) {
    const trimmed = String(part || '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    unique.push(trimmed);
  });
  return unique.join('\n\n').trim();
}

/**
 * Strip JSON architectural debris and rebuild continuous pedagogical prose.
 * Preserves full text length — never truncates.
 */
function sterilizePhaseCFallbackText(raw) {
  let text = stripHtmlToPlainText(raw);
  text = jsonRepair.plainTextFromModelOutput(text);

  const quotedProse = extractQuotedProseFromJsonDebris(text);
  if (quotedProse.length) {
    return mergeProseFragments(quotedProse);
  }

  text = unescapeJsonStringFragment(text);
  text = text.replace(/[\u201c\u201d\u05f4]/g, '"').replace(/[\u2018\u2019\u05f3]/g, "'");

  text = text.replace(PHASE_C_JSON_KEY_PATTERN, ' ');
  text = text.replace(/[{}\[\]]/g, ' ');
  text = text.replace(/\bnull\b/gi, ' ').replace(/\b(?:true|false)\b/gi, ' ');

  text = text.replace(/,\s*,+/g, ',');
  text = text.replace(/^\s*[,:\s]+/gm, '');
  text = text.replace(/\s*,\s*$/gm, '');
  text = text.replace(/^\s*:\s*/gm, '');
  text = text.replace(/^\s*,+\s*/gm, '');
  text = text.replace(/"\s*,\s*"/g, '\n\n');
  text = text.replace(/["']/g, '');

  text = text.replace(/[^\S\n]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  const paragraphs = text.split(/\n\n+/).map(function (part) {
    return part.replace(/^[\s,"':\-–—]+|[\s,"':\-–—]+$/g, '').trim();
  }).filter(function (part) {
    return isSubstantiveFallbackFragment(part);
  });

  return paragraphs.join('\n\n').trim();
}

function pushFallbackTextChunk(chunks, value) {
  if (value == null) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) chunks.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(function (item) { pushFallbackTextChunk(chunks, item); });
    return;
  }
  if (typeof value === 'object') {
    pushFallbackTextChunk(chunks, value.content || value.text || value.body || value.summary || value.insight);
    pushFallbackTextChunk(chunks, value.heading || value.title || value.theme);
    if (Array.isArray(value.sections)) value.sections.forEach(function (sec) { pushFallbackTextChunk(chunks, sec); });
    if (Array.isArray(value.items)) value.items.forEach(function (item) { pushFallbackTextChunk(chunks, item); });
    if (Array.isArray(value.episodes)) value.episodes.forEach(function (ep) { pushFallbackTextChunk(chunks, ep); });
    if (Array.isArray(value.global)) value.global.forEach(function (block) { pushFallbackTextChunk(chunks, block); });
  }
}

/** Collect every textual fragment from a parse-fallback payload (prefer longest source). */
function gatherPhaseCFallbackSourceText(parsed) {
  if (parsed == null) return '';
  if (typeof parsed === 'string') return parsed;
  if (typeof parsed !== 'object') return String(parsed);

  const chunks = [];
  pushFallbackTextChunk(chunks, parsed.core_emphases);
  pushFallbackTextChunk(chunks, parsed.core_pedagogical_emphases);
  pushFallbackTextChunk(chunks, parsed.pedagogical_emphases);
  pushFallbackTextChunk(chunks, parsed.key_points);
  pushFallbackTextChunk(chunks, parsed.theory);
  pushFallbackTextChunk(chunks, parsed.inspiration);
  pushFallbackTextChunk(chunks, parsed.pedagogical_inspiration);
  pushFallbackTextChunk(chunks, parsed.theory_background);
  pushFallbackTextChunk(chunks, parsed.rawText);

  if (!chunks.length) {
    return shared.coerceText(parsed);
  }

  chunks.sort(function (a, b) { return b.length - a.length; });
  const richest = chunks[0];
  if (richest && richest.length >= 200) return richest;

  const seen = new Set();
  const unique = [];
  chunks.forEach(function (chunk) {
    const key = chunk.slice(0, 120);
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(chunk);
  });
  return unique.join('\n\n');
}

function paragraphsFromSterileEssay(essay) {
  if (!essay) return [];
  return essay.split(/\n\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
}

/** Regex harvester for live bilingual URLs embedded in raw Perplexity apiResponse debris. */
const PHASE_C_URL_PATTERN = /https?:\/\/[^\s"'<>\\\]\)】\u0000-\u001f]+/gi;

/** Legacy structural archive URLs known to 404 — never emit as fallback links. */
const PHASE_C_DEAD_URL_PATTERNS = [
  /harduf\.org\.il/i,
  /shaked\.org\.il/i,
  /kehilanet/i,
  /\/http_new\//i,
  /index\.asp/i,
  /ViewPage\.asp/i,
  /edupage\.org\/.*login/i,
  /google\.com\/search/i,
];

const PHASE_C_THEORY_URL_HINTS = /rsarchive|waldorflibrary|steiner|anthroposoph|gesamtausgabe|\bga[\d_]|lecture|archive|library|essay|article|journal|research|pdf|anthro/i;
const PHASE_C_INSPIRATION_URL_HINTS = /pinterest|form[\-_]?draw|chalkboard|blackboard|main[\-_]?lesson|lesson[\-_]?book|gallery|creative|craft|artistic|inspiration|pint/i;
const PHASE_C_PEDAGOGY_URL_HINTS = /awsna|iaswece|waldorfeducation|teacher|classroom|curriculum|pedagog|educationpace|mofet/i;

function cleanHarvestedUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  url = url.replace(/\\+$/g, '');
  url = url.replace(/[),.;:'"»«\]}>]+$/g, '');
  url = url.replace(/&amp;/gi, '&');
  url = url.replace(/&#x2F;/gi, '/');
  return url;
}

function isDeadPhaseCFallbackUrl(url) {
  const u = String(url || '').trim();
  if (!u || !/^https?:\/\//i.test(u)) return true;
  if (/pinterest\.com/i.test(u)) return false;
  if (waldorfWebSeed.isBrokenOrGuessedPedagogicalUrl(u)) return true;
  for (let i = 0; i < PHASE_C_DEAD_URL_PATTERNS.length; i++) {
    if (PHASE_C_DEAD_URL_PATTERNS[i].test(u)) return true;
  }
  try {
    const parsed = new URL(u);
    const path = (parsed.pathname || '').replace(/\/+$/, '');
    if (!path || path === '/' || path === '/index.html' || path === '/index.php') return true;
  } catch (e) {
    return true;
  }
  return false;
}

function gatherPhaseCFallbackApiResponse(parsed) {
  if (parsed == null) return '';
  if (typeof parsed === 'string') return parsed;
  const parts = [];
  if (parsed._apiResponseRaw) parts.push(String(parsed._apiResponseRaw));
  if (parsed.rawText) parts.push(String(parsed.rawText));
  try {
    parts.push(JSON.stringify(parsed));
  } catch (e) { /* ignore circular refs */ }
  const sourceText = gatherPhaseCFallbackSourceText(parsed);
  if (sourceText) parts.push(sourceText);
  return parts.join('\n');
}

function inferHarvestedLinkTitle(url, raw, topic) {
  const u = String(url || '').trim();
  const blob = String(raw || '');
  const idx = blob.indexOf(u);
  if (idx >= 0) {
    const windowStart = Math.max(0, idx - 420);
    const windowText = blob.slice(windowStart, idx + u.length + 40);
    const md = windowText.match(new RegExp('\\[([^\\]]{2,120})\\]\\(\\s*' + u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\)', 'i'));
    if (md && md[1]) return md[1].trim();
    const jsonTitle = windowText.match(/"title"\s*:\s*"((?:\\.|[^"\\]){2,160})"[\s\S]{0,220}"url"\s*:\s*"/i);
    if (jsonTitle && jsonTitle[1]) return unescapeJsonStringFragment(jsonTitle[1]);
    const heTitle = windowText.match(/"title"\s*:\s*"([^"]*[\u0590-\u05FF][^"]{1,160})"/);
    if (heTitle && heTitle[1]) return unescapeJsonStringFragment(heTitle[1]);
  }
  try {
    const host = new URL(u).hostname.replace(/^www\./i, '');
    const tail = (new URL(u).pathname || '').split('/').filter(Boolean).pop() || '';
    const readable = decodeURIComponent(tail).replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim();
    const topicStr = String(topic || '').trim();
    if (readable && readable.length > 2) return readable + (topicStr ? ' — ' + topicStr : '');
    return host + (topicStr ? ' — ' + topicStr : '');
  } catch (e) {
    return u;
  }
}

function classifyPhaseCFallbackUrl(url) {
  const u = String(url || '').toLowerCase();
  if (/pinterest\.com/i.test(u)) return 'pinterest';
  if (PHASE_C_INSPIRATION_URL_HINTS.test(u)) return 'inspiration';
  if (PHASE_C_THEORY_URL_HINTS.test(u)) return 'theory';
  if (PHASE_C_PEDAGOGY_URL_HINTS.test(u)) return 'relevant';
  return 'relevant';
}

function harvestPhaseCFallbackLinksFromRaw(apiResponse, topic) {
  const raw = String(apiResponse || '');
  if (!raw.trim()) return [];
  const seen = new Set();
  const out = [];
  let match;
  const re = new RegExp(PHASE_C_URL_PATTERN.source, 'gi');
  while ((match = re.exec(raw)) !== null) {
    const url = cleanHarvestedUrl(match[0]);
    if (!url || seen.has(url) || isDeadPhaseCFallbackUrl(url)) continue;
    seen.add(url);
    out.push({
      title: inferHarvestedLinkTitle(url, raw, topic),
      url: url,
      bucket: classifyPhaseCFallbackUrl(url),
    });
  }
  return out;
}


function filterLiveNormalizedLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.filter(function (item) {
    if (!item || typeof item !== 'object') return false;
    const url = String(item.url || item.link || item.href || '').trim();
    return url && !isDeadPhaseCFallbackUrl(url);
  });
}

/**
 * Distribute harvested live URLs across Phase C tabs without duplicating the same list.
 * Theory → bibliography.websites | Inspiration → pinterest + pedagogical_resources | Tab 3 → relevant_links.
 */
function distributePhaseCFallbackLinks(normalized, harvested, topic) {
  if (!normalized) return normalized;
  harvested = harvested || [];

  normalized.relevant_links = filterLiveNormalizedLinks(normalized.relevant_links);
  normalized.pinterest_links = filterLiveNormalizedLinks(normalized.pinterest_links);
  normalized.pedagogical_resources = filterLiveNormalizedLinks(normalized.pedagogical_resources);
  if (!normalized.theory || typeof normalized.theory !== 'object') {
    normalized.theory = { title: '', sections: [], bibliography: { books: [], articles: [], websites: [] } };
  }
  if (!normalized.theory.bibliography) {
    normalized.theory.bibliography = { books: [], articles: [], websites: [] };
  }
  normalized.theory.bibliography.websites = filterLiveNormalizedLinks(normalized.theory.bibliography.websites);

  if (!harvested.length) return normalized;

  const seen = new Set();
  function seenUrl(url) {
    const u = String(url || '').trim();
    if (!u || seen.has(u)) return true;
    seen.add(u);
    return false;
  }

  (normalized.relevant_links || []).forEach(function (item) { seenUrl(item.url); });
  (normalized.pinterest_links || []).forEach(function (item) { seenUrl(item.url); });
  (normalized.pedagogical_resources || []).forEach(function (item) { seenUrl(item.url); });
  (normalized.theory.bibliography.websites || []).forEach(function (item) { seenUrl(item.url); });

  const pinterest = normalized.pinterest_links.slice();
  const inspiration = normalized.pedagogical_resources.slice();
  const theorySites = normalized.theory.bibliography.websites.slice();
  const relevant = normalized.relevant_links.slice();

  harvested.forEach(function (item) {
    const url = String(item.url || '').trim();
    if (!url || seenUrl(url)) return;
    const title = String(item.title || url).trim();
    const bucket = item.bucket || classifyPhaseCFallbackUrl(url);

    if (bucket === 'pinterest' && pinterest.length < 8) {
      pinterest.push({
        title: title,
        url: url,
        board: String(topic || '').trim(),
        pin: title,
        src: '',
      });
      return;
    }
    if (bucket === 'inspiration' && inspiration.length < 10) {
      inspiration.push({
        title: title,
        url: url,
        label: 'השראה מעשית',
        source: '',
        snippet: '',
      });
      return;
    }
    if (bucket === 'theory' && theorySites.length < 8) {
      theorySites.push({
        title: title,
        author: '',
        year: '',
        detail: '',
        url: url,
        category: 'websites',
        id: 'websites-harvest-' + theorySites.length,
      });
      return;
    }
    if (relevant.length < 8) {
      relevant.push({ title: title, url: url });
    }
  });

  normalized.pinterest_links = pinterest;
  normalized.pedagogical_resources = inspiration;
  normalized.theory.bibliography.websites = theorySites;
  normalized.relevant_links = relevant;
  return normalized;
}

function applyPhaseCFallbackLinkHarvester(normalized, parsed, topic) {
  const raw = gatherPhaseCFallbackApiResponse(parsed);
  const harvested = harvestPhaseCFallbackLinksFromRaw(raw, topic);
  return distributePhaseCFallbackLinks(normalized, harvested, topic);
}

async function callPhaseCPerplexitySafe(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const raw = await perplexityClient.callPerplexityChat({
    model: perplexityClient.PERPLEXITY_MODEL,
    temperature: opts.temperature != null ? opts.temperature : 0.35,
    max_tokens: opts.max_tokens != null
      ? opts.max_tokens
      : perplexityClient.PERPLEXITY_MAX_OUTPUT_TOKENS_PRO,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  const phase = opts.phase || 'topic_master';
  const result = jsonRepair.parsePureModelJson(raw, {
    phase: phase,
    context: {
      grade: opts.grade || opts.gradeLabel || '',
      gradeLabel: opts.gradeLabel || opts.grade || '',
      topic: opts.topic || '',
      query: opts.query || '',
    },
    unwrap: true,
  });
  if (result.parsed && typeof result.parsed === 'object') {
    result.parsed._apiResponseRaw = String(raw || '');
  }
  return result;
}

function buildKeyPointsFromEssay(essay, paragraphs) {
  if (paragraphs.length >= 5) return paragraphs.slice(0, 6);
  if (paragraphs.length >= 2) return paragraphs.slice(0, 6);
  if (!essay) return [];
  const sentences = essay.split(/(?<=[.!?׃。])\s+/).map(function (s) { return s.trim(); }).filter(function (s) {
    return s.length > 24;
  });
  if (sentences.length >= 4) {
    const groupSize = Math.max(1, Math.ceil(sentences.length / 5));
    const groups = [];
    for (let i = 0; i < sentences.length && groups.length < 6; i += groupSize) {
      groups.push(sentences.slice(i, i + groupSize).join(' '));
    }
    return groups;
  }
  return [essay];
}

const PHASE_C_FALLBACK_BOLD_PHRASES = [
  'מצפן התפתחותי', 'רציונל התפתחותי', 'רודולף שטיינר', 'רודולף סטיינר', 'Rudolf Steiner',
  'וולדורף', 'אנתרופוסופיה', 'אימגינציה', 'רישום צורות', 'שיעור ראשי', 'מחזור התפתחותי',
  'גיל התשע', 'גיל השמונה', 'גיל השבע', 'גיל השש', 'גיל החמש', 'גיל הארבע', 'גיל השלוש',
  'נפש', 'רוח', 'גוף', 'פדגוגיה', 'התפתחותי', 'דימוי', 'תנועה', 'אמנות',
];

const THEORY_FALLBACK_HEADINGS = [
  'יסודות אנתרופוסופיים ומהות הנושא',
  'גיל והתפתחות — מצפן למורה',
  'יישום בכיתה ודימוי פדגוגי',
  'מקורות, השראה והעמקה',
];

function splitIntoSentences(text) {
  return String(text || '').split(/(?<=[.!?׃。])\s+/).map(function (s) {
    return s.trim();
  }).filter(function (s) {
    return s.length > 20;
  });
}

function splitEssayIntoChunks(essay, targetCount) {
  const paragraphs = paragraphsFromSterileEssay(essay);
  if (paragraphs.length >= targetCount) return paragraphs;
  if (!essay) return [];
  const sentences = splitIntoSentences(essay);
  if (sentences.length < targetCount) return paragraphs.length ? paragraphs : [essay];
  const groupSize = Math.max(1, Math.ceil(sentences.length / targetCount));
  const chunks = [];
  for (let i = 0; i < sentences.length && chunks.length < targetCount; i += groupSize) {
    chunks.push(sentences.slice(i, i + groupSize).join(' '));
  }
  return chunks.length ? chunks : [essay];
}

function groupParagraphsIntoChunks(paragraphs, targetCount) {
  const items = (paragraphs || []).filter(Boolean);
  if (!items.length) return [];
  if (items.length <= targetCount) return items.slice();
  const groupSize = Math.max(1, Math.ceil(items.length / targetCount));
  const chunks = [];
  for (let i = 0; i < items.length && chunks.length < targetCount; i += groupSize) {
    chunks.push(items.slice(i, i + groupSize).join('\n\n'));
  }
  return chunks.length ? chunks : [items.join('\n\n')];
}

function normalizeForDedup(text) {
  return stripHtmlToPlainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDuplicateText(fragment, seenKeys, minLen) {
  const norm = normalizeForDedup(fragment);
  const floor = minLen != null ? minLen : 24;
  if (!norm || norm.length < floor) return false;
  if (seenKeys.has(norm)) return true;
  let seen;
  for (seen of seenKeys) {
    if (seen.length < 40 || norm.length < 40) continue;
    if (seen.includes(norm) || norm.includes(seen)) return true;
    const wordsA = norm.split(' ').filter(function (w) { return w.length > 3; });
    const setB = new Set(seen.split(' ').filter(function (w) { return w.length > 3; }));
    let overlap = 0;
    wordsA.forEach(function (w) { if (setB.has(w)) overlap++; });
    const ratio = overlap / Math.max(wordsA.length, 1);
    if (ratio > 0.72 && overlap >= 6) return true;
  }
  return false;
}

function markTextSeen(fragment, seenKeys) {
  const norm = normalizeForDedup(fragment);
  if (norm) seenKeys.add(norm);
  splitIntoSentences(fragment).forEach(function (sentence) {
    const sentenceNorm = normalizeForDedup(sentence);
    if (sentenceNorm.length >= 30) seenKeys.add(sentenceNorm);
  });
}

function dedupeTextFragments(fragments, seenKeys) {
  const out = [];
  (fragments || []).forEach(function (frag) {
    const trimmed = String(frag || '').trim();
    if (!trimmed || isDuplicateText(trimmed, seenKeys, 20)) return;
    markTextSeen(trimmed, seenKeys);
    out.push(trimmed);
  });
  return out;
}

const FALLBACK_PEDAGOGY_KEYWORDS = /מצפן|התפתחות|גיל\s|מורה|פדגוג|דימוי|נפש|רוח|סמכות|עצמאות|מרד|developmental|compass|teacher|authority|rebellion/i;
const FALLBACK_THEORY_KEYWORDS = /היסטור|מהפכ|אנתרופוסופ|שטיינר|steiner|רקע|תקופה|anthroposoph|revolution|history|lecture|ga\s*\d/i;
const FALLBACK_INSPIRATION_KEYWORDS = /כיתה|שיעור|פעילות|תנועה|אמנות|חווי|יישום|דוגמ|יציר|drawing|art|classroom|practical|inspiration|creative/i;

function classifyFallbackParagraphBucket(paragraph) {
  const text = String(paragraph || '');
  const pedScore = (text.match(FALLBACK_PEDAGOGY_KEYWORDS) || []).length;
  const theoryScore = (text.match(FALLBACK_THEORY_KEYWORDS) || []).length;
  const inspScore = (text.match(FALLBACK_INSPIRATION_KEYWORDS) || []).length;
  if (pedScore >= theoryScore && pedScore >= inspScore && pedScore > 0) return 'pedagogy';
  if (theoryScore >= inspScore && theoryScore > 0) return 'theory';
  if (inspScore > 0) return 'inspiration';
  return 'neutral';
}

function fillFallbackBucket(bucket, targetChars, pool) {
  let len = bucket.reduce(function (sum, item) { return sum + item.len; }, 0);
  while (len < targetChars && pool.length) {
    const item = pool.shift();
    if (!item) break;
    bucket.push(item);
    len += item.len;
  }
  return pool;
}

function partitionFallbackEssay(essay, grade) {
  let paragraphs = paragraphsFromSterileEssay(essay);
  if (paragraphs.length < 4) {
    paragraphs = groupParagraphsIntoChunks(splitIntoSentences(essay), Math.max(6, Math.ceil(splitIntoSentences(essay).length / 2)));
  }
  if (!paragraphs.length && essay) paragraphs = [essay];

  const tagged = paragraphs.map(function (paragraph, index) {
    return {
      text: paragraph,
      bucket: classifyFallbackParagraphBucket(paragraph),
      index: index,
      len: paragraph.length,
    };
  });

  const totalLen = tagged.reduce(function (sum, item) { return sum + item.len; }, 0) || essay.length || 1;
  const targetCore = Math.floor(totalLen * 0.37);
  const targetTheory = Math.floor(totalLen * 0.33);
  const targetInsp = Math.max(0, totalLen - targetCore - targetTheory);

  const core = [];
  const theory = [];
  const inspiration = [];
  const neutral = [];
  tagged.forEach(function (item) {
    if (item.bucket === 'pedagogy') core.push(item);
    else if (item.bucket === 'theory') theory.push(item);
    else if (item.bucket === 'inspiration') inspiration.push(item);
    else neutral.push(item);
  });

  let remainder = neutral.slice();
  remainder = fillFallbackBucket(core, targetCore, remainder.filter(function (item) {
    return FALLBACK_PEDAGOGY_KEYWORDS.test(item.text);
  }));
  remainder = fillFallbackBucket(core, targetCore, remainder);
  remainder = fillFallbackBucket(theory, targetTheory, remainder);
  remainder = fillFallbackBucket(inspiration, targetInsp, remainder);
  remainder.forEach(function (item) {
    if (core.reduce(function (s, t) { return s + t.len; }, 0) < targetCore) core.push(item);
    else if (theory.reduce(function (s, t) { return s + t.len; }, 0) < targetTheory) theory.push(item);
    else inspiration.push(item);
  });

  return {
    theoryParagraphs: theory.map(function (item) { return item.text; }),
    inspirationParagraphs: inspiration.map(function (item) { return item.text; }),
    coreParagraphs: core.map(function (item) { return item.text; }),
  };
}

const CORE_EMPHASES_HEADINGS_BY_GRADE = {
  '8': [
    'מצפן התפתחותי — סמכות פנימית ואתגר המרד',
    'יחס המורה לגיל המרד והעצמאות הרוחנית',
    'דגשים לבניית תקופה והיעדים הפדגוגיים',
  ],
  '7': [
    'מצפן התפתחותי — גיל ההתבגרות המוקדמת',
    'יחס המורה לקצב, לדימוי ולשאלות הקיום',
    'דגשים לבניית תקופה והיעדים הפדגוגיים',
  ],
  '6': [
    'מצפן התפתחותי — מעבר לעולם הארצי והרציונלי',
    'יחס המורה לשאלות צדק, סמכות וקהילה',
    'דגשים לבניית תקופה והיעדים הפדגוגיים',
  ],
};

function getCoreEmphasesHeadings(grade) {
  const gradeNum = resolveGradeNum(grade);
  if (gradeNum && CORE_EMPHASES_HEADINGS_BY_GRADE[gradeNum]) {
    return CORE_EMPHASES_HEADINGS_BY_GRADE[gradeNum].slice();
  }
  return [
    'מצפן התפתחותי — רציונל גילי',
    'יחס המורה לקצב ולמצפן ההתפתחותי',
    'דגשים לבניית תקופה והיעדים הפדגוגיים',
  ];
}

const FALLBACK_DOMAIN_PATTERN = /\b((?:www\.)?[a-z0-9][-a-z0-9]*(?:\.[a-z0-9][-a-z0-9]*)+\.(?:org|com|edu|net|il)(?:\/[^\s,.;:)}\]"']*)?)/gi;
const FALLBACK_MARKDOWN_LINK_PATTERN = /\[([^\]]{2,160})\]\(\s*(https?:\/\/[^)\s]+)\s*\)/gi;
const FALLBACK_TITLE_URL_PATTERN = /([^\n]{4,140}?)\s*(?:[—–\-:])\s*(https?:\/\/\S+)/gi;
const FALLBACK_BARE_URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

function buildFallbackAnchorHtml(url, label) {
  const href = cleanHarvestedUrl(url);
  if (!href || isDeadPhaseCFallbackUrl(href)) return escapeHtmlForFallback(label || url);
  const display = String(label || href).trim() || href;
  return '<a href="' + escapeHtmlForFallback(href) + '" target="_blank" rel="noopener noreferrer" class="prose-source-link">' +
    escapeHtmlForFallback(display) + '</a>';
}

function ensureDomainHref(domain) {
  const raw = String(domain || '').trim().replace(/^www\./i, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return cleanHarvestedUrl(raw);
  return cleanHarvestedUrl('https://' + raw.replace(/^\/+/, ''));
}

function linkifyFallbackSegment(text) {
  const extracted = [];
  const placeholders = [];
  let work = String(text || '');

  function stashLink(url, label) {
    const clean = ensureDomainHref(url);
    if (!clean || isDeadPhaseCFallbackUrl(clean)) return null;
    const title = String(label || clean).trim() || clean;
    extracted.push({ title: title, url: clean, bucket: classifyPhaseCFallbackUrl(clean) });
    const token = '\x00FLINK' + placeholders.length + '\x00';
    placeholders.push(buildFallbackAnchorHtml(clean, title));
    return token;
  }

  work = work.replace(FALLBACK_MARKDOWN_LINK_PATTERN, function (full, label, url) {
    return stashLink(url, label) || full;
  });
  work = work.replace(FALLBACK_TITLE_URL_PATTERN, function (full, label, url) {
    return stashLink(url, label) || full;
  });
  work = work.replace(FALLBACK_BARE_URL_PATTERN, function (url) {
    return stashLink(url, '') || url;
  });
  work = work.replace(FALLBACK_DOMAIN_PATTERN, function (domain) {
    if (/^https?:\/\//i.test(domain)) return domain;
    return stashLink(domain, domain) || domain;
  });

  work = escapeHtmlForFallback(work);
  PHASE_C_FALLBACK_BOLD_PHRASES.forEach(function (phrase) {
    const re = new RegExp('(' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    work = work.replace(re, '<strong>$1</strong>');
  });
  placeholders.forEach(function (html, index) {
    work = work.split('\x00FLINK' + index + '\x00').join(html);
  });

  return { html: work, links: extracted };
}

function mergeExtractedLinksIntoNormalized(normalized, linkGroups, topic) {
  const harvested = [];
  (linkGroups || []).forEach(function (group) {
    (group || []).forEach(function (item) {
      if (item && item.url) harvested.push(item);
    });
  });
  if (!harvested.length) return normalized;
  return distributePhaseCFallbackLinks(normalized, harvested, topic);
}

function escapeHtmlForFallback(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function boldPedagogicalPhrases(text) {
  let out = escapeHtmlForFallback(text);
  PHASE_C_FALLBACK_BOLD_PHRASES.forEach(function (phrase) {
    const re = new RegExp('(' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    out = out.replace(re, '<strong>$1</strong>');
  });
  return out;
}

function formatFallbackProseChunk(text) {
  const parts = String(text || '').split(/\n\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
  if (!parts.length) return { html: '', links: [] };
  const allLinks = [];
  const html = parts.map(function (part) {
    const linked = linkifyFallbackSegment(part);
    allLinks.push.apply(allLinks, linked.links || []);
    return '<p>' + linked.html + '</p>';
  }).join('\n');
  return { html: html, links: allLinks };
}

function buildTheoryFallbackSections(essay, paragraphs, seenKeys) {
  const seen = seenKeys || new Set();
  let source = paragraphs && paragraphs.length >= 3
    ? dedupeTextFragments(paragraphs.slice(), seen)
    : dedupeTextFragments(splitEssayIntoChunks(essay, 4), seen);

  if (source.length < 3 && essay) {
    const extra = dedupeTextFragments(splitIntoSentences(essay), seen);
    source = source.concat(extra);
  }

  let chunks = source.slice(0, 4);
  while (chunks.length < 3 && chunks.length > 0) {
    let largest = chunks[0];
    let largestIdx = 0;
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i].length > largest.length) {
        largest = chunks[i];
        largestIdx = i;
      }
    }
    const sentences = splitIntoSentences(largest);
    if (sentences.length < 2) break;
    const mid = Math.ceil(sentences.length / 2);
    const first = dedupeTextFragments([sentences.slice(0, mid).join(' ')], seen);
    const second = dedupeTextFragments([sentences.slice(mid).join(' ')], seen);
    if (!first.length && !second.length) break;
    chunks.splice(largestIdx, 1);
    if (first.length) chunks.splice(largestIdx, 0, first[0]);
    if (second.length) chunks.splice(largestIdx + (first.length ? 1 : 0), 0, second[0]);
    if (chunks.length >= 4) break;
  }

  const allLinks = [];
  const sections = chunks.map(function (content, i) {
    const deduped = dedupeTextFragments([content], seen);
    const chunkText = deduped[0] || content;
    const formatted = formatFallbackProseChunk(chunkText);
    allLinks.push.apply(allLinks, formatted.links || []);
    return {
      heading: THEORY_FALLBACK_HEADINGS[i] || ('חלון ' + (i + 1)),
      content: formatted.html,
      icon: 'fa-compass',
    };
  }).filter(function (sec) { return sec.content; });

  return { sections: sections, links: allLinks };
}

function buildCoreEmphasesFallbackHtml(paragraphs, essay, grade, seenKeys) {
  const seen = seenKeys || new Set();
  const headings = getCoreEmphasesHeadings(grade);
  let source = dedupeTextFragments((paragraphs || []).slice(), seen);
  if (!source.length && essay) {
    source = dedupeTextFragments(paragraphsFromSterileEssay(essay), seen);
  }
  if (!source.length && essay) {
    source = dedupeTextFragments(splitEssayIntoChunks(essay, 3), seen);
  }

  let chunks = source.length >= 2
    ? groupParagraphsIntoChunks(source, 3)
    : dedupeTextFragments(splitEssayIntoChunks(source.join('\n\n') || essay, 3), seen);
  chunks = dedupeTextFragments(chunks, seen).slice(0, 3);
  while (chunks.length < 2 && essay) {
    const extra = dedupeTextFragments(splitEssayIntoChunks(essay, 3), seen);
    chunks = dedupeTextFragments(chunks.concat(extra), seen).slice(0, 3);
    break;
  }

  const allLinks = [];
  let html = '<div class="prose-ai leading-relaxed w-full space-y-5">';
  chunks.forEach(function (content, i) {
    if (!content) return;
    const formatted = formatFallbackProseChunk(content);
    allLinks.push.apply(allLinks, formatted.links || []);
    html += '<article class="theory-fallback-window bg-white/75 rounded-2xl border border-gold/25 p-5 sm:p-6 w-full box-border">';
    html += '<h4 class="app-subhead font-display font-bold text-sage-dark mb-3"><strong>' +
      escapeHtmlForFallback(headings[i] || ('דגש ' + (i + 1))) + '</strong></h4>';
    html += formatted.html || '';
    html += '</article>';
  });
  html += '</div>';
  return { html: html, links: allLinks };
}

function splitInspirationFallbackItems(paragraphs, essay) {
  let items = paragraphs.length > 1 ? paragraphs.slice() : splitEssayIntoChunks(essay, 6);
  if (!items.length && essay) items = [essay];
  return items.filter(function (item) { return String(item || '').trim().length > 24; });
}

function buildInspirationFallbackGlobalBlocks(items) {
  if (!items.length) return [{ title: 'תובנות והשראה', items: [] }];
  const blockTitles = ['רעיונות מעשיים לכיתה', 'דימוי ואמנות', 'תנועה וחוויה', 'השראה נוספת'];
  const perBlock = Math.max(2, Math.ceil(items.length / Math.min(4, Math.ceil(items.length / 2))));
  const blocks = [];
  for (let i = 0; i < items.length; i += perBlock) {
    const slice = items.slice(i, i + perBlock);
    if (!slice.length) continue;
    blocks.push({
      title: blockTitles[blocks.length] || ('השראה ' + (blocks.length + 1)),
      items: slice,
    });
  }
  return blocks.length ? blocks : [{ title: 'תובנות והשראה', items: items }];
}

const BOOK_TITLE_FROM_TEXT_PATTERNS = [
  /«([^»]{4,120})»/g,
  /"([^"]{4,120})"/g,
  /(?:ספר|כתב|הרצאות|מאמר)[:\s—–-]+([^\n,.:]{4,100})/gi,
  /(?:Rudolf Steiner|רודולף (?:שטיינר|סטיינר))[^,\n]{0,60}/gi,
  /GA\s*\d{1,4}[^,\n]{0,80}/gi,
  /(?:Form Drawing|Education as Art|Painting and Drawing|Kingdom of Childhood)[^,\n]{0,60}/gi,
];

function extractRecommendedReadingFromText(text, topic) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const seen = new Set();
  const out = [];
  function pushBook(title, author, note) {
    const t = String(title || '').trim().replace(/^[\s:–—\-]+|[\s:–—\-]+$/g, '');
    if (!t || t.length < 4 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push({
      title: t,
      author: String(author || '').trim(),
      note: String(note || ('מקור מומלץ להעמקה בנושא ' + String(topic || '').trim())).trim(),
    });
  }
  BOOK_TITLE_FROM_TEXT_PATTERNS.forEach(function (pattern) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(raw)) !== null) {
      if (match[1]) {
        pushBook(match[1], '', '');
      } else {
        pushBook(match[0], '', '');
      }
    }
  });
  return out.slice(0, 8);
}

function resolveGradeNum(grade) {
  const digit = String(grade || '').match(/[1-8]/);
  return digit ? digit[0] : '';
}

function buildDefaultRecommendedReading(grade, topic) {
  const topicStr = String(topic || '').trim();
  const gradeNum = resolveGradeNum(grade);
  const hebrewGrades = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח'];
  const gradeLabel = gradeNum
    ? ('כיתה ' + hebrewGrades[parseInt(gradeNum, 10) - 1] + "'")
    : String(grade || '').trim();

  if (/רישום|צורות|form[\s-]?draw/i.test(topicStr)) {
    return [
      {
        title: 'Form Drawing — Grades 1–4',
        author: 'Laura Embrey-Stine & Ernst Schuberth',
        note: 'מדריך מעשי לרישום צורות לפי גילאים — קווים, סימטריה ומעבר לכתב עבור ' + gradeLabel + '.',
      },
      {
        title: 'Painting and Drawing in Waldorf Schools',
        author: 'Thomas Wildgruber',
        note: 'עקרונות אמנותיים וולדורפיים לציור ורישום — רלוונטי במיוחד ל' + topicStr + '.',
      },
      {
        title: 'הרצאות על חינוך וולדורפי — כרך ב׳',
        author: 'רודולף שטיינר',
        note: 'יסודות אנתרופוסופיים לחינוך אמנותי-תנועתי בגילאי בית הספר היסודי.',
      },
    ];
  }

  if (/חשבון|מתמטיק/i.test(topicStr)) {
    return [
      { title: 'Mathematics in the Waldorf School', author: 'Ernst Schuberth', note: 'גישה וולדורפית לחשבון ב' + gradeLabel + ' — מספרים, דימויים ותנועה.' },
      { title: 'Active Arithmetic', author: 'Henning Andersen', note: 'תרגילים וחוויות מעשיות לשיעורי חשבון בגיל הרך והיסודי.' },
      { title: 'הרצאות למורים — GA 304', author: 'רודולף שטיינר', note: 'עקרונות מתמטיים-אנתרופוסופיים לשיעור הראשי.' },
    ];
  }

  if (/שפה|קריאה|כתיבה|ספרות/i.test(topicStr)) {
    return [
      { title: 'The Kingdom of Childhood', author: 'Rudolf Steiner', note: 'הרצאות יסוד על דימוי שפה וספרות בגיל ' + (gradeLabel || 'בית הספר היסודי') + '.' },
      { title: 'Teaching Language Arts in the Waldorf School', author: 'Dorit Winter', note: 'קריאה, כתיבה וספרות כחוויה חיה — מותאם ל' + topicStr + '.' },
      { title: 'הרצאות על חינוך — GA 306', author: 'רודולף שטיינר', note: 'רקע אנתרופוסופי לעבודת השפה והדיבור בכיתה.' },
    ];
  }

  const genericByGrade = {
    '1': [
      { title: 'The Kingdom of Childhood', author: 'Rudolf Steiner', note: 'יסודות חינוך וולדורפי לכיתה א׳ — דימוי, קסם וסדר.' },
      { title: 'You Are Your Child\'s First Teacher', author: 'Rahima Baldwin Dancy', note: 'התפתחות ראשונית וגישה בית-בית ספרית לגיל השבע.' },
      { title: 'הרצאות לכיתה א׳', author: 'רודולף שטיינר', note: 'מצפן פדגוגי לפתיחת דרכו של הילד בבית הספר.' },
    ],
    '2': [
      { title: 'Waldorf Education: A Family Guide', author: 'Pamela Johnson Fenner', note: 'סקירה נגישה של עקרונות וולדורף לשנה השנייה.' },
      { title: 'Teaching As a Lively Art', author: 'Marjorie Spock', note: 'יחס מורה-תלמיד ואמנות ההוראה בגיל הרך.' },
      { title: 'הרצאות על חינוך וולדורפי', author: 'רודולף שטיינר', note: 'העמקה ביסודות הרוחניים-פדגוגיים לכיתה ב׳.' },
    ],
    '3': [
      { title: 'Form Drawing — Grades 1–4', author: 'Laura Embrey-Stine', note: 'רישום צורות ומעבר לכתב — מרכזי לעבודת כיתה ג׳.' },
      { title: 'The Tasks and Content of the Steiner-Waldorf Curriculum', author: 'Martyn Rawson', note: 'מפת תכנים לפי כיתות — עוגן לתכנון תקופה.' },
      { title: 'הרצאות לכיתה ג׳', author: 'רודולף שטיינר', note: 'רקע התפתחותי לעבודה אמנותית-תנועתית בגיל התשע.' },
    ],
  };

  if (gradeNum && genericByGrade[gradeNum]) return genericByGrade[gradeNum];

  return [
    { title: 'The Tasks and Content of the Steiner-Waldorf Curriculum', author: 'Martyn Rawson', note: 'מפת תכנים לפי כיתות — רלוונטי ל' + topicStr + ' ב' + (gradeLabel || 'בית הספר היסודי') + '.' },
    { title: 'Education as Art', author: 'Eugene Schwartz', note: 'חיבור בין אמנות, דימוי ושיעור ראשי בוולדורף.' },
    { title: 'הרצאות על חינוך וולדורפי', author: 'רודולף שטיינר', note: 'מקור אנתרופוסופי מרכזי להבנת הנושא ' + topicStr + '.' },
  ];
}

function ensureRecommendedReading(normalized, essay, grade, topic) {
  let reading = Array.isArray(normalized.recommended_reading)
    ? normalized.recommended_reading.filter(function (item) { return item && item.title; })
    : [];
  if (!reading.length) {
    reading = extractRecommendedReadingFromText(essay, topic);
  }
  if (!reading.length && normalized.theory && normalized.theory.bibliography) {
    const bib = normalized.theory.bibliography;
    (bib.books || []).forEach(function (book) {
      if (!book || !book.title) return;
      reading.push({
        title: book.title,
        author: book.author || '',
        note: book.detail || book.note || '',
      });
    });
  }
  if (!reading.length) {
    reading = buildDefaultRecommendedReading(grade, topic);
  }
  normalized.recommended_reading = reading.slice(0, 8);
  return normalized;
}

function collectPhaseCTabUrls(lists) {
  const urls = new Set();
  (lists || []).forEach(function (list) {
    (list || []).forEach(function (item) {
      if (!item) return;
      const u = String(item.url || item.link || item.href || '').trim();
      if (u) urls.add(u);
    });
  });
  return urls;
}

function deduplicatePhaseCTabLinks(normalized) {
  if (!normalized) return normalized;
  const inspirationUrls = collectPhaseCTabUrls([
    normalized.pinterest_links,
    normalized.pedagogical_resources,
  ]);
  const theoryUrls = collectPhaseCTabUrls([
    normalized.theory && normalized.theory.bibliography && normalized.theory.bibliography.websites,
  ]);

  normalized.pedagogical_resources = filterLiveNormalizedLinks(normalized.pedagogical_resources).filter(function (item) {
    const u = String(item.url || '').trim();
    return u && !theoryUrls.has(u);
  });

  normalized.relevant_links = filterLiveNormalizedLinks(normalized.relevant_links).filter(function (item) {
    const u = String(item.url || '').trim();
    if (!u) return false;
    if (inspirationUrls.has(u)) return false;
    if (theoryUrls.has(u)) return false;
    return true;
  });

  if (normalized.theory && normalized.theory.bibliography) {
    const tab3Urls = collectPhaseCTabUrls([normalized.relevant_links]);
    normalized.theory.bibliography.websites = filterLiveNormalizedLinks(
      normalized.theory.bibliography.websites
    ).filter(function (item) {
      const u = String(item.url || '').trim();
      return u && !inspirationUrls.has(u) && !tab3Urls.has(u);
    });
  }

  return normalized;
}

/**
 * Rebuild a normalized Phase C response from parse-fallback debris into full-length sterile prose.
 */
function applyPhaseCFallbackCleaner(normalized, parsed, grade, topic) {
  const source = gatherPhaseCFallbackSourceText(parsed);
  const essay = sterilizePhaseCFallbackText(source);
  if (!essay) return normalized;

  const topicStr = String(topic || 'נושא').trim();
  const gradeStr = String(grade || '').trim();
  const titleSuffix = gradeStr ? (gradeStr + ' · ' + topicStr) : topicStr;
  const seenKeys = new Set();
  const partition = partitionFallbackEssay(essay, gradeStr);

  const theoryParagraphs = dedupeTextFragments(partition.theoryParagraphs, seenKeys);
  const inspirationParagraphs = dedupeTextFragments(partition.inspirationParagraphs, seenKeys);
  const coreParagraphs = dedupeTextFragments(partition.coreParagraphs, seenKeys);

  const theoryEssay = theoryParagraphs.join('\n\n') || essay;
  const inspirationEssay = inspirationParagraphs.join('\n\n') || essay;
  const coreEssay = coreParagraphs.join('\n\n') || essay;

  const theoryResult = buildTheoryFallbackSections(
    theoryEssay,
    theoryParagraphs.length ? theoryParagraphs : paragraphsFromSterileEssay(theoryEssay),
    seenKeys
  );
  const coreResult = buildCoreEmphasesFallbackHtml(
    coreParagraphs,
    coreEssay,
    gradeStr,
    seenKeys
  );
  const inspirationItems = splitInspirationFallbackItems(
    inspirationParagraphs.length ? inspirationParagraphs : paragraphsFromSterileEssay(inspirationEssay),
    inspirationEssay
  );
  const keyPoints = buildKeyPointsFromEssay(
    coreEssay,
    coreParagraphs.length ? coreParagraphs : paragraphsFromSterileEssay(coreEssay)
  );

  normalized.theory = {
    title: 'רקע תיאורטי — ' + titleSuffix,
    sections: theoryResult.sections,
    bibliography: (normalized.theory && normalized.theory.bibliography) || { books: [], articles: [], websites: [] },
  };
  normalized.inspiration = {
    title: 'השראה פדגוגית — ' + topicStr,
    global: buildInspirationFallbackGlobalBlocks(inspirationItems),
    podcast: { title: 'תובנות', episodes: [] },
    narrative: inspirationParagraphs.length > 2 ? inspirationParagraphs.slice(-3) : [],
  };
  normalized.core_emphases = coreResult.html;
  normalized.key_points = keyPoints;
  if (!Array.isArray(normalized.recommended_reading)) normalized.recommended_reading = [];
  if (!Array.isArray(normalized.relevant_links)) normalized.relevant_links = [];
  if (!Array.isArray(normalized.pinterest_links)) normalized.pinterest_links = [];
  if (!Array.isArray(normalized.pedagogical_resources)) normalized.pedagogical_resources = [];

  mergeExtractedLinksIntoNormalized(normalized, [theoryResult.links, coreResult.links], topicStr);
  applyPhaseCFallbackLinkHarvester(normalized, parsed, topicStr);
  ensureRecommendedReading(normalized, coreEssay || essay, gradeStr, topicStr);
  deduplicatePhaseCTabLinks(normalized);

  return normalized;
}

const SYSTEM_PROMPT = [
  'You are a Waldorf / anthroposophical pedagogy expert.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'theory (object: {title, sections: [{heading, content, icon?}], bibliography: {books, articles, websites: [{title, url?}]}} — rich theoretical background for the grade+topic),',
  'inspiration (object: {title, global: [{title, items: [strings]}], podcast: {title, episodes: [{theme, insight}]}, narrative: [strings]} — artistic/pedagogical classroom inspiration),',
  'pinterest_links (array of objects: {title, url, board} — 4-8 live Pinterest board or curated pin URLs for this grade+topic Waldorf visual inspiration),',
  'pedagogical_resources (array of objects: {title, url, label, source, snippet} — live professional inspiration links for teachers),',
  'core_emphases (string: AT LEAST 3-4 comprehensive Hebrew paragraphs with a dedicated Developmental Compass block — מצפן התפתחותי / רציונל התפתחותי ומצפן למורה — covering why-this-age, inner developmental milestone, teacher attitude/rhythm, and concrete pedagogical goals; NEVER brief or truncated),',
  'key_points (array of exactly 5-6 substantial Hebrew strings — each 2-4 sentences on lesson-block dynamics, transitions, or core concepts; NOT terse one-liners; NEVER empty),',
  'recommended_reading (array of 5-8 objects: {title, author, note} — note MUST be 1-2 sentences on what the source covers and why it is relevant; NEVER an empty array),',
  'relevant_links (array of 6-8 objects: {title, url} — title MUST include short context after em dash/colon; live Steiner archives, Waldorf Library, professional essays; NEVER an empty array).',
  '',
  shared.STRUCTURAL_COMPLETENESS_INSTRUCTION,
].join(' ');

function normalizeBibliography(bib) {
  const data = bib && typeof bib === 'object' ? bib : {};
  function mapList(list, category) {
    if (!Array.isArray(list)) return [];
    return list.map(function (item, idx) {
      if (typeof item === 'string') {
        return { title: item.trim(), author: '', year: '', detail: '', url: '', category: category, id: category + '-' + idx };
      }
      if (!item || typeof item !== 'object') return null;
      return {
        title: String(item.title || item.name || '').trim(),
        author: String(item.author || item.writer || item.publisher || '').trim(),
        year: String(item.year || '').trim(),
        detail: String(item.detail || item.note || item.description || '').trim(),
        url: String(item.url || item.link || item.href || '').trim(),
        category: category,
        id: String(item.id || category + '-' + idx),
      };
    }).filter(function (item) { return item && item.title; });
  }
  return {
    books: mapList(data.books, 'books'),
    articles: mapList(data.articles, 'articles'),
    websites: mapList(data.websites, 'websites'),
  };
}

function normalizePinterestLinks(value) {
  if (!Array.isArray(value)) return [];
  return value.map(function (item, idx) {
    if (!item || typeof item !== 'object') return null;
    const url = String(item.url || item.link || item.href || '').trim();
    if (!url || !/pinterest/i.test(url)) return null;
    return {
      title: String(item.title || item.pin || item.query || ('Pinterest ' + (idx + 1))).trim(),
      url: url,
      board: String(item.board || item.category || '').trim(),
      pin: String(item.pin || item.title || '').trim(),
      src: String(item.src || item.image || '').trim(),
    };
  }).filter(Boolean);
}

function normalizePedagogicalResources(value) {
  if (!Array.isArray(value)) return [];
  return value.map(function (item) {
    if (!item || typeof item !== 'object') return null;
    const url = String(item.url || item.link || item.href || '').trim();
    if (!url || !/^https?:\/\//i.test(url) || /pinterest/i.test(url)) return null;
    return {
      title: String(item.title || item.name || url).trim(),
      url: url,
      label: String(item.label || item.type || item.category || 'מאמר פדגוגי').trim(),
      source: String(item.source || item.publisher || '').trim(),
      snippet: String(item.snippet || item.description || item.summary || '').trim(),
    };
  }).filter(Boolean);
}

function normalizeTheoryBlock(parsed, grade, topic) {
  const data = parsed && typeof parsed === 'object' ? parsed : {};
  const theory = data.theory;
  if (theory && typeof theory === 'object' && Array.isArray(theory.sections) && theory.sections.length) {
    return {
      title: String(theory.title || ('רקע תיאורטי — ' + topic)).trim(),
      sections: theory.sections.map(function (sec) {
        if (!sec || typeof sec !== 'object') {
          return { heading: '', content: shared.coerceText(sec), icon: 'fa-compass' };
        }
        return {
          heading: String(sec.heading || sec.title || '').trim(),
          content: shared.coerceText(sec.content || sec.text || sec.body || sec),
          icon: String(sec.icon || 'fa-compass').trim(),
        };
      }).filter(function (sec) { return sec.heading || sec.content; }),
      bibliography: normalizeBibliography(theory.bibliography),
    };
  }
  const fallback = shared.coerceText(data.theory_background || data.theoretical_background || data.theory);
  return {
    title: 'רקע תיאורטי — ' + topic,
    sections: fallback ? [{ heading: 'מהות ורקע פדגוגי', content: fallback, icon: 'fa-compass' }] : [],
    bibliography: normalizeBibliography(theory && theory.bibliography),
  };
}

function normalizeInspirationBlock(parsed, topic) {
  const data = parsed && typeof parsed === 'object' ? parsed : {};
  const insp = data.inspiration;
  if (insp && typeof insp === 'object') {
    const global = Array.isArray(insp.global) ? insp.global.map(function (block) {
      if (!block || typeof block !== 'object') {
        return { title: 'השראה', items: shared.coerceList(block) };
      }
      return {
        title: String(block.title || block.heading || 'השראה').trim(),
        items: shared.coerceList(block.items || block.points || block.ideas),
      };
    }).filter(function (block) { return block.items && block.items.length; }) : [];
    const podcast = insp.podcast && typeof insp.podcast === 'object' ? {
      title: String(insp.podcast.title || 'תובנות').trim(),
      episodes: Array.isArray(insp.podcast.episodes) ? insp.podcast.episodes.map(function (ep) {
        if (!ep || typeof ep !== 'object') return { theme: '', insight: shared.coerceText(ep) };
        return {
          theme: String(ep.theme || ep.title || '').trim(),
          insight: shared.coerceText(ep.insight || ep.text || ep.content),
        };
      }).filter(function (ep) { return ep.theme || ep.insight; }) : [],
    } : { title: 'תובנות', episodes: [] };
    const narrative = shared.coerceList(insp.narrative);
    if (global.length || podcast.episodes.length || narrative.length) {
      return {
        title: String(insp.title || ('השראה פדגוגית — ' + topic)).trim(),
        global: global,
        podcast: podcast,
        narrative: narrative,
      };
    }
  }
  const fallback = shared.coerceText(data.pedagogical_inspiration || data.inspiration);
  if (!fallback) return null;
  return {
    title: 'השראה פדגוגית — ' + topic,
    global: [{ title: 'רעיונות והשראה', items: shared.coerceList(fallback) }],
    podcast: { title: 'תובנות', episodes: [] },
    narrative: [],
  };
}

function pickNestedEssenceObject(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.curriculum && typeof data.curriculum === 'object' && !Array.isArray(data.curriculum)) {
    return data.curriculum;
  }
  const deep = data.pedagogicalDeepDive || data.pedagogical_deep_dive;
  if (deep && typeof deep === 'object' && !Array.isArray(deep)) return deep;
  return null;
}

function pickEssenceText(data, nested, deep, keys) {
  let i;
  const sources = [data, nested, deep];
  for (i = 0; i < keys.length; i++) {
    const key = keys[i];
    let s;
    for (s = 0; s < sources.length; s++) {
      const src = sources[s];
      if (!src || src[key] == null) continue;
      const text = shared.coerceText(src[key]);
      if (text) return text;
    }
  }
  return '';
}

function normalizePhaseCResponse(parsed, grade, topic) {
  const data = parsed && typeof parsed === 'object' ? parsed : {};
  const nested = pickNestedEssenceObject(data) || {};
  const deep = (data.pedagogicalDeepDive || data.pedagogical_deep_dive);
  const deepObj = deep && typeof deep === 'object' && !Array.isArray(deep) ? deep : null;
  const pedagogicalResources = normalizePedagogicalResources(data.pedagogical_resources);
  const pinterestLinks = normalizePinterestLinks(data.pinterest_links);
  const coreEmphases = pickEssenceText(data, nested, deepObj, [
    'core_emphases', 'core_pedagogical_emphases', 'pedagogical_emphases', 'developmental_compass',
  ]) || (typeof deep === 'string' ? shared.coerceText(deep) : '');
  const keyPoints = shared.coerceList(
    data.key_points || data.keyPoints || data.main_points || data.central_points ||
    nested.key_points || (deepObj && (deepObj.key_points || deepObj.pedagogical_goals))
  );
  const recommendedReading = shared.coerceReadingList(
    data.recommended_reading || data.recommended_literature || data.recommendedLiterature ||
    nested.recommended_reading || nested.recommended_literature ||
    (deepObj && (deepObj.recommended_reading || deepObj.recommended_literature))
  );
  const relevantLinks = shared.coerceLinks(
    data.relevant_links || data.links || data.professional_links ||
    nested.relevant_links || (deepObj && deepObj.relevant_links)
  );
  const inspirationUrlSet = collectPhaseCTabUrls([pinterestLinks, pedagogicalResources]);
  const pedagogicalFallback = relevantLinks
    .filter(function (link) { return link && link.url && !inspirationUrlSet.has(String(link.url).trim()); })
    .slice(0, 8)
    .map(function (link) {
      return { title: link.title, url: link.url, label: 'מאמר פדגוגי', source: '', snippet: '' };
    });
  const result = {
    theory: normalizeTheoryBlock(data, grade, topic),
    inspiration: normalizeInspirationBlock(data, topic),
    pinterest_links: pinterestLinks,
    pedagogical_resources: pedagogicalResources.length ? pedagogicalResources : pedagogicalFallback,
    core_emphases: coreEmphases,
    key_points: keyPoints,
    recommended_reading: recommendedReading,
    relevant_links: relevantLinks,
  };
  ensureRecommendedReading(result, coreEmphases, grade, topic);
  return deduplicatePhaseCTabLinks(result);
}

function resolveGradeId(body) {
  const fromBody = String(body.gradeId || body.currentGrade || '').trim();
  if (fromBody) return fromBody;
  const grade = String(body.grade || body.gradeLabel || '').trim();
  const digit = grade.match(/[1-8]/);
  return digit ? digit[0] : '';
}

function safeNormalizePhaseCResponse(parsed, grade, topic) {
  const topicStr = String(topic || 'נושא').trim();
  const needsFallbackClean = isPhaseCParseFallback(parsed) ||
    Boolean(parsed && parsed._normalizeFallback);
  let result;
  try {
    result = normalizePhaseCResponse(parsed, grade, topicStr);
  } catch (normErr) {
    console.warn('[pure-phase-c] normalizePhaseCResponse failed:', normErr.message || normErr);
    result = normalizePhaseCResponse({
      theory: {
        title: 'רקע תיאורטי — ' + topicStr,
        sections: [{
          heading: 'תוכן',
          content: gatherPhaseCFallbackSourceText(parsed) || 'לא ניתן לעבד את התשובה.',
          icon: 'fa-compass',
        }],
      },
      core_emphases: gatherPhaseCFallbackSourceText(parsed),
      _parseFallback: true,
      _normalizeFallback: true,
    }, grade, topicStr);
  }
  if (needsFallbackClean) {
    result = applyPhaseCFallbackCleaner(result, parsed, grade, topicStr);
  }
  return result;
}

async function runPurePhaseC(body) {
  const grade = String(body.grade || body.gradeLabel || body.gradeId || '').trim();
  const topic = String(body.topic || '').trim();
  const gradeId = resolveGradeId(body);
  if (!grade) throw shared.badRequest('grade is required');
  if (!topic) throw shared.badRequest('topic is required');

  if (gradeId && !body.forceFresh && !body.skipCache) {
    const cached = await cache.getTopicMasterCache(gradeId, topic);
    if (cached && cached.data) {
      try {
        return {
          data: safeNormalizePhaseCResponse(cached.data, grade, topic),
          meta: Object.assign({
            fromCache: true,
            source: 'topic_master_archive',
          }, cached.meta || {}),
        };
      } catch (cacheErr) {
        console.warn('[pure-phase-c] cache normalize failed, regenerating:', cacheErr.message || cacheErr);
      }
    }
  }

  const userPrompt = [
    'Produce Phase C pedagogical products and essence for Waldorf education.',
    'Grade: ' + grade,
    'Topic: ' + topic,
    'Focus on developmental appropriateness, soul-spiritual qualities, and practical classroom orientation.',
    'Write pedagogical content in Hebrew unless the topic itself is in another language.',
    '',
    shared.STRUCTURAL_COMPLETENESS_INSTRUCTION,
    '',
    shared.PROFESSIONAL_LINKS_INSTRUCTION,
    '',
    shared.PEDAGOGICAL_DEPTH_INSTRUCTION,
    '',
    'Return MAXIMUM-DEPTH, classroom-ready content — ALL sections fully populated at full length, zero truncation:',
    '- Tab 1 theory: exhaustive historical & anthroposophical foundations — 3-5 deep sections; bibliography with live HTTPS URLs on every website entry.',
    '- Tab 2 inspiration: highly enriched artistic/creative ideas — multiple global blocks, podcast episodes, narrative threads (no URLs inside text).',
    '- pinterest_links: 4-8 LIVE pinterest.com board or pin URLs matching grade+topic (main lesson books, form drawing, chalkboard art, student work).',
    '- pedagogical_resources: 5-10 LIVE professional teacher-facing links (articles, archives, deep sources — not parent school pages).',
    '- Tab 3 core_emphases (דגשים פדגוגיים ומהותיים): 3-4 deep paragraphs with Developmental Compass (מצפן התפתחותי) and concrete pedagogical goals.',
    '- Tab 3 key_points (נקודות מרכזיות): 5-6 substantial bullets on lesson architecture.',
    '- Tab 3 recommended_reading (ספרות מומלצת): 5-8 entries with contextual notes — MUST NOT be empty.',
    '- Tab 3 relevant_links (קישורים רלוונטיים): 6-8 live professional sources — MUST NOT be empty.',
  ].join('\n');

  const modelResult = await callPhaseCPerplexitySafe(SYSTEM_PROMPT, userPrompt, {
    phase: 'topic_master',
    grade: grade,
    gradeLabel: grade,
    topic: topic,
    max_tokens: perplexityClient.PERPLEXITY_MAX_OUTPUT_TOKENS_PRO,
  });
  const parsed = modelResult.parsed;
  const normalized = safeNormalizePhaseCResponse(parsed, grade, topic);

  if (gradeId && !modelResult.parseFallback) {
    cache.setTopicMasterCache(gradeId, grade, topic, normalized).catch(function (err) {
      console.warn('[pure-phase-c] topic_master cache save failed:', err.message || err);
    });
  }

  return {
    data: normalized,
    meta: {
      fromCache: false,
      source: modelResult.parseFallback ? 'perplexity-pure-fallback' : 'perplexity-pure',
      parseFallback: Boolean(modelResult.parseFallback),
    },
  };
}

const legacyHandler = shared.createLegacyPostHandler(async function (body) {
  const result = await runPurePhaseC(body || {});
  return result.data;
});

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
    const result = await runPurePhaseC(body || {});
    return Response.json({
      ok: true,
      data: result.data,
      meta: result.meta || { fromCache: false, source: 'perplexity-pure' },
    }, { status: 200, headers: headers });
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
  safeNormalizePhaseCResponse,
  sterilizePhaseCFallbackText,
  gatherPhaseCFallbackSourceText,
  applyPhaseCFallbackCleaner,
  harvestPhaseCFallbackLinksFromRaw,
  distributePhaseCFallbackLinks,
  gatherPhaseCFallbackApiResponse,
  buildTheoryFallbackSections,
  buildCoreEmphasesFallbackHtml,
  partitionFallbackEssay,
  dedupeTextFragments,
  linkifyFallbackSegment,
  ensureRecommendedReading,
  deduplicatePhaseCTabLinks,
  extractRecommendedReadingFromText,
  buildDefaultRecommendedReading,
};
