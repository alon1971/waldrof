/**
 * POST /api/pure-phase-c — unified Step B→C synthesis via Perplexity with topic_master archive cache.
 * Body: { grade, gradeId, topic }
 */
const shared = require('./pure-api-shared');
const cache = require('./cache');
const perplexityClient = require('./perplexity-client');

const SYSTEM_PROMPT = [
  'You are a Waldorf / anthroposophical pedagogy expert.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'theory (object: {title, sections: [{heading, content, icon?}], bibliography: {books, articles, websites: [{title, url?}]}} — rich theoretical background for the grade+topic),',
  'inspiration (object: {title, global: [{title, items: [strings]}], podcast: {title, episodes: [{theme, insight}]}, narrative: [strings]} — artistic/pedagogical classroom inspiration),',
  'pinterest_links (array of objects: {title, url, board} — 4-8 live Pinterest board or curated pin URLs for this grade+topic Waldorf visual inspiration),',
  'pedagogical_resources (array of objects: {title, url, label, source, snippet} — live professional inspiration links for teachers),',
  'core_emphases (string: AT LEAST 3-4 comprehensive Hebrew paragraphs with a dedicated Developmental Compass block — מצפן התפתחותי / רציונל התפתחותי ומצפן למורה — covering why-this-age, inner developmental milestone, teacher attitude/rhythm, and concrete pedagogical goals; NEVER brief or truncated),',
  'key_points (array of exactly 5-6 substantial Hebrew strings — each 2-4 sentences on lesson-block dynamics, transitions, or core concepts; NOT terse one-liners; NEVER empty),',
  'recommended_reading (array of 5-8 objects: {title, author, note} — note MUST be 1-2 sentences on what the source covers and why it is relevant; NEVER an empty array),',
  'relevant_links (array of 6-8 objects: {title, url} — title MUST include short context after em dash/colon; live Steiner archives, Waldorf Library, professional essays; NEVER an empty array).',
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
    return {
      title: String(item.title || item.name || url).trim(),
      url: url,
      label: String(item.label || item.type || item.category || 'מאמר פדגוגי').trim(),
      source: String(item.source || item.publisher || '').trim(),
      snippet: String(item.snippet || item.description || item.summary || '').trim(),
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
          heading: String(sec.heading || sec.title || '').trim(),
          content: shared.coerceText(sec.content || sec.text || sec.body || sec),
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
    const podcast = insp.podcast && typeof insp.podcast === 'object' ? {
      title: String(insp.podcast.title || 'תובנות').trim(),
      episodes: Array.isArray(insp.podcast.episodes) ? insp.podcast.episodes.map(function (ep) {
        if (!ep || typeof ep !== 'object') return { theme: '', insight: shared.coerceText(ep) };
        return {
          theme: String(ep.theme || ep.title || '').trim(),
          insight: shared.coerceText(ep.insight || ep.text || ep.content),
        };
      }).filter(function (ep) { return ep.theme || ep.insight; }) : [],
    } : { title: 'תובנות', episodes: [] };
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
  const relevantLinks = shared.coerceLinks(
    data.relevant_links || data.links || data.professional_links ||
    nested.relevant_links || (deepObj && deepObj.relevant_links)
  );
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
  return {
    theory: normalizeTheoryBlock(data, grade, topic),
    inspiration: normalizeInspirationBlock(data, topic),
    pinterest_links: pinterestLinks,
    pedagogical_resources: pedagogicalResources.length ? pedagogicalResources : relevantLinks.map(function (link) {
      return { title: link.title, url: link.url, label: 'מאמר פדגוגי', source: '', snippet: '' };
    }),
    core_emphases: coreEmphases,
    key_points: keyPoints,
    recommended_reading: recommendedReading,
    relevant_links: relevantLinks,
  };
}

function resolveGradeId(body) {
  const fromBody = String(body.gradeId || body.currentGrade || '').trim();
  if (fromBody) return fromBody;
  const grade = String(body.grade || body.gradeLabel || '').trim();
  const digit = grade.match(/[1-8]/);
  return digit ? digit[0] : '';
}

function safeNormalizePhaseCResponse(parsed, grade, topic) {
  try {
    return normalizePhaseCResponse(parsed, grade, topic);
  } catch (normErr) {
    console.warn('[pure-phase-c] normalizePhaseCResponse failed:', normErr.message || normErr);
    const plain = shared.coerceText(parsed);
    const topicStr = String(topic || 'נושא').trim();
    return normalizePhaseCResponse({
      theory: {
        title: 'רקע תיאורטי — ' + topicStr,
        sections: [{ heading: 'תוכן', content: plain || 'לא ניתן לעבד את התשובה.', icon: 'fa-compass' }],
      },
      core_emphases: plain,
      _normalizeFallback: true,
    }, grade, topicStr);
  }
}

async function runPurePhaseC(body) {
  const grade = String(body.grade || body.gradeLabel || body.gradeId || '').trim();
  const topic = String(body.topic || '').trim();
  const gradeId = resolveGradeId(body);
  if (!grade) throw shared.badRequest('grade is required');
  if (!topic) throw shared.badRequest('topic is required');

  if (gradeId && !body.forceFresh && !body.skipCache) {
    const cached = await cache.getTopicMasterCache(gradeId, topic);
    if (cached && cached.data) {
      try {
        return {
          data: safeNormalizePhaseCResponse(cached.data, grade, topic),
          meta: Object.assign({
            fromCache: true,
            source: 'topic_master_archive',
          }, cached.meta || {}),
        };
      } catch (cacheErr) {
        console.warn('[pure-phase-c] cache normalize failed, regenerating:', cacheErr.message || cacheErr);
      }
    }
  }

  const userPrompt = [
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
    shared.PEDAGOGICAL_DEPTH_INSTRUCTION,
    '',
    'Return MAXIMUM-DEPTH, classroom-ready content — ALL sections fully populated at full length, zero truncation:',
    '- Tab 1 theory: exhaustive historical & anthroposophical foundations — 3-5 deep sections; bibliography with live HTTPS URLs on every website entry.',
    '- Tab 2 inspiration: highly enriched artistic/creative ideas — multiple global blocks, podcast episodes, narrative threads (no URLs inside text).',
    '- pinterest_links: 4-8 LIVE pinterest.com board or pin URLs matching grade+topic (main lesson books, form drawing, chalkboard art, student work).',
    '- pedagogical_resources: 5-10 LIVE professional teacher-facing links (articles, archives, deep sources — not parent school pages).',
    '- Tab 3 core_emphases (דגשים פדגוגיים ומהותיים): 3-4 deep paragraphs with Developmental Compass (מצפן התפתחותי) and concrete pedagogical goals.',
    '- Tab 3 key_points (נקודות מרכזיות): 5-6 substantial bullets on lesson architecture.',
    '- Tab 3 recommended_reading (ספרות מומלצת): 5-8 entries with contextual notes — MUST NOT be empty.',
    '- Tab 3 relevant_links (קישורים רלוונטיים): 6-8 live professional sources — MUST NOT be empty.',
  ].join('\n');

  const modelResult = await shared.callPerplexityJsonSafe(SYSTEM_PROMPT, userPrompt, {
    phase: 'topic_master',
    grade: grade,
    gradeLabel: grade,
    topic: topic,
    max_tokens: perplexityClient.PERPLEXITY_MAX_OUTPUT_TOKENS_PRO,
  });
  const parsed = modelResult.parsed;
  const normalized = safeNormalizePhaseCResponse(parsed, grade, topic);

  if (gradeId && !modelResult.parseFallback) {
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
  legacyHandler,
  fetch: fetchHandler,
  runPurePhaseC,
  normalizePhaseCResponse,
  safeNormalizePhaseCResponse,
};
