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

  /** Pedagogical synonym clusters — same Waldorf block / core topic in different word forms. */
  var PEDAGOGICAL_TOPIC_CLUSTERS = [
    ['גילוי', 'גילויים', 'מגלים', 'מגלי', 'מגלה', 'גילה', 'תגלית', 'תגליות', 'גלי', 'עולם'],
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
      .replace(/(?:^|\s)(?:ב|ל|ש)?כיתה\s+[א-ת]['׳]?(?:\s|$)/g, ' ')
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

  function wordsMorphologicallyRelated(wordA, wordB) {
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

  return {
    stableNormalize: stableNormalize,
    extractMeaningfulTokens: extractMeaningfulTokens,
    stripHebrewAffixes: stripHebrewAffixes,
    consonantSkeleton: consonantSkeleton,
    wordsMorphologicallyRelated: wordsMorphologicallyRelated,
    expandHebrewSearchTerms: expandHebrewSearchTerms,
    scoreMorphologicalTopicMatch: scoreMorphologicalTopicMatch,
    scoreHebrewTopicSimilarity: scoreHebrewTopicSimilarity,
  };
}));
