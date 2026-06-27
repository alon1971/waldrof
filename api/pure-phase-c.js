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

/** Zionism / History / Aliyah topic contexts — reject off-topic STEM links. */
const PHASE_C_HISTORY_ZIONISM_TOPIC_HINTS = /ציונות|zionism|עלייה|aliyah|היסטור|history|יהודה|מדינה|לאומ|national\s*revival/i;

/** Mathematics / exact sciences / academic-excellence noise for history themes. */
const PHASE_C_MATH_EXCELLENCE_OFF_TOPIC = /מתמטיק|mathematic|מדעים\s*מדויק|exact\s*scien|מצוינות\s*במתמטיק|academic\s*excellence|פיזיק|כימיה|biology|calculus|algebra|גיאומטר|stem\s*education/i;

const PHASE_C_TRUSTED_ROOT_DOMAINS = /(?:^|\.)waldorf\.co\.il|(?:^|\.)class4\.co\.il/i;

const PHASE_C_PROVEN_BARE_DOMAIN_PATTERN = /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:org|com|edu|net|il)(?:\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%[\]-]*)?$/i;

function isHistoryZionismTopicContext(topic) {
  return PHASE_C_HISTORY_ZIONISM_TOPIC_HINTS.test(String(topic || ''));
}

function isOffTopicMathExcellenceContent(text) {
  return PHASE_C_MATH_EXCELLENCE_OFF_TOPIC.test(String(text || ''));
}

function violatesPedagogicalTopicContext(url, snippet, topic) {
  if (!isHistoryZionismTopicContext(topic)) return false;
  const blob = [url, snippet].filter(Boolean).join(' ');
  return isOffTopicMathExcellenceContent(blob);
}

function isPinterestPhaseCUrl(url) {
  return /pinterest/i.test(String(url || ''));
}

/** Only accept real external URLs — never Hebrew prose or percent-encoded sentence paths (trusted Waldorf hosts exempt). */
function isTrustedWaldorfUploadUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const host = String(parsed.hostname || '').replace(/^www\./i, '');
    return PHASE_C_TRUSTED_ROOT_DOMAINS.test(host) && /wp-content\/uploads/i.test(parsed.pathname || '');
  } catch (e) {
    return false;
  }
}

function hasLongPercentEncodedHebrewPath(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const pathQuery = (parsed.pathname || '') + (parsed.search || '');
    if (!/%D7[0-9A-Fa-f]{2}/i.test(pathQuery)) return false;
    const encodedRuns = pathQuery.match(/%D7[0-9A-Fa-f]{2}/gi);
    return pathQuery.length > 60 || Boolean(encodedRuns && encodedRuns.length >= 3);
  } catch (e) {
    return false;
  }
}

function isValidPhaseCExternalUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  if (isForbiddenForeignSourceUrl(raw)) return false;
  if (!/^https?:\/\//i.test(raw)) {
    if (!PHASE_C_PROVEN_BARE_DOMAIN_PATTERN.test(raw) && !PHASE_C_TRUSTED_ROOT_DOMAINS.test(raw)) {
      return false;
    }
    return isValidPhaseCExternalUrl('https://' + raw.replace(/^\/+/, ''));
  }
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || '').replace(/^www\./i, '');
    if (PHASE_C_TRUSTED_ROOT_DOMAINS.test(host)) return true;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i.test(host)) {
      return false;
    }
    const pathQuery = (parsed.pathname || '') + (parsed.search || '');
    if (/%D7[0-9A-Fa-f]{2}/i.test(pathQuery)) return false;
    if (pathQuery.length > 160 && /%[0-9A-Fa-f]{2}/i.test(pathQuery)) return false;
    if (/[\u0590-\u05FF]/.test(pathQuery)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function resolvePhaseCFriendlyLinkTitle(label, url) {
  const href = String(url || '').trim();
  const clean = String(label || '').trim();
  if (clean && !/^https?:\/\//i.test(clean) && !/%[0-9A-Fa-f]{2}/i.test(clean) &&
      !/[\u0590-\u05FF]/.test(clean) && clean.length <= 120) {
    return clean;
  }
  try {
    const parsed = new URL(href);
    const path = String(parsed.pathname || '').toLowerCase();
    if (/\.pdf(?:$|[?#])/i.test(path) || (isTrustedWaldorfUploadUrl(href) && hasLongPercentEncodedHebrewPath(href))) {
      return '[קישור למקור פדגוגי - PDF]';
    }
    if (hasLongPercentEncodedHebrewPath(href) || /%D7[0-9A-Fa-f]{2}/i.test(href)) {
      return '[קישור למקור פדגוגי]';
    }
    const host = parsed.hostname.replace(/^www\./i, '');
    if (PHASE_C_TRUSTED_ROOT_DOMAINS.test(host)) {
      return '[קישור למקור פדגוגי]';
    }
  } catch (e) { /* ignore */ }
  if (/^https?:\/\//i.test(clean) || /%[0-9A-Fa-f]{2}/i.test(clean)) {
    return '[קישור למקור פדגוגי]';
  }
  return clean || '[קישור למקור פדגוגי]';
}

/** Trusted Waldorf/anthro portal roots — prefer these over deep links. */
const PHASE_C_TRUSTED_PORTAL_ROOTS = [
  'https://rsarchive.org/',
  'https://www.waldorflibrary.org/',
  'https://waldorflibrary.org/',
  'https://antro.co.il/',
  'https://www.antro.co.il/',
  'https://waldorfeducation.org/',
  'https://www.iaswece.org/',
  'https://iaswece.org/',
];

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
  /%D7[0-9A-Fa-f]{2}/i,
];

const PHASE_C_THEORY_URL_HINTS = /rsarchive|waldorflibrary|steiner|anthroposoph|gesamtausgabe|\bga[\d_]|lecture|archive|library|essay|article|journal|research|pdf|anthro/i;
const PHASE_C_INSPIRATION_URL_HINTS = /pinterest|form[\-_]?draw|chalkboard|blackboard|main[\-_]?lesson|lesson[\-_]?book|gallery|creative|craft|artistic|inspiration|pint/i;
const PHASE_C_PEDAGOGY_URL_HINTS = /awsna|iaswece|waldorfeducation|teacher|classroom|curriculum|pedagog|educationpace|mofet/i;

/** Trusted pedagogical hosts — always pass the educational gate. */
const PHASE_C_EDUCATIONAL_DOMAIN_HINTS = /(?:^|\.)rsarchive\.org|waldorflibrary|waldorfeducation|awsna|iaswece|steiner|anthroposoph|educationpace|mofet\.macam|gesamtausgabe|pedagogy|waldorf/i;

/** Keywords in URL path/query that rescue borderline hosts (Pinterest pins, etc.). */
const PHASE_C_EDUCATIONAL_PATH_KEYWORDS = /waldorf|steiner|anthroposoph|astronomy|astronom|lesson|pedagog|curriculum|classroom|main[\-_]?lesson|form[\-_]?draw|chalkboard|blackboard|education|archive|lecture|compass|inspiration|pin|board|teacher|development|gesamtausgabe|\bga[\d_]|block|מחזור|וולדורף|שטיינר|אסטרונומ|פדגוג|שיעור|כיתה|השראה/i;

/** Generic e-commerce / clothing / marketplace hosts. */
const PHASE_C_SPAM_COMMERCE_DOMAINS = /(?:^|\.)(?:amazon|ebay|aliexpress|alibaba|wish|shein|asos|zara|hm|nike|adidas|etsy|shopify|woocommerce|fashion|clothing|boutique|apparel)(?:\.[a-z]{2,})?$/i;

/** Ad networks and tracking domains. */
const PHASE_C_AD_NETWORK_DOMAINS = /(?:^|\.)(?:doubleclick|googlesyndication|adservice|taboola|outbrain|adnxs|adform|criteo)(?:\.[a-z]{2,})?$/i;

/** Raw social network homepages (no educational path). */
const PHASE_C_GENERIC_SOCIAL_HOSTS = /^(?:www\.)?(?:facebook|instagram|tiktok|twitter|x)\.com$/i;

function urlHasEducationalKeyword(url) {
  return PHASE_C_EDUCATIONAL_PATH_KEYWORDS.test(String(url || ''));
}

function isTrustedEducationalDomain(url) {
  try {
    const host = new URL(String(url || '')).hostname.replace(/^www\./i, '');
    return PHASE_C_EDUCATIONAL_DOMAIN_HINTS.test(host);
  } catch (e) {
    return false;
  }
}

function isSpamCommerceOrAdUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.replace(/^www\./i, '');
    if (PHASE_C_SPAM_COMMERCE_DOMAINS.test(host) || PHASE_C_AD_NETWORK_DOMAINS.test(host)) {
      return !urlHasEducationalKeyword(url);
    }
    return false;
  } catch (e) {
    return true;
  }
}

function isGenericSocialRootUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = (parsed.hostname || '').replace(/^www\./i, '');
    const path = (parsed.pathname || '').replace(/\/+$/, '');
    if (PHASE_C_GENERIC_SOCIAL_HOSTS.test(host) && (!path || path === '/')) return true;
    if (/^pinterest\.com$/i.test(host)) {
      if (!path || path === '/' || path === '/index.html') return true;
      if (/^\/(login|signup|about|business|ideas|settings)\/?$/i.test(path)) return true;
      if (/^\/(pin|search|boards?)\//i.test(path)) return false;
      if (urlHasEducationalKeyword(url)) return false;
      return true;
    }
    return false;
  } catch (e) {
    return true;
  }
}

/** Reject generic commerce, ad networks, and bare social homepages unless URL carries educational keywords. */
function isNonEducationalSpamUrl(url) {
  const u = String(url || '').trim();
  if (!u) return true;
  if (isTrustedEducationalDomain(u)) return false;
  if (isSpamCommerceOrAdUrl(u)) return true;
  if (isGenericSocialRootUrl(u)) return true;
  return false;
}

function cleanHarvestedUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  url = url.replace(/\\+$/g, '');
  url = url.replace(/[),.;:'"»«\]}>]+$/g, '');
  url = url.replace(/&amp;/gi, '&');
  url = url.replace(/&#x2F;/gi, '/');
  if (!isValidPhaseCExternalUrl(url)) return '';
  return url;
}

function isForbiddenForeignSourceUrl(url) {
  const u = String(url || '').trim();
  if (!u) return true;
  const lower = u.toLowerCase();
  if (/\.(ru|su|ua)(?:\/|$|:)/i.test(lower)) return true;
  if (/cyberleninka|elibrary\.ru|vestnik|valdorfsk|pedagogik/i.test(lower) && /\.ru|\.su|\.ua/i.test(lower)) {
    return true;
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u.replace(/^\/+/, ''));
    const host = String(parsed.hostname || '').toLowerCase();
    if (/\.(ru|su|ua)$/.test(host)) return true;
  } catch (e) {
    return false;
  }
  return false;
}

const PHASE_C_DISALLOWED_FOREIGN_SCRIPTS = /[\u0400-\u04FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;

function hasDisallowedForeignScript(text) {
  return PHASE_C_DISALLOWED_FOREIGN_SCRIPTS.test(String(text || ''));
}

function normalizeToTrustedPortalRoot(url) {
  const clean = cleanHarvestedUrl(url);
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    const origin = (parsed.origin || '').toLowerCase();
    for (let i = 0; i < PHASE_C_TRUSTED_PORTAL_ROOTS.length; i++) {
      const root = PHASE_C_TRUSTED_PORTAL_ROOTS[i];
      if (origin === new URL(root).origin.toLowerCase()) {
        const segments = String(parsed.pathname || '').split('/').filter(Boolean);
        if (segments.length > 2 || /%[0-9A-Fa-f]{2}/i.test(parsed.pathname || '')) {
          return root.endsWith('/') ? root : (root + '/');
        }
        return clean;
      }
    }
  } catch (e) { /* ignore */ }
  return clean;
}

function isShallowReliablePhaseCUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const host = String(parsed.hostname || '').replace(/^www\./i, '');
    const path = String(parsed.pathname || '');
    if (/%[0-9A-Fa-f]{2}/i.test(path) || /%D7/i.test(path)) return false;
    const segments = path.split('/').filter(Boolean);
    if (PHASE_C_TRUSTED_ROOT_DOMAINS.test(host) || isTrustedEducationalDomain(url)) {
      if (segments.length <= 2) return true;
      return segments.length <= 3 && !/%[0-9A-Fa-f]{2}/i.test(path);
    }
    if (/pinterest\.com/i.test(host)) return segments.length >= 1 && segments.length <= 4;
    return segments.length <= 1;
  } catch (e) {
    return false;
  }
}

function isDeadPhaseCFallbackUrl(url) {
  const u = String(url || '').trim();
  if (!u || !/^https?:\/\//i.test(u)) return true;
  if (isForbiddenForeignSourceUrl(u)) return true;
  if (isNonEducationalSpamUrl(u)) return true;
  if (waldorfWebSeed.isBrokenOrGuessedPedagogicalUrl(u)) return true;
  if (!isShallowReliablePhaseCUrl(u) && !isPinterestPhaseCUrl(u)) return true;
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

const LIVE_REFERENCE_MIN_SNIPPET_CHARS = 20;

function normalizeCitationUrlForMatch(url) {
  const clean = cleanHarvestedUrl(url);
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    const path = (parsed.pathname || '').replace(/\/+$/, '');
    return (parsed.origin + path + (parsed.search || '')).toLowerCase();
  } catch (e) {
    return clean.toLowerCase().replace(/\/+$/, '');
  }
}

function extractLiveCitationsFromParsed(parsed, topic) {
  const topicStr = String(topic || '').trim();
  const out = [];
  const seen = new Set();
  function pushUrl(url, snippet) {
    const clean = cleanHarvestedUrl(url);
    if (!clean || isDeadPhaseCFallbackUrl(clean) || isForbiddenForeignSourceUrl(clean)) return;
    if (violatesPedagogicalTopicContext(clean, snippet || '', topicStr)) return;
    const key = normalizeCitationUrlForMatch(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  }
  if (!parsed) return out;
  if (Array.isArray(parsed._liveCitations)) {
    parsed._liveCitations.forEach(function (url) { pushUrl(url, ''); });
  }
  const raw = parsed._apiResponseRaw;
  if (raw) {
    try {
      const data = JSON.parse(String(raw));
      perplexityClient.extractCitations(data).forEach(function (url) { pushUrl(url, ''); });
    } catch (e) {
      const match = String(raw).match(/"citations"\s*:\s*(\[[\s\S]*?\])/);
      if (match) {
        try {
          const arr = JSON.parse(match[1]);
          if (Array.isArray(arr)) {
            arr.forEach(function (item) {
              if (typeof item === 'string') pushUrl(item, '');
              else if (item && item.url) pushUrl(item.url, item.snippet || item.title || '');
            });
          }
        } catch (e2) { /* ignore partial JSON */ }
      }
    }
  }
  return out;
}

function buildLiveCitationUrlSet(parsed, topic) {
  const set = new Set();
  extractLiveCitationsFromParsed(parsed, topic).forEach(function (url) {
    const key = normalizeCitationUrlForMatch(url);
    if (key) set.add(key);
  });
  return set;
}

function isVerifiedLiveCitationUrl(url, citationSet) {
  const key = normalizeCitationUrlForMatch(url);
  if (!key || !citationSet || !citationSet.size) return false;
  if (citationSet.has(key)) return true;
  for (const cite of citationSet) {
    if (key.startsWith(cite) || cite.startsWith(key)) return true;
  }
  return false;
}

function hasLiveReferenceSnippet(item) {
  if (!item || typeof item !== 'object') return false;
  const snippet = String(
    item.note || item.detail || item.description || item.snippet || item.summary || ''
  ).trim();
  return snippet.length >= LIVE_REFERENCE_MIN_SNIPPET_CHARS;
}

function filterLinkItemsByLiveCitations(items, citationSet, options) {
  const opts = options || {};
  const topic = String(opts.topic || '').trim();
  if (!citationSet || !citationSet.size) return [];
  return (items || []).filter(function (item) {
    if (!item || typeof item !== 'object') return false;
    if (!isAllowedPhaseCSourceItem(item)) return false;
    const url = String(item.url || item.link || item.href || '').trim();
    if (!url || !isVerifiedLiveCitationUrl(url, citationSet)) return false;
    if (opts.blockPinterest && isPinterestPhaseCUrl(url)) return false;
    const snippet = String(item.note || item.detail || item.description || item.snippet || item.summary || item.title || '').trim();
    if (violatesPedagogicalTopicContext(url, snippet, topic)) return false;
    if (opts.requireSnippet && !hasLiveReferenceSnippet(item)) return false;
    const title = String(item.title || item.name || '').trim();
    return Boolean(title || url);
  });
}

function filterBibliographyByLiveCitations(bib, citationSet, topic) {
  const data = bib && typeof bib === 'object' ? bib : {};
  const topicStr = String(topic || '').trim();
  function filterList(list, requireUrl) {
    return (list || []).filter(function (item) {
      if (!item || typeof item !== 'object' || !item.title) return false;
      if (!isPayloadLiteratureSourceItem(item)) return false;
      const url = String(item.url || item.link || item.href || '').trim();
      if (!url) return !requireUrl;
      if (!citationSet || !citationSet.size) return false;
      if (!isVerifiedLiveCitationUrl(url, citationSet)) return false;
      if (isPinterestPhaseCUrl(url)) return false;
      const snippet = String(item.note || item.detail || item.description || item.snippet || item.summary || item.title || '').trim();
      if (violatesPedagogicalTopicContext(url, snippet, topicStr)) return false;
      return requireUrl ? hasLiveReferenceSnippet(item) : true;
    });
  }
  return {
    books: filterList(data.books, false),
    articles: filterList(data.articles, false),
    websites: filterList(data.websites, true),
  };
}

function filterRecommendedReadingByLiveCitations(reading, citationSet, topic) {
  const topicStr = String(topic || '').trim();
  return (reading || []).filter(function (item) {
    if (!item || !item.title) return false;
    if (!isPayloadLiteratureSourceItem(item)) return false;
    const url = String(item.url || item.link || item.href || '').trim();
    if (!url) return true;
    if (!hasLiveReferenceSnippet(item)) return false;
    if (!citationSet || !citationSet.size) return false;
    if (!isVerifiedLiveCitationUrl(url, citationSet)) return false;
    if (isPinterestPhaseCUrl(url)) return false;
    const snippet = String(item.note || item.detail || item.description || item.snippet || item.summary || item.title || '').trim();
    return !violatesPedagogicalTopicContext(url, snippet, topicStr);
  });
}

function applyLiveCitationGate(normalized, parsed, topic) {
  if (!normalized || typeof normalized !== 'object') return normalized;
  const topicStr = String(topic || (normalized._topicMaster && normalized._topicMaster.topic) || '').trim();
  stampTopicMasterArchiveLinks(normalized, parsed || normalized);
  const citationSet = buildLiveCitationUrlSet(parsed || normalized, topicStr);
  if (!citationSet || !citationSet.size) {
    if (hasArchivedLinkContent(normalized)) {
      normalized._liveCitations = collectPhaseCLinkUrlList(normalized, topicStr);
      return deduplicatePhaseCTabLinks(normalized, topicStr);
    }
    normalized.recommended_reading = [];
    normalized.relevant_links = [];
    normalized.pedagogical_resources = [];
    normalized.pinterest_links = [];
    if (normalized.theory && normalized.theory.bibliography) {
      normalized.theory.bibliography = { books: [], articles: [], websites: [] };
    }
    return normalized;
  }

  normalized.relevant_links = filterLinkItemsByLiveCitations(normalized.relevant_links, citationSet, {
    topic: topicStr,
    blockPinterest: true,
  });
  normalized.pinterest_links = filterLinkItemsByLiveCitations(
    filterLiveNormalizedLinks(normalized.pinterest_links),
    citationSet,
    { topic: topicStr }
  ).filter(function (item) {
    return item && item.url && /pinterest/i.test(item.url);
  });
  normalized.pedagogical_resources = filterLinkItemsByLiveCitations(
    filterLiveNormalizedLinks(normalized.pedagogical_resources),
    citationSet,
    { requireSnippet: true, topic: topicStr, blockPinterest: true }
  );
  normalized.recommended_reading = filterRecommendedReadingByLiveCitations(
    normalized.recommended_reading,
    citationSet,
    topicStr
  );

  if (normalized.theory && normalized.theory.bibliography) {
    const filtered = filterBibliographyByLiveCitations(normalized.theory.bibliography, citationSet, topicStr);
    filtered.websites = (filtered.websites || []).filter(function (item) {
      const url = String(item && item.url || '').trim();
      return url && !isPinterestPhaseCUrl(url);
    });
    normalized.theory.bibliography = filtered;
  }

  normalized._liveCitations = extractLiveCitationsFromParsed(parsed, topicStr);
  return deduplicatePhaseCTabLinks(normalized, topicStr);
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

function harvestPhaseCFallbackLinksFromRaw(apiResponse, topic, parsed) {
  const raw = String(apiResponse || '');
  const topicStr = String(topic || '').trim();
  const liveUrls = extractLiveCitationsFromParsed(parsed, topicStr);
  if (!liveUrls.length) return [];
  const seen = new Set();
  const out = [];
  liveUrls.forEach(function (url) {
    if (!url || seen.has(url) || isDeadPhaseCFallbackUrl(url)) return;
    const title = inferHarvestedLinkTitle(url, raw, topicStr);
    if (violatesPedagogicalTopicContext(url, title, topicStr)) return;
    seen.add(url);
    out.push({
      title: title,
      url: url,
      bucket: classifyPhaseCFallbackUrl(url),
    });
  });
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

/** Merge every harvested URL into resources-tab relevant_links — never duplicate into narrative fields. */
function distributePhaseCFallbackLinks(normalized, harvested, topic) {
  if (!normalized) return normalized;
  harvested = harvested || [];
  const topicStr = String(topic || '').trim();

  if (!normalized.theory || typeof normalized.theory !== 'object') {
    normalized.theory = { title: '', sections: [], bibliography: { books: [], articles: [], websites: [] } };
  }
  if (!normalized.theory.bibliography) {
    normalized.theory.bibliography = { books: [], articles: [], websites: [] };
  }

  const seen = new Set();
  function seenUrl(url) {
    const key = normalizeCitationUrlForMatch(cleanHarvestedUrl(url));
    if (!key || seen.has(key)) return true;
    seen.add(key);
    return false;
  }

  (normalized.relevant_links || []).forEach(function (item) {
    seenUrl(extractUrlFromLinkItem(item));
  });

  if (!Array.isArray(normalized.pinterest_links)) normalized.pinterest_links = [];
  harvested.forEach(function (item) {
    const url = String(item.url || '').trim();
    if (!url || seenUrl(url)) return;
    const title = String(item.title || url).trim();
    const bucket = item.bucket || classifyPhaseCFallbackUrl(url);
    if (bucket === 'pinterest' && normalized.pinterest_links.length < 8) {
      normalized.pinterest_links.push({
        title: title,
        url: url,
        board: topicStr,
        pin: title,
        src: '',
      });
    }
    if (!Array.isArray(normalized.relevant_links)) normalized.relevant_links = [];
    normalized.relevant_links.push({
      title: resolvePhaseCFriendlyLinkTitle(title, url),
      url: url,
    });
  });

  return centralizePhaseCLinksToResourcesTab(normalized, topicStr);
}

function applyPhaseCFallbackLinkHarvester(normalized, parsed, topic) {
  const topicStr = String(topic || '').trim();
  const citationSet = buildLiveCitationUrlSet(parsed, topicStr);
  if (!citationSet.size) return normalized;
  const raw = gatherPhaseCFallbackApiResponse(parsed);
  const harvested = harvestPhaseCFallbackLinksFromRaw(raw, topicStr, parsed);
  return distributePhaseCFallbackLinks(normalized, harvested, topicStr);
}

async function callPhaseCPerplexitySafe(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const apiResult = await perplexityClient.callPerplexityChatWithCitations({
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
  const raw = apiResult.content;
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
    result.parsed._apiResponseRaw = String(apiResult.rawResponseText || raw || '');
    result.parsed._liveCitations = Array.isArray(apiResult.citations) ? apiResult.citations.filter(Boolean) : [];
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
    return s.length > 4;
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

function sentenceStructuralSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 12 || b.length < 12) return a === b ? 1 : 0;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  const wordsA = a.split(' ').filter(function (w) { return w.length > 2; });
  const setB = new Set(b.split(' ').filter(function (w) { return w.length > 2; }));
  let overlap = 0;
  wordsA.forEach(function (w) { if (setB.has(w)) overlap++; });
  return overlap / Math.max(wordsA.length, setB.size, 1);
}

function stripSequentialDuplicateSentences(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  return raw.split(/\n\n+/).map(function (para) {
    const sentences = splitIntoSentences(para);
    if (sentences.length < 2) return para.trim();
    const out = [];
    let prevNorm = '';
    sentences.forEach(function (sentence) {
      const trimmed = String(sentence || '').trim();
      if (!trimmed) return;
      const norm = normalizeForDedup(trimmed);
      if (prevNorm && norm.length >= 12 && sentenceStructuralSimilarity(prevNorm, norm) >= 0.9) return;
      out.push(trimmed);
      prevNorm = norm;
    });
    return out.join(' ');
  }).filter(Boolean).join('\n\n').trim();
}

function stripPercentEncodedUrlGarbage(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s<>"']*%[0-9A-Fa-f]{2}[^\s<>"']*/gi, ' ')
    .replace(/\bhttps?:\/\/[^\s<>"']{140,}\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Strip URLs and link markup from narrative prose — links belong in dedicated arrays only. */
function stripNakedUrlsFromProse(text) {
  let out = String(text || '');
  out = out.replace(/<details[\s\S]*?<\/details>/gi, '');
  out = out.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  out = out.replace(/https?:\/\/[^\s<>"']+/gi, ' ');
  out = out.replace(/\bclass\s*=\s*['"][^'"]*['"]/gi, ' ');
  out = out.replace(/\btarget\s*=\s*['"][^'"]*['"]/gi, ' ');
  out = out.replace(/\bhref\s*=\s*['"][^'"]*['"]/gi, ' ');
  return out.replace(/\s{2,}/g, ' ').trim();
}

function stripPedagogicalNarrativeMarkup(html) {
  let out = stripBracketCitationMarkersInHtml(String(html || ''));
  out = out.replace(/<details[\s\S]*?<\/details>/gi, '');
  out = out.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  out = out.replace(/https?:\/\/[^\s<>"']+/gi, '');
  out = out.replace(/\bclass\s*=\s*['"][^'"]*['"]/gi, '');
  out = out.replace(/\btarget\s*=\s*['"][^'"]*['"]/gi, '');
  out = out.replace(/\bhref\s*=\s*['"][^'"]*['"]/gi, '');
  return out.trim();
}

function sanitizePhaseCStringField(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/<[a-z][\s\S]*>/i.test(raw)) return sanitizePhaseCProseField(raw);
  return sanitizePhaseCPlainProse(raw);
}

function sanitizePhaseCPlainProse(text) {
  let out = stripBracketCitationMarkersInProse(String(text || ''));
  out = stripPercentEncodedUrlGarbage(out);
  if (hasDisallowedForeignScript(out)) {
    out = out.split(/\n\n+/).map(function (para) {
      return hasDisallowedForeignScript(para) && !/[\u0590-\u05FF]/.test(para) ? '' : para;
    }).filter(Boolean).join('\n\n');
  }
  out = stripSequentialDuplicateSentences(out);
  return stripNakedUrlsFromProse(out).trim();
}

function stripSequentialDuplicateHtmlBlocks(html) {
  const blocks = String(html || '').split(/(?=<\/p>\s*|<p[\s>])/i).map(function (b) {
    return b.trim();
  }).filter(Boolean);
  if (blocks.length < 2) return String(html || '');
  const out = [];
  let prevNorm = '';
  blocks.forEach(function (block) {
    const norm = normalizeForDedup(block);
    if (!norm || norm.length < 20) {
      out.push(block);
      return;
    }
    if (prevNorm && sentenceStructuralSimilarity(prevNorm, norm) >= 0.9) return;
    out.push(block);
    prevNorm = norm;
  });
  return out.join('\n');
}

function sanitizePhaseCProseField(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (/<[a-z][\s\S]*>/i.test(raw)) {
    return stripSequentialDuplicateHtmlBlocks(stripPedagogicalNarrativeMarkup(raw));
  }
  return sanitizePhaseCPlainProse(raw);
}

/** Waldorf / Anthroposophy relevance — required for every Box A source. */
const PHASE_C_WALDORF_ANTHRO_KEYWORDS = /וולדורף|ולדורף|שטיינר|סטיינר|אנתרופוסופ|anthroposoph|waldorf|steiner|rsarchive|waldorflibrary|awsna|iaswece|gesamtausgabe|\bga[\s\-_]?\d|main[\-_]?lesson|form[\-_]?draw|antro\.co|educationpace|harduf|humani|eldo|salut|כ\.ע\.ל|כ"ע|selg|kovacs|finser|staley|spiritual\s*science/i;

/** Generic national-curriculum / non-Waldorf education hosts — reject unless Waldorf keyword also present. */
const PHASE_C_GENERIC_EDUCATION_BLOCKLIST = /education\.gov\.il|khanacademy|khan-academy|matific|kidsplus|kids\s*plus|מט"ח|מט״ח|ראמ"ה|ראמ״ה|נגבה|mofet\.macam|teachers\.org\.il|משרד\s*החינוך|national\s*curriculum|common\s*core|edutopia|teacherpayteachers|tpt\.com|greatschools|education\.com|scholastic\.com/i;

const PHASE_C_NON_HE_EN_SCRIPTS = /[\u0400-\u04FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0370-\u03FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;

function isHebrewOrEnglishSourceText(text, lang) {
  const code = String(lang || '').trim().toLowerCase();
  if (code === 'he' || code === 'en') return true;
  if (code && code !== 'he' && code !== 'en') return false;
  const s = String(text || '').trim();
  if (!s) return false;
  if (/[\u0590-\u05FF]/.test(s)) return true;
  if (PHASE_C_NON_HE_EN_SCRIPTS.test(s)) return false;
  return /[a-zA-Z]/.test(s);
}

function isWaldorfAnthroposophyRelevant(item) {
  if (!item || typeof item !== 'object') return false;
  const url = String(item.url || item.link || item.href || '').trim();
  const blob = [
    item.title, item.name, item.note, item.author, item.snippet,
    item.detail, item.description, item.label, item.source, url,
  ].filter(Boolean).join(' ');
  const hasWaldorf = PHASE_C_WALDORF_ANTHRO_KEYWORDS.test(blob) || isTrustedEducationalDomain(url);
  if (!hasWaldorf) return false;
  const genericHit = PHASE_C_GENERIC_EDUCATION_BLOCKLIST.test(blob) ||
    PHASE_C_GENERIC_OFF_TOPIC_ENTITIES.test(blob);
  if (genericHit && !PHASE_C_WALDORF_ANTHRO_KEYWORDS.test(blob)) return false;
  if (genericHit && url && PHASE_C_GENERIC_EDUCATION_BLOCKLIST.test(url) && !isTrustedEducationalDomain(url)) {
    return false;
  }
  return true;
}

function isAllowedPhaseCSourceItem(item) {
  if (!item || typeof item !== 'object') return false;
  const url = String(item.url || item.link || item.href || '').trim();
  if (url && (isForbiddenForeignSourceUrl(url) || isDeadPhaseCFallbackUrl(url))) return false;
  const blob = [
    item.title, item.name, item.note, item.author, item.snippet,
    item.detail, item.description, item.label, item.source,
  ].filter(Boolean).join(' ');
  if (!blob.trim() && !url) return false;
  if (!isHebrewOrEnglishSourceText(blob, item.lang)) return false;
  if (!isWaldorfAnthroposophyRelevant(item)) return false;
  return true;
}

/** Master-payload literature (recommended_reading / theory.bibliography) — title fallback without keyword gate. */
function isPayloadLiteratureSourceItem(item) {
  if (!item || typeof item !== 'object') return false;
  const title = String(item.title || item.name || '').trim();
  if (!title) return false;
  const url = String(item.url || item.link || item.href || '').trim();
  if (url && (isForbiddenForeignSourceUrl(url) || isDeadPhaseCFallbackUrl(url))) return false;
  const blob = [
    item.title, item.name, item.note, item.author, item.snippet,
    item.detail, item.description, item.label, item.source,
  ].filter(Boolean).join(' ');
  if (hasDisallowedForeignScript(blob) && !/[\u0590-\u05FF]/.test(blob)) return false;
  return isHebrewOrEnglishSourceText(blob || title, item.lang);
}

function filterAllowedPhaseCLinkList(items) {
  return (items || []).filter(isAllowedPhaseCSourceItem);
}

function applyPhaseCTextSanitizationChain(normalized) {
  if (!normalized || typeof normalized !== 'object') return normalized;
  if (normalized.core_emphases) {
    normalized.core_emphases = sanitizePhaseCProseField(normalized.core_emphases);
  }
  if (Array.isArray(normalized.key_points)) {
    normalized.key_points = normalized.key_points.map(function (item) {
      return typeof item === 'string' ? sanitizePhaseCStringField(item) : item;
    }).filter(function (item) {
      if (typeof item !== 'string') return Boolean(item);
      const plain = stripHtmlToPlainText(item).trim();
      if (plain.length < 8) return false;
      return !(hasDisallowedForeignScript(plain) && !/[\u0590-\u05FF]/.test(plain));
    });
  }
  if (Array.isArray(normalized.recommended_reading)) {
    normalized.recommended_reading = normalized.recommended_reading.filter(isPayloadLiteratureSourceItem).map(function (item) {
      return Object.assign({}, item, {
        title: sanitizePhaseCPlainProse(item.title || ''),
        note: sanitizePhaseCPlainProse(item.note || item.description || ''),
      });
    }).filter(function (item) { return item.title; });
  }
  normalized.relevant_links = filterAllowedPhaseCLinkList(normalized.relevant_links);
  normalized.pedagogical_resources = filterAllowedPhaseCLinkList(normalized.pedagogical_resources);
  if (normalized.theory && typeof normalized.theory === 'object') {
    if (Array.isArray(normalized.theory.sections)) {
      normalized.theory.sections = normalized.theory.sections.map(function (sec) {
        if (!sec || typeof sec !== 'object') return sec;
        return Object.assign({}, sec, {
          heading: sanitizePhaseCPlainProse(sec.heading || sec.title || ''),
          content: sanitizePhaseCProseField(sec.content || sec.text || sec.body || ''),
        });
      }).filter(function (sec) {
        return sec && (sec.heading || stripHtmlToPlainText(sec.content || '').trim());
      });
    }
    if (normalized.theory.bibliography) {
      const bib = normalized.theory.bibliography;
      ['books', 'articles', 'websites'].forEach(function (key) {
        if (Array.isArray(bib[key])) bib[key] = bib[key].filter(isPayloadLiteratureSourceItem);
      });
    }
  }
  if (normalized.inspiration && typeof normalized.inspiration === 'object') {
    if (Array.isArray(normalized.inspiration.global)) {
      normalized.inspiration.global = normalized.inspiration.global.map(function (block) {
        if (!block || typeof block !== 'object') return block;
        return Object.assign({}, block, {
          title: sanitizePhaseCPlainProse(block.title || ''),
          items: (block.items || []).map(function (item) {
            if (typeof item === 'string') return sanitizePhaseCStringField(item);
            if (item && typeof item === 'object') {
              const next = Object.assign({}, item);
              ['text', 'preview', 'detail', 'content', 'insight'].forEach(function (key) {
                if (typeof next[key] === 'string') next[key] = sanitizePhaseCStringField(next[key]);
              });
              return next;
            }
            return item;
          }).filter(function (item) {
            return typeof item === 'string' ? item.trim().length >= 8 : Boolean(item);
          }),
        });
      }).filter(function (block) { return block && block.items && block.items.length; });
    }
    if (Array.isArray(normalized.inspiration.narrative)) {
      normalized.inspiration.narrative = normalized.inspiration.narrative.map(function (item) {
        return typeof item === 'string' ? sanitizePhaseCStringField(item) : item;
      }).filter(function (item) {
        return typeof item === 'string' ? item.trim().length >= 8 : Boolean(item);
      });
    }
    if (normalized.inspiration.podcast && Array.isArray(normalized.inspiration.podcast.episodes)) {
      normalized.inspiration.podcast.episodes = filterAllowedPhaseCLinkList(
        normalized.inspiration.podcast.episodes
      ).map(function (ep) {
        return Object.assign({}, ep, {
          theme: sanitizePhaseCPlainProse(ep.theme || ''),
          insight: sanitizePhaseCPlainProse(ep.insight || ep.text || ''),
        });
      });
    }
  }
  return normalized;
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
    if (ratio > 0.9 && overlap >= 6) return true;
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

function buildDistinctKeyPointsFromEssay(essay, paragraphs, grade, topic) {
  const seen = new Set();
  const coreText = stripHtmlToPlainText(essay);
  if (coreText) markTextSeen(coreText, seen);
  const sentences = splitIntoSentences(coreText).filter(function (sentence) {
    return !isDuplicateText(sentence, seen, 30);
  });
  if (sentences.length >= 4) {
    return dedupeTextFragments(sentences, seen).slice(0, 6);
  }
  const grouped = buildKeyPointsFromEssay(coreText, paragraphs || paragraphsFromSterileEssay(coreText));
  const distinct = dedupeTextFragments(grouped, seen);
  if (distinct.length) return distinct.slice(0, 6);
  const defaults = buildGradeDefaultCoreEmphasesParagraphs(grade, topic);
  return dedupeTextFragments(
    defaults.map(function (paragraph) {
      return paragraph.split(/(?<=[.!?׃。])\s+/).slice(0, 2).join(' ').trim() || paragraph;
    }),
    seen
  ).slice(0, 6);
}

function deduplicateTab3Fields(normalized, grade, topic) {
  if (!normalized || typeof normalized !== 'object') return normalized;
  const coreNorm = normalizeForDedup(normalized.core_emphases || '');
  const seen = new Set();
  if (coreNorm) seen.add(coreNorm);
  const originals = Array.isArray(normalized.key_points) ? normalized.key_points.slice() : [];
  const keyPoints = [];
  originals.forEach(function (item) {
    const raw = String(item || '').trim();
    const plain = stripHtmlToPlainText(raw).trim();
    const norm = normalizeForDedup(plain);
    if (!norm || norm.length < 40) return;
    if (seen.has(norm)) return;
    if (coreNorm && norm.length >= 80 && coreNorm.includes(norm)) return;
    if (coreNorm && coreNorm.length >= 80 && norm.includes(coreNorm)) return;
    seen.add(norm);
    keyPoints.push(raw);
  });
  if (!keyPoints.length && coreNorm) {
    normalized.key_points = buildDistinctKeyPointsFromEssay(
      plainFromHtml(normalized.core_emphases),
      paragraphsFromSterileEssay(plainFromHtml(normalized.core_emphases)),
      grade,
      topic
    );
  } else {
    normalized.key_points = keyPoints;
  }
  return normalized;
}

function plainFromHtml(html) {
  return stripHtmlToPlainText(String(html || '')).trim();
}

function collectPhaseCCitationSourcesForLinkify(normalized, parsed, topic) {
  const items = collectPhaseCLinkItemsForDisplay(normalized, topic);
  const out = [];
  const seen = new Set();
  function pushUrl(url) {
    const clean = cleanHarvestedUrl(url);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  }
  extractLiveCitationsFromParsed(parsed || normalized, topic).forEach(pushUrl);
  items.forEach(function (item) { pushUrl(item.url); });
  return out;
}

function stripBracketCitationMarkersInProse(text) {
  return String(text || '').replace(/\[\d{1,3}\]/g, '');
}

function stripBracketCitationMarkersInHtml(html) {
  return String(html || '').replace(/\[\d{1,3}\]/g, '');
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

/**
 * Split sterilized essay proportionally across tabs — 35% theory, 35% pedagogy, 30% inspiration.
 * Preserves 100% of text; nothing is dropped or deduplicated across tabs.
 */
function partitionFallbackEssay(essay) {
  const text = String(essay || '').trim();
  if (!text) {
    return { theoryParagraphs: [], inspirationParagraphs: [], coreParagraphs: [] };
  }

  let paragraphs = paragraphsFromSterileEssay(text);
  if (paragraphs.length < 3) {
    const sentences = splitIntoSentences(text);
    paragraphs = groupParagraphsIntoChunks(sentences, Math.max(3, Math.ceil(sentences.length / 3)));
  }
  if (!paragraphs.length) paragraphs = [text];

  const totalLen = paragraphs.reduce(function (sum, p) { return sum + p.length; }, 0) || text.length;
  const targetTheory = Math.floor(totalLen * 0.35);
  const targetCore = Math.floor(totalLen * 0.35);

  const theory = [];
  const core = [];
  const inspiration = [];
  let theoryLen = 0;
  let coreLen = 0;
  let phase = 0;

  paragraphs.forEach(function (p) {
    if (phase === 0) {
      theory.push(p);
      theoryLen += p.length;
      if (theoryLen >= targetTheory) phase = 1;
    } else if (phase === 1) {
      core.push(p);
      coreLen += p.length;
      if (coreLen >= targetCore) phase = 2;
    } else {
      inspiration.push(p);
    }
  });

  if (!theory.length && !core.length && !inspiration.length) {
    const theoryEnd = Math.floor(text.length * 0.35);
    const coreEnd = Math.floor(text.length * 0.70);
    return {
      theoryParagraphs: [text.slice(0, theoryEnd)],
      coreParagraphs: [text.slice(theoryEnd, coreEnd)],
      inspirationParagraphs: [text.slice(coreEnd)],
    };
  }

  return {
    theoryParagraphs: theory,
    inspirationParagraphs: inspiration,
    coreParagraphs: core,
  };
}

const PHASE_C_TAB3_MIN_PLAIN_CHARS = 40;

function tab3FieldPlainLen(value) {
  return stripHtmlToPlainText(String(value || '')).trim().length;
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
  '5': [
    'מצפן התפתחותי — גיל האחד עשר והתעוררות הרציונלית',
    'יחס המורה לדימוי, לסיפור ולמעבר לעולם המושגים',
    'דגשים לבניית תקופה והיעדים הפדגוגיים',
  ],
  '4': [
    'מצפן התפתחותי — גיל העשירי ואיזון בין קסם לרציונליות',
    'יחס המורה לסמכות, לקהילה ולשאלות מוסריות',
    'דגשים לבניית תקופה והיעדים הפדגוגיים',
  ],
  '3': [
    'מצפן התפתחותי — גיל התשע ומעבר לעצמאות רגשית',
    'יחס המורה לביטחון, לסדר ולדימוי חי',
    'דגשים לבניית תקופה והיעדים הפדגוגיים',
  ],
  '2': [
    'מצפן התפתחותי — גיל השמונה וחיזוק האני',
    'יחס המורה לדימוי, לסיפור ולקצב עדין',
    'דגשים לבניית תקופה והיעדים הפדגוגיים',
  ],
  '1': [
    'מצפן התפתחותי — גיל השבע ופתיחת שער בית הספר',
    'יחס המורה לקסם, לסמכות חמה ולסדר מגן',
    'דגשים לבניית תקופה והיעדים הפדגוגיים',
  ],
};

/** Grade-specific 3-paragraph developmental defaults when prose splitting fails entirely. */
const GRADE_DEFAULT_CORE_EMPHASES_PARAGRAPHS = {
  '8': [
    'בגיל ארבע-עשרה (כיתה ח׳) הילד עובר לשלב שבו הסמכות הפנימית והשיפוט המוסרי העצמי הופכים למרכז ההתפתחות. המורה נדרשת לכבד את רגישות גיל המרד ולספק מסגרת ברורה שמאפשרת לתלמיד לבחון רעיונות, לחשוב בביקורתיות ולגלות עצמאות רוחנית — לא כהתנגדות עיוורת, אלא כבניית שיפוט פנימי.',
    'בתקופת היסטוריה בכיתה ח׳ הדגש הוא על יחסים סיבתיים בהיסטוריה: איך כוחות חברתיים, רעיונות ומהפכות משפיעים זה על זה. התלמיד לומד לראות דפוסים, לקשר בין אירועים ולהבין את המחיר האנושי של שינוי. המורה מלווה את התלמידים בדיון, בדימוי ובחוויה אמנותית — כך שההיסטוריה נהיית חוויה נפשית חיה ולא רק עובדות.',
    'בגיל זה מתאזנים קוטבי רגשיים — ביטחון מול חוסר ודאות, אידיאליזם מול אכזבה, קבלה מול מרד. המורה שומרת על קצב, על יחס חם ועל מטרות פדגוגיות ברורות: לעודד חשיבה עצמאית, לטפח אמפתיה היסטורית, ולבנות תקופה שבה התלמיד מרגיש מוכר, מאתגר ומעורב — עם דגש על שיעור ראשי, אמנות, תנועה ודיון כחלקים אינטגרליים.',
  ],
  '7': [
    'בגיל שלוש-עשרה (כיתה ז׳) מתעוררת תחושת עצמאות רגשית ושאלות עמוקות על זהות וקיום. המורה מציעה דימויים חיים, סיפורים וחוויות אמנותיות שמאפשרים לתלמיד לעבד מורכבות בלי לחץ אינטלקטואלי יתר. הקצב חשוב: לא למהר, לא לדחוף — אלא להאזין ולהוביל בעדינות.',
    'התלמיד בגיל זה מתחיל לראות את העולם דרך עדשה אישית — גילוי, רנסנס, מפגשים בין תרבויות. המורה מחברת בין התוכן לבין חוויית הנפש: איך גילוי משנה תפיסה, איך אמנות משקפת רוח תקופה, ואיך ההיסטוריה נוגעת בשאלות שמעסיקות את התלמיד עצמו.',
    'דגשים לבניית התקופה: ליצור מרחב בטוח לשאלות, לשלב אמנות ותנועה, לבנות מעברים ברורים בין שיעורים, ולהציב יעדים פדגוגיים מדידים — הבנה דרך חוויה, לא רק שינון. המורה היא מלווה רוחני-פדגוגי שמכיר את מצפן הגיל.',
  ],
  '6': [
    'בגיל שתים-עשרה (כיתה ו׳) הילד נכנס לעולם הארצי והרציונלי בצורה מובהקת יותר. הוא שואל על צדק, על סמכות ועל מקומו בקהילה. המורה מספקת תוכן שמאתגר את החשיבה תוך שמירה על קשר אישי ועל דימוי חי.',
    'המעבר מגיל ילדותי לגיל ההתבגרות המוקדמת מביא עימו רגישות לשוויון ולחוק. בתכנון התקופה יש להדגיש דיון, עבודה קבוצתית ופרויקטים שמאפשרים לתלמיד לקחת אחריות. המורה מאזנת בין סמכות חיצונית לבין עידוד שיפוט פנימי מתפתח.',
    'יעדים פדגוגיים לתקופה: לחזק חשיבה סיבתית, לטפח אמפתיה חברתית, לשלב אמנות ומעשה, ולבנות רצף שיעורים שמכבד את קצב הגיל. המצפן ההתפתחותי מנחה את בחירת הדימויים, הסיפורים והפעילויות.',
  ],
  '5': [
    'בגיל אחד-עשר (כיתה ה׳) מתחדדת היכולת לחשוב במושגים מופשטים יותר, אך עדיין נדרש דימוי חי וסיפור. המורה בונה תקופה שמחברת בין הרציונל לבין האמנותי — כך שהתלמיד חווה את התוכן בגוף ובנפש.',
    'גיל זה מאופיין בחיפוש אחר משמעות ובשאלות על מקום האדם בעולם. המורה מציעה תוכן שמאתגר בעדינות, שומרת על סדר וקצב, ומאפשרת לתלמידים לגלות עצמאות בהדרגה.',
    'דגשים לבניית התקופה: שיעור ראשי עשיר בדימוי, מעברים ברורים בין נושאים, שילוב תנועה ואמנות, ומטרות ברורות לכל בלוק — הבנה, חוויה ויישום בכיתה.',
  ],
  '4': [
    'בגיל עשר (כיתה ד׳) הילד חווה מעבר בין עולם הילדות לעולם המבוגרים. הוא עדיין זקוק לסיפור ולדימוי, אך מתחיל לבקש הסברים רציונליים. המורה מאזנת בין קסם לבין בהירות, ובונה אמון דרך עקביות וסמכות חמה.',
    'שאלות על צדק, על קהילה ועל מקום האישי בחברה בולטות יותר. בתכנון התקופה יש להדגיש חוויה קבוצתית, פרויקטים ועבודה שמחזקת את תחושת השייכות לכיתה כקהילה לומדת.',
    'יעדים פדגוגיים: לחזק כתיבה ורישום, לעמק דימויים, לשלב אמנות ומעשה, ולהציב יעדים ברורים לכל שבוע — כך שהתלמיד יודע לאן התקופה מובילה.',
  ],
  '3': [
    'בגיל תשע (כיתה ג׳) הילד מחפש יציבות וביטחון תוך גילוי עצמאות רגשית. המורה יוצרת סדר ברור, קצב מוכר ודימויים חיים שמאפשרים לו להרגיש בטוח לקחת צעדים קטנים לעצמאות.',
    'המעבר לעולם מופשט יותר — בקריאה, בכתיבה ובחשבון — דורש מהמורה לבנות גשרים מדימוי לרעיון. כל תוכן חדש מומלץ להציג דרך סיפור, תמונה או חוויה לפני הסבר מופשט.',
    'דגשים לבניית התקופה: לשמור על קצב אחיד, לחזק מיומנויות יסוד, לשלב אמנות ותנועה, ולהגדיר יעדים פדגוגיים ברורים — ביטחון, מיומנות ושמחה בלמידה.',
  ],
  '2': [
    'בגיל שמונה (כיתה ב׳) הילד מחזק את תחושת האני ומחפש הכרה. המורה מציעה סיפורים, שירים ודימויים שמאפשרים לו להרגיש נראה ומוערך, תוך שמירה על סדר ועל גבולות ברורים.',
    'הקשר למורה עדיין מרכזי — אמון, חום ועקביות מאפשרים למידה עמוקה. בתכנון התקופה יש להדגיש חזרה על מוטיבים, עבודה ידנית ואמנות שמחזקים את הקשר בין גוף לנפש.',
    'יעדים פדגוגיים: לחזק קריאה וכתיבה בדימוי, לטפח קשב וסבלנות, לשלב תנועה ושירה, ולבנות תקופה עם מטרות ברורות שמכבדות את קצב הגיל.',
  ],
  '1': [
    'בגיל שבע (כיתה א׳) הילד פותח את דלת בית הספר — עולם של קסם, סדר וסמכות מלאה. המורה היא דמות מכונה שמובילה בעדינות, בדימוי ובשמחה. הקצב איטי, חוזר ומגן.',
    'הדגש הוא על חוויה חושית, סיפור ואמנות — לא על הסברים מופשטים. כל נושא חדש נכנס דרך שיר, ציור, תנועה או מעשה ידני, כך שהילד חווה את הלמידה בגוף ובלב.',
    'דגשים לבניית התקופה: לשמור על רצף ועל קסם, לבנות הרגלים של שיעור ראשי, לחזק מיומנויות יסוד בעדינות, ולהגדיר יעדים פדגוגיים פשוטים וברורים — ביטחון, שמחה ופתיחות לעולם.',
  ],
};

function buildGradeDefaultCoreEmphasesParagraphs(grade, topic) {
  const gradeNum = resolveGradeNum(grade);
  const topicStr = String(topic || 'הנושא').trim();
  const base = (gradeNum && GRADE_DEFAULT_CORE_EMPHASES_PARAGRAPHS[gradeNum])
    ? GRADE_DEFAULT_CORE_EMPHASES_PARAGRAPHS[gradeNum].slice()
    : [
      'מצפן התפתחותי: כל תקופה בוולדורף נבנית מתוך הבנת הגיל — מה הילד חווה בנפש, ברוח ובגוף, ומה המורה יכולה להציע כדי לתמוך בצמיחה.',
      'יחס המורה לקצב, לדימוי ולמסגרת: המורה שומרת על סדר ברור, על חום ועל דימויים חיים שמאפשרים לתלמיד להרגיש בטוח, מעורב ומאתגר — בלי לדחוף מעבר לקצב ההתפתחותי.',
      'דגשים לבניית התקופה בנושא «' + topicStr + '»: להגדיר יעדים פדגוגיים ברורים, לשלב שיעור ראשי אמנות ותנועה, ולבנות מעברים שמחברים בין היום-יום לבין תמונה גדולה של התקופה.',
    ];
  if (!topicStr || topicStr === 'הנושא' || topicStr === 'נושא') return base;
  return base.map(function (paragraph, index) {
    if (index === 2) {
      return paragraph.replace('«' + topicStr + '»', '«' + topicStr + '»')
        .replace(/דגשים לבניית התקופה[^:]*:/, 'דגשים לבניית התקופה בנושא «' + topicStr + '»:');
    }
    return paragraph + ' הנושא «' + topicStr + '» מציע הזדמנות לחבר בין התוכן לבין מצפן הגיל.';
  });
}

function gatherRichTab3SourceText(normalized, essay, parsed) {
  const chunks = [];
  function pushText(value) {
    const text = stripHtmlToPlainText(String(value || '')).trim();
    if (text && text.length >= 12) chunks.push(text);
  }
  pushText(essay);
  pushText(gatherPhaseCFallbackSourceText(parsed));
  if (normalized && normalized.theory && Array.isArray(normalized.theory.sections)) {
    normalized.theory.sections.forEach(function (sec) {
      pushText(sec && (sec.content || sec.text || sec.body));
    });
  }
  if (normalized && normalized.inspiration) {
    const insp = normalized.inspiration;
    if (Array.isArray(insp.global)) {
      insp.global.forEach(function (block) {
        if (block && Array.isArray(block.items)) block.items.forEach(pushText);
      });
    }
    if (Array.isArray(insp.narrative)) insp.narrative.forEach(pushText);
  }
  pushText(normalized && normalized.core_emphases);
  const seen = new Set();
  const unique = [];
  chunks.forEach(function (chunk) {
    const key = chunk.slice(0, 100);
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(chunk);
  });
  return unique.join('\n\n').trim();
}

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
const PHASE_C_BROKEN_HTTPS_LINK_PATTERN = /(?:^|[\s*•\-])\[?\s*HTTPS\s*\]?\s*\(\s*(https?:\/\/[^)\s]+)\s*\)/gi;
const PHASE_C_SOURCE_LINK_CLASS = 'prose-source-link text-blue-600 underline hover:text-blue-800';
const PHASE_C_SOURCE_LINK_LABEL = 'קישור למקור';

function buildFallbackAnchorHtml(url, label) {
  const href = cleanHarvestedUrl(url);
  if (!href || isDeadPhaseCFallbackUrl(href)) return escapeHtmlForFallback(label || url);
  let display = String(label || '').trim();
  if (!display || /^https?$/i.test(display) || /^HTTPS$/i.test(display)) {
    display = PHASE_C_SOURCE_LINK_LABEL;
  }
  return '<a href="' + escapeHtmlForFallback(href) + '" target="_blank" rel="noopener noreferrer" class="' +
    PHASE_C_SOURCE_LINK_CLASS + '">' + escapeHtmlForFallback(display) + '</a>';
}

function extractUrlFromLinkItem(item) {
  if (!item) return '';
  if (typeof item === 'string') return cleanHarvestedUrl(item);
  return cleanHarvestedUrl(item.url || item.link || item.href || '');
}

/** Harvest every live HTTPS URL stored across Phase C link arrays (for archive round-trip). */
function collectPhaseCLinkUrlList(normalized, topic) {
  if (!normalized || typeof normalized !== 'object') return [];
  const topicStr = String(topic || (normalized._topicMaster && normalized._topicMaster.topic) || '').trim();
  const seen = new Set();
  const out = [];
  function pushUrl(raw) {
    const clean = cleanHarvestedUrl(raw);
    if (!clean || isDeadPhaseCFallbackUrl(clean)) return;
    if (violatesPedagogicalTopicContext(clean, '', topicStr)) return;
    const key = normalizeCitationUrlForMatch(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  }
  (normalized._liveCitations || []).forEach(pushUrl);
  (normalized.relevant_links || []).forEach(function (item) { pushUrl(extractUrlFromLinkItem(item)); });
  (normalized.pinterest_links || []).forEach(function (item) { pushUrl(extractUrlFromLinkItem(item)); });
  (normalized.pedagogical_resources || []).forEach(function (item) { pushUrl(extractUrlFromLinkItem(item)); });
  (normalized.recommended_reading || []).forEach(function (item) { pushUrl(extractUrlFromLinkItem(item)); });
  const bib = normalized.theory && normalized.theory.bibliography;
  if (bib) {
    ['books', 'articles', 'websites'].forEach(function (cat) {
      (bib[cat] || []).forEach(function (item) { pushUrl(extractUrlFromLinkItem(item)); });
    });
  }
  extractLiveCitationsFromParsed(normalized, topicStr).forEach(pushUrl);
  return out;
}

function hasArchivedLinkContent(normalized) {
  return collectPhaseCLinkUrlList(normalized).length > 0;
}

/** Persist citation index from all stored link fields so Supabase archive hydrates completely. */
function stampTopicMasterArchiveLinks(normalized, parsed) {
  if (!normalized || typeof normalized !== 'object') return normalized;
  const seed = parsed && typeof parsed === 'object' ? parsed : normalized;
  const merged = Object.assign({}, seed, normalized);
  normalized._liveCitations = collectPhaseCLinkUrlList(merged);
  return normalized;
}

function collectPhaseCLinkItemsForDisplay(normalized, topic) {
  const topicStr = String(topic || (normalized && normalized._topicMaster && normalized._topicMaster.topic) || '').trim();
  const seen = new Set();
  const out = [];
  function pushItem(title, url) {
    const clean = cleanHarvestedUrl(url);
    if (!clean || isDeadPhaseCFallbackUrl(clean)) return;
    if (isPinterestPhaseCUrl(clean)) return;
    const snippet = String(title || '').trim();
    if (violatesPedagogicalTopicContext(clean, snippet, topicStr)) return;
    const key = normalizeCitationUrlForMatch(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const label = String(title || inferHarvestedLinkTitle(clean, '', topicStr) || clean).trim();
    out.push({ title: label, url: clean });
  }
  (normalized.relevant_links || []).forEach(function (item) {
    if (!item) return;
    pushItem(item.title || item.name, item.url || item.link || item.href);
  });
  (normalized.pedagogical_resources || []).forEach(function (item) {
    if (!item) return;
    pushItem(item.title || item.name, item.url || item.link || item.href);
  });
  const bib = normalized.theory && normalized.theory.bibliography;
  if (bib) {
    ['websites', 'articles', 'books'].forEach(function (cat) {
      (bib[cat] || []).forEach(function (item) {
        if (!item) return;
        pushItem(item.title || item.name, item.url || item.link || item.href);
      });
    });
  }
  collectPhaseCLinkUrlList(normalized, topicStr).forEach(function (url) {
    pushItem('', url);
  });
  return out.slice(0, 12);
}

/** Sources block with real clickable anchors (never styled spans). */
function buildPhaseCFallbackSourcesSectionHtml(normalized, topic) {
  const links = collectPhaseCLinkItemsForDisplay(normalized, topic);
  if (!links.length) return '';
  const items = links.map(function (item, index) {
    const num = index + 1;
    return '<li id="phase-c-source-' + num + '">' + buildFallbackAnchorHtml(item.url, item.title) + '</li>';
  }).join('');
  return '<div id="phase-c-sources" class="grade-insights-sources mt-4 text-walnut/80">' +
    '<p class="mb-1"><strong>מקורות:</strong></p>' +
    '<ol class="list-decimal mr-5 space-y-1 i18n-list">' + items + '</ol></div>';
}

function ensureDomainHref(domain) {
  const raw = String(domain || '').trim().replace(/^www\./i, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return cleanHarvestedUrl(raw);
  const candidate = cleanHarvestedUrl('https://' + raw.replace(/^\/+/, ''));
  return candidate;
}

function linkifyFallbackSegment(text, topic) {
  const topicStr = String(topic || '').trim();
  const extracted = [];
  const placeholders = [];
  let work = String(text || '');

  function stashLink(url, label) {
    const clean = ensureDomainHref(url);
    if (!clean || isDeadPhaseCFallbackUrl(clean)) return null;
    if (isPinterestPhaseCUrl(clean)) return null;
    const title = String(label || clean).trim() || clean;
    if (violatesPedagogicalTopicContext(clean, title, topicStr)) return null;
    extracted.push({ title: title, url: clean, bucket: classifyPhaseCFallbackUrl(clean) });
    const token = '\x00FLINK' + placeholders.length + '\x00';
    placeholders.push(buildFallbackAnchorHtml(clean, title));
    return token;
  }

  work = work.replace(FALLBACK_MARKDOWN_LINK_PATTERN, function (full, label, url) {
    return stashLink(url, label) || full;
  });
  work = work.replace(PHASE_C_BROKEN_HTTPS_LINK_PATTERN, function (full, url) {
    return stashLink(url, '') || full;
  });
  work = work.replace(/\[?\s*HTTPS\s*\]?\s*\(\s*(https?:\/\/[^)\s]+)\s*\)/gi, function (full, url) {
    return stashLink(url, '') || full;
  });
  work = work.replace(FALLBACK_TITLE_URL_PATTERN, function (full, label, url) {
    return stashLink(url, label) || full;
  });
  work = work.replace(FALLBACK_BARE_URL_PATTERN, function (url) {
    return stashLink(url, '') || url;
  });
  work = work.replace(/(?:^|\s)[*•\-]\s*HTTPS\b/gi, ' ');
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

  work = stripBracketCitationMarkersInProse(work);

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

function extractLinksFromProseSegment(text, topic) {
  const topicStr = String(topic || '').trim();
  const extracted = [];
  const seen = new Set();
  function pushLink(url, label) {
    const clean = ensureDomainHref(url);
    if (!clean || isDeadPhaseCFallbackUrl(clean)) return;
    if (isPinterestPhaseCUrl(clean)) return;
    const title = String(label || clean).trim() || clean;
    if (violatesPedagogicalTopicContext(clean, title, topicStr)) return;
    const key = normalizeCitationUrlForMatch(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    extracted.push({ title: title, url: clean, bucket: classifyPhaseCFallbackUrl(clean) });
  }
  const raw = String(text || '');
  let match;
  const mdRe = new RegExp(FALLBACK_MARKDOWN_LINK_PATTERN.source, 'gi');
  while ((match = mdRe.exec(raw)) !== null) {
    pushLink(match[2], match[1]);
  }
  const titleUrlRe = new RegExp(FALLBACK_TITLE_URL_PATTERN.source, 'gi');
  while ((match = titleUrlRe.exec(raw)) !== null) {
    pushLink(match[2], match[1]);
  }
  const bareRe = new RegExp(FALLBACK_BARE_URL_PATTERN.source, 'gi');
  while ((match = bareRe.exec(raw)) !== null) {
    pushLink(match[0], '');
  }
  return extracted;
}

function formatFallbackProseChunk(text, topic) {
  const parts = String(text || '').split(/\n\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
  if (!parts.length) return { html: '', links: [] };
  const allLinks = [];
  const html = parts.map(function (part) {
    allLinks.push.apply(allLinks, extractLinksFromProseSegment(part, topic));
    const plain = sanitizePhaseCPlainProse(part);
    if (!plain) return '';
    return '<p>' + boldPedagogicalPhrases(plain) + '</p>';
  }).filter(Boolean).join('\n');
  return { html: html, links: allLinks };
}

function buildTheoryFallbackSections(essay, paragraphs, topic) {
  let source = paragraphs && paragraphs.length >= 1
    ? paragraphs.slice()
    : splitEssayIntoChunks(essay, 4);

  if (source.length < 3 && essay) {
    source = source.concat(splitIntoSentences(essay));
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
    chunks.splice(largestIdx, 1, sentences.slice(0, mid).join(' '), sentences.slice(mid).join(' '));
    if (chunks.length >= 4) break;
  }

  const allLinks = [];
  const sections = chunks.map(function (content, i) {
    const formatted = formatFallbackProseChunk(content, topic);
    allLinks.push.apply(allLinks, formatted.links || []);
    return {
      heading: THEORY_FALLBACK_HEADINGS[i] || ('חלון ' + (i + 1)),
      content: formatted.html,
      icon: 'fa-compass',
    };
  }).filter(function (sec) { return sec.content; });

  return { sections: sections, links: allLinks };
}

function buildCoreEmphasesFallbackHtml(paragraphs, essay, grade, topic) {
  const topicStr = String(topic || '').trim();
  const headings = getCoreEmphasesHeadings(grade);
  const fallbackEssay = String(essay || '').trim();
  let source = (paragraphs || []).slice().filter(function (p) { return String(p || '').trim().length > 8; });
  if (!source.length && fallbackEssay) {
    source = paragraphsFromSterileEssay(fallbackEssay);
  }
  if (!source.length && fallbackEssay) {
    source = splitEssayIntoChunks(fallbackEssay, 3);
  }
  if (!source.length) {
    source = buildGradeDefaultCoreEmphasesParagraphs(grade, '');
  }

  let chunks = source.length >= 2
    ? groupParagraphsIntoChunks(source, 3)
    : splitEssayIntoChunks(source.join('\n\n') || fallbackEssay, 3);
  chunks = chunks.filter(function (c) { return String(c || '').trim().length > 8; }).slice(0, 3);

  const duplicatePayload = fallbackEssay || source.join('\n\n') || chunks.join('\n\n');
  const gradeDefaults = buildGradeDefaultCoreEmphasesParagraphs(grade, topicStr);
  while (chunks.length < 3) {
    const fallbackChunk = gradeDefaults[chunks.length] || gradeDefaults[0] || '';
    if (!fallbackChunk) break;
    chunks.push(fallbackChunk);
  }

  const allLinks = [];
  let html = '<div class="prose-ai leading-relaxed w-full space-y-5">';
  let articleCount = 0;
  chunks.forEach(function (content, i) {
    const text = String(content || duplicatePayload || '').trim();
    if (!text) return;
    const formatted = formatFallbackProseChunk(text, topicStr);
    if (!formatted.html || tab3FieldPlainLen(formatted.html) < 8) {
      const fallbackChunk = buildGradeDefaultCoreEmphasesParagraphs(grade, topicStr)[i] ||
        buildGradeDefaultCoreEmphasesParagraphs(grade, topicStr)[0];
      const fallbackFormatted = formatFallbackProseChunk(fallbackChunk, topicStr);
      allLinks.push.apply(allLinks, fallbackFormatted.links || []);
      html += '<article class="theory-fallback-window bg-white/75 rounded-2xl border border-gold/25 p-5 sm:p-6 w-full box-border">';
      html += '<h4 class="app-subhead font-display font-bold text-sage-dark mb-3"><strong>' +
        escapeHtmlForFallback(headings[i] || ('דגש ' + (i + 1))) + '</strong></h4>';
      html += fallbackFormatted.html || '<p>' + boldPedagogicalPhrases(fallbackChunk) + '</p>';
      html += '</article>';
      articleCount++;
      return;
    }
    allLinks.push.apply(allLinks, formatted.links || []);
    html += '<article class="theory-fallback-window bg-white/75 rounded-2xl border border-gold/25 p-5 sm:p-6 w-full box-border">';
    html += '<h4 class="app-subhead font-display font-bold text-sage-dark mb-3"><strong>' +
      escapeHtmlForFallback(headings[i] || ('דגש ' + (i + 1))) + '</strong></h4>';
    html += formatted.html;
    html += '</article>';
    articleCount++;
  });
  html += '</div>';

  if (!articleCount || tab3FieldPlainLen(html) < PHASE_C_TAB3_MIN_PLAIN_CHARS) {
    const defaults = buildGradeDefaultCoreEmphasesParagraphs(grade, topicStr);
    return buildCoreEmphasesFallbackHtml(defaults, defaults.join('\n\n'), grade, topicStr);
  }
  return { html: stripBracketCitationMarkersInHtml(html), links: allLinks };
}

function splitInspirationFallbackItems(paragraphs, essay) {
  let items = paragraphs.length ? paragraphs.slice() : splitEssayIntoChunks(essay, 6);
  if (!items.length && essay) items = [essay];
  return items.filter(function (item) { return String(item || '').trim().length > 4; });
}

/**
 * Absolute safety net — every Tab 3 field must have substantive content before response leaves the server.
 * Duplicates the richest available prose payload when regex/split isolation fails.
 */
function ensurePhaseCTab3Population(normalized, opts) {
  if (!normalized || typeof normalized !== 'object') return normalized;
  const options = opts || {};
  const grade = String(options.grade || '').trim();
  const topic = String(options.topic || 'נושא').trim();
  const parsed = options.parsed;
  const richEssay = gatherRichTab3SourceText(
    normalized,
    options.essay || '',
    parsed
  );
  const defaultParagraphs = buildGradeDefaultCoreEmphasesParagraphs(grade, topic);
  const payloadEssay = richEssay || defaultParagraphs.join('\n\n');

  if (tab3FieldPlainLen(normalized.core_emphases) < PHASE_C_TAB3_MIN_PLAIN_CHARS) {
    const partition = partitionFallbackEssay(payloadEssay);
    let coreParagraphs = partition.coreParagraphs.filter(function (p) {
      return String(p || '').trim().length > 8;
    });
    if (!coreParagraphs.length) {
      coreParagraphs = paragraphsFromSterileEssay(payloadEssay);
    }
    if (!coreParagraphs.length) {
      coreParagraphs = defaultParagraphs.slice();
    }
    if (!coreParagraphs.length) {
      coreParagraphs = [payloadEssay];
    }
    const coreResult = buildCoreEmphasesFallbackHtml(coreParagraphs, payloadEssay, grade, topic);
    normalized.core_emphases = coreResult.html;
    mergeExtractedLinksIntoNormalized(normalized, [coreResult.links], topic);
  }

  if (!Array.isArray(normalized.key_points)) normalized.key_points = [];
  const substantiveKeyPoints = normalized.key_points.filter(function (item) {
    return String(item || '').trim().length >= 20;
  });
  if (!substantiveKeyPoints.length) {
    const kpParagraphs = paragraphsFromSterileEssay(payloadEssay);
    normalized.key_points = buildKeyPointsFromEssay(payloadEssay, kpParagraphs);
  }
  if (!normalized.key_points.length) {
    normalized.key_points = defaultParagraphs.map(function (paragraph) {
      return paragraph.split(/(?<=[.!?׃。])\s+/).slice(0, 2).join(' ').trim() || paragraph;
    }).filter(function (item) { return item.length >= 20; }).slice(0, 6);
  }
  if (!normalized.key_points.length) {
    normalized.key_points = defaultParagraphs.slice(0, 5);
  }

  if (!Array.isArray(normalized.relevant_links)) normalized.relevant_links = [];
  if (!normalized.relevant_links.length) {
    applyPhaseCFallbackLinkHarvester(normalized, parsed, topic);
  }
  normalized.relevant_links = filterLiveNormalizedLinks(normalized.relevant_links);
  if (!normalized.relevant_links.length && normalized.theory && normalized.theory.bibliography) {
    normalized.relevant_links = filterLiveNormalizedLinks(normalized.theory.bibliography.websites)
      .map(function (item) {
        return { title: String(item.title || item.url || '').trim(), url: String(item.url || '').trim() };
      })
      .filter(function (item) { return item.url; })
      .slice(0, 8);
  }
  if (!normalized.relevant_links.length && normalized.pedagogical_resources && normalized.pedagogical_resources.length) {
    normalized.relevant_links = filterLiveNormalizedLinks(normalized.pedagogical_resources)
      .map(function (item) {
        return { title: String(item.title || item.url || '').trim(), url: String(item.url || '').trim() };
      })
      .filter(function (item) { return item.url; })
      .slice(0, 8);
  }

  ensureRecommendedReading(normalized, payloadEssay, grade, topic, parsed);
  applyLiveCitationGate(normalized, parsed, topic);

  if (tab3FieldPlainLen(normalized.core_emphases) < PHASE_C_TAB3_MIN_PLAIN_CHARS) {
    const emergency = buildCoreEmphasesFallbackHtml(defaultParagraphs, defaultParagraphs.join('\n\n'), grade, topic);
    normalized.core_emphases = emergency.html;
  }

  return deduplicateTab3Fields(normalized, grade, topic);
}

function duplicateRichPayloadAcrossFallbackTabs(normalized, essay, grade, topic) {
  const text = String(essay || '').trim();
  if (!text) return normalized;
  const topicStr = String(topic || 'נושא').trim();
  const titleSuffix = grade ? (grade + ' · ' + topicStr) : topicStr;

  const theorySections = normalized.theory && Array.isArray(normalized.theory.sections)
    ? normalized.theory.sections
    : [];
  const theoryHasContent = theorySections.some(function (sec) {
    return tab3FieldPlainLen(sec && sec.content) >= PHASE_C_TAB3_MIN_PLAIN_CHARS;
  });
  if (!theoryHasContent) {
    const theoryResult = buildTheoryFallbackSections(text, paragraphsFromSterileEssay(text), topicStr);
    if (theoryResult.sections.length) {
      normalized.theory = {
        title: (normalized.theory && normalized.theory.title) || ('רקע תיאורטי — ' + titleSuffix),
        sections: theoryResult.sections,
        bibliography: (normalized.theory && normalized.theory.bibliography) || { books: [], articles: [], websites: [] },
      };
      mergeExtractedLinksIntoNormalized(normalized, [theoryResult.links], topicStr);
    }
  }

  const insp = normalized.inspiration;
  const inspHasContent = insp && (
    (Array.isArray(insp.global) && insp.global.some(function (b) { return b && b.items && b.items.length; })) ||
    (Array.isArray(insp.narrative) && insp.narrative.length)
  );
  if (!inspHasContent) {
    const inspirationItems = splitInspirationFallbackItems(paragraphsFromSterileEssay(text), text);
    normalized.inspiration = {
      title: (insp && insp.title) || ('השראה פדגוגית — ' + topicStr),
      global: buildInspirationFallbackGlobalBlocks(inspirationItems.length ? inspirationItems : [text]),
      podcast: (insp && insp.podcast) || { title: 'תובנות', episodes: [] },
      narrative: paragraphsFromSterileEssay(text).slice(-3),
    };
  }

  if (tab3FieldPlainLen(normalized.core_emphases) < PHASE_C_TAB3_MIN_PLAIN_CHARS) {
    const coreResult = buildCoreEmphasesFallbackHtml(paragraphsFromSterileEssay(text), text, grade, topicStr);
    normalized.core_emphases = coreResult.html;
    mergeExtractedLinksIntoNormalized(normalized, [coreResult.links], topicStr);
  }

  return normalized;
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

function extractRecommendedReadingFromText() {
  return [];
}

function resolveGradeNum(grade) {
  const digit = String(grade || '').match(/[1-8]/);
  return digit ? digit[0] : '';
}

function buildDefaultRecommendedReading() {
  return [];
}

function buildDefaultRelevantLinks() {
  return [];
}

function ensureRecommendedReading(normalized, essay, grade, topic, parsed) {
  const topicStr = String(topic || '').trim();
  const citationSet = buildLiveCitationUrlSet(parsed, topicStr);
  let reading = filterRecommendedReadingByLiveCitations(
    Array.isArray(normalized.recommended_reading) ? normalized.recommended_reading : [],
    citationSet,
    topicStr
  );
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

function stripUrlsFromBibliographyEntry(item) {
  if (!item || typeof item !== 'object') return item;
  const next = Object.assign({}, item);
  next.url = '';
  delete next.link;
  delete next.href;
  return next;
}

/**
 * Resources tab (המלצות לקריאה וקישורים) — gather ALL external URLs here; strip from narrative-tab payloads.
 */
function centralizePhaseCLinksToResourcesTab(normalized, topic) {
  if (!normalized || typeof normalized !== 'object') return normalized;
  const topicStr = String(topic || '').trim();
  const merged = [];
  const seen = new Set();

  function pushItem(title, url) {
    let clean = normalizeToTrustedPortalRoot(url);
    if (!clean || isDeadPhaseCFallbackUrl(clean)) return;
    const candidate = { title: String(title || clean).trim(), url: clean };
    if (!isAllowedPhaseCSourceItem(candidate)) return;
    const key = normalizeCitationUrlForMatch(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push({
      title: resolvePhaseCFriendlyLinkTitle(candidate.title, clean),
      url: clean,
    });
  }

  (normalized.relevant_links || []).forEach(function (item) {
    if (!item) return;
    pushItem(item.title || item.name, extractUrlFromLinkItem(item));
  });
  (normalized.pedagogical_resources || []).forEach(function (item) {
    if (!item) return;
    pushItem(item.title || item.label || item.name, extractUrlFromLinkItem(item));
  });
  (normalized.pinterest_links || []).forEach(function (item) {
    if (!item) return;
    pushItem(item.title || item.board || 'Pinterest', extractUrlFromLinkItem(item));
  });
  (normalized.recommended_reading || []).forEach(function (item) {
    if (!item) return;
    pushItem(item.title, extractUrlFromLinkItem(item));
  });
  const bib = normalized.theory && normalized.theory.bibliography;
  if (bib) {
    ['websites', 'articles', 'books'].forEach(function (cat) {
      (bib[cat] || []).forEach(function (item) {
        if (!item) return;
        pushItem(item.title || item.name, extractUrlFromLinkItem(item));
      });
    });
  }
  extractLiveCitationsFromParsed(normalized, topicStr).forEach(function (url) {
    pushItem('', url);
  });

  normalized.relevant_links = filterLiveNormalizedLinks(merged).slice(0, 12);
  normalized.pedagogical_resources = [];

  if (bib) {
    ['books', 'articles', 'websites'].forEach(function (cat) {
      bib[cat] = (bib[cat] || []).map(stripUrlsFromBibliographyEntry).filter(function (item) {
        return item && String(item.title || '').trim() && isPayloadLiteratureSourceItem(item);
      });
    });
  }

  normalized.recommended_reading = (normalized.recommended_reading || []).map(function (item) {
    if (!item || typeof item !== 'object') return item;
    const next = Object.assign({}, item);
    next.url = '';
    delete next.link;
    return next;
  }).filter(function (item) {
    return item && String(item.title || '').trim() && isPayloadLiteratureSourceItem(item);
  });

  return normalized;
}

function deduplicatePhaseCTabLinks(normalized, topic) {
  return centralizePhaseCLinksToResourcesTab(normalized, topic);
}

/** @deprecated alias — use centralizePhaseCLinksToResourcesTab */
function centralizePhaseCLinksToTab3(normalized, topic) {
  return centralizePhaseCLinksToResourcesTab(normalized, topic);
}

/**
 * Rebuild a normalized Phase C response from parse-fallback debris into full-length sterile prose.
 */
function applyPhaseCFallbackCleaner(normalized, parsed, grade, topic) {
  const source = gatherPhaseCFallbackSourceText(parsed);
  let essay = sterilizePhaseCFallbackText(source);
  if (!essay) {
    essay = sterilizePhaseCFallbackText(gatherPhaseCFallbackApiResponse(parsed));
  }
  if (!essay) {
    essay = String(source || '').trim();
  }

  const topicStr = String(topic || 'נושא').trim();
  const gradeStr = String(grade || '').trim();
  const titleSuffix = gradeStr ? (gradeStr + ' · ' + topicStr) : topicStr;
  const defaultParagraphs = buildGradeDefaultCoreEmphasesParagraphs(gradeStr, topicStr);
  const richEssay = essay || defaultParagraphs.join('\n\n');
  const partition = partitionFallbackEssay(richEssay);

  let theoryParagraphs = partition.theoryParagraphs;
  let inspirationParagraphs = partition.inspirationParagraphs;
  let coreParagraphs = partition.coreParagraphs;

  if (!theoryParagraphs.length && !inspirationParagraphs.length && !coreParagraphs.length) {
    theoryParagraphs = paragraphsFromSterileEssay(richEssay);
    inspirationParagraphs = theoryParagraphs.slice();
    coreParagraphs = theoryParagraphs.slice();
  }
  if (!coreParagraphs.length) {
    coreParagraphs = defaultParagraphs.slice();
  }

  const theoryEssay = theoryParagraphs.join('\n\n') || richEssay;
  const inspirationEssay = inspirationParagraphs.join('\n\n') || richEssay;
  const coreEssay = coreParagraphs.join('\n\n') || richEssay;

  const theoryResult = buildTheoryFallbackSections(
    theoryEssay,
    theoryParagraphs.length ? theoryParagraphs : paragraphsFromSterileEssay(theoryEssay),
    topicStr
  );
  const coreResult = buildCoreEmphasesFallbackHtml(
    coreParagraphs,
    coreEssay,
    gradeStr,
    topicStr
  );
  const inspirationItems = splitInspirationFallbackItems(
    inspirationParagraphs.length ? inspirationParagraphs : paragraphsFromSterileEssay(inspirationEssay),
    inspirationEssay
  );
  let keyPoints = buildKeyPointsFromEssay(
    coreEssay,
    coreParagraphs.length ? coreParagraphs : paragraphsFromSterileEssay(coreEssay)
  );
  if (!keyPoints.length) {
    keyPoints = defaultParagraphs.map(function (p) {
      return p.split(/(?<=[.!?׃。])\s+/).slice(0, 2).join(' ').trim() || p;
    }).slice(0, 6);
  }

  normalized.theory = {
    title: 'רקע תיאורטי — ' + titleSuffix,
    sections: theoryResult.sections.length
      ? theoryResult.sections
      : buildTheoryFallbackSections(richEssay, paragraphsFromSterileEssay(richEssay), topicStr).sections,
    bibliography: (normalized.theory && normalized.theory.bibliography) || { books: [], articles: [], websites: [] },
  };
  normalized.inspiration = {
    title: 'השראה פדגוגית — ' + topicStr,
    global: buildInspirationFallbackGlobalBlocks(
      inspirationItems.length ? inspirationItems : paragraphsFromSterileEssay(richEssay)
    ),
    podcast: { title: 'תובנות', episodes: [] },
    narrative: inspirationParagraphs.length > 2 ? inspirationParagraphs.slice(-3) : paragraphsFromSterileEssay(richEssay).slice(-3),
  };
  normalized.core_emphases = coreResult.html;
  normalized.key_points = keyPoints;
  if (!Array.isArray(normalized.recommended_reading)) normalized.recommended_reading = [];
  if (!Array.isArray(normalized.relevant_links)) normalized.relevant_links = [];
  if (!Array.isArray(normalized.pinterest_links)) normalized.pinterest_links = [];
  if (!Array.isArray(normalized.pedagogical_resources)) normalized.pedagogical_resources = [];

  duplicateRichPayloadAcrossFallbackTabs(normalized, richEssay, gradeStr, topicStr);
  mergeExtractedLinksIntoNormalized(normalized, [theoryResult.links, coreResult.links], topicStr);
  applyPhaseCFallbackLinkHarvester(normalized, parsed, topicStr);
  ensureRecommendedReading(normalized, coreEssay || richEssay, gradeStr, topicStr, parsed);
  applyLiveCitationGate(normalized, parsed, topicStr);

  return ensurePhaseCTab3Population(normalized, {
    essay: richEssay,
    grade: gradeStr,
    topic: topicStr,
    parsed: parsed,
  });
}

const PHASE_C_GENERIC_OFF_TOPIC_ENTITIES = /מט"ח|מט״ח|ראמ"ה|ראמ״ה|נגבה|KidsPlus|kids\s*plus|פורטל\s+עובדי\s+הוראה|תוכנית\s+הלימודים\s+החדשה/i;
const PHASE_C_HALLUCINATED_MEDIA_TITLE = /פודקאסט|podcast|סדרת\s+וידאו|video\s+series/i;

const PHASE_C_NO_HALLUCINATED_MEDIA_INSTRUCTION = [
  'FORBIDDEN: Generate conceptual or non-existent media structures such as "Podcast", "פודקאסט", "Video Series", or episodic anthologies',
  'UNLESS every episode includes a verified working HTTPS url field pointing to a real external resource.',
  'If you cannot provide a real, working link for EACH episode, omit the podcast key entirely and use narrative strings instead.',
].join(' ');

function filterGenericEntitiesFromProse(text) {
  const raw = String(text || '');
  if (!raw || !PHASE_C_GENERIC_OFF_TOPIC_ENTITIES.test(raw)) return raw;
  return raw.split(/\n\n+/).map(function (para) {
    const trimmed = String(para || '').trim();
    if (!trimmed) return '';
    if (PHASE_C_GENERIC_OFF_TOPIC_ENTITIES.test(trimmed) &&
        !/וולדורף|שטיינר|אנתרופוסופ|waldorf|steiner|anthroposoph/i.test(trimmed)) {
      return '';
    }
    return trimmed.replace(PHASE_C_GENERIC_OFF_TOPIC_ENTITIES, '').replace(/\s{2,}/g, ' ').trim();
  }).filter(Boolean).join('\n\n').trim();
}

function inspirationEpisodeHasVerifiedLink(ep) {
  if (!ep || typeof ep !== 'object') return false;
  const url = String(ep.url || ep.link || ep.href || '').trim();
  return Boolean(url && isValidPhaseCExternalUrl(url));
}

function sanitizeInspirationPodcastBlock(podcast) {
  if (!podcast || typeof podcast !== 'object') return { title: 'תובנות', episodes: [] };
  const episodes = Array.isArray(podcast.episodes) ? podcast.episodes : [];
  const title = String(podcast.title || '').trim();
  const linked = episodes.filter(inspirationEpisodeHasVerifiedLink);
  const isConceptualMedia = PHASE_C_HALLUCINATED_MEDIA_TITLE.test(title);
  if (episodes.length && linked.length !== episodes.length) {
    return { title: 'תובנות', episodes: [] };
  }
  if (isConceptualMedia && !linked.length) {
    return { title: 'תובנות', episodes: [] };
  }
  return { title: title || 'תובנות', episodes: linked };
}

/** Maximum-priority Waldorf/Anthroposophy mandate — prepended to every Phase C Perplexity call. */
const WALDORF_CORE_SYSTEM_PROMPT = [
  'You are a senior Waldorf and Anthroposophical curriculum expert.',
  'All generated text, background, activities, and curriculum blueprints MUST strictly adhere to Waldorf/Steiner education.',
  'Completely forbid generic state-curriculum frameworks, and filter out entities like מט"ח, ראמ"ה, נגבה, or KidsPlus.',
  'Only use anthroposophical pedagogical sources.',
].join(' ');

const PHASE_C_SOURCE_HARVESTING_INSTRUCTION = [
  '=== SOURCE HARVESTING (STRICT — Waldorf & Anthroposophy first) ===',
  'The generated content and sources MUST heavily prioritize and center around Waldorf education (חינוך ולדורף) and Anthroposophy (אנתרופוסופיה).',
  'Prioritize scanning and returning references from trusted domains like antro.co.il, Israeli Waldorf school platforms, and anthroposophical portals.',
  'The main body of references MUST remain Waldorf-focused: Steiner archives (rsarchive.org), waldorflibrary.org, AWSNA, IASWECE, antro.co.il, Israeli Waldorf networks, and anthroposophical research libraries.',
  'Generic state-curriculum or practical mapping links (מט"ח, פורטל עובדי הוראה, משרד החינוך sheets, national curriculum spreadsheets) are capped at a MAXIMUM of 1-2 links TOTAL across the entire response — only as a minimal practical appendix, never as the primary reference set.',
  'STRICTLY FORBIDDEN in theory body text: generic national-curriculum entities (מט"ח, ראמ"ה, נגבה, KidsPlus) unless directly tied to Waldorf/anthroposophical pedagogy.',
  '=== END SOURCE HARVESTING ===',
].join(' ');

const PHASE_C_CRITICAL_TEXT_INSTRUCTION = [
  'CRITICAL TEXT INSTRUCTION: Do NOT include any academic bracketed citation numbers or footnotes (e.g., [1], [2], [7]) anywhere in the text.',
  'Absolutely FORBID repeating or duplicating the same paragraphs or sentences across different JSON fields.',
  'Write unique content for each key.',
].join(' ');

const PHASE_C_LANGUAGE_SOURCE_RULE = [
  'CRITICAL LANGUAGE & SOURCE RULE: You are strictly FORBIDDEN from returning, searching, or citing sources in Russian, Arabic, or any foreign language other than Hebrew or English.',
  'Every single referenced source, pedagogical text, or recommended tool MUST be actively available ONLY in Hebrew or English.',
  'Absolutely no academic document repositories from foreign governments or universities (e.g., .ru, .su, .ua domains).',
].join(' ');

const PHASE_C_EXPANSION_NARRATIVE_RULE = [
  '=== LIVE EXPANSION NARRATIVE (on-demand UI) ===',
  'When users click «הרחבה ואספקטים פרקטיים», a SEPARATE API call returns expansion text.',
  'ABSOLUTELY FORBID repeating or duplicating the same sentence, paragraph, or bullet back-to-back anywhere in expansion output — each sentence must appear at most once.',
  'If you catch yourself restating an idea, skip the repeat and advance with new pedagogical detail instead.',
  'Expansion bodies: pure pedagogical narrative and practical classroom guidance ONLY.',
  'STRICTLY FORBIDDEN inside expansion bodies: book titles, author names, URLs, domain names, source lists, bibliography, «guillemet» titles, square brackets, numeric brackets like [1], and any citation markup.',
  'ABSOLUTELY FORBID JSON keys inspirationReferences, citations, materialsNeeded, furtherReading, bibliography, recommended_reading, or relevant_links in expansion payloads — omit them entirely.',
  '=== END LIVE EXPANSION NARRATIVE ===',
].join(' ');

const PHASE_C_LINKS_CENTRALIZATION_RULE = [
  '=== CENTRALIZED SOURCES (Resources tab Box A ONLY — «המלצות לקריאה וקישורים») ===',
  'ALL external HTTPS links, recommended literature, and bibliography metadata belong EXCLUSIVELY in recommended_reading and relevant_links (Resources tab Box A).',
  'Narrative tab and expansion panels: ZERO URLs, ZERO <a> anchors, ZERO link markup, ZERO book lists, ZERO bibliography.',
  'STRICT CONTENT FILTER: include ONLY sources explicitly related to Waldorf pedagogy or Anthroposophy — discard generic education sites (מט"ח, משרד החינוך, Khan Academy, Matific, etc.).',
  'LANGUAGE FILTER: retain ONLY sources written in Hebrew or English — discard all other languages.',
  'Prefer reliable TOP-LEVEL portal homepages ONLY (https://rsarchive.org/, https://www.waldorflibrary.org/, https://antro.co.il/, https://waldorfeducation.org/, https://www.iaswece.org/) — NEVER emit deep article paths, encoded Hebrew paths, or guessed slugs that 404.',
  'Never invent or guess deep-link paths; when uncertain, use the organization homepage root URL.',
  '=== END CENTRALIZED SOURCES ===',
].join(' ');

const PHASE_C_NARRATIVE_TEXT_ONLY_RULE = [
  '=== NARRATIVE TEXT ONLY (GLOBAL — ALL TABS) ===',
  'Every pedagogical narrative field (theory sections, inspiration items, core_emphases, key_points) MUST contain PEDAGOGICAL PROSE ONLY.',
  'STRICTLY FORBIDDEN inside narrative bodies: academic bracket citations [1], footnotes, raw URLs, naked domains, HTML <a> anchors, <details> blocks, or any link markup.',
  'The UI loads «הרחבה ואספקטים פרקטיים» via a separate on-demand API call — NEVER bundle expansions, workshop steps, or practical dives in this payload.',
  PHASE_C_EXPANSION_NARRATIVE_RULE,
  PHASE_C_LINKS_CENTRALIZATION_RULE,
  '=== END NARRATIVE TEXT ONLY ===',
].join(' ');

const PHASE_C_ESSAY_DEPTH_REQUIREMENTS = [
  '=== MAXIMUM ESSAY DEPTH (MANDATORY — full live-research curriculum quality) ===',
  'Write EXTENSIVE, comprehensive, academic-yet-practical Waldorf curriculum essays — NOT summaries, NOT thin bullets, NOT stubs.',
  'Use the FULL output token budget across ALL tabs. Never sacrifice length for brevity.',
  'Narrative tab — theory: 3-5 sections; EACH section = 5-8 deep paragraphs (plain HTML: <p>, <strong>, <ul>/<li> only — NO links in section content).',
  'Narrative tab — inspiration: 2-4 global blocks with 6-10 items each; every item = rich pedagogical mini-essay (plain text/HTML prose only — Peter Selg, classroom arts, movement).',
  'Resources tab — pedagogical_resources: title, url, label, source, snippet ONLY — no content HTML body.',
  'Narrative tab — core_emphases: MINIMUM 5-6 long paragraphs including full Developmental Compass (מצפן התפתחותי) — prose only.',
  'Narrative tab — key_points: exactly 5-6 items; EACH = 3-6 unique sentences of grade-specific lesson architecture — prose only.',
  'Resources tab — recommended_reading: 5-8 entries with substantive 2-3 sentence notes each (no URLs).',
  'Resources tab — relevant_links: 6-10 verified live HTTPS URLs with descriptive Hebrew titles — dedicated links array ONLY.',
  '=== END ESSAY DEPTH ===',
].join(' ');

const PHASE_C_ON_DEMAND_EXPANSION_INSTRUCTION = [
  '=== ON-DEMAND LIVE EXPANSIONS (UI architecture) ===',
  'This response is the BASELINE synthesis only. The frontend triggers separate Perplexity research when users click expansion buttons.',
  'Do NOT include expansion, contentExpansion, pedagogical_deep_dive, or <details> blocks anywhere.',
  PHASE_C_NARRATIVE_TEXT_ONLY_RULE,
  PHASE_C_ESSAY_DEPTH_REQUIREMENTS,
  'Narrative tab (מידע והשראה): theory sections, inspiration suggestion cards, core_emphases essay, key_points — plain pedagogical previews only; ZERO links and ZERO bibliography.',
  'Resources tab (המלצות לקריאה וקישורים): recommended_reading + relevant_links + pinterest_links ONLY — all live URLs and literature metadata live here.',
  '=== END ON-DEMAND EXPANSIONS ===',
].join(' ');

function extractPhaseCGradeNumber(grade) {
  const m = String(grade || '').match(/[1-8]/);
  return m ? parseInt(m[0], 10) : null;
}

function buildPhaseCGradeTopicLockInstruction(grade, topic) {
  const g = extractPhaseCGradeNumber(grade);
  const topicStr = String(topic || '').trim();
  const lines = [
    '=== GRADE & TOPIC LOCK (ABSOLUTE — NON-NEGOTIABLE) ===',
    'Target grade: ' + String(grade || '').trim(),
    'Target main-lesson topic: ' + topicStr,
    'Every section MUST match THIS grade developmental stage and THIS topic only.',
    'FORBIDDEN: importing concepts, examples, or links from other grades.',
    'FORBIDDEN for Grades 1-6: adolescent themes (הלידה השנייה, puberty, מרד השלישי, chemistry/physics upper-school depth) unless grade is 7 or 8.',
  ];
  if (g !== null && g <= 2) {
    lines.push(
      'Grades 1-2 LOCK: fairy-tale consciousness, qualities of numbers, form drawing, rhythm, imaginative math stories, pictorial counting.',
      'Grade 1 math example: המספרים כאיכויות, ציור צורות, סיפורי מספרים, תנועה ושיר — NEVER הלידה השנייה, NEVER abstract algebra, NEVER upper-school science.'
    );
  } else if (g !== null && g >= 7) {
    lines.push('Grades 7-8: adolescent soul themes are appropriate when directly tied to the topic and grade.');
  } else if (g !== null) {
    lines.push('Middle grades (3-6): concrete imaginative thinking; match Steiner middle-period curriculum — no early-childhood-only tone, no full upper-school abstraction.');
  }
  lines.push('=== END GRADE & TOPIC LOCK ===');
  return lines.join('\n');
}

const SYSTEM_PROMPT = [
  WALDORF_CORE_SYSTEM_PROMPT,
  PHASE_C_ON_DEMAND_EXPANSION_INSTRUCTION,
  PHASE_C_CRITICAL_TEXT_INSTRUCTION,
  PHASE_C_LANGUAGE_SOURCE_RULE,
  PHASE_C_NARRATIVE_TEXT_ONLY_RULE,
  PHASE_C_SOURCE_HARVESTING_INSTRUCTION,
  PHASE_C_NO_HALLUCINATED_MEDIA_INSTRUCTION,
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'theory (object: {title, sections: [{heading, content, icon?}], bibliography: {books, articles, websites: [{title, url?, author?, note?}]}} — exhaustive theoretical background; EACH section content = 5-8 deep paragraphs using ONLY <p>, <strong>, <ul>/<li>; NO links or citations in section HTML; bibliography holds all sources),',
  'inspiration (object: {title, global: [{title, items: [rich pedagogical mini-essays — plain prose/HTML without links]}], podcast: {title, episodes: [{theme, insight, url?}]} — OPTIONAL; omit unless every episode has verified HTTPS url, narrative: [essay strings]} — vivid classroom inspiration; NO bare URLs in item prose),',
  'pinterest_links (array of objects: {title, url, board} — 4-8 live Pinterest board or curated pin URLs for this grade+topic Waldorf visual inspiration),',
  'pedagogical_resources (array of objects: {title, url, label, source, snippet} — metadata and short snippet ONLY; NO content HTML body),',
  'core_emphases (string: compiled pedagogical essay with MINIMUM 5-6 comprehensive Hebrew paragraphs and full Developmental Compass — prose only; NO links),',
  'key_points (array of exactly 5-6 rich strings — EACH 3-6 substantial grade-locked sentences; prose only; NEVER duplicate core_emphases),',
  'recommended_reading (array of 5-8 objects: {title, author, note} — note MUST be 2-3 substantive sentences; NO urls),',
  'relevant_links (array of 6-10 objects: {title, url} — THE ONLY place for live HTTPS links and bibliography website URLs; Resources tab; prefer top-level Waldorf/anthro portals; at most 1-2 ministry links total; NEVER inside narrative fields).',
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
    const content = String(item.content || item.html || item.body || '').trim();
    const snippet = String(item.snippet || item.description || item.summary || content || '').trim();
    return {
      title: String(item.title || item.name || url).trim(),
      url: url,
      label: resolvePhaseCFriendlyLinkTitle(item.label || item.title || item.name, url),
      source: String(item.source || item.publisher || '').trim(),
      snippet: stripPedagogicalNarrativeMarkup(snippet).slice(0, 400),
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
          heading: sanitizePhaseCPlainProse(String(sec.heading || sec.title || '').trim()),
          content: sanitizePhaseCProseField(
            filterGenericEntitiesFromProse(shared.coerceText(sec.content || sec.text || sec.body || sec))
          ),
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
    const podcast = sanitizeInspirationPodcastBlock(insp.podcast && typeof insp.podcast === 'object' ? {
      title: String(insp.podcast.title || 'תובנות').trim(),
      episodes: Array.isArray(insp.podcast.episodes) ? insp.podcast.episodes.map(function (ep) {
        if (!ep || typeof ep !== 'object') return { theme: '', insight: shared.coerceText(ep) };
        return {
          theme: String(ep.theme || ep.title || '').trim(),
          insight: shared.coerceText(ep.insight || ep.text || ep.content),
          url: String(ep.url || ep.link || ep.href || '').trim(),
        };
      }).filter(function (ep) { return ep.theme || ep.insight; }) : [],
    } : { title: 'תובנות', episodes: [] });
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
  ).map(function (link) {
    if (!link || typeof link !== 'object') return link;
    const url = String(link.url || link.link || link.href || '').trim();
    return Object.assign({}, link, {
      title: resolvePhaseCFriendlyLinkTitle(link.title || link.name, url),
      url: url,
    });
  });
  const result = {
    theory: normalizeTheoryBlock(data, grade, topic),
    inspiration: normalizeInspirationBlock(data, topic),
    pinterest_links: pinterestLinks,
    pedagogical_resources: [],
    core_emphases: filterGenericEntitiesFromProse(coreEmphases),
    key_points: keyPoints,
    recommended_reading: recommendedReading,
    relevant_links: relevantLinks,
  };
  ensureRecommendedReading(result, coreEmphases, grade, topic, parsed);
  return deduplicateTab3Fields(applyLiveCitationGate(result, parsed, topic), grade, topic);
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
  if (parsed && typeof parsed === 'object') {
    stampTopicMasterArchiveLinks(parsed, parsed);
  }
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
  } else {
    const sourceEssay = sterilizePhaseCFallbackText(gatherPhaseCFallbackSourceText(parsed)) ||
      gatherRichTab3SourceText(result, '', parsed);
    duplicateRichPayloadAcrossFallbackTabs(result, sourceEssay, grade, topicStr);
    result = ensurePhaseCTab3Population(result, {
      essay: sourceEssay,
      grade: grade,
      topic: topicStr,
      parsed: parsed,
    });
  }
  stampTopicMasterArchiveLinks(result, parsed || result);
  result = applyLiveCitationGate(result, parsed || result, topicStr);
  result = applyPhaseCTextSanitizationChain(result);
  return centralizePhaseCLinksToResourcesTab(result, topicStr);
}

function shouldBypassTopicMasterCache(body) {
  if (!body || typeof body !== 'object') return false;
  return Boolean(body.forceFresh || body.skipCache || body.bypassCache || body.forceRefresh);
}

async function runPurePhaseC(body) {
  const grade = String(body.grade || body.gradeLabel || body.gradeId || '').trim();
  const topic = String(body.topic || '').trim();
  const gradeId = resolveGradeId(body);
  if (!grade) throw shared.badRequest('grade is required');
  if (!topic) throw shared.badRequest('topic is required');

  if (gradeId && shouldBypassTopicMasterCache(body)) {
    try {
      await cache.deleteTopicMasterCache(gradeId, topic);
      console.log('[pure-phase-c] cache bypass — live Perplexity crawl for', topic);
    } catch (purgeErr) {
      console.warn('[pure-phase-c] topic_master cache purge failed:', purgeErr.message || purgeErr);
    }
  }

  if (gradeId && !shouldBypassTopicMasterCache(body)) {
    const cached = await cache.getTopicMasterCache(gradeId, topic);
    if (cached && cached.data) {
      try {
        stampTopicMasterArchiveLinks(cached.data, cached.data);
        return {
          data: safeNormalizePhaseCResponse(cached.data, grade, topic),
          meta: Object.assign({
            fromCache: true,
            source: cached.meta && cached.meta.semanticMatch
              ? (cached.meta.source || 'topic_master_semantic')
              : 'topic_master_archive',
          }, cached.meta || {}),
        };
      } catch (cacheErr) {
        console.warn('[pure-phase-c] cache normalize failed, regenerating:', cacheErr.message || cacheErr);
      }
    }
  }

  const userPrompt = [
    WALDORF_CORE_SYSTEM_PROMPT,
    '',
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
    PHASE_C_SOURCE_HARVESTING_INSTRUCTION,
    '',
    shared.PEDAGOGICAL_DEPTH_INSTRUCTION,
    '',
    PHASE_C_NO_HALLUCINATED_MEDIA_INSTRUCTION,
    '',
    PHASE_C_CRITICAL_TEXT_INSTRUCTION,
    '',
    PHASE_C_LANGUAGE_SOURCE_RULE,
    '',
    PHASE_C_NARRATIVE_TEXT_ONLY_RULE,
    '',
    PHASE_C_ON_DEMAND_EXPANSION_INSTRUCTION,
    '',
    buildPhaseCGradeTopicLockInstruction(grade, topic),
    '',
    'Return MAXIMUM-DEPTH live-research baseline content — exhaustive essays, full-length guidelines, ALL links centralized in relevant_links / pinterest_links (Resources tab), zero truncation:',
    '- Narrative tab theory: 3-5 sections × 5-8 deep paragraphs each (prose ONLY — zero URLs, zero anchors in section HTML).',
    '- Narrative tab inspiration: 2-4 global blocks × 6-10 rich pedagogical mini-essays each (prose only — expansions load on-demand in UI).',
    '- pinterest_links: 4-8 LIVE pinterest.com URLs (Resources tab Box B; also mirrored into relevant_links).',
    '- Narrative tab core_emphases: 5-6 deep paragraphs with full Developmental Compass — prose only.',
    '- Narrative tab key_points: 5-6 extensive grade-locked items (3-6 sentences each) — unique prose only.',
    '- Resources tab recommended_reading: 5-8 entries with substantive notes (titles/authors only — NO urls).',
    '- Resources tab relevant_links: 6-10 reliable top-level Waldorf/anthro portal URLs; NEVER inside narrative fields.',
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
  stampTopicMasterArchiveLinks(normalized, parsed);

  if (gradeId) {
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
  WALDORF_CORE_SYSTEM_PROMPT,
  PHASE_C_ON_DEMAND_EXPANSION_INSTRUCTION,
  PHASE_C_NARRATIVE_TEXT_ONLY_RULE,
  PHASE_C_ESSAY_DEPTH_REQUIREMENTS,
  buildPhaseCGradeTopicLockInstruction,
  extractPhaseCGradeNumber,
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
  deduplicateTab3Fields,
  buildDistinctKeyPointsFromEssay,
  dedupeTextFragments,
  stripBracketCitationMarkersInHtml,
  stripBracketCitationMarkersInProse,
  applyPhaseCTextSanitizationChain,
  sanitizePhaseCProseField,
  sanitizePhaseCPlainProse,
  stripSequentialDuplicateSentences,
  isForbiddenForeignSourceUrl,
  hasDisallowedForeignScript,
  isHebrewOrEnglishSourceText,
  isWaldorfAnthroposophyRelevant,
  isAllowedPhaseCSourceItem,
  isPayloadLiteratureSourceItem,
  linkifyFallbackSegment,
  ensureRecommendedReading,
  deduplicatePhaseCTabLinks,
  centralizePhaseCLinksToResourcesTab,
  centralizePhaseCLinksToTab3,
  applyLiveCitationGate,
  extractLiveCitationsFromParsed,
  buildLiveCitationUrlSet,
  ensurePhaseCTab3Population,
  buildGradeDefaultCoreEmphasesParagraphs,
  tab3FieldPlainLen,
  stampTopicMasterArchiveLinks,
  collectPhaseCLinkUrlList,
  collectPhaseCLinkItemsForDisplay,
  buildPhaseCFallbackSourcesSectionHtml,
  hasArchivedLinkContent,
  isNonEducationalSpamUrl,
  isDeadPhaseCFallbackUrl,
  isValidPhaseCExternalUrl,
  isHistoryZionismTopicContext,
  violatesPedagogicalTopicContext,
  isPinterestPhaseCUrl,
  shouldBypassTopicMasterCache,
};
