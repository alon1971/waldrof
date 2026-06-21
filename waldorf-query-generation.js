/**
 * Centralized query generation for Inspiration (Pinterest) and Resources (articles).
 * Shared by api/generate.js (Node), waldorf-web-seed.js, research-client.js, index.html.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WaldorfQueryGeneration = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PINTEREST_SEARCH_BASE = 'https://www.pinterest.com/search/pins/?q=';
  var GOOGLE_SEARCH_BASE = 'https://www.google.com/search?q=';

  var PINTEREST_WALDORF_ANCHORS = [
    'waldorf', 'steiner', 'main lesson', 'form drawing', 'blackboard',
  ];

  var ARTICLE_PEDAGOGY_ANCHORS = ['וולדורף', 'חינוך וולדורף', 'Main Lesson', 'פדגוגיה'];

  var HEBREW_GRADE_LETTER_TO_NUM = {
    'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6, 'ז': 7, 'ח': 8, 'ט': 9,
    'י': 10, 'יא': 11, 'יב': 12,
  };

  var HEBREW_GRADE_NUM_TO_LETTER = {
    1: 'א', 2: 'ב', 3: 'ג', 4: 'ד', 5: 'ה', 6: 'ו', 7: 'ז', 8: 'ח', 9: 'ט',
    10: 'י', 11: 'יא', 12: 'יב',
  };

  var GRADE_LABEL_BY_ID = {
    '1': 'כיתה א׳', '2': 'כיתה ב׳', '3': 'כיתה ג׳', '4': 'כיתה ד׳',
    '5': 'כיתה ה׳', '6': 'כיתה ו׳', '7': 'כיתה ז׳', '8': 'כיתה ח׳',
  };

  /** Hardcoded grade-to-topic ownership — mirrors api/pedagogical-scope.js CURRICULUM_BLOCKS. */
  var GRADE_TOPIC_BLOCKS = [
    {
      gradeId: '1',
      blockLabel: 'אגדות וסיפורי טבע',
      aliases: [
        'אגדות', 'אגדה', 'סיפורי פיות', 'פיות', 'סיפורי טבע',
        'fairy tale', 'fairy tales', 'nature stories',
      ],
    },
    {
      gradeId: '2',
      blockLabel: 'משלי חיות וסיפורי צדיקים',
      aliases: [
        'משלי חיות', 'משל חיות', 'fables', 'animal fables',
        'סיפורי צדיקים', 'צדיקים', 'saints', 'saint stories',
      ],
    },
    {
      gradeId: '3',
      blockLabel: 'תנ״ך וחקלאות',
      aliases: [
        'תנ״ך', 'תנך', 'מקרא', 'בראשית', 'נח', 'אברהם', 'משה',
        'חקלאות', 'בית בנין', 'בניית בית', 'בנייה', 'construction', 'house building',
        'old testament', 'bible stories', 'farming', 'agriculture',
      ],
    },
    {
      gradeId: '4',
      blockLabel: 'מיתולוגיה נורדית',
      aliases: [
        'נורדית', 'נורד', 'נורדים', 'אסגארד', 'אודין', 'תור', 'thor', 'odin',
        'norse', 'norse mythology', 'גיאוגרפיה מקומית', 'local geography',
      ],
    },
    {
      gradeId: '5',
      blockLabel: 'יוון העתיקה',
      aliases: [
        'יוון', 'יוון העתיקה', 'מיתולוגיה יוונית', 'יוונית', 'הומרוס', 'הומר',
        'מסעות אודיסאוס', 'אודיסאוס', 'אודיסיאה', 'odysseus', 'odyssey',
        'greek mythology', 'ancient greece',
      ],
    },
    {
      gradeId: '5',
      blockLabel: 'בוטניקה',
      aliases: ['בוטניקה', 'צמחים', 'botany', 'plants'],
    },
    {
      gradeId: '6',
      blockLabel: 'רומא וימי ביניים',
      aliases: [
        'רומא', 'רומאית', 'rome', 'roman', 'roman history',
        'ימי ביניים', 'medieval', 'middle ages',
        'גיאולוגיה', 'geology', 'mineralogy',
      ],
    },
    {
      gradeId: '7',
      blockLabel: 'מגלי עולם ורנסנס',
      aliases: [
        'מגלי עולם', 'מגלים', 'גילוי העולם', 'age of exploration', 'explorers',
        'רנסנס', 'renaissance', 'גלילאו', 'galileo', 'פיזיקה', 'physics', 'astronomy',
      ],
    },
    {
      gradeId: '8',
      blockLabel: 'מהפכות והיסטוריה מודרנית',
      aliases: [
        'מהפכה', 'מהפכות', 'מהפכה צרפתית', 'המהפכה הצרפתית', 'revolution', 'revolutions',
        'כימיה אורגנית', 'organic chemistry', 'היסטוריה מודרנית', 'modern history',
      ],
    },
  ];

  /** Hebrew / niche Waldorf phrases → clean English Pinterest keywords (unquoted). */
  var HEBREW_TOPIC_ENGLISH_MAP = [
    { pattern: /מהפכה|מהפכות|revolution/i, en: 'revolutions' },
    { pattern: /בני(?:י)?ת\s*בית|בית\s*בנין|תקופת\s*בנייה|house\s*building/i, en: 'house building main lesson' },
    { pattern: /חקלאות|farming|agriculture/i, en: 'farming agriculture' },
    { pattern: /רישום\s*צורה|form\s*drawing/i, en: 'form drawing' },
    { pattern: /מחבר(?:ת|ות)\s*תקופה|main\s*lesson\s*book/i, en: 'main lesson book' },
    { pattern: /ציור\s*גיר|blackboard|chalkboard/i, en: 'blackboard drawing' },
    { pattern: /נורדית|norse/i, en: 'norse mythology' },
    { pattern: /יוון|greek|אודיסאוס|odysseus/i, en: 'ancient greece mythology' },
    { pattern: /רומא|rome|roman/i, en: 'rome history' },
    { pattern: /רנסנס|renaissance/i, en: 'renaissance' },
    { pattern: /מגלי\s*עולם|explorers|exploration/i, en: 'age of exploration' },
    { pattern: /בוטניקה|botany|plants/i, en: 'botany plants' },
    { pattern: /גיאולוגיה|geology/i, en: 'geology' },
    { pattern: /כימיה|chemistry/i, en: 'chemistry' },
    { pattern: /תנ״ך|תנך|מקרא|bible/i, en: 'old testament stories' },
    { pattern: /אגדות|fairy\s*tale/i, en: 'fairy tales' },
    { pattern: /משלי\s*חיות|fables/i, en: 'animal fables' },
    { pattern: /צדיקים|saints/i, en: 'saint stories' },
    { pattern: /חשבון|מתמטיקה|math|arithmetic/i, en: 'math lesson' },
  ];

  var ISRAELI_WALDORF_ARTICLE_DOMAINS = [
    'waldorf.org.il',
    'harduf-waldorf.org.il',
    'shakedwaldorf.org.il',
    'adamolam.co.il',
  ];

  function stableNormalize(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function stripGradePhrases(text) {
    return String(text || '')
      .replace(/(?:^|\s)(?:ו|ב|ל|ש)?כיתה\s+[א-ת\d]{1,2}['׳"]?(?:\s|$)/gi, ' ')
      .replace(/(?:grade|class|waldorf\s+class)\s*\d{1,2}/gi, ' ')
      .replace(/["'«»""]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function containsHebrewText(text) {
    return /[\u0590-\u05FF]/.test(String(text || ''));
  }

  function parseGradeNumberFromToken(token) {
    if (!token) return null;
    var t = String(token).trim().replace(/['׳"]/g, '');
    if (/^\d{1,2}$/.test(t)) return parseInt(t, 10);
    if (HEBREW_GRADE_LETTER_TO_NUM[t]) return HEBREW_GRADE_LETTER_TO_NUM[t];
    return null;
  }

  function activeGradeNumber(body) {
    var id = String((body && (body.currentGrade ?? body.gradeId)) || '').trim();
    var n = parseInt(id, 10);
    return n >= 1 && n <= 12 ? n : null;
  }

  function hebrewGradeLabelForId(gradeId) {
    var n = parseInt(String(gradeId || ''), 10);
    var letter = HEBREW_GRADE_NUM_TO_LETTER[n];
    return letter ? ('כיתה ' + letter) : (GRADE_LABEL_BY_ID[String(gradeId)] || '');
  }

  function extractGradeNumbersFromText(text) {
    var src = String(text || '');
    var nums = [];
    var match;
    var reHe = /כיתה\s*([א-ת]{1,2})['׳"]?/gi;
    while ((match = reHe.exec(src)) !== null) {
      var heNum = parseGradeNumberFromToken(match[1]);
      if (heNum) nums.push(heNum);
    }
    var reEn = /(?:grade|class|waldorf\s+class)\s*(\d{1,2})/gi;
    while ((match = reEn.exec(src)) !== null) {
      var enNum = parseInt(match[1], 10);
      if (enNum >= 1 && enNum <= 12) nums.push(enNum);
    }
    return nums;
  }

  function topicTextMatchesAlias(textNorm, alias) {
    var aliasNorm = stableNormalize(alias);
    if (!aliasNorm || !textNorm) return false;
    if (textNorm === aliasNorm) return true;
    if (aliasNorm.length >= 3 && textNorm.indexOf(aliasNorm) >= 0) return true;
    if (textNorm.length >= 4 && aliasNorm.indexOf(textNorm) >= 0) return true;
    return false;
  }

  function findCurriculumBlockForTopic(topicText) {
    var cleaned = stripGradePhrases(topicText);
    var norm = stableNormalize(cleaned);
    if (!norm || norm.length < 2) return null;

    var best = null;
    var bestAliasLen = 0;
    for (var i = 0; i < GRADE_TOPIC_BLOCKS.length; i++) {
      var block = GRADE_TOPIC_BLOCKS[i];
      for (var j = 0; j < block.aliases.length; j++) {
        var alias = block.aliases[j];
        if (!topicTextMatchesAlias(norm, alias)) continue;
        var aliasLen = stableNormalize(alias).length;
        if (!best || aliasLen > bestAliasLen) {
          best = block;
          bestAliasLen = aliasLen;
        }
      }
    }
    return best;
  }

  /**
   * @returns {null|object} mismatch when topic does not belong to gradeId
   */
  function validateGradeTopicScope(gradeId, topicText) {
    var gid = String(gradeId || '').trim();
    var topic = String(topicText || '').trim();
    if (!gid || !topic) return null;

    var block = findCurriculumBlockForTopic(topic);
    if (!block || block.gradeId === gid) return null;

    return {
      requestedTopicRaw: topic,
      currentGradeId: gid,
      currentGradeLabel: GRADE_LABEL_BY_ID[gid] || ('כיתה ' + gid),
      canonicalGradeId: block.gradeId,
      canonicalGradeLabel: GRADE_LABEL_BY_ID[block.gradeId] || ('כיתה ' + block.gradeId),
      blockLabel: block.blockLabel,
    };
  }

  function hasMismatchedGradeInText(text, body) {
    var active = activeGradeNumber(body);
    if (!active) return false;
    return extractGradeNumbersFromText(text).some(function (n) { return n !== active; });
  }

  function hasWaldorfPedagogyAnchor(text) {
    var lc = String(text || '').toLowerCase();
    return PINTEREST_WALDORF_ANCHORS.some(function (anchor) {
      return lc.indexOf(anchor.toLowerCase()) !== -1;
    }) || /\bwaldorf\b/i.test(lc);
  }

  function hasActiveGradeAnchor(text, body) {
    var gradeNum = activeGradeNumber(body);
    if (!gradeNum) return true;
    var src = String(text || '');
    if (extractGradeNumbersFromText(src).indexOf(gradeNum) !== -1) return true;
    if (new RegExp('(?:grade|class|waldorf\\s+class)\\s*' + gradeNum + '\\b', 'i').test(src)) return true;
    return false;
  }

  function stripQuotes(text) {
    return String(text || '')
      .replace(/["'«»""]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function shortenTopicCore(raw) {
    var text = stripQuotes(stripGradePhrases(raw));
    if (!text) return '';
    var parts = text.split(/\s*[—–\-|]\s*/).map(function (p) { return p.trim(); }).filter(Boolean);
    if (parts.length > 1) {
      parts.sort(function (a, b) { return a.length - b.length; });
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].length >= 2 && parts[i].length <= 28) return parts[i];
      }
    }
    return text.split(/\s+/).slice(0, 4).join(' ');
  }

  function translateTopicToEnglish(topicText) {
    var raw = stripQuotes(stripGradePhrases(topicText));
    if (!raw) return '';

    for (var i = 0; i < HEBREW_TOPIC_ENGLISH_MAP.length; i++) {
      var entry = HEBREW_TOPIC_ENGLISH_MAP[i];
      if (entry.pattern.test(raw)) return entry.en;
    }

    if (!containsHebrewText(raw)) {
      return raw
        .replace(/\b(?:וולדורף|ולדורף|waldorf|steiner)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .slice(0, 4)
        .join(' ');
    }

    return shortenTopicCore(raw)
      .replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function appendArticlePedagogyAnchors(parts) {
    var list = Array.isArray(parts) ? parts.slice() : [parts];
    ARTICLE_PEDAGOGY_ANCHORS.forEach(function (anchor) {
      var lc = list.join(' ').toLowerCase();
      if (lc.indexOf(anchor.toLowerCase()) === -1) list.push(anchor);
    });
    return list.filter(Boolean);
  }

  /**
   * Build clean, unquoted English Pinterest search phrase.
   * Template: Waldorf Class {grade} {englishTopic}
   */
  function buildPinterestSearchQuery(rawPin, topic, body) {
    var gradeId = String((body && (body.currentGrade ?? body.gradeId)) || '').trim();
    if (!gradeId) return '';

    var topicForScope = String(topic || rawPin || '').trim();
    if (validateGradeTopicScope(gradeId, topicForScope)) return '';

    var source = stripQuotes(String(rawPin || topic || '').trim());
    var englishTopic = translateTopicToEnglish(source || topic);
    if (!englishTopic) englishTopic = translateTopicToEnglish(topic);
    if (!englishTopic) return '';

    englishTopic = englishTopic
      .replace(/\b(?:וולדורף|ולדורף|waldorf|steiner|class|grade)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join(' ');

    if (!englishTopic) return '';

    var query = ('Waldorf Class ' + gradeId + ' ' + englishTopic).replace(/\s+/g, ' ').trim();
    if (hasMismatchedGradeInText(query, body)) return '';
    return query;
  }

  function buildPinterestSearchUrl(query) {
    var q = String(query || '').trim();
    if (!q || !hasWaldorfPedagogyAnchor(q)) return '';
    return PINTEREST_SEARCH_BASE + encodeURIComponent(q);
  }

  function buildPinterestSearchUrlFromParts(rawPin, topic, body) {
    var query = buildPinterestSearchQuery(rawPin, topic, body);
    if (!query) return '';
    return buildPinterestSearchUrl(query);
  }

  /**
   * Google site-restricted article search — never emits direct Waldorf domain paths.
   * Template: site:domain1 OR site:domain2 "{topic}" כיתה {grade} וולדורף Main Lesson
   */
  function buildArticleGoogleSearchQuery(topic, gradeLabel, options) {
    options = options || {};
    var t = String(topic || '').trim();
    var grade = String(gradeLabel || '').trim();
    if (!t) return '';

    var domains = options.domains || ISRAELI_WALDORF_ARTICLE_DOMAINS;
    var siteClause = domains.map(function (d) { return 'site:' + d; }).join(' OR ');

    var parts = appendArticlePedagogyAnchors([
      siteClause,
      '"' + stripQuotes(t) + '"',
      grade,
    ]);

    return parts.filter(Boolean).join(' ');
  }

  function buildArticleGoogleSearchUrl(topic, gradeLabel, options) {
    var query = buildArticleGoogleSearchQuery(topic, gradeLabel, options);
    if (!query) return '';
    return GOOGLE_SEARCH_BASE + encodeURIComponent(query);
  }

  function buildPerDomainArticleSearchUrl(domain, topic, gradeLabel) {
    return buildArticleGoogleSearchUrl(topic, gradeLabel, { domains: [domain] });
  }

  function pinterestItemText(item) {
    if (!item) return '';
    return [item.board, item.title, item.pin, item.url, item.src].filter(Boolean).join(' ');
  }

  function passesStrictPinterestItemFilter(item, body) {
    var blob = pinterestItemText(item);
    if (!blob) return false;
    if (hasMismatchedGradeInText(blob, body)) return false;
    if (!hasWaldorfPedagogyAnchor(blob)) return false;
    if (!hasActiveGradeAnchor(blob, body)) return false;
    var gradeId = String((body && (body.currentGrade ?? body.gradeId)) || '').trim();
    if (gradeId && validateGradeTopicScope(gradeId, body.topic || item.pin || item.title)) return false;
    if (/["'«»]/.test(String(item.pin || '')) && containsHebrewText(item.pin)) return false;
    return true;
  }

  function sanitizePinterestGalleryItem(item, body, topic) {
    if (!item || typeof item !== 'object') return null;
    var gradeId = String((body && (body.currentGrade ?? body.gradeId)) || '').trim();
    if (gradeId && validateGradeTopicScope(gradeId, topic)) return null;
    if (hasMismatchedGradeInText(pinterestItemText(item), body)) return null;

    var pin = buildPinterestSearchQuery(item.pin || item.title || '', topic, body);
    if (!pin) return null;

    var sanitized = {
      board: String(item.board || item.title || 'השראה ויזואלית').trim(),
      title: String(item.title || item.board || pin).trim(),
      pin: pin,
      src: String(item.src || '').trim(),
      url: '',
    };

    if (!passesStrictPinterestItemFilter(sanitized, body)) return null;
    sanitized.url = buildPinterestSearchUrl(pin);
    if (!sanitized.url) return null;
    return sanitized;
  }

  function sanitizePinterestGallery(gallery, body, maxItems) {
    maxItems = maxItems != null ? maxItems : 4;
    var topic = String((body && body.topic) || '').trim();
    var gradeId = String((body && (body.currentGrade ?? body.gradeId)) || '').trim();
    if (gradeId && validateGradeTopicScope(gradeId, topic)) return [];

    var seen = Object.create(null);
    var out = [];
    (Array.isArray(gallery) ? gallery : []).forEach(function (item) {
      var sanitized = sanitizePinterestGalleryItem(item, body, topic);
      if (!sanitized) return;
      var key = String(sanitized.pin || '').toLowerCase().trim();
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(sanitized);
    });
    return out.slice(0, maxItems);
  }

  function isIsraeliWaldorfDomain(url) {
    var u = String(url || '').toLowerCase();
    return ISRAELI_WALDORF_ARTICLE_DOMAINS.some(function (d) {
      return u.indexOf(d) >= 0;
    });
  }

  function shouldForceArticleSearchRedirect(url) {
    if (!url) return false;
    if (/google\.com\/search/i.test(url)) return false;
    return isIsraeliWaldorfDomain(url);
  }

  return {
    PINTEREST_SEARCH_BASE: PINTEREST_SEARCH_BASE,
    GOOGLE_SEARCH_BASE: GOOGLE_SEARCH_BASE,
    GRADE_TOPIC_BLOCKS: GRADE_TOPIC_BLOCKS,
    ISRAELI_WALDORF_ARTICLE_DOMAINS: ISRAELI_WALDORF_ARTICLE_DOMAINS,
    PINTEREST_MAX_GALLERY_ITEMS: 4,
    validateGradeTopicScope: validateGradeTopicScope,
    findCurriculumBlockForTopic: findCurriculumBlockForTopic,
    translateTopicToEnglish: translateTopicToEnglish,
    buildPinterestSearchQuery: buildPinterestSearchQuery,
    buildStrictPinterestQuery: buildPinterestSearchQuery,
    buildPinterestSearchUrl: buildPinterestSearchUrl,
    buildPinterestSearchUrlFromParts: buildPinterestSearchUrlFromParts,
    buildArticleGoogleSearchQuery: buildArticleGoogleSearchQuery,
    buildArticleGoogleSearchUrl: buildArticleGoogleSearchUrl,
    buildPerDomainArticleSearchUrl: buildPerDomainArticleSearchUrl,
    appendArticlePedagogyAnchors: appendArticlePedagogyAnchors,
    sanitizePinterestGallery: sanitizePinterestGallery,
    sanitizePinterestGalleryItem: sanitizePinterestGalleryItem,
    passesStrictPinterestItemFilter: passesStrictPinterestItemFilter,
    hasMismatchedGradeInText: hasMismatchedGradeInText,
    hasWaldorfPedagogyAnchor: hasWaldorfPedagogyAnchor,
    hebrewGradeLabelForId: hebrewGradeLabelForId,
    shouldForceArticleSearchRedirect: shouldForceArticleSearchRedirect,
    isIsraeliWaldorfDomain: isIsraeliWaldorfDomain,
    pinterestItemText: pinterestItemText,
  };
}));
