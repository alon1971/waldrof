/**
 * Waldorf web research seed — domain whitelist, site: queries, inspiration fallbacks.
 * Shared by api/generate.js (Node) and index.html / research-client.js (browser).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WaldorfWebSeed = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var WALDORF_WEB_SEED_DOMAINS = [
    {
      id: 'waldorf_forum',
      domain: 'waldorf.org.il',
      source: 'הפורום לחינוך וולדורף בישראל',
      label: 'מקור וולדורף רשמי',
      searchPath: '/?s=',
      baseUrl: 'https://www.waldorf.org.il',
    },
    {
      id: 'adam_olam',
      domain: 'adamolam.co.il',
      source: 'מגזין אדם עולם',
      label: 'כתב עת פדגוגי',
      searchPath: '/?s=',
      baseUrl: 'https://www.adamolam.co.il',
    },
    {
      id: 'shaked',
      domain: 'shaked.org.il',
      source: 'בית ספר שקד קריית טבעון',
      label: 'מערך שיעור מאתר בית ספר',
      searchPath: '/?s=',
      baseUrl: 'https://www.shaked.org.il',
    },
    {
      id: 'harduf',
      domain: 'harduf.org.il',
      source: 'בית ספר חרדוף',
      label: 'מערך שיעור מאתר בית ספר',
      searchPath: '/?s=',
      baseUrl: 'https://www.harduf.org.il',
    },
  ];

  var WALDORF_SEMINAR_SEARCH_TERMS = [
    'הרדוף חינוך וולדורף',
    'סמינר שילוב',
    'סמינר דוד ילין וולדורף',
    'בית ספר שקד קרית טבעון וולדורף',
  ];

  function encodeSearchTopic(topic) {
    return encodeURIComponent(String(topic || '').trim());
  }

  function buildDomainSearchUrl(seed, topic) {
    var t = String(topic || '').trim();
    if (!seed || !seed.baseUrl) return '';
    var path = seed.searchPath || '/?s=';
    if (path.indexOf('=') >= 0) {
      return seed.baseUrl + path + encodeSearchTopic(t || 'וולדורף');
    }
    return seed.baseUrl + path + encodeSearchTopic(t || 'וולדורף');
  }

  function buildWaldorfSiteSearchQueries(topic, gradeLabel) {
    var t = String(topic || '').trim();
    var grade = String(gradeLabel || '').trim();
    var queries = [];
    WALDORF_WEB_SEED_DOMAINS.forEach(function (seed) {
      if (!t) return;
      queries.push('site:' + seed.domain + ' ' + t + (grade ? ' ' + grade : '') + ' וולדורף');
      queries.push('site:' + seed.domain + ' ' + t);
    });
    WALDORF_SEMINAR_SEARCH_TERMS.forEach(function (term) {
      if (!t) return;
      queries.push(term + ' ' + t);
    });
    queries.push('site:waldorf.org.il ' + (t || 'וולדורף'));
    queries.push('site:adamolam.co.il ' + (t || 'וולדורף'));
    return queries;
  }

  function buildWaldorfWebSeedInstruction(topic, gradeLabel) {
    var t = String(topic || '').trim() || 'וולדורף';
    var grade = String(gradeLabel || '').trim();
    var lines = [
      'MANDATORY WALDORF DOMAIN WHITELIST — run these site-restricted searches FIRST (before generic web search):',
    ];
    WALDORF_WEB_SEED_DOMAINS.forEach(function (seed) {
      lines.push('- site:' + seed.domain + ' «' + t + '»' + (grade ? ' «' + grade + '»' : '') + ' (' + seed.source + ')');
    });
    WALDORF_SEMINAR_SEARCH_TERMS.forEach(function (term) {
      lines.push('- «' + term + '» + «' + t + '»');
    });
    lines.push(
      'Populate pedagogicalResources ONLY from verified pages on these domains (or AWSNA, Goetheanum, waldorflibrary.org when relevant).',
      'NEVER leave pedagogicalResources empty when any whitelisted domain has topic-related Waldorf material — use the site search index URLs as fallback entries if no deep link is found.'
    );
    return lines.join('\n');
  }

  function buildWebInspirationFallbackResources(topic, gradeLabel) {
    var t = String(topic || '').trim() || 'וולדורף';
    var grade = String(gradeLabel || '').trim();
    var out = [];
    var seen = Object.create(null);
    WALDORF_WEB_SEED_DOMAINS.forEach(function (seed) {
      var url = buildDomainSearchUrl(seed, t);
      if (!url || seen[url]) return;
      seen[url] = true;
      out.push({
        title: seed.source + ' — חיפוש: «' + t + '»',
        url: url,
        label: seed.label,
        source: seed.source,
        snippet: grade
          ? ('אינדקס חיפוש רשמי לנושא «' + t + '» ב' + grade + ' — מקור וולדורפי מומלץ')
          : ('אינדקס חיפוש רשמי לנושא «' + t + '» — מקור וולדורפי מומלץ'),
        _fallback: true,
      });
    });
    return out;
  }

  function ensureWebInspirationFallback(resources, topic, gradeLabel, options) {
    options = options || {};
    var minCount = options.minCount != null ? options.minCount : 2;
    var list = Array.isArray(resources) ? resources.slice() : [];
    var seen = Object.create(null);
    list.forEach(function (item) {
      if (item && item.url) seen[String(item.url).trim()] = true;
    });
    if (list.length >= minCount && !options.force) return list;
    buildWebInspirationFallbackResources(topic, gradeLabel).forEach(function (stub) {
      if (!stub.url || seen[stub.url]) return;
      seen[stub.url] = true;
      list.push(stub);
    });
    return list.slice(0, options.maxCount != null ? options.maxCount : 12);
  }

  function isWhitelistedWaldorfDomain(url) {
    var u = String(url || '').toLowerCase();
    if (!u) return false;
    return WALDORF_WEB_SEED_DOMAINS.some(function (seed) {
      return u.indexOf(seed.domain) >= 0;
    });
  }

  return {
    WALDORF_WEB_SEED_DOMAINS: WALDORF_WEB_SEED_DOMAINS,
    WALDORF_SEMINAR_SEARCH_TERMS: WALDORF_SEMINAR_SEARCH_TERMS,
    buildWaldorfSiteSearchQueries: buildWaldorfSiteSearchQueries,
    buildWaldorfWebSeedInstruction: buildWaldorfWebSeedInstruction,
    buildWebInspirationFallbackResources: buildWebInspirationFallbackResources,
    buildDomainSearchUrl: buildDomainSearchUrl,
    ensureWebInspirationFallback: ensureWebInspirationFallback,
    isWhitelistedWaldorfDomain: isWhitelistedWaldorfDomain,
  };
}));
