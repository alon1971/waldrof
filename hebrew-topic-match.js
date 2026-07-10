/**
 * Hebrew topic morphological / semantic matching for archive probe (step B).
 * Shared by api/cache.js (Node) and index.html (browser fallback).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WaldorfHebrewTopicMatch = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEBREW_TOPIC_STOP_WORDS = new Set([
    'לימוד', 'ללמוד', 'לימודי', 'לימודית', 'הוראת', 'הוראה', 'ללמד', 'מלמד', 'מלמדת',
    'שיעור', 'שיעורי', 'שיעורים', 'יחידת', 'יחידה', 'נושא', 'בנושא', 'בעניין', 'בנוגע', 'לנושא',
    'על', 'את', 'של', 'עם', 'או', 'גם', 'כי', 'אם', 'זה', 'זו', 'הוא', 'היא', 'הם', 'אני', 'אתה',
    'כיתה', 'שכבה', 'שכבת', 'גיל', 'לכיתה', 'בכיתה', 'בשכבה',
    'פעילות', 'פעילויות', 'עבודה', 'תרגול', 'תרגיל', 'תרגילים', 'משימה', 'משימות',
    'דרך', 'מתוך', 'איך', 'כיצד', 'מה', 'למה', 'מתי', 'איפה', 'כאן', 'שם',
    'תלמיד', 'תלמידים', 'תלמידה', 'ילדים', 'ילד', 'ילדה', 'מורה', 'המורה',
    'תקופה', 'תקופת', 'תקופות', 'בלוק', 'בלוקים', 'שלב', 'שלבים', 'פרק', 'פרקים',
    'ב', 'ל', 'מ', 'כ', 'ו', 'ש',
  ]);

  /**
   * Grade-scoped canonical archive lesson titles (step B semantic redirect).
   * Partial / morphological queries map to these titles for confirmation in chat.
   */
  var GRADE_CANONICAL_ARCHIVE_TOPICS = {
    '7': 'תקופת מגלי עולם',
  };

  var GRADE_LABEL_BY_ID = {
    '1': 'כיתה א׳',
    '2': 'כיתה ב׳',
    '3': 'כיתה ג׳',
    '4': 'כיתה ד׳',
    '5': 'כיתה ה׳',
    '6': 'כיתה ו׳',
    '7': 'כיתה ז׳',
    '8': 'כיתה ח׳',
  };

  /**
   * Valid overlapping Waldorf topics — allowed in multiple grades with NO warnings.
   */
  var VALID_OVERLAPPING_TOPIC_CLUSTERS = [
    {
      label: 'בוטניקה / צמחים',
      aliases: ['צמחים', 'צמח', 'בוטניקה', 'botany', 'plants'],
      gradeIds: ['5', '6'],
    },
    {
      label: 'אדם וחיות / ממלכת החי',
      aliases: [
        'אדם וחיות', 'האדם וחיות', 'אדם וממלכת החי', 'האדם וממלכת החי',
        'ממלכת החי', 'human and animal', 'kingdom of nature',
      ],
      gradeIds: ['4', '5'],
    },
    {
      label: 'פיזיקה / כימיה',
      aliases: [
        'פיזיקה', 'physics', 'כימיה', 'chemistry',
        'כימיה אורגנית', 'organic chemistry',
      ],
      gradeIds: ['6', '7', '8'],
    },
  ];

  /**
   * Canonical Waldorf main-lesson blocks — primary grade ownership for soft-warning routing.
   */
  var CURRICULUM_TOPIC_BLOCKS = [
    { gradeId: '1', blockLabel: 'אגדות וסיפורי טבע', aliases: ['אגדות', 'אגדה', 'סיפורי פיות', 'פיות', 'סיפורי טבע', 'fairy tale', 'fairy tales', 'nature stories'] },
    { gradeId: '2', blockLabel: 'משלי חיות וסיפורי צדיקים', aliases: ['משלי חיות', 'משל חיות', 'fables', 'animal fables', 'סיפורי צדיקים', 'צדיקים', 'saints', 'saint stories'] },
    { gradeId: '3', blockLabel: 'תנ״ך וחקלאות', aliases: ['תנ״ך', 'תנך', 'מקרא', 'בראשית', 'נח', 'חקלאות', 'בית בנין', 'בניית בית', 'old testament', 'bible stories'] },
    { gradeId: '4', blockLabel: 'מיתולוגיה נורדית', aliases: ['נורדית', 'נורד', 'נורדים', 'אסגארד', 'אודין', 'תור', 'thor', 'odin', 'norse', 'norse mythology', 'גיאוגרפיה מקומית', 'local geography'] },
    { gradeId: '4', blockLabel: 'אדם וממלכת החי', aliases: ['אדם וחיות', 'האדם וחיות', 'אדם וממלכת החי', 'האדם וממלכת החי', 'ממלכת החי', 'human and animal', 'kingdom of nature'] },
    { gradeId: '5', blockLabel: 'יוון העתיקה', aliases: ['יוון', 'יוון העתיקה', 'מיתולוגיה יוונית', 'יוונית', 'הומרוס', 'הומר', 'אודיסאוס', 'היסטוריה יוונית', 'אלכסנדר הגדול', 'אולימפיאדה', 'אולימפיה', 'greek mythology', 'ancient greece'] },
    { gradeId: '5', blockLabel: 'בוטניקה', aliases: ['בוטניקה', 'צמחים', 'צמח', 'botany', 'plants'] },
    { gradeId: '6', blockLabel: 'רומא וימי ביניים', aliases: ['רומא', 'רומאית', 'rome', 'roman', 'roman history', 'ימי ביניים', 'medieval', 'middle ages', 'גיאולוגיה', 'geology', 'mineralogy'] },
    { gradeId: '7', blockLabel: 'מגלי עולם ורנסנס', aliases: ['מגלי עולם', 'מגלים', 'גילוי העולם', 'age of exploration', 'explorers', 'רנסנס', 'renaissance', 'גלילאו', 'galileo', 'פיזיקה', 'physics', 'אסטרונומיה', 'astronomy'] },
    { gradeId: '8', blockLabel: 'מהפכות והיסטוריה מודרנית', aliases: ['מהפכה', 'מהפכות', 'מהפכה צרפתית', 'revolution', 'revolutions', 'כימיה אורגנית', 'organic chemistry', 'כימיה', 'chemistry', 'היסטוריה מודרנית', 'modern history'] },
  ];

  /**
   * Advanced historical / narrative epochs — strict Waldorf grade ownership.
   * Checked before any archive semantic similarity or disambiguation.
   */
  var PEDAGOGICAL_EPOCH_GRADE_TOPICS = [
    {
      gradeId: '7',
      displayTopic: 'רנסנס',
      aliases: [
        'רנסנס', 'renaissance',
        'המהפכה המדעית', 'מהפכה מדעית', 'scientific revolution',
        'גילוי ארצות', 'גילוי העולם', 'מגלי עולם', 'מגלים', 'מסעות גילוי',
        'age of exploration', 'explorers', 'גלילאו', 'galileo',
      ],
    },
    {
      gradeId: '4',
      displayTopic: 'מיתולוגיה נורדית',
      aliases: [
        'נורדי', 'נורד', 'נורדית', 'נורדים', 'מיתולוגיה נורדית',
        'סיפורי הצפון', 'סיפורי צפון', 'norse', 'norse mythology',
      ],
    },
    {
      gradeId: '5',
      displayTopic: 'יוון העתיקה',
      aliases: [
        'יוון', 'יוון העתיקה', 'מיתולוגיה יוונית', 'יוונית',
        'אלכסנדר הגדול', 'alexander the great',
        'greek mythology', 'ancient greece', 'הומרוס', 'הומר', 'אודיסאוס',
        'היסטוריה יוונית',
      ],
    },
    {
      gradeId: '6',
      displayTopic: 'רומא',
      aliases: [
        'רומא', 'האימפריה הרומית', 'רומאית', 'היסטוריה רומית',
        'rome', 'roman', 'roman empire', 'roman history',
      ],
    },
  ];

  /**
   * Definitive Waldorf operational-skill block titles — require exact archive match;
   * never suggest narrative epochs (Torah, mythology blocks, etc.) as alternatives.
   */
  var OPERATIONAL_SKILL_BLOCK_TITLES = [
    'רישום צורה', 'form drawing',
    'חשבון', 'מתמטיקה', 'arithmetic', 'mathematics', 'math',
    'ציור גיר', 'ציור גיר על לוח', 'chalkboard drawing', 'chalk drawing', 'waldorf blackboard',
    'מחברות תקופה', 'מחברת תקופה', 'main lesson books', 'main lesson book', 'epoch book', 'block book',
    'עבודות תלמידים', 'עבודות תלמידים ולדורף', 'student work',
    'אותיות', 'אלפבית', 'קריאה וכתיבה', 'reading and writing',
    'מלאכה', 'handwork', 'כלי נגינה', 'eurythmy', 'אאוריתמיה',
  ];

  /** Markers for narrative / historical main-lesson epochs — must not pair with operational skills. */
  var NARRATIVE_EPOCH_MARKERS = [
    'בראשית', 'תורה', 'תנ״ך', 'תנך', 'מקרא', 'ביבליה', 'bible', 'genesis', 'torah',
    'מיתולוגיה', 'mythology', 'אגדות', 'אגדה', 'fairy tale', 'fairy tales',
    'תקופת', 'תקופה', 'epoch', 'סיפורי', 'סיפור', 'היסטוריה', 'history',
    'נורדית', 'יוון', 'רומא', 'ימי ביניים', 'רנסנס', 'מהפכה',
    'אודיסאוס', 'הומרוס', 'מגלי עולם', 'גילוי העולם',
  ];

  /** Universally accepted Waldorf pedagogical alias clusters (allowed disambiguation targets). */
  var ALLOWED_PEDAGOGICAL_ALIAS_CLUSTERS = [
    ['סיפורי הצפון', 'סיפורי צפון', 'מיתולוגיה נורדית', 'נורדית', 'norse mythology'],
    ['יוון', 'יוון העתיקה', 'מיתולוגיה יוונית', 'יוונית', 'עתיקה', 'היסטוריה יוונית', 'אלכסנדר הגדול', 'אולימפיאדה', 'אולימפיה', 'greek mythology', 'ancient greece'],
    ['מסעות אודיסאוס', 'אודיסאוס', 'אודיסיאה', 'odysseus', 'odyssey'],
    ['משלי חיות', 'fables', 'animal fables'],
    ['סיפורי צדיקים', 'saints', 'saint stories'],
  ];

  /** Hebrew homophone / near-homophone pairs that must never morphologically match. */
  var FALSE_MORPHOLOGY_PAIRS = [
    ['צורה', 'תורה'],
    ['רישום', 'בראשית'],
    ['חשבון', 'תורה'],
    ['חשבון', 'בראשית'],
  ];

  /** Pedagogical synonym clusters — same Waldorf block / core topic in different word forms. */
  var PEDAGOGICAL_TOPIC_CLUSTERS = [
    ['גילוי', 'גילויים', 'מגלים', 'מגלי', 'מגלה', 'גילה', 'תגלית', 'תגליות', 'גלי', 'עולם', 'מסעות'],
    ['אותיות', 'אות', 'אלף', 'אלפא', 'אלפבית', 'כתיבה', 'קריאה'],
    ['חשבון', 'מתמטיקה', 'מספרים', 'מספר', 'חישוב', 'כפל', 'חיבור'],
    ['צמחים', 'צמח', 'בוטניקה', 'גינה', 'גינון', 'זרעים', 'זרע'],
    ['חיות', 'חיה', 'זואולוגיה', 'בעלי', 'חיים'],
    ['גיאוגרפיה', 'מפה', 'מפות', 'ארץ', 'ארצות', 'יבשות'],
    ['היסטוריה', 'עבר', 'תרבויות', 'תרבות', 'עמים'],
    ['מיתולוגיה', 'מיתוס', 'מיתוסים', 'אגדות', 'אגדה', 'סיפורי'],
    ['פיזיקה', 'מכניקה', 'אנרגיה', 'חשמל', 'אור'],
    ['כימיה', 'יסודות', 'חומרים', 'תגובות'],
  ];

  var clusterIndex = null;

  function buildClusterIndex() {
    if (clusterIndex) return clusterIndex;
    clusterIndex = new Map();
    PEDAGOGICAL_TOPIC_CLUSTERS.forEach(function (cluster, clusterId) {
      cluster.forEach(function (word) {
        var key = normalizeHebrewWord(word);
        if (!key) return;
        if (!clusterIndex.has(key)) clusterIndex.set(key, []);
        clusterIndex.get(key).push({ id: clusterId, word: key });
      });
    });
    return clusterIndex;
  }

  function stableNormalize(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function normalizeHebrewWord(word) {
    return stableNormalize(word).replace(/[״"'`׳\-–—_,.;:!?()[\]{}]/g, '');
  }

  function isHebrewTopicStopWord(word) {
    var w = String(word || '').trim();
    if (!w) return true;
    if (HEBREW_TOPIC_STOP_WORDS.has(w)) return true;
    if (w.charAt(0) === 'ה' && w.length > 2 && HEBREW_TOPIC_STOP_WORDS.has(w.slice(1))) return true;
    return false;
  }

  function stripDefiniteArticle(word) {
    var w = String(word || '');
    if (w.charAt(0) === 'ה' && w.length > 2) {
      var stem = w.slice(1);
      if (stem && !isHebrewTopicStopWord(stem)) return stem;
    }
    return w;
  }

  function removeGradePhrasesFromTopic(text) {
    return String(text || '')
      .replace(/(?:^|\s)(?:ו|ב|ל|ש)?כיתה\s+[א-ת]['׳]?(?:\s|$)/g, ' ')
      .replace(/(?:^|\s)שכב(?:ה|ת)\s+[א-ת]['׳]?(?:\s|$)/g, ' ')
      .replace(/(?:^|\s)גיל\s+\d[\d\-]*(?:\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractMeaningfulTokens(raw) {
    var text = stableNormalize(raw);
    if (!text) return [];

    text = text
      .replace(/[״"'`׳\-–—_,.;:!?()[\]{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    text = removeGradePhrasesFromTopic(text);

    var tokens = [];
    var seen = new Set();
    text.split(/\s+/).filter(Boolean).forEach(function (word) {
      if (isHebrewTopicStopWord(word)) return;
      var cleaned = stripDefiniteArticle(word);
      if (!cleaned || isHebrewTopicStopWord(cleaned)) return;
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        tokens.push(cleaned);
      }
    });

    if (!tokens.length && text) {
      text.split(/\s+/).filter(function (w) { return w.length >= 2; }).forEach(function (w) {
        if (!seen.has(w)) {
          seen.add(w);
          tokens.push(w);
        }
      });
    }
    return tokens;
  }

  function stripHebrewAffixes(word) {
    var w = normalizeHebrewWord(word);
    if (!w || w.length < 2) return w;

    if (w.charAt(0) === 'ה' && w.length > 2) w = w.slice(1);

    var prefixes = ['ובה', 'ולה', 'מה', 'שה', 'של', 'וב', 'ול', 'וה', 'ה', 'ו', 'ב', 'ל', 'מ', 'כ', 'ש'];
    var changed = true;
    var guard = 0;
    while (changed && w.length >= 3 && guard < 6) {
      changed = false;
      guard++;
      for (var i = 0; i < prefixes.length; i++) {
        var p = prefixes[i];
        if (w.indexOf(p) === 0 && w.length > p.length + 1) {
          w = w.slice(p.length);
          changed = true;
          break;
        }
      }
    }

    var suffixes = ['יות', 'יון', 'יים', 'ות', 'ים', 'ין', 'נו', 'כם', 'הן', 'יהם', 'יהן', 'ת', 'ה', 'י', 'ו', 'ן'];
    for (var j = 0; j < suffixes.length; j++) {
      var s = suffixes[j];
      if (w.length > s.length + 2 && w.slice(-s.length) === s) {
        w = w.slice(0, -s.length);
        break;
      }
    }

    return w;
  }

  function consonantSkeleton(word) {
    return stripHebrewAffixes(word).replace(/[אוי]/g, '');
  }

  function sharedStemLength(a, b, minLen) {
    minLen = minLen || 3;
    if (!a || !b || a.length < minLen || b.length < minLen) return 0;
    var best = 0;
    for (var len = Math.min(a.length, b.length); len >= minLen; len--) {
      for (var i = 0; i <= a.length - len; i++) {
        var part = a.slice(i, i + len);
        if (b.indexOf(part) >= 0) {
          return len;
        }
      }
    }
    return best;
  }

  function isKnownFalseMorphologyPair(wordA, wordB) {
    var a = normalizeHebrewWord(wordA);
    var b = normalizeHebrewWord(wordB);
    if (!a || !b) return false;
    for (var i = 0; i < FALSE_MORPHOLOGY_PAIRS.length; i++) {
      var pair = FALSE_MORPHOLOGY_PAIRS[i];
      var p0 = normalizeHebrewWord(pair[0]);
      var p1 = normalizeHebrewWord(pair[1]);
      if ((a === p0 && b === p1) || (a === p1 && b === p0)) return true;
    }
    return false;
  }

  function topicContainsMarker(text, markers) {
    var norm = stableNormalize(text);
    if (!norm) return false;
    for (var i = 0; i < markers.length; i++) {
      var marker = stableNormalize(markers[i]);
      if (!marker || marker.length < 2) continue;
      if (norm === marker || norm.indexOf(marker) >= 0) return true;
    }
    return false;
  }

  function topicTextMatchesEpochAlias(textNorm, alias) {
    var aliasNorm = stableNormalize(alias);
    if (!aliasNorm || !textNorm) return false;
    if (textNorm === aliasNorm) return true;
    if (aliasNorm.length >= 3 && textNorm.indexOf(aliasNorm) >= 0) return true;
    if (textNorm.length >= 4 && aliasNorm.indexOf(textNorm) >= 0) return true;
    return false;
  }

  function displayEpochTopicLabel(topicText, epochEntry) {
    var raw = String(topicText || '').trim();
    if (!raw) return epochEntry ? epochEntry.displayTopic : '';
    var norm = stableNormalize(removeGradePhrasesFromTopic(raw));
    for (var i = 0; i < (epochEntry && epochEntry.aliases ? epochEntry.aliases.length : 0); i++) {
      var alias = epochEntry.aliases[i];
      if (topicTextMatchesEpochAlias(norm, alias)) return String(alias).trim();
    }
    return raw.length > 48 ? raw.slice(0, 48) + '…' : raw;
  }

  function gradeLabelForId(gradeId) {
    return GRADE_LABEL_BY_ID[String(gradeId || '').trim()] || ('כיתה ' + gradeId);
  }

  function gradeShortLabelForMessage(gradeId, gradeLabel) {
    var fromLabel = String(gradeLabel || '').trim();
    if (fromLabel) {
      return fromLabel.replace(/^כיתה\s+/u, '').trim();
    }
    return gradeLabelForId(gradeId).replace(/^כיתה\s+/u, '').trim();
  }

  /**
   * Resolve a query to its canonical Waldorf grade when it names a guarded epoch topic.
   * @returns {null|object}
   */
  function findPedagogicalEpochGrade(topicText) {
    var cleaned = removeGradePhrasesFromTopic(topicText);
    var norm = stableNormalize(cleaned);
    if (!norm || norm.length < 2) return null;

    var best = null;
    var bestAliasLen = 0;
    for (var i = 0; i < PEDAGOGICAL_EPOCH_GRADE_TOPICS.length; i++) {
      var entry = PEDAGOGICAL_EPOCH_GRADE_TOPICS[i];
      for (var j = 0; j < entry.aliases.length; j++) {
        var alias = entry.aliases[j];
        if (!topicTextMatchesEpochAlias(norm, alias)) continue;
        var aliasLen = stableNormalize(alias).length;
        if (!best || aliasLen > bestAliasLen) {
          best = entry;
          bestAliasLen = aliasLen;
        }
      }
    }
    return best;
  }

  function findOverlappingTopicCluster(topicText) {
    var cleaned = removeGradePhrasesFromTopic(topicText);
    var norm = stableNormalize(cleaned);
    if (!norm || norm.length < 2) return null;

    var best = null;
    var bestAliasLen = 0;
    for (var i = 0; i < VALID_OVERLAPPING_TOPIC_CLUSTERS.length; i++) {
      var cluster = VALID_OVERLAPPING_TOPIC_CLUSTERS[i];
      for (var j = 0; j < cluster.aliases.length; j++) {
        var alias = cluster.aliases[j];
        if (!topicTextMatchesEpochAlias(norm, alias)) continue;
        var aliasLen = stableNormalize(alias).length;
        if (!best || aliasLen > bestAliasLen) {
          best = cluster;
          bestAliasLen = aliasLen;
        }
      }
    }
    return best;
  }

  function isTopicAllowedInOverlappingGrades(gradeId, topicText) {
    var cluster = findOverlappingTopicCluster(topicText);
    if (!cluster) return false;
    return cluster.gradeIds.indexOf(String(gradeId || '').trim()) >= 0;
  }

  function findCurriculumTopicBlock(topicText) {
    var cleaned = removeGradePhrasesFromTopic(topicText);
    var norm = stableNormalize(cleaned);
    if (!norm || norm.length < 2) return null;

    var best = null;
    var bestAliasLen = 0;
    for (var i = 0; i < CURRICULUM_TOPIC_BLOCKS.length; i++) {
      var block = CURRICULUM_TOPIC_BLOCKS[i];
      for (var j = 0; j < block.aliases.length; j++) {
        var alias = block.aliases[j];
        if (!topicTextMatchesEpochAlias(norm, alias)) continue;
        var aliasLen = stableNormalize(alias).length;
        if (!best || aliasLen > bestAliasLen) {
          best = block;
          bestAliasLen = aliasLen;
        }
      }
    }
    return best;
  }

  function displayCurriculumTopicLabel(topicText, block) {
    var raw = String(topicText || '').trim();
    if (!raw) return block ? block.blockLabel : '';
    var norm = stableNormalize(removeGradePhrasesFromTopic(raw));
    for (var i = 0; i < (block && block.aliases ? block.aliases.length : 0); i++) {
      var alias = block.aliases[i];
      if (topicTextMatchesEpochAlias(norm, alias)) return String(alias).trim();
    }
    return raw.length > 48 ? raw.slice(0, 48) + '…' : raw;
  }

  function buildScopeMismatchResult(currentGradeId, topicText, currentGradeLabel, canonicalGradeId, canonicalLabel, blockLabel, displayTopic) {
    return {
      severity: 'soft',
      requestedTopic: displayTopic,
      requestedTopicRaw: topicText,
      currentGradeId: String(currentGradeId || '').trim(),
      currentGradeLabel: String(currentGradeLabel || '').trim() || gradeLabelForId(currentGradeId),
      canonicalGradeId: String(canonicalGradeId || '').trim(),
      canonicalGradeLabel: canonicalLabel || gradeLabelForId(canonicalGradeId),
      blockLabel: blockLabel || '',
    };
  }

  /**
   * @returns {null|object} soft mismatch when topic is outside standard curriculum for grade
   */
  function validateTopicGradeScope(currentGradeId, topicText, currentGradeLabel) {
    var gid = String(currentGradeId || '').trim();
    var topic = String(topicText || '').trim();
    if (!gid || !topic) return null;

    if (isTopicAllowedInOverlappingGrades(gid, topic)) return null;

    var epoch = findPedagogicalEpochGrade(topic);
    if (epoch) {
      if (epoch.gradeId === gid) return null;
      return buildScopeMismatchResult(
        gid, topic, currentGradeLabel,
        epoch.gradeId, gradeLabelForId(epoch.gradeId),
        epoch.displayTopic,
        displayEpochTopicLabel(topic, epoch)
      );
    }

    var block = findCurriculumTopicBlock(topic);
    if (block) {
      if (block.gradeId === gid) return null;
      return buildScopeMismatchResult(
        gid, topic, currentGradeLabel,
        block.gradeId, gradeLabelForId(block.gradeId),
        block.blockLabel,
        displayCurriculumTopicLabel(topic, block)
      );
    }

    return null;
  }

  /**
   * @returns {null|object} mismatch when topic belongs to a different grade than current context
   */
  function checkPedagogicalGradeMismatch(currentGradeId, topicText, currentGradeLabel) {
    return validateTopicGradeScope(currentGradeId, topicText, currentGradeLabel);
  }

  function buildGradeSoftWarningMessage(mismatch) {
    var m = mismatch || {};
    var topic = m.requestedTopic || m.requestedTopicRaw || 'נושא זה';
    var currentShort = gradeShortLabelForMessage(m.currentGradeId, m.currentGradeLabel);
    var canonicalShort = gradeShortLabelForMessage(m.canonicalGradeId, m.canonicalGradeLabel);
    var canonicalHint = canonicalShort
      ? ' (בדרך כלל מיועד לכיתה ' + canonicalShort + ')'
      : '';
    return (
      'הנושא «' + topic + '» אולי אינו שייך לתוכנית הלימודים הסטנדרטית של כיתה ' + currentShort +
      canonicalHint + '. מומלץ לדייק את הנושא — או להמשיך בכל זאת אם בחרת במודע.'
    );
  }

  function buildGradeMismatchMessage(mismatch) {
    return buildGradeSoftWarningMessage(mismatch);
  }

  function buildCurriculumOverrideAntiHallucinationInstruction(topicText, gradeLabel) {
    var topic = String(topicText || '').trim() || 'נושא זה';
    var grade = String(gradeLabel || '').trim() || 'כיתה זו';
    return (
      'The user has bypassed standard alignment and explicitly requested «' + topic + '» for «' + grade + '». ' +
      'Generate the contents based strictly on this combination. ' +
      'Do not hallucinate or generate irrelevant/fake placeholders — provide factual, pedagogically sound content ' +
      'adapted as realistically as possible for this age group.'
    );
  }

  function isDefinitiveOperationalSkillTitle(query) {
    var norm = stableNormalize(query);
    if (!norm) return false;
    for (var i = 0; i < OPERATIONAL_SKILL_BLOCK_TITLES.length; i++) {
      var title = stableNormalize(OPERATIONAL_SKILL_BLOCK_TITLES[i]);
      if (norm === title) return true;
    }
    return false;
  }

  function isNarrativeEpochTopic(text) {
    return topicContainsMarker(text, NARRATIVE_EPOCH_MARKERS);
  }

  function isOperationalSkillTopic(text) {
    if (isDefinitiveOperationalSkillTitle(text)) return true;
    return topicContainsMarker(text, OPERATIONAL_SKILL_BLOCK_TITLES);
  }

  function sharesAllowedPedagogicalAlias(textA, textB) {
    var a = stableNormalize(textA);
    var b = stableNormalize(textB);
    if (!a || !b) return false;
    for (var i = 0; i < ALLOWED_PEDAGOGICAL_ALIAS_CLUSTERS.length; i++) {
      var cluster = ALLOWED_PEDAGOGICAL_ALIAS_CLUSTERS[i];
      var hitA = false;
      var hitB = false;
      for (var j = 0; j < cluster.length; j++) {
        var alias = stableNormalize(cluster[j]);
        if (!alias) continue;
        if (a === alias || a.indexOf(alias) >= 0 || alias.indexOf(a) >= 0) hitA = true;
        if (b === alias || b.indexOf(alias) >= 0 || alias.indexOf(b) >= 0) hitB = true;
      }
      if (hitA && hitB) return true;
    }
    return false;
  }

  /**
   * True when a "did you mean" suggestion crosses Waldorf domain boundaries
   * (e.g. Form Drawing → Genesis/Torah epoch).
   */
  function isInvalidCrossDomainTopicSuggestion(query, suggestedTopic) {
    var q = String(query || '').trim();
    var s = String(suggestedTopic || '').trim();
    if (!q || !s) return false;
    if (stableNormalize(q) === stableNormalize(s)) return false;
    if (sharesAllowedPedagogicalAlias(q, s)) return false;

    var qSkill = isOperationalSkillTopic(q);
    var sSkill = isOperationalSkillTopic(s);
    var qNarrative = isNarrativeEpochTopic(q);
    var sNarrative = isNarrativeEpochTopic(s);

    if (qSkill && sNarrative) return true;
    if (qNarrative && sSkill) return true;
    if (isDefinitiveOperationalSkillTitle(q) && sNarrative) return true;

    return false;
  }

  function shouldBypassSemanticArchiveSuggestion(query) {
    return isDefinitiveOperationalSkillTitle(query);
  }

  function wordsMorphologicallyRelated(wordA, wordB) {
    if (isKnownFalseMorphologyPair(wordA, wordB)) return false;

    var normA = normalizeHebrewWord(wordA);
    var normB = normalizeHebrewWord(wordB);
    if (!normA || !normB) return false;
    if (normA === normB) return true;

    if (normA.length >= 2 && normB.indexOf(normA) >= 0) return true;
    if (normB.length >= 2 && normA.indexOf(normB) >= 0) return true;

    var stemA = stripHebrewAffixes(normA);
    var stemB = stripHebrewAffixes(normB);
    if (stemA && stemB) {
      if (stemA === stemB) return true;
      if (stemA.length >= 3 && stemB.indexOf(stemA) >= 0) return true;
      if (stemB.length >= 3 && stemA.indexOf(stemB) >= 0) return true;
      if (sharedStemLength(stemA, stemB, 3) >= 3) return true;
    }

    var skelA = consonantSkeleton(normA);
    var skelB = consonantSkeleton(normB);
    if (skelA && skelB) {
      if (skelA === skelB) return true;
      if (skelA.length >= 3 && skelB.indexOf(skelA) >= 0) return true;
      if (skelB.length >= 3 && skelA.indexOf(skelB) >= 0) return true;
      if (sharedStemLength(skelA, skelB, 3) >= 3) return true;
    }

    return tokensSharePedagogicalCluster(normA, normB);
  }

  function tokensSharePedagogicalCluster(tokenA, tokenB) {
    var idx = buildClusterIndex();
    var a = idx.get(normalizeHebrewWord(tokenA));
    var b = idx.get(normalizeHebrewWord(tokenB));
    if (!a || !b) return false;
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < b.length; j++) {
        if (a[i].id === b[j].id) return true;
      }
    }
    return false;
  }

  function tokenMatchesCandidateText(token, candidateText) {
    var ct = stableNormalize(candidateText);
    if (!ct) return false;
    if (ct.indexOf(token) >= 0) return true;

    var candidateTokens = extractMeaningfulTokens(ct);
    for (var i = 0; i < candidateTokens.length; i++) {
      if (wordsMorphologicallyRelated(token, candidateTokens[i])) return true;
    }

    var stem = stripHebrewAffixes(token);
    if (stem.length >= 3 && ct.indexOf(stem) >= 0) return true;

    var skeleton = consonantSkeleton(token);
    if (skeleton.length >= 3) {
      for (var j = 0; j < candidateTokens.length; j++) {
        if (consonantSkeleton(candidateTokens[j]).indexOf(skeleton) >= 0) return true;
        if (skeleton.indexOf(consonantSkeleton(candidateTokens[j])) >= 0) return true;
      }
    }

    return false;
  }

  function scoreMorphologicalTopicMatch(queryRaw, candidateTopic, candidateQueryText) {
    var queryTokens = extractMeaningfulTokens(queryRaw);
    if (!queryTokens.length) return 0;

    var candidates = [];
    if (candidateTopic) candidates.push(String(candidateTopic));
    if (candidateQueryText) candidates.push(String(candidateQueryText));
    if (!candidates.length) return 0;

    var matched = 0;
    queryTokens.forEach(function (token) {
      var hit = false;
      for (var i = 0; i < candidates.length && !hit; i++) {
        if (tokenMatchesCandidateText(token, candidates[i])) hit = true;
      }
      if (hit) matched++;
    });

    if (!matched) return 0;

    var coverage = matched / queryTokens.length;
    if (isDefinitiveOperationalSkillTitle(queryRaw) && coverage < 1) return 0;
    if (matched >= 1 && coverage >= 0.34) {
      return 0.72 + Math.min(0.16, coverage * 0.16);
    }
    return 0;
  }

  /**
   * Expand a topic query into Hebrew search terms for relaxed archive SQL ilike probes.
   */
  function expandHebrewSearchTerms(topic, maxTerms) {
    maxTerms = maxTerms || 8;
    var terms = new Set();
    var raw = stableNormalize(topic);
    if (!raw) return [];

    raw.split(/\s+/).filter(function (w) { return w.length >= 2; }).forEach(function (w) {
      terms.add(w);
    });

    extractMeaningfulTokens(topic).forEach(function (token) {
      terms.add(token);
      var stem = stripHebrewAffixes(token);
      if (stem.length >= 3) terms.add(stem);
      var skeleton = consonantSkeleton(token);
      if (skeleton.length >= 3) terms.add(skeleton);

      var idx = buildClusterIndex();
      var clusterHits = idx.get(token);
      if (clusterHits) {
        clusterHits.forEach(function (hit) {
          PEDAGOGICAL_TOPIC_CLUSTERS[hit.id].forEach(function (related) {
            if (related.length >= 3) terms.add(related);
          });
        });
      }
    });

    // Expand pedagogical aliases (e.g. יוון העתיקה ↔ יוון ↔ עתיקה).
    // Match exact or "seed contains alias" only — avoid bare מיתולוגיה → מיתולוגיה נורדית.
    var seedTerms = Array.from(terms);
    seedTerms.forEach(function (seed) {
      var seedNorm = stableNormalize(seed);
      if (!seedNorm) return;
      for (var i = 0; i < ALLOWED_PEDAGOGICAL_ALIAS_CLUSTERS.length; i++) {
        var cluster = ALLOWED_PEDAGOGICAL_ALIAS_CLUSTERS[i];
        var hit = false;
        for (var j = 0; j < cluster.length; j++) {
          var aliasNorm = stableNormalize(cluster[j]);
          if (!aliasNorm) continue;
          if (aliasNorm === seedNorm
            || (aliasNorm.length >= 3 && seedNorm.indexOf(aliasNorm) >= 0)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          cluster.forEach(function (alias) {
            var a = stableNormalize(alias);
            if (a && a.length >= 2) terms.add(a);
          });
        }
      }
    });

    // Grade-5 Greece search tags — never expand to bare mythology (pollutes Norse grade-4 hits).
    var greeceTags = ['עתיקה', 'מיתולוגיה יוונית', 'היסטוריה יוונית', 'אלכסנדר הגדול', 'אולימפיאדה'];
    var hasGreece = raw.indexOf('יוון') >= 0
      || raw === 'עתיקה'
      || raw === 'ancient greece'
      || raw === 'greek mythology'
      || raw.indexOf('מיתולוגיה יוונית') >= 0
      || raw.indexOf('היסטוריה יוונית') >= 0
      || raw.indexOf('greek mythology') >= 0
      || raw.indexOf('אלכסנדר') >= 0
      || raw.indexOf('אולימפ') >= 0
      || raw.indexOf('alexander') >= 0
      || raw.indexOf('olympic') >= 0;
    if (!hasGreece) {
      terms.forEach(function (t) {
        var tn = stableNormalize(t);
        if (tn === 'יוון' || tn.indexOf('יוון') >= 0 || tn === 'מיתולוגיה יוונית'
          || tn === 'ancient greece' || tn === 'greek mythology'
          || tn.indexOf('אלכסנדר') >= 0 || tn.indexOf('אולימפ') >= 0) {
          hasGreece = true;
        }
      });
    }
    if (hasGreece) {
      greeceTags.forEach(function (tag) { terms.add(tag); });
      terms.add('יוון');
      terms.add('יוון העתיקה');
      terms.delete('מיתולוגיה');
    }

    return Array.from(terms)
      .filter(function (t) { return t && t.length >= 2; })
      .sort(function (a, b) { return b.length - a.length; })
      .slice(0, maxTerms);
  }

  /**
   * Full topic similarity score including morphological / pedagogical matching.
   * Returns 1 for equivalent topics, ~0.88 for substring, ~0.72–0.88 for morph match.
   */
  function scoreHebrewTopicSimilarity(queryRaw, candidateTopic, candidateQueryText, options) {
    options = options || {};
    var normalizeTopicQuery = options.normalizeTopicQuery;
    var scoreChatQuestionSimilarity = options.scoreChatQuestionSimilarity;

    if (typeof normalizeTopicQuery === 'function') {
      var queryKey = normalizeTopicQuery(queryRaw);
      var topicKey = normalizeTopicQuery(candidateTopic || candidateQueryText || '');
      if (queryKey && topicKey && queryKey === topicKey) return 1;
    }

    var queryNorm = stableNormalize(queryRaw);
    var topicNorm = stableNormalize(candidateTopic || '');
    var queryTextNorm = stableNormalize(candidateQueryText || '');
    if (!queryNorm) return 0;
    if (topicNorm && queryNorm === topicNorm) return 1;
    if (queryTextNorm && queryNorm === queryTextNorm) return 1;

    if (queryNorm.length >= 2) {
      if (topicNorm && topicNorm.indexOf(queryNorm) >= 0) return 0.88;
      if (queryTextNorm && queryTextNorm.indexOf(queryNorm) >= 0) return 0.86;
    }

    var morphScore = scoreMorphologicalTopicMatch(queryRaw, candidateTopic, candidateQueryText);
    if (morphScore > 0) return morphScore;

    if (typeof scoreChatQuestionSimilarity === 'function') {
      return scoreChatQuestionSimilarity(queryRaw, candidateTopic || candidateQueryText || '');
    }
    return 0;
  }

  function getGradeCanonicalArchiveTopic(gradeId) {
    return GRADE_CANONICAL_ARCHIVE_TOPICS[String(gradeId || '').trim()] || '';
  }

  /**
   * True when a grade has a canonical archive topic and the query is a partial variant
   * that should halt step B and ask for confirmation (not an exact title match).
   */
  function shouldProbeCanonicalArchiveTopic(gradeId, queryRaw) {
    var canonical = getGradeCanonicalArchiveTopic(gradeId);
    if (!canonical) return false;
    var queryNorm = stableNormalize(queryRaw);
    var canonicalNorm = stableNormalize(canonical);
    if (!queryNorm || queryNorm === canonicalNorm) return false;
    var score = scoreHebrewTopicSimilarity(queryRaw, canonical, '');
    return score >= 0.5 && score < 0.99;
  }

  return {
    stableNormalize: stableNormalize,
    extractMeaningfulTokens: extractMeaningfulTokens,
    stripHebrewAffixes: stripHebrewAffixes,
    consonantSkeleton: consonantSkeleton,
    wordsMorphologicallyRelated: wordsMorphologicallyRelated,
    expandHebrewSearchTerms: expandHebrewSearchTerms,
    scoreMorphologicalTopicMatch: scoreMorphologicalTopicMatch,
    scoreHebrewTopicSimilarity: scoreHebrewTopicSimilarity,
    getGradeCanonicalArchiveTopic: getGradeCanonicalArchiveTopic,
    shouldProbeCanonicalArchiveTopic: shouldProbeCanonicalArchiveTopic,
    findPedagogicalEpochGrade: findPedagogicalEpochGrade,
    findOverlappingTopicCluster: findOverlappingTopicCluster,
    isTopicAllowedInOverlappingGrades: isTopicAllowedInOverlappingGrades,
    findCurriculumTopicBlock: findCurriculumTopicBlock,
    validateTopicGradeScope: validateTopicGradeScope,
    checkPedagogicalGradeMismatch: checkPedagogicalGradeMismatch,
    buildGradeSoftWarningMessage: buildGradeSoftWarningMessage,
    buildGradeMismatchMessage: buildGradeMismatchMessage,
    buildCurriculumOverrideAntiHallucinationInstruction: buildCurriculumOverrideAntiHallucinationInstruction,
    VALID_OVERLAPPING_TOPIC_CLUSTERS: VALID_OVERLAPPING_TOPIC_CLUSTERS,
    CURRICULUM_TOPIC_BLOCKS: CURRICULUM_TOPIC_BLOCKS,
    gradeShortLabelForMessage: gradeShortLabelForMessage,
    gradeLabelForId: gradeLabelForId,
    PEDAGOGICAL_EPOCH_GRADE_TOPICS: PEDAGOGICAL_EPOCH_GRADE_TOPICS,
    isDefinitiveOperationalSkillTitle: isDefinitiveOperationalSkillTitle,
    isOperationalSkillTopic: isOperationalSkillTopic,
    isNarrativeEpochTopic: isNarrativeEpochTopic,
    isInvalidCrossDomainTopicSuggestion: isInvalidCrossDomainTopicSuggestion,
    shouldBypassSemanticArchiveSuggestion: shouldBypassSemanticArchiveSuggestion,
    sharesAllowedPedagogicalAlias: sharesAllowedPedagogicalAlias,
    OPERATIONAL_SKILL_BLOCK_TITLES: OPERATIONAL_SKILL_BLOCK_TITLES,
    NARRATIVE_EPOCH_MARKERS: NARRATIVE_EPOCH_MARKERS,
  };
}));
