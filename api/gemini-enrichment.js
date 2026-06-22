/**
 * Gemini + Google Search enrichment links — dynamic topic/grade queries only.
 * Article URLs must appear in grounding metadata (anti-hallucination).
 * Pinterest search URLs are built from topic + grade (no hardcoded domain lists).
 */
'use strict';

const env = require('./env');
const jsonRepair = require('./json-repair');
const enrichmentLinks = require('./enrichment-links');
const waldorfQueryGen = require('../waldorf-query-generation');

const { cleanAndParseJSON } = jsonRepair;

const GEMINI_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_ATTEMPTS = 2;

const ENRICHMENT_GEMINI_SYSTEM =
  'You are a Waldorf / Steiner pedagogy research curator.\n' +
  'Use Google Search to find REAL, verified pedagogical resources for the requested topic and grade.\n' +
  'STRICT ANTI-HALLUCINATION: include article URLs ONLY when they appear in your live search results — never invent paths or domains.\n' +
  'Do NOT use hardcoded website lists, site: operators, or model memory for URLs.\n' +
  'Quality over quantity: return fewer links rather than filler. If search finds no verified article URLs, return an empty article_links array.\n' +
  'Pinterest entries must be full https://www.pinterest.com/search/pins/?q=… URLs with grade-locked English queries (Waldorf Class N {topic}).';

function buildDynamicSearchContext(body) {
  const topic = String((body && body.topic) || (body && body.activityTitle) || '').trim();
  const gradeLabel = String((body && body.gradeLabel) || '').trim();
  const gradeId = String((body && (body.currentGrade ?? body.gradeId)) || '').trim();
  const englishTopic = waldorfQueryGen.resolveEnglishTopic
    ? waldorfQueryGen.resolveEnglishTopic(topic)
    : waldorfQueryGen.translateTopicToEnglish(topic);
  const isOverride = waldorfQueryGen.isPedagogicalScopeOverridden
    ? waldorfQueryGen.isPedagogicalScopeOverridden(body)
    : false;
  return {
    topic: topic,
    englishTopic: englishTopic,
    gradeLabel: gradeLabel,
    gradeId: gradeId,
    isOverride: isOverride,
    searchQueryHe: topic + ' חינוך וולדורף' + (gradeLabel ? ' ' + gradeLabel : ''),
    searchQueryEn: 'Waldorf ' + englishTopic + (gradeId ? ' Grade ' + gradeId : '') + ' pedagogy main lesson',
  };
}

function buildDynamicPinterestLinks(body) {
  const topic = String((body && body.topic) || '').trim();
  const stubs = waldorfQueryGen.buildPinterestGalleryForTopic(topic, body || {});
  return stubs.slice(0, enrichmentLinks.ENRICHMENT_LINKS_MAX).map(function (item) {
    return {
      title: item.title,
      url: item.url,
      query: item.pin,
      pin: item.pin,
      board: item.board,
    };
  });
}

function getEnrichmentResponseSchema() {
  return {
    type: 'object',
    properties: {
      enrichment_links: {
        type: 'object',
        properties: {
          pinterest_links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                query: { type: 'string' },
              },
              required: ['title', 'url'],
            },
            maxItems: enrichmentLinks.ENRICHMENT_LINKS_MAX,
          },
          article_links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                source: { type: 'string' },
                label: { type: 'string' },
                snippet: { type: 'string' },
              },
              required: ['title', 'url'],
            },
            maxItems: enrichmentLinks.ENRICHMENT_LINKS_MAX,
          },
        },
        required: ['pinterest_links', 'article_links'],
      },
    },
    required: ['enrichment_links'],
  };
}

function extractGeminiText(payload) {
  const candidates = payload && payload.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return '';
  const parts = candidates[0].content && candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(function (part) {
    return part && typeof part.text === 'string' ? part.text : '';
  }).join('').trim();
}

function extractGroundingUris(payload) {
  const uris = new Set();
  const candidates = (payload && payload.candidates) || [];
  candidates.forEach(function (c) {
    const gm = c && c.groundingMetadata;
    if (!gm) return;
    (gm.groundingChunks || []).forEach(function (chunk) {
      const uri = chunk && chunk.web && chunk.web.uri;
      if (uri) uris.add(String(uri).trim());
    });
  });
  return uris;
}

function normalizeGroundedUri(uri) {
  const u = String(uri || '').trim();
  if (!u) return '';
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (e) {
    return u.replace(/\/$/, '');
  }
}

function uriMatchesGrounding(candidateUrl, groundingUris) {
  const norm = normalizeGroundedUri(candidateUrl);
  if (!norm || !groundingUris.size) return false;
  for (const grounded of groundingUris) {
    const g = normalizeGroundedUri(grounded);
    if (!g) continue;
    if (norm === g) return true;
    if (norm.indexOf(g) === 0 || g.indexOf(norm) === 0) return true;
  }
  return false;
}

function filterArticleLinksToGrounded(articleLinks, groundingUris) {
  const seen = Object.create(null);
  const out = [];
  const useStrictGrounding = groundingUris && groundingUris.size > 0;

  (Array.isArray(articleLinks) ? articleLinks : []).forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    const url = String(item.url || item.link || '').trim();
    if (!enrichmentLinks.isVerifiedArticleUrl(url)) return;
    if (useStrictGrounding && !uriMatchesGrounding(url, groundingUris)) return;
    if (seen[url]) return;
    seen[url] = true;
    const meta = enrichmentLinks.inferResourceMetaFromUrl(url);
    out.push({
      title: String(item.title || meta.source || '').trim() || meta.source,
      url: url,
      source: String(item.source || meta.source || '').trim() || meta.source,
      label: String(item.label || meta.label || '').trim() || meta.label,
      snippet: String(item.snippet || item.description || '').trim(),
      _fromGeminiSearch: true,
    });
  });
  return out.slice(0, enrichmentLinks.ENRICHMENT_LINKS_MAX);
}

function mergePinterestLinkLists(primary, secondary) {
  const seen = Object.create(null);
  const out = [];
  function pushItem(item) {
    if (!item || typeof item !== 'object') return;
    const url = String(item.url || '').trim();
    const query = String(item.query || item.pin || '').trim();
    const key = url || query;
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push(item);
  }
  (Array.isArray(primary) ? primary : []).forEach(pushItem);
  (Array.isArray(secondary) ? secondary : []).forEach(pushItem);
  return out.slice(0, enrichmentLinks.ENRICHMENT_LINKS_MAX);
}

function buildGeminiEnrichmentUserPrompt(body) {
  const ctx = buildDynamicSearchContext(body);
  if (!ctx.topic || !ctx.gradeId) {
    console.warn('[gemini-enrichment] incomplete enrichment context — topic:', ctx.topic || '(missing)',
      'gradeId:', ctx.gradeId || '(missing)');
  }
  const overrideBlock = ctx.isOverride
    ? (
      '\nTEACHER CURRICULUM OVERRIDE (MANDATORY): The teacher explicitly bypassed grade-topic validation. ' +
      'Search and return resources for Subject «' + ctx.topic + '» at Grade «' + ctx.gradeLabel + '» (id ' + ctx.gradeId + ') — ' +
      'English subject keywords: «' + ctx.englishTopic + '». Do NOT return empty arrays solely because of curriculum mismatch.\n'
    )
    : '';
  return (
    '=== LIVE SEARCH — ENRICHMENT LINKS (TOPIC + GRADE) ===\n' +
    'Subject (Hebrew): «' + ctx.topic + '»\n' +
    'Subject (English keywords): «' + ctx.englishTopic + '»\n' +
    'Grade: ' + (ctx.gradeLabel || ('Grade ' + ctx.gradeId)) + ' (id ' + ctx.gradeId + ')\n' +
    overrideBlock +
    'Search queries to use:\n' +
    '- Hebrew: «' + ctx.searchQueryHe + '»\n' +
    '- English: «' + ctx.searchQueryEn + '»\n\n' +
    'Tasks:\n' +
    '1. pinterest_links: up to ' + enrichmentLinks.ENRICHMENT_LINKS_MAX + ' DISTINCT Pinterest SEARCH URLs ' +
    '(https://www.pinterest.com/search/pins/?q=…) — use grade-locked English phrases such as:\n' +
    '   • Waldorf Class ' + (ctx.gradeId || 'N') + ' ' + ctx.englishTopic + '\n' +
    '   • ' + ctx.englishTopic + ' Waldorf Grade ' + (ctx.gradeId || 'N') + ' main lesson book\n' +
    '   • Waldorf blackboard drawing ' + ctx.englishTopic + ' Class ' + (ctx.gradeId || 'N') + '\n' +
    '2. article_links: up to ' + enrichmentLinks.ENRICHMENT_LINKS_MAX + ' Waldorf/anthroposophic article URLs found ONLY via live search — ' +
    'each must be a real HTTPS page you actually retrieved for «' + ctx.topic + '» at grade ' + ctx.gradeId + '. ' +
    'If none found, return [].\n\n' +
    'Return JSON: { "enrichment_links": { "pinterest_links": [...], "article_links": [...] } }\n' +
    '=== END LIVE SEARCH ===\n'
  );
}

async function callGeminiWithGoogleSearch(systemPrompt, userPrompt) {
  const apiKey = env.getGeminiApiKey();
  if (!apiKey) {
    throw new Error('שגיאה: מפתח GEMINI_API_KEY לא מוגדר בשרת');
  }

  const url = API_BASE + '/models/' + encodeURIComponent(GEMINI_MODEL) + ':generateContent';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: getEnrichmentResponseSchema(),
      },
    }),
  });

  const raw = await res.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new Error('Gemini returned non-JSON response (' + res.status + '): ' + raw.slice(0, 300));
  }

  if (!res.ok) {
    const msg = payload.error && payload.error.message ? payload.error.message : raw.slice(0, 300);
    const err = new Error('Gemini error ' + res.status + ': ' + msg);
    if (res.status === 429 || res.status === 400 || res.status === 403) err.statusCode = res.status;
    throw err;
  }

  return payload;
}

/**
 * Fetch enrichment_links via Gemini Google Search + dynamic Pinterest builders.
 * @returns {Promise<{ pinterest_links: object[], article_links: object[] }>}
 */
async function fetchGeminiEnrichmentLinks(body) {
  const enrichmentBody = body && typeof body === 'object' ? body : {};
  const topic = String(enrichmentBody.topic || enrichmentBody.activityTitle || '').trim();
  const gradeId = String(enrichmentBody.currentGrade ?? enrichmentBody.gradeId ?? '').trim();
  if (!topic || !gradeId) {
    console.warn('[gemini-enrichment] fetchGeminiEnrichmentLinks missing topic or grade —',
      'topic:', topic || '(empty)', 'gradeId:', gradeId || '(empty)');
  }

  const pinterestFromQuery = buildDynamicPinterestLinks(enrichmentBody);
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const payload = await callGeminiWithGoogleSearch(
        ENRICHMENT_GEMINI_SYSTEM,
        buildGeminiEnrichmentUserPrompt(enrichmentBody)
      );
      const text = extractGeminiText(payload);
      if (!text) throw new Error('Gemini returned empty enrichment response');

      const parsed = cleanAndParseJSON(text, {
        phase: 'enrichment_links',
        context: enrichmentBody,
        fallbackOnError: false,
        unwrap: true,
      });
      const links = parsed && parsed.enrichment_links ? parsed.enrichment_links : parsed;
      const groundingUris = extractGroundingUris(payload);
      if (!groundingUris.size) {
        console.warn('[gemini-enrichment] no grounding URIs in response — using URL verification fallback for articles');
      }

      const geminiPinterest = Array.isArray(links.pinterest_links) ? links.pinterest_links : [];
      const mergedPinterest = mergePinterestLinkLists(pinterestFromQuery, geminiPinterest);
      const article_links = filterArticleLinksToGrounded(
        Array.isArray(links.article_links) ? links.article_links : [],
        groundingUris
      );

      if (!mergedPinterest.length && !article_links.length) {
        console.warn('[gemini-enrichment] empty enrichment result for topic:', topic, 'grade:', gradeId);
      }

      return {
        pinterest_links: mergedPinterest.length ? mergedPinterest : pinterestFromQuery,
        article_links: article_links,
      };
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_ATTEMPTS || (err.statusCode && err.statusCode !== 429)) break;
    }
  }

  console.warn('[gemini-enrichment] search failed, Pinterest-only fallback:', lastErr && lastErr.message);
  return {
    pinterest_links: pinterestFromQuery,
    article_links: [],
  };
}

module.exports = {
  fetchGeminiEnrichmentLinks,
  buildDynamicPinterestLinks,
  buildDynamicSearchContext,
  mergePinterestLinkLists,
  extractGroundingUris,
  filterArticleLinksToGrounded,
};
