/**
 * Query expansion for Direct Drive / catalog navigation search.
 * Combines local pedagogical aliases + optional Gemini synonym expansion.
 */
const env = require('./env');
const catalogTopics = require('./catalog-topics');
const hebrewTopicMatch = require('../hebrew-topic-match');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_EXPAND_MODEL = 'gemini-2.5-flash';

function stableNormalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u05F3\u05F4׳״`'"]/g, '')
    .replace(/[-–—_/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Prefer longer pedagogical phrases, but always keep `priorityTerms` (e.g. the
 * raw user query «תזונה») so Drive `name contains` is not starved by aliases.
 */
function uniqueTerms(terms, limit, priorityTerms) {
  const seen = new Set();
  const out = [];
  const cap = limit || 12;

  function pushTerm(term) {
    const cleaned = String(term || '').trim().replace(/\s+/g, ' ');
    if (!cleaned || cleaned.length < 2 || cleaned.length > 64) return;
    const key = stableNormalize(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  }

  (priorityTerms || []).forEach(pushTerm);

  const rest = [];
  (terms || []).forEach(function (term) {
    const cleaned = String(term || '').trim().replace(/\s+/g, ' ');
    if (!cleaned || cleaned.length < 2 || cleaned.length > 64) return;
    const key = stableNormalize(cleaned);
    if (!key || seen.has(key)) return;
    rest.push(cleaned);
  });
  rest.sort(function (a, b) { return b.length - a.length; });
  for (let i = 0; i < rest.length && out.length < cap; i++) {
    pushTerm(rest[i]);
  }
  return out.slice(0, cap);
}

/**
 * Local expansion: Hebrew morphology + curriculum / catalog aliases.
 * Prefers multi-word phrases over bare single tokens when the query is multi-token.
 */
function expandDriveNavigationQueryLocal(query) {
  const q = String(query || '').trim();
  if (!q) {
    return { query: '', phrases: [], tokens: [], allTerms: [] };
  }

  const phrases = new Set();
  const tokens = new Set();
  phrases.add(q);

  hebrewTopicMatch.expandHebrewSearchTerms(q, 16).forEach(function (term) {
    const t = String(term || '').trim();
    if (!t) return;
    if (t.indexOf(' ') >= 0 || t.length >= 5) phrases.add(t);
    else tokens.add(t);
  });

  catalogTopics.expandCatalogTopicAliases([q].concat(Array.from(phrases))).forEach(function (alias) {
    const a = String(alias || '').trim();
    if (!a) return;
    if (a.indexOf(' ') >= 0 || a.length >= 5) phrases.add(a);
    else tokens.add(a);
  });

  const block = typeof hebrewTopicMatch.findCurriculumTopicBlock === 'function'
    ? hebrewTopicMatch.findCurriculumTopicBlock(q)
    : null;
  if (block && Array.isArray(block.aliases)) {
    block.aliases.forEach(function (alias) {
      const a = String(alias || '').trim();
      if (a) phrases.add(a);
    });
  }
  const overlap = typeof hebrewTopicMatch.findOverlappingTopicCluster === 'function'
    ? hebrewTopicMatch.findOverlappingTopicCluster(q)
    : null;
  if (overlap && Array.isArray(overlap.aliases)) {
    overlap.aliases.forEach(function (alias) {
      const a = String(alias || '').trim();
      if (a) phrases.add(a);
    });
  }

  // Always keep the raw query (+ short Hebrew seeds) so «תזונה» is not dropped
  // when longer aliases like «waldorf nutrition» fill the term budget.
  const prioritySeeds = [q].concat(
    Array.from(tokens).filter(function (t) { return t.length >= 4 && t.length <= 12; })
  );
  const phraseList = uniqueTerms(
    catalogTopics.stripExcludedSearchTerms
      ? catalogTopics.stripExcludedSearchTerms(q, Array.from(phrases))
      : Array.from(phrases),
    12,
    prioritySeeds
  );
  const tokenList = uniqueTerms(
    catalogTopics.stripExcludedSearchTerms
      ? catalogTopics.stripExcludedSearchTerms(q, Array.from(tokens))
      : Array.from(tokens),
    8,
    prioritySeeds
  );
  // Prefer phrases for Drive queries — bare "אדם" alone matches Gilgamesh fullText.
  const driveTerms = phraseList.length
    ? uniqueTerms(
      phraseList.concat(tokenList.filter(function (t) {
        return t.length >= 4;
      })),
      10,
      prioritySeeds
    )
    : uniqueTerms(tokenList, 8, prioritySeeds);

  return {
    query: q,
    phrases: phraseList,
    tokens: tokenList,
    allTerms: driveTerms,
    curriculumBlock: block || null,
    excludedTerms: typeof catalogTopics.getExcludedTermsForQuery === 'function'
      ? catalogTopics.getExcludedTermsForQuery(q)
      : [],
  };
}

function extractGeminiJsonArray(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.terms)) return parsed.terms;
  } catch (e) {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) return parsed;
      } catch (e2) { /* ignore */ }
    }
  }
  return [];
}

async function expandDriveNavigationQueryWithGemini(query, localExpansion) {
  const apiKey = env.getGeminiApiKey && env.getGeminiApiKey();
  if (!apiKey) return localExpansion;

  const q = String(query || '').trim();
  if (!q) return localExpansion;

  const url = GEMINI_API_BASE + '/models/' + encodeURIComponent(GEMINI_EXPAND_MODEL) + ':generateContent';
  const systemPrompt = [
    'You expand Waldorf / Steiner teacher catalog search queries in Hebrew.',
    'Return ONLY a JSON array of 4-8 short Hebrew (or English) synonyms / folder-name variants.',
    'Stay on the same pedagogical topic. Do not add unrelated epochs or myths.',
    'Example: "אדם חיה" → ["אדם וחיות","אדם חיות","האדם בממלכת החי","ממלכת החי"].',
  ].join(' ');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: 'Query: ' + q }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 256,
          responseMimeType: 'application/json',
        },
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      console.warn('[drive-query-expand] Gemini HTTP', res.status, raw.slice(0, 160));
      return localExpansion;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      return localExpansion;
    }
    const text = (((payload.candidates || [])[0] || {}).content || {}).parts || [];
    const joined = text.map(function (part) {
      return part && part.text ? part.text : '';
    }).join('');
    const geminiTerms = extractGeminiJsonArray(joined)
      .map(function (term) { return String(term || '').trim(); })
      .filter(Boolean);
    const safeGeminiTerms = catalogTopics.stripExcludedSearchTerms
      ? catalogTopics.stripExcludedSearchTerms(q, geminiTerms)
      : geminiTerms;

    const mergedPhrases = uniqueTerms(
      (localExpansion.phrases || []).concat(safeGeminiTerms),
      12,
      [q]
    );
    const mergedAll = uniqueTerms(
      mergedPhrases.concat(localExpansion.tokens || []),
      10,
      [q]
    );
    return Object.assign({}, localExpansion, {
      phrases: mergedPhrases,
      allTerms: mergedAll,
      geminiExpanded: safeGeminiTerms.length > 0,
    });
  } catch (err) {
    console.warn('[drive-query-expand] Gemini failed:', err.message || err);
    return localExpansion;
  }
}

async function expandDriveNavigationQuery(query, options) {
  const opts = options || {};
  const local = expandDriveNavigationQueryLocal(query);
  if (opts.skipGemini === true) return local;
  return expandDriveNavigationQueryWithGemini(query, local);
}

/**
 * Central (name/folder) relevance — rejects fullText-only false positives like גילגמש.
 */
function scoreCentralDriveRelevance(query, hit, expansion) {
  const q = String(query || '').trim();
  const exp = expansion || expandDriveNavigationQueryLocal(q);
  const central = stableNormalize([
    hit && hit.fileName,
    hit && hit.title,
    hit && hit.displayTitle,
    hit && hit.catalogTopic,
    hit && hit.topic,
    hit && hit.locationPath,
    hit && hit.drivePath,
    hit && hit.pathLabels,
  ].filter(Boolean).join(' '));
  if (!central) return 0;

  const phrases = exp.phrases || [];
  for (let i = 0; i < phrases.length; i++) {
    const phrase = stableNormalize(phrases[i]);
    if (phrase.length >= 4 && central.indexOf(phrase) >= 0) {
      return phrase.length >= 8 ? 1 : 0.92;
    }
    if (
      phrase.length >= 4
      && typeof hebrewTopicMatch.aliasMatchesQueryByTokens === 'function'
      && hebrewTopicMatch.aliasMatchesQueryByTokens(phrase, central)
    ) {
      return 0.9;
    }
  }

  const queryTokens = typeof hebrewTopicMatch.extractMeaningfulTokens === 'function'
    ? hebrewTopicMatch.extractMeaningfulTokens(q)
    : q.split(/\s+/).filter(function (t) { return t.length >= 2; });
  if (queryTokens.length >= 2) {
    const matched = queryTokens.filter(function (qt) {
      if (central.indexOf(stableNormalize(qt)) >= 0) return true;
      const centralTokens = hebrewTopicMatch.extractMeaningfulTokens(central);
      return centralTokens.some(function (ct) {
        return hebrewTopicMatch.hebrewTokensRelated
          ? hebrewTopicMatch.hebrewTokensRelated(qt, ct)
          : stableNormalize(ct) === stableNormalize(qt);
      });
    });
    if (matched.length >= queryTokens.length) return 0.88;
    if (matched.length >= 2) return 0.75;
    return 0;
  }

  if (queryTokens.length === 1) {
    const token = stableNormalize(queryTokens[0]);
    if (token.length >= 3 && central.indexOf(token) >= 0) return 0.8;
  }
  return 0;
}

function isCentralDriveHitRelevant(query, hit, expansion) {
  if (scoreCentralDriveRelevance(query, hit, expansion) < 0.75) return false;
  // Active exclude: rival mythology / epoch folders must never pass central relevance.
  if (typeof catalogTopics.topicsAreMutuallyExcluded === 'function') {
    const rivalHay = [
      hit && hit.catalogTopic,
      hit && hit.topic,
      hit && hit.fileName,
      hit && hit.title,
      hit && hit.locationPath,
      hit && hit.drivePath,
    ].filter(Boolean).join(' ');
    if (catalogTopics.topicsAreMutuallyExcluded(query, rivalHay)) return false;
  }
  return true;
}

module.exports = {
  expandDriveNavigationQueryLocal,
  expandDriveNavigationQuery,
  expandDriveNavigationQueryWithGemini,
  scoreCentralDriveRelevance,
  isCentralDriveHitRelevant,
  uniqueTerms,
};
