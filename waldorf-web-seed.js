/**
 * Waldorf web research helpers — URL sanitizer and anti-hallucination prompts.
 * No hardcoded domain whitelists or site-restricted search fallbacks.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WaldorfWebSeed = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var queryGen = null;
  try {
    if (typeof require === 'function') {
      queryGen = require('./waldorf-query-generation.js');
    }
  } catch (e) { /* browser bundle */ }
  if (!queryGen && typeof WaldorfQueryGeneration !== 'undefined') {
    queryGen = WaldorfQueryGeneration;
  }

  var BROKEN_URL_PATTERNS = [
    /shaked\.org\.il/i,
    /harduf\.org\.il\/http_new/i,
    /harduf\.org\.il\/.*index\.asp/i,
    /harduf\.org\.il\/\?s=/i,
    /harduf\.org\.il\/\?/i,
    /kehilanet|קהילנט/i,
    /\/http_new\//i,
    /index\.asp\?sitename=/i,
    /ViewPage\.asp\?pagesCatID=/i,
    /edupage\.org\/.*login/i,
  ];

  var INVENTED_SEARCH_PATTERNS = [
    /\?s=/i,
    /[?&]search=/i,
    /\/search\?/i,
    /\/\?q=/i,
  ];

  function isSiteRestrictedGoogleSearchUrl(url) {
    if (queryGen && queryGen.isSiteRestrictedGoogleSearchUrl) {
      return queryGen.isSiteRestrictedGoogleSearchUrl(url);
    }
    var u = String(url || '');
    if (!/google\.com\/search/i.test(u)) return false;
    return /site%3A|site:/i.test(u);
  }

  function isSafeGoogleSiteSearchUrl(url) {
    return isSiteRestrictedGoogleSearchUrl(url);
  }

  function isBrokenOrGuessedPedagogicalUrl(url) {
    var u = String(url || '').trim();
    if (!u) return true;
    if (isSiteRestrictedGoogleSearchUrl(u)) return true;

    for (var i = 0; i < BROKEN_URL_PATTERNS.length; i++) {
      if (BROKEN_URL_PATTERNS[i].test(u)) return true;
    }

    try {
      var parsed = new URL(u);
      var path = parsed.pathname || '/';
      var isRootish = path === '/' || path === '/index.html' || path === '/index.php';
      if (isRootish && !parsed.search) return true;

      for (var j = 0; j < INVENTED_SEARCH_PATTERNS.length; j++) {
        if (INVENTED_SEARCH_PATTERNS[j].test(u)) return true;
      }
    } catch (e) {
      return true;
    }

    return false;
  }

  function looksLikeVerifiedDeepLink(url, context) {
    context = context || {};
    var u = String(url || '').trim();
    if (!u || isBrokenOrGuessedPedagogicalUrl(u)) return false;
    if (isSiteRestrictedGoogleSearchUrl(u)) return false;

    try {
      var parsed = new URL(u);
      var path = (parsed.pathname || '').replace(/\/+$/, '');
      if (!path || path === '/' || path === '/index.html') return false;
      if (BROKEN_URL_PATTERNS.some(function (p) { return p.test(u); })) return false;
      if (/\?s=/.test(u)) return false;
      if (/index\.asp/i.test(u)) return false;
      return path.length > 1;
    } catch (e) {
      return false;
    }
  }

  function sanitizePedagogicalResourceUrl(url, topic, context) {
    context = context || {};
    var u = String(url || '').trim();
    if (!u) return '';
    if (isBrokenOrGuessedPedagogicalUrl(u)) return '';
    if (context.verified === true && looksLikeVerifiedDeepLink(u, context)) return u;
    if (looksLikeVerifiedDeepLink(u, context) && !isBrokenOrGuessedPedagogicalUrl(u)) return u;
    if (/^https?:\/\//i.test(u) && !isSiteRestrictedGoogleSearchUrl(u)) return u;
    return '';
  }

  function buildWaldorfSiteSearchQueries(topic, gradeLabel) {
    var t = String(topic || '').trim();
    if (!t) return [];
    if (queryGen && queryGen.buildOpenArticleSearchQuery) {
      var q = queryGen.buildOpenArticleSearchQuery(t, gradeLabel);
      return q ? [q] : [];
    }
    var grade = String(gradeLabel || '').trim();
    return [t + ' וולדורף' + (grade ? ' ' + grade : '')];
  }

  var ANTI_URL_HALLUCINATION_INSTRUCTION =
    '=== ANTI URL HALLUCINATION (ABSOLUTE — PEDAGOGICAL RESOURCES) ===\n' +
    'STRICTLY FORBIDDEN to invent, guess, or format URLs that were not returned by live web search.\n' +
    'NEVER append paths or query strings (e.g. /?s=, /http_new/, index.asp) unless that EXACT URL appeared in your live search citations.\n' +
    'NEVER emit site-restricted Google search URLs (site:domain …) — use only verified deep links from live search.\n' +
    'If you lack a verified deep link from live search, OMIT the url field entirely.\n' +
    'ONLY include url when copied verbatim from a citation returned by web search (full HTTPS path to an article/PDF/page).\n' +
    '=== END ANTI URL HALLUCINATION ===\n';

  function buildWaldorfWebSeedInstruction(topic, gradeLabel) {
    var t = String(topic || '').trim() || 'וולדורף';
    var grade = String(gradeLabel || '').trim();
    return [
      ANTI_URL_HALLUCINATION_INSTRUCTION,
      'OPEN WEB SEARCH — discover Waldorf/anthroposophic pedagogical articles using dynamic queries from the block topic and grade.',
      'Query pattern: «' + t + '» + Waldorf pedagogy' + (grade ? ' + «' + grade + '»' : '') + ' — no site: restrictions, no forced domains.',
      'Populate pedagogicalResources ONLY with URLs copied verbatim from live search citations (deep article/PDF pages).',
      'If no verified deep links exist, return an empty pedagogicalResources array — never pad with fabricated or site-restricted search URLs.',
    ].join('\n');
  }

  function buildWebInspirationFallbackResources(topic, gradeLabel) {
    return [];
  }

  function ensureWebInspirationFallback(resources, topic, gradeLabel, options) {
    options = options || {};
    var list = Array.isArray(resources) ? resources.slice() : [];
    return sanitizePedagogicalResourceList(list, topic, gradeLabel)
      .slice(0, options.maxCount != null ? options.maxCount : 12);
  }

  function sanitizePedagogicalResourceList(resources, topic, gradeLabel) {
    var out = [];
    var seen = Object.create(null);
    (resources || []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var rawUrl = String(item.url || item.link || item.href || '').trim();
      if (!rawUrl) return;
      var safeUrl = sanitizePedagogicalResourceUrl(rawUrl, topic, {
        topic: topic,
        gradeLabel: gradeLabel,
        verified: item._verified === true || item._fromCitation === true,
      });
      if (!safeUrl || seen[safeUrl]) return;
      if (!isAllowedPedagogicalUrl(safeUrl)) return;
      seen[safeUrl] = true;
      var copy = Object.assign({}, item, { url: safeUrl });
      if (safeUrl !== rawUrl) {
        copy._sanitized = true;
        copy._originalUrl = rawUrl;
      }
      out.push(copy);
    });
    return out;
  }

  function isAllowedPedagogicalUrl(url) {
    var u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return false;
    if (/pinterest\.|facebook\.com|instagram\.com|youtube\.com|tiktok\.com/i.test(u)) return false;
    if (isSiteRestrictedGoogleSearchUrl(u)) return false;
    if (isBrokenOrGuessedPedagogicalUrl(u)) return false;
    return true;
  }

  return {
    WALDORF_WEB_SEED_DOMAINS: [],
    WALDORF_SEMINAR_SEARCH_TERMS: [],
    ANTI_URL_HALLUCINATION_INSTRUCTION: ANTI_URL_HALLUCINATION_INSTRUCTION,
    buildWaldorfSiteSearchQueries: buildWaldorfSiteSearchQueries,
    buildWaldorfWebSeedInstruction: buildWaldorfWebSeedInstruction,
    buildWebInspirationFallbackResources: buildWebInspirationFallbackResources,
    ensureWebInspirationFallback: ensureWebInspirationFallback,
    sanitizePedagogicalResourceUrl: sanitizePedagogicalResourceUrl,
    sanitizePedagogicalResourceList: sanitizePedagogicalResourceList,
    isAllowedPedagogicalUrl: isAllowedPedagogicalUrl,
    isBrokenOrGuessedPedagogicalUrl: isBrokenOrGuessedPedagogicalUrl,
    isSafeGoogleSiteSearchUrl: isSafeGoogleSiteSearchUrl,
    isSiteRestrictedGoogleSearchUrl: isSiteRestrictedGoogleSearchUrl,
    looksLikeVerifiedDeepLink: looksLikeVerifiedDeepLink,
    findSeedForUrl: function () { return null; },
  };
}));
