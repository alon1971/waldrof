/**
 * Waldorf web research seed — domain whitelist, safe search fallbacks, URL sanitizer.
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

  var GOOGLE_SEARCH_BASE = 'https://www.google.com/search?q=';

  var WALDORF_WEB_SEED_DOMAINS = [
    {
      id: 'waldorf_forum',
      domain: 'waldorf.org.il',
      searchDomains: ['waldorf.org.il'],
      source: 'הפורום לחינוך וולדורף בישראל',
      label: 'מקור וולדורף רשמי',
      baseUrl: 'https://www.waldorf.org.il',
      fallbackMode: 'google_site',
      searchExtra: 'וולדורף',
    },
    {
      id: 'adam_olam',
      domain: 'adamolam.co.il',
      searchDomains: ['adamolam.co.il'],
      source: 'מגזין אדם עולם',
      label: 'כתב עת פדגוגי',
      baseUrl: 'https://www.adamolam.co.il',
      fallbackMode: 'google_site',
      searchExtra: 'וולדורף',
    },
    {
      id: 'shaked',
      domain: 'shakedwaldorf.org.il',
      searchDomains: ['shakedwaldorf.org.il', 'shakedtivon.edupage.org'],
      brokenDomains: ['shaked.org.il'],
      source: 'בית ספר שקד קריית טבעון',
      label: 'מערך שיעור מאתר בית ספר',
      baseUrl: 'https://www.shakedwaldorf.org.il',
      portalUrl: 'https://shakedtivon.edupage.org',
      fallbackMode: 'google_site',
      searchExtra: 'וולדורף שקד קריית טבעון',
    },
    {
      id: 'harduf',
      domain: 'harduf-waldorf.org.il',
      searchDomains: ['harduf-waldorf.org.il'],
      brokenDomains: ['harduf.org.il'],
      source: 'בית ספר ולדורף הרדוף',
      label: 'מערך שיעור מאתר בית ספר',
      baseUrl: 'https://harduf-waldorf.org.il',
      fallbackMode: 'google_site',
      searchExtra: 'וולדורף הרדוף',
    },
  ];

  var WALDORF_SEMINAR_SEARCH_TERMS = [
    'הרדוף חינוך וולדורף',
    'סמינר שילוב',
    'סמינר דוד ילין וולדורף',
    'בית ספר שקד קרית טבעון וולדורף',
  ];

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

  function encodeGoogleQuery(parts) {
    return parts.filter(Boolean).map(function (p) {
      return String(p).trim();
    }).filter(Boolean).join(' ');
  }

  function buildGoogleSiteSearchUrl(searchDomains, topic, extraTerms) {
    var domains = Array.isArray(searchDomains) ? searchDomains : [searchDomains];
    var domain = domains[0];
    if (!domain) return '';
    var query = encodeGoogleQuery([
      'site:' + domain,
      topic,
      extraTerms,
      'וולדורף',
    ]);
    return GOOGLE_SEARCH_BASE + encodeURIComponent(query);
  }

  function findSeedForUrl(url) {
    var u = String(url || '').toLowerCase();
    if (!u) return null;
    for (var i = 0; i < WALDORF_WEB_SEED_DOMAINS.length; i++) {
      var seed = WALDORF_WEB_SEED_DOMAINS[i];
      var domains = [seed.domain].concat(seed.searchDomains || [], seed.brokenDomains || []);
      for (var j = 0; j < domains.length; j++) {
        if (u.indexOf(String(domains[j]).toLowerCase()) >= 0) return seed;
      }
    }
    if (/google\.com\/search/i.test(u) && /site%3A|site:/i.test(u)) {
      for (var k = 0; k < WALDORF_WEB_SEED_DOMAINS.length; k++) {
        var s = WALDORF_WEB_SEED_DOMAINS[k];
        var searchList = [s.domain].concat(s.searchDomains || []);
        for (var m = 0; m < searchList.length; m++) {
          if (u.indexOf(encodeURIComponent('site:' + searchList[m]).toLowerCase()) >= 0 ||
              u.indexOf('site:' + searchList[m].toLowerCase()) >= 0) {
            return s;
          }
        }
      }
    }
    return null;
  }

  function findSeedById(id) {
    for (var i = 0; i < WALDORF_WEB_SEED_DOMAINS.length; i++) {
      if (WALDORF_WEB_SEED_DOMAINS[i].id === id) return WALDORF_WEB_SEED_DOMAINS[i];
    }
    return null;
  }

  function isSafeGoogleSiteSearchUrl(url) {
    var u = String(url || '').trim();
    if (!/^https?:\/\/(www\.)?google\.com\/search\?/i.test(u)) return false;
    return /site%3A|site:/i.test(u);
  }

  function isBrokenOrGuessedPedagogicalUrl(url) {
    var u = String(url || '').trim();
    if (!u) return true;
    if (isSafeGoogleSiteSearchUrl(u)) return false;

    for (var i = 0; i < BROKEN_URL_PATTERNS.length; i++) {
      if (BROKEN_URL_PATTERNS[i].test(u)) return true;
    }

    var seed = findSeedForUrl(u);
    if (!seed) return false;

    if (seed.brokenDomains && seed.brokenDomains.some(function (d) {
      return u.toLowerCase().indexOf(d.toLowerCase()) >= 0;
    })) {
      return true;
    }

    try {
      var parsed = new URL(u);
      var path = parsed.pathname || '/';
      var isRootish = path === '/' || path === '/index.html' || path === '/index.php';
      if (isRootish && !parsed.search) return true;

      for (var j = 0; j < INVENTED_SEARCH_PATTERNS.length; j++) {
        if (INVENTED_SEARCH_PATTERNS[j].test(u)) {
          if (seed.id === 'shaked' || seed.id === 'harduf') return true;
          if (seed.id === 'waldorf_forum' || seed.id === 'adam_olam') {
            if (itemLooksInvented(u)) return true;
          }
        }
      }
    } catch (e) {
      return true;
    }

    return false;
  }

  function itemLooksInvented(url) {
    var u = String(url || '');
    if (/\?s=/.test(u)) {
      try {
        var parsed = new URL(u);
        var q = parsed.searchParams.get('s') || '';
        if (q && q.length > 0) return true;
      } catch (e) {
        return true;
      }
    }
    return false;
  }

  function looksLikeVerifiedDeepLink(url) {
    var u = String(url || '').trim();
    if (!u || isBrokenOrGuessedPedagogicalUrl(u)) return false;
    if (isSafeGoogleSiteSearchUrl(u)) return true;

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

  function buildFallbackSearchUrl(seed, topic, gradeLabel) {
    if (!seed) return '';
    var t = String(topic || '').trim() || 'וולדורף';
    var grade = String(gradeLabel || '').trim();
    var extra = [seed.searchExtra || 'וולדורף', grade].filter(Boolean).join(' ');
    return buildGoogleSiteSearchUrl(seed.searchDomains || [seed.domain], t, extra);
  }

  function buildDomainSearchUrl(seed, topic, gradeLabel) {
    return buildFallbackSearchUrl(seed, topic, gradeLabel);
  }

  function sanitizePedagogicalResourceUrl(url, topic, context) {
    context = context || {};
    var u = String(url || '').trim();
    if (!u) return '';

    if (isSafeGoogleSiteSearchUrl(u) && !isBrokenOrGuessedPedagogicalUrl(u)) return u;

    if (context.verified === true && looksLikeVerifiedDeepLink(u)) return u;

    if (looksLikeVerifiedDeepLink(u) && !isBrokenOrGuessedPedagogicalUrl(u)) return u;

    var seed = findSeedForUrl(u) ||
      (context.seedId ? findSeedById(context.seedId) : null);
    var t = String(topic || context.topic || '').trim() || 'וולדורף';
    var grade = String(context.gradeLabel || '').trim();

    if (seed) {
      return buildFallbackSearchUrl(seed, t, grade);
    }

    if (isBrokenOrGuessedPedagogicalUrl(u)) {
      return buildGoogleSiteSearchUrl('waldorf.org.il', t, 'וולדורף');
    }

    return u;
  }

  function buildWaldorfSiteSearchQueries(topic, gradeLabel) {
    var t = String(topic || '').trim();
    var grade = String(gradeLabel || '').trim();
    var queries = [];
    WALDORF_WEB_SEED_DOMAINS.forEach(function (seed) {
      if (!t) return;
      (seed.searchDomains || [seed.domain]).forEach(function (domain) {
        queries.push('site:' + domain + ' ' + t + (grade ? ' ' + grade : '') + ' וולדורף');
      });
    });
    WALDORF_SEMINAR_SEARCH_TERMS.forEach(function (term) {
      if (!t) return;
      queries.push(term + ' ' + t);
    });
    return queries;
  }

  var ANTI_URL_HALLUCINATION_INSTRUCTION =
    '=== ANTI URL HALLUCINATION (ABSOLUTE — PEDAGOGICAL RESOURCES) ===\n' +
    'STRICTLY FORBIDDEN to invent, guess, or format static URLs for Israeli Waldorf institutions.\n' +
    'NEVER append paths or query strings (e.g. /?s=, /http_new/, index.asp) unless that EXACT URL appeared in your live search citations.\n' +
    'BROKEN / FORBIDDEN domains for direct links: shaked.org.il (use shakedwaldorf.org.il), harduf.org.il search/login pages (use harduf-waldorf.org.il).\n' +
    'If you lack a verified deep link from live search, OMIT the url field — the system will inject safe Google site: search redirects.\n' +
    'ONLY include url when copied verbatim from a citation returned by web search (full HTTPS path to an article/PDF/page).\n' +
    '=== END ANTI URL HALLUCINATION ===\n';

  function buildWaldorfWebSeedInstruction(topic, gradeLabel) {
    var t = String(topic || '').trim() || 'וולדורף';
    var grade = String(gradeLabel || '').trim();
    var lines = [
      ANTI_URL_HALLUCINATION_INSTRUCTION,
      'MANDATORY WALDORF DOMAIN WHITELIST — run these site-restricted Google searches FIRST (before generic web search):',
    ];
    WALDORF_WEB_SEED_DOMAINS.forEach(function (seed) {
      (seed.searchDomains || [seed.domain]).forEach(function (domain) {
        lines.push('- site:' + domain + ' «' + t + '»' + (grade ? ' «' + grade + '»' : '') + ' (' + seed.source + ')');
      });
    });
    WALDORF_SEMINAR_SEARCH_TERMS.forEach(function (term) {
      lines.push('- «' + term + '» + «' + t + '»');
    });
    lines.push(
      'Populate pedagogicalResources ONLY with URLs copied verbatim from live search citations (deep article/PDF pages).',
      'NEVER fabricate search-index URLs. If no verified deep link exists for a source, omit that item — safe fallback links are added server-side.',
      'Verified school domains: shakedwaldorf.org.il, shakedtivon.edupage.org, harduf-waldorf.org.il — NOT shaked.org.il or harduf.org.il/?s=…'
    );
    return lines.join('\n');
  }

  function buildWebInspirationFallbackResources(topic, gradeLabel) {
    var t = String(topic || '').trim() || 'וולדורף';
    var grade = String(gradeLabel || '').trim();
    var out = [];
    var seen = Object.create(null);
    WALDORF_WEB_SEED_DOMAINS.forEach(function (seed) {
      var url = buildFallbackSearchUrl(seed, t, grade);
      if (!url || seen[url]) return;
      seen[url] = true;
      out.push({
        title: seed.source + ' — חיפוש: «' + t + '»',
        url: url,
        label: seed.label,
        source: seed.source,
        snippet: grade
          ? ('חיפוש Google מוגבל לאתר — נושא «' + t + '» ב' + grade)
          : ('חיפוש Google מוגבל לאתר — נושא «' + t + '»'),
        _fallback: true,
        _safeSearch: true,
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
    if (list.length >= minCount && !options.force) return sanitizePedagogicalResourceList(list, topic, gradeLabel);
    buildWebInspirationFallbackResources(topic, gradeLabel).forEach(function (stub) {
      if (!stub.url || seen[stub.url]) return;
      seen[stub.url] = true;
      list.push(stub);
    });
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

  function isWhitelistedWaldorfDomain(url) {
    return Boolean(findSeedForUrl(url));
  }

  function isAllowedPedagogicalUrl(url) {
    var u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return false;
    if (/pinterest\.|facebook\.com|instagram\.com|youtube\.com|tiktok\.com/i.test(u)) return false;
    if (isSafeGoogleSiteSearchUrl(u)) return true;
    if (isBrokenOrGuessedPedagogicalUrl(u)) return false;

    var international = [
      /waldorf\.org\.il/i, /adamolam\.co\.il/i, /shakedwaldorf\.org\.il/i,
      /shakedtivon\.edupage\.org/i, /harduf-waldorf\.org\.il/i,
      /goetheanum/i, /waldorfeducation\.org|awsna/i, /waldorf-world|waldorfworld/i,
      /iaswece/i, /waldorflibrary/i, /rsarchive|steinerarchive/i,
      /anthroposophy/i, /waldorf/i,
    ];
    return international.some(function (p) { return p.test(u); });
  }

  return {
    WALDORF_WEB_SEED_DOMAINS: WALDORF_WEB_SEED_DOMAINS,
    WALDORF_SEMINAR_SEARCH_TERMS: WALDORF_SEMINAR_SEARCH_TERMS,
    ANTI_URL_HALLUCINATION_INSTRUCTION: ANTI_URL_HALLUCINATION_INSTRUCTION,
    buildWaldorfSiteSearchQueries: buildWaldorfSiteSearchQueries,
    buildWaldorfWebSeedInstruction: buildWaldorfWebSeedInstruction,
    buildWebInspirationFallbackResources: buildWebInspirationFallbackResources,
    buildDomainSearchUrl: buildDomainSearchUrl,
    buildGoogleSiteSearchUrl: buildGoogleSiteSearchUrl,
    buildFallbackSearchUrl: buildFallbackSearchUrl,
    ensureWebInspirationFallback: ensureWebInspirationFallback,
    sanitizePedagogicalResourceUrl: sanitizePedagogicalResourceUrl,
    sanitizePedagogicalResourceList: sanitizePedagogicalResourceList,
    isWhitelistedWaldorfDomain: isWhitelistedWaldorfDomain,
    isAllowedPedagogicalUrl: isAllowedPedagogicalUrl,
    isBrokenOrGuessedPedagogicalUrl: isBrokenOrGuessedPedagogicalUrl,
    isSafeGoogleSiteSearchUrl: isSafeGoogleSiteSearchUrl,
    looksLikeVerifiedDeepLink: looksLikeVerifiedDeepLink,
    findSeedForUrl: findSeedForUrl,
  };
}));
