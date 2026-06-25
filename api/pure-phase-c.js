/**
 * POST /api/pure-phase-c — isolated Phase C synthesis via Perplexity (no cache).
 * Body: { grade, topic }
 */
const shared = require('./pure-api-shared');

const SYSTEM_PROMPT = [
  'You are a Waldorf / anthroposophical pedagogy expert.',
  'Respond ONLY with valid JSON (no markdown fences, no commentary) using exactly these keys:',
  'theory (object: {title, sections: [{heading, content, icon?}], bibliography: {books, articles, websites: [{title, url?}]}} — rich theoretical background for the grade+topic),',
  'inspiration (object: {title, global: [{title, items: [strings]}], podcast: {title, episodes: [{theme, insight}]}, narrative: [strings]} — artistic/pedagogical classroom inspiration),',
  'pinterest_links (array of objects: {title, url, board} — 4-8 live Pinterest board or curated pin URLs for this grade+topic Waldorf visual inspiration),',
  'pedagogical_resources (array of objects: {title, url, label, source, snippet} — live professional inspiration links for teachers),',
  'core_emphases (string: AT LEAST 2-3 comprehensive Hebrew paragraphs with Developmental Compass — רציונל התפתחותי ומצפן למורה — covering why-this-age, inner developmental milestone, and teacher attitude/rhythm; never brief),',
  'key_points (array of exactly 5-6 substantial Hebrew strings — each 2-4 sentences on lesson-block dynamics, transitions, or core concepts; NOT terse one-liners),',
  'recommended_reading (array of 5-8 objects: {title, author, note} — note MUST be 1-2 sentences on what the source covers and why it is relevant),',
  'relevant_links (array of 6-8 objects: {title, url} — title MUST include short context after em dash/colon; live Steiner archives, Waldorf Library, professional essays).',
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

function normalizePhaseCResponse(parsed, grade, topic) {
  const data = parsed && typeof parsed === 'object' ? parsed : {};
  const relevantLinks = shared.coerceLinks(data.relevant_links);
  const pedagogicalResources = normalizePedagogicalResources(data.pedagogical_resources);
  const pinterestLinks = normalizePinterestLinks(data.pinterest_links);
  return {
    theory: normalizeTheoryBlock(data, grade, topic),
    inspiration: normalizeInspirationBlock(data, topic),
    pinterest_links: pinterestLinks,
    pedagogical_resources: pedagogicalResources.length ? pedagogicalResources : relevantLinks.map(function (link) {
      return { title: link.title, url: link.url, label: 'מאמר פדגוגי', source: '', snippet: '' };
    }),
    core_emphases: shared.coerceText(data.core_emphases),
    key_points: shared.coerceList(data.key_points),
    recommended_reading: shared.coerceReadingList(data.recommended_reading),
    relevant_links: relevantLinks,
  };
}

async function runPurePhaseC(body) {
  const grade = String(body.grade || body.gradeLabel || body.gradeId || '').trim();
  const topic = String(body.topic || '').trim();
  if (!grade) throw shared.badRequest('grade is required');
  if (!topic) throw shared.badRequest('topic is required');

  const userPrompt = [
    'Produce Phase C pedagogical products and essence for Waldorf education.',
    'Grade: ' + grade,
    'Topic: ' + topic,
    'Focus on developmental appropriateness, soul-spiritual qualities, and practical classroom orientation.',
    'Write pedagogical content in Hebrew unless the topic itself is in another language.',
    '',
    shared.PROFESSIONAL_LINKS_INSTRUCTION,
    '',
    shared.PEDAGOGICAL_DEPTH_INSTRUCTION,
    '',
    'Return rich, classroom-ready content:',
    '- theory: deep Waldorf theoretical background with 3-5 sections and bibliography (websites must include verified URLs).',
    '- inspiration: vivid artistic/pedagogical ideas with global blocks and podcast-style episodes (no URLs inside text).',
    '- pinterest_links: 4-8 LIVE pinterest.com board or pin URLs matching grade+topic (main lesson books, form drawing, chalkboard art, student work).',
    '- pedagogical_resources: 5-10 LIVE professional teacher-facing links (articles, archives, deep sources — not parent school pages).',
    '- core_emphases (דגשים פדגוגיים ומהותיים): deep multi-paragraph breakdown with explicit Developmental Compass (רציונל התפתחותי ומצפן למורה).',
    '- key_points (נקודות מרכזיות): 5-6 substantial bullets on lesson architecture — never superficial one-liners.',
    '- recommended_reading (ספרות מומלצת): each entry with contextual note explaining coverage and relevance.',
    '- relevant_links (קישורים): 6-8 live professional sources with descriptive titles explaining what each covers.',
  ].join('\n');

  const parsed = await shared.callPerplexityJson(SYSTEM_PROMPT, userPrompt);
  return normalizePhaseCResponse(parsed, grade, topic);
}

const legacyHandler = shared.createLegacyPostHandler(runPurePhaseC);

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
    const data = await runPurePhaseC(body || {});
    return Response.json({ ok: true, data: data, meta: { fromCache: false, source: 'perplexity-pure' } }, { status: 200, headers: headers });
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
};
