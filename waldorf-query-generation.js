/**
 * Centralized query generation for Inspiration (Pinterest) and Resources (articles).
 * Design rules:
 *  - Article site: searches = ONE domain, Hebrew-only terms, no English, no exact-quote phrases.
 *  - Pinterest = topic keywords FIRST, then Waldorf; never generic notebook/form-drawing clutter.
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

  var GRADE_TOPIC_BLOCKS = [
    { gradeId: '1', blockLabel: 'אגדות וסיפורי טבע', aliases: ['אגדות', 'אגדה', 'סיפורי פיות', 'פיות', 'סיפורי טבע', 'fairy tale', 'fairy tales', 'nature stories'] },
    { gradeId: '2', blockLabel: 'משלי חיות וסיפורי צדיקים', aliases: ['משלי חיות', 'משל חיות', 'fables', 'animal fables', 'סיפורי צדיקים', 'צדיקים', 'saints', 'saint stories'] },
    { gradeId: '3', blockLabel: 'תנ״ך וחקלאות', aliases: ['תנ״ך', 'תנך', 'מקרא', 'בראשית', 'נח', 'חקלאות', 'בית בנין', 'בניית בית', 'בנייה', 'construction', 'house building', 'old testament', 'bible stories', 'farming', 'agriculture'] },
    { gradeId: '4', blockLabel: 'מיתולוגיה נורדית', aliases: ['נורדית', 'נורד', 'נורדים', 'אסגארד', 'אודין', 'תור', 'thor', 'odin', 'norse', 'norse mythology', 'גיאוגרפיה מקומית', 'local geography'] },
    { gradeId: '5', blockLabel: 'יוון העתיקה', aliases: ['יוון', 'יוון העתיקה', 'מיתולוגיה יוונית', 'יוונית', 'הומרוס', 'הומר', 'מסעות אודיסאוס', 'אודיסאוס', 'אודיסיאה', 'odysseus', 'odyssey', 'greek mythology', 'ancient greece'] },
    { gradeId: '5', blockLabel: 'בוטניקה', aliases: ['בוטניקה', 'צמחים', 'botany', 'plants'] },
    { gradeId: '6', blockLabel: 'רומא וימי ביניים', aliases: ['רומא', 'רומאית', 'rome', 'roman', 'roman history', 'ימי ביניים', 'medieval', 'middle ages', 'גיאולוגיה', 'geology', 'mineralogy'] },
    { gradeId: '7', blockLabel: 'מגלי עולם ורנסנס', aliases: ['מגלי עולם', 'מגלים', 'גילוי העולם', 'age of exploration', 'explorers', 'רנסנס', 'renaissance', 'גלילאו', 'galileo', 'פיזיקה', 'physics', 'astronomy'] },
    { gradeId: '8', blockLabel: 'מהפכות והיסטוריה מודרנית', aliases: ['מהפכה', 'מהפכות', 'מהפכה צרפתית', 'המהפכה הצרפתית', 'revolution', 'revolutions', 'french revolution', 'כימיה אורגנית', 'organic chemistry', 'היסטוריה מודרנית', 'modern history'] },
  ];

  /** Topic → Pinterest English (topic-first) + article Hebrew cores. */
  var TOPIC_LEXICON = [
    { pattern: /מהפכה|מהפכות|revolution/i, pinterest: ['revolutions', 'French Revolution'], articleHe: ['מהפכות', 'מהפכה צרפתית'], displayHe: 'מהפכות' },
    { pattern: /בני(?:י)?ת\s*בית|בית\s*בנין|תקופת\s*בנייה|house\s*building/i, pinterest: ['house building', 'Waldorf building'], articleHe: ['בניית בית', 'תקופת בנייה'], displayHe: 'בניית בית' },
    { pattern: /חקלאות|farming|agriculture/i, pinterest: ['farming', 'agriculture'], articleHe: ['חקלאות'], displayHe: 'חקלאות' },
    { pattern: /רישום\s*צורה|form\s*drawing/i, pinterest: ['form drawing'], articleHe: ['רישום צורה'], displayHe: 'רישום צורה' },
    { pattern: /מחבר(?:ת|ות)\s*תקופה|main\s*lesson\s*book/i, pinterest: ['main lesson book'], articleHe: ['מחברת תקופה'], displayHe: 'מחברת תקופה' },
    { pattern: /ציור\s*גיר|blackboard|chalkboard/i, pinterest: ['chalkboard drawing'], articleHe: ['ציור גיר'], displayHe: 'ציור גיר' },
    { pattern: /נורדית|norse/i, pinterest: ['Norse mythology'], articleHe: ['מיתולוגיה נורדית', 'נורדית'], displayHe: 'מיתולוגיה נורדית' },
    { pattern: /יוון|greek|אודיסאוס|odysseus/i, pinterest: ['ancient Greece', 'Greek mythology'], articleHe: ['יוון העתיקה', 'מיתולוגיה יוונית'], displayHe: 'יוון העתיקה' },
    { pattern: /רומא|rome|roman/i, pinterest: ['Roman history'], articleHe: ['רומא', 'היסטוריה רומית'], displayHe: 'רומא' },
    { pattern: /רנסנס|renaissance/i, pinterest: ['Renaissance'], articleHe: ['רנסנס'], displayHe: 'רנסנס' },
    { pattern: /מגלי\s*עולם|explorers|exploration/i, pinterest: ['Age of Exploration'], articleHe: ['מגלי עולם'], displayHe: 'מגלי עולם' },
    { pattern: /בוטניקה|botany|plants/i, pinterest: ['botany'], articleHe: ['בוטניקה'], displayHe: 'בוטניקה' },
    { pattern: /גיאולוגיה|geology/i, pinterest: ['geology'], articleHe: ['גיאולוגיה'], displayHe: 'גיאולוגיה' },
    { pattern: /כימיה|chemistry/i, pinterest: ['chemistry'], articleHe: ['כימיה'], displayHe: 'כימיה' },
    { pattern: /תנ״ך|תנך|מקרא|bible/i, pinterest: ['Old Testament stories'], articleHe: ['תנ״ך', 'סיפורי מקרא'], displayHe: 'תנ״ך' },
    { pattern: /אגדות|fairy\s*tale/i, pinterest: ['fairy tales'], articleHe: ['אגדות'], displayHe: 'אגדות' },
    { pattern: /משלי\s*חיות|fables/i, pinterest: ['animal fables'], articleHe: ['משלי חיות'], displayHe: 'משלי חיות' },
    { pattern: /צדיקים|saints/i, pinterest: ['saint stories'], articleHe: ['סיפורי צדיקים'], displayHe: 'סיפורי צדיקים' },
    { pattern: /חשבון|מתמטיקה|math|arithmetic/i, pinterest: ['math lesson'], articleHe: ['חשבון'], displayHe: 'חשבון' },
  ];

  var GENERIC_PINTEREST_CLUTTER = [
    /main\s*lesson\s*book/i, /form\s*drawing/i, /chalkboard/i, /blackboard/i,
    /מחברת\s*תקופה/i, /מחברות\s*תקופה/i, /רישום\s*צורה/i, /ציור\s*גיר/i,
    /epoch\s*book/i, /block\s*book/i,
  ];

  var ISRAELI_WALDORF_ARTICLE_DOMAINS = [
    'waldorf.org.il',
    'harduf-waldorf.org.il',
    'shakedwaldorf.org.il',
    'adamolam.co.il',
  ];

  var ISRAELI_WALDORF_SEED_SOURCES = [
    { id: 'waldorf_forum', domain: 'waldorf.org.il', source: 'הפורום לחינוך וולדורף בישראל', label: 'מקור וולדורף רשמי' },
    { id: 'adam_olam', domain: 'adamolam.co.il', source: 'מגזין אדם עולם', label: 'כתב עת פדגוגי' },
    { id: 'shaked', domain: 'shakedwaldorf.org.il', source: 'בית ספר שקד קריית טבעון', label: 'מערך שיעור מאתר בית ספר' },
    { id: 'harduf', domain: 'harduf-waldorf.org.il', source: 'בית ספר ולדורף הרדוף', label: 'מערך שיעור מאתר בית ספר' },
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

  function stripQuotes(text) {
    return String(text || '').replace(/["'«»""]/g, ' ').replace(/\s+/g, ' ').trim();
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

  function resolveTopicLexicon(topicText) {
    var raw = stripQuotes(stripGradePhrases(topicText));
    if (!raw) return null;
    for (var i = 0; i < TOPIC_LEXICON.length; i++) {
      if (TOPIC_LEXICON[i].pattern.test(raw)) return TOPIC_LEXICON[i];
    }
    return null;
  }

  /**
   * Core searchable terms — short, realistic, no definite-article lock-in.
   */
  function extractTopicProfile(topicText) {
    var raw = stripQuotes(stripGradePhrases(topicText));
    var lex = resolveTopicLexicon(raw);
    if (lex) {
      return {
        displayHe: lex.displayHe,
        articleHe: lex.articleHe.slice(),
        pinterestEn: lex.pinterest.slice(),
        raw: raw,
      };
    }
    var heWords = [];
    if (containsHebrewText(raw)) {
      raw.split(/\s+/).forEach(function (w) {
        var word = w.replace(/^ה/, '').trim();
        if (word.length >= 2) heWords.push(word);
      });
      if (!heWords.length) heWords.push(raw.replace(/^ה/, '').trim());
    }
    var enWords = raw
      .replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ')
      .replace(/\b(?:וולדורף|ולדורף|waldorf|steiner)\b/gi, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);
    return {
      displayHe: heWords[0] || raw.slice(0, 24),
      articleHe: heWords.length ? heWords.slice(0, 2) : [raw.slice(0, 20)],
      pinterestEn: enWords.length ? enWords : ['Waldorf lesson'],
      raw: raw,
    };
  }

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

  function pinContainsTopicFocus(pin, topic) {
    var profile = extractTopicProfile(topic);
    var blob = stableNormalize(pin);
    if (!blob) return false;
    var hit = false;
    profile.pinterestEn.forEach(function (term) {
      if (stableNormalize(term).length >= 3 && blob.indexOf(stableNormalize(term)) >= 0) hit = true;
    });
    profile.articleHe.forEach(function (term) {
      if (stableNormalize(term).length >= 2 && blob.indexOf(stableNormalize(term)) >= 0) hit = true;
    });
    if (!hit && profile.raw.length >= 3) {
      var rawNorm = stableNormalize(profile.raw);
      if (blob.indexOf(rawNorm) >= 0) hit = true;
    }
    return hit;
  }

  function isGenericPinterestClutter(text) {
    var s = String(text || '');
    return GENERIC_PINTEREST_CLUTTER.some(function (re) { return re.test(s); });
  }

  function hasWaldorfPedagogyAnchor(text) {
    return /\bwaldorf\b/i.test(String(text || '')) ||
      /וולדורף|ולדורף/i.test(String(text || ''));
  }

  function joinQueryTokens(tokens, max) {
    var seen = Object.create(null);
    var out = [];
    (tokens || []).forEach(function (tok) {
      var t = String(tok || '').trim();
      if (!t) return;
      var key = stableNormalize(t);
      if (seen[key]) return;
      seen[key] = true;
      out.push(t);
    });
    return out.slice(0, max || 5).join(' ');
  }

  /**
   * Pinterest: topic-first English query. Primary topic words come BEFORE Waldorf.
   * Example: "revolutions French Revolution Waldorf"
   */
  function buildPinterestSearchQuery(rawPin, topic, body) {
    var gradeId = String((body && (body.currentGrade ?? body.gradeId)) || '').trim();
    var topicStr = String(topic || rawPin || '').trim();
    if (!topicStr) return '';
    if (gradeId && validateGradeTopicScope(gradeId, topicStr)) return '';

    var profile = extractTopicProfile(topicStr);
    var source = stripQuotes(String(rawPin || '').trim());
    if (source && !containsHebrewText(source) && !isGenericPinterestClutter(source) &&
        pinContainsTopicFocus(source, topicStr)) {
      if (!hasWaldorfPedagogyAnchor(source)) source = source + ' Waldorf';
      return joinQueryTokens(source.split(/\s+/), 5);
    }

    var tokens = profile.pinterestEn.slice();
    if (gradeId) tokens.push('grade ' + gradeId);
    tokens.push('Waldorf');
    return joinQueryTokens(tokens, 5);
  }

  function buildPinterestSearchUrl(query) {
    var q = String(query || '').trim();
    if (!q) return '';
    return PINTEREST_SEARCH_BASE + encodeURIComponent(q);
  }

  function buildPinterestSearchUrlFromParts(rawPin, topic, body) {
    var query = buildPinterestSearchQuery(rawPin, topic, body);
    return query ? buildPinterestSearchUrl(query) : '';
  }

  /**
   * Build 2–4 topic-centric gallery entries (no generic notebook clutter).
   */
  function buildPinterestGalleryForTopic(topic, body) {
    body = body || {};
    var topicStr = String(topic || body.topic || '').trim();
    var gradeId = String(body.currentGrade ?? body.gradeId ?? '').trim();
    if (!topicStr) return [];
    if (gradeId && validateGradeTopicScope(gradeId, topicStr)) return [];

    var profile = extractTopicProfile(topicStr);
    var display = profile.displayHe || topicStr;
    var variants = [];
    var seen = Object.create(null);

    function pushVariant(board, title, pinTokens) {
      var pin = joinQueryTokens(pinTokens, 5);
      if (!pin || isGenericPinterestClutter(pin)) return;
      if (!pinContainsTopicFocus(pin, topicStr)) return;
      var key = stableNormalize(pin);
      if (seen[key]) return;
      seen[key] = true;
      var url = buildPinterestSearchUrl(pin);
      if (!url) return;
      variants.push({ board: board, title: title, pin: pin, url: url, src: '' });
    }

    pushVariant(
      'נושא התקופה',
      display + ' — השראה ויזואלית',
      profile.pinterestEn.concat(['Waldorf', 'main lesson'])
    );
    if (gradeId) {
      pushVariant(
        'כיתה ' + gradeId,
        display + ' — כיתה ' + gradeId,
        profile.pinterestEn.concat(['Waldorf', 'grade ' + gradeId])
      );
    }
    pushVariant(
      'היסטוריה וולדורפית',
      display,
      profile.pinterestEn.concat(['Waldorf', 'history', 'lesson'])
    );

    return variants.slice(0, 4);
  }

  /**
   * Article Google search — ONE domain, Hebrew-only, short, realistic.
   * Example: site:harduf-waldorf.org.il מהפכות וולדורף
   */
  function buildArticleGoogleSearchQuery(topic, gradeLabel, options) {
    options = options || {};
    var profile = extractTopicProfile(topic);
    var domains = options.domains || ISRAELI_WALDORF_ARTICLE_DOMAINS;
    var domain = String((domains && domains[0]) || '').trim();
    if (!domain) return '';

    var primaryHe = profile.articleHe[0] || profile.displayHe || stripQuotes(topic);
    var tokens = ['site:' + domain, primaryHe, 'וולדורף'];

    return joinQueryTokens(tokens, 4);
  }

  function buildArticleGoogleSearchUrl(topic, gradeLabel, options) {
    var query = buildArticleGoogleSearchQuery(topic, gradeLabel, options);
    if (!query) return '';
    return GOOGLE_SEARCH_BASE + encodeURIComponent(query);
  }

  function buildPerDomainArticleSearchUrl(domain, topic, gradeLabel) {
    return buildArticleGoogleSearchUrl(topic, gradeLabel, { domains: [domain] });
  }

  /** Fallback resource rows — one simple Hebrew search per Israeli Waldorf source. */
  function buildWebInspirationFallbackResources(topic, gradeLabel) {
    var profile = extractTopicProfile(topic);
    var display = profile.displayHe || String(topic || '').trim() || 'וולדורף';
    var grade = String(gradeLabel || '').trim();
    var out = [];
    var seen = Object.create(null);

    ISRAELI_WALDORF_SEED_SOURCES.forEach(function (seed) {
      var url = buildPerDomainArticleSearchUrl(seed.domain, topic, gradeLabel);
      if (!url || seen[url]) return;
      seen[url] = true;
      out.push({
        title: seed.source + ' — ' + display,
        url: url,
        label: seed.label,
        source: seed.source,
        snippet: grade
          ? ('חיפוש: ' + display + ' · ' + grade)
          : ('חיפוש: ' + display),
        _fallback: true,
        _safeSearch: true,
      });
    });
    return out;
  }

  function pinterestItemText(item) {
    if (!item) return '';
    return [item.board, item.title, item.pin, item.url, item.src].filter(Boolean).join(' ');
  }

  function passesStrictPinterestItemFilter(item, body) {
    var blob = pinterestItemText(item);
    if (!blob) return false;
    if (hasMismatchedGradeInText(blob, body)) return false;
    if (isGenericPinterestClutter(blob)) return false;
    var topic = String((body && body.topic) || '').trim();
    if (!topic) return false;
    if (!pinContainsTopicFocus(blob, topic)) return false;
    if (!hasWaldorfPedagogyAnchor(blob) && !/\bgrade\s*\d\b/i.test(blob)) return false;
    return true;
  }

  function sanitizePinterestGalleryItem(item, body, topic) {
    if (!item || typeof item !== 'object') return null;
    var topicStr = String(topic || (body && body.topic) || '').trim();
    var gradeId = String((body && (body.currentGrade ?? body.gradeId)) || '').trim();
    if (gradeId && validateGradeTopicScope(gradeId, topicStr)) return null;
    if (isGenericPinterestClutter(pinterestItemText(item))) return null;

    var pin = buildPinterestSearchQuery(item.pin || item.title || '', topicStr, body);
    if (!pin || !pinContainsTopicFocus(pin, topicStr)) return null;

    var sanitized = {
      board: String(item.board || item.title || 'השראה ויזואלית').trim(),
      title: String(item.title || item.board || pin).trim(),
      pin: pin,
      src: String(item.src || '').trim(),
      url: buildPinterestSearchUrl(pin),
    };
    if (!passesStrictPinterestItemFilter(sanitized, Object.assign({}, body, { topic: topicStr }))) return null;
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
      var key = stableNormalize(sanitized.pin);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(sanitized);
    });

    if (!out.length && topic) {
      buildPinterestGalleryForTopic(topic, body).forEach(function (stub) {
        var key = stableNormalize(stub.pin);
        if (!key || seen[key]) return;
        seen[key] = true;
        out.push(stub);
      });
    }

    return out.slice(0, maxItems);
  }

  function isIsraeliWaldorfDomain(url) {
    var u = String(url || '').toLowerCase();
    return ISRAELI_WALDORF_ARTICLE_DOMAINS.some(function (d) { return u.indexOf(d) >= 0; });
  }

  function shouldForceArticleSearchRedirect(url) {
    if (!url) return false;
    if (/google\.com\/search/i.test(url)) return false;
    return isIsraeliWaldorfDomain(url);
  }

  function translateTopicToEnglish(topicText) {
    return extractTopicProfile(topicText).pinterestEn.join(' ');
  }

  function appendArticlePedagogyAnchors(parts) {
    var list = Array.isArray(parts) ? parts.slice() : [parts];
    if (list.join(' ').indexOf('וולדורף') === -1 && list.join(' ').indexOf('ולדורף') === -1) {
      list.push('וולדורף');
    }
    return list.filter(Boolean);
  }

  return {
    PINTEREST_SEARCH_BASE: PINTEREST_SEARCH_BASE,
    GOOGLE_SEARCH_BASE: GOOGLE_SEARCH_BASE,
    GRADE_TOPIC_BLOCKS: GRADE_TOPIC_BLOCKS,
    ISRAELI_WALDORF_ARTICLE_DOMAINS: ISRAELI_WALDORF_ARTICLE_DOMAINS,
    PINTEREST_MAX_GALLERY_ITEMS: 4,
    validateGradeTopicScope: validateGradeTopicScope,
    findCurriculumBlockForTopic: findCurriculumBlockForTopic,
    extractTopicProfile: extractTopicProfile,
    translateTopicToEnglish: translateTopicToEnglish,
    buildPinterestSearchQuery: buildPinterestSearchQuery,
    buildStrictPinterestQuery: buildPinterestSearchQuery,
    buildPinterestSearchUrl: buildPinterestSearchUrl,
    buildPinterestSearchUrlFromParts: buildPinterestSearchUrlFromParts,
    buildPinterestGalleryForTopic: buildPinterestGalleryForTopic,
    buildArticleGoogleSearchQuery: buildArticleGoogleSearchQuery,
    buildArticleGoogleSearchUrl: buildArticleGoogleSearchUrl,
    buildPerDomainArticleSearchUrl: buildPerDomainArticleSearchUrl,
    buildWebInspirationFallbackResources: buildWebInspirationFallbackResources,
    appendArticlePedagogyAnchors: appendArticlePedagogyAnchors,
    sanitizePinterestGallery: sanitizePinterestGallery,
    sanitizePinterestGalleryItem: sanitizePinterestGalleryItem,
    passesStrictPinterestItemFilter: passesStrictPinterestItemFilter,
    hasMismatchedGradeInText: hasMismatchedGradeInText,
    hasWaldorfPedagogyAnchor: hasWaldorfPedagogyAnchor,
    pinContainsTopicFocus: pinContainsTopicFocus,
    isGenericPinterestClutter: isGenericPinterestClutter,
    hebrewGradeLabelForId: hebrewGradeLabelForId,
    shouldForceArticleSearchRedirect: shouldForceArticleSearchRedirect,
    isIsraeliWaldorfDomain: isIsraeliWaldorfDomain,
    pinterestItemText: pinterestItemText,
  };
}));
