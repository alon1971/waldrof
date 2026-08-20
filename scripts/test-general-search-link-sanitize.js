#!/usr/bin/env node
'use strict';

const pgs = require('../api/pure-general-search');
const perplexityClient = require('../api/perplexity-client');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

const query = 'בוטניקה';

const searchQuery = pgs.buildPerplexityLiveLinksQuery(query);
assert(
  searchQuery === '"' + query + '" Waldorf education arithmetic math articles',
  'live-link query blends the topic with English Waldorf search terms'
);

const lock = pgs.buildPerplexityLiveLinksInstructions(query);
assert(lock.indexOf('חובה מוחלטת') >= 0, 'topic lock is mandatory');
assert(lock.indexOf(query) >= 0, 'topic lock names the query');
assert(lock.indexOf('אין להחזיר מאמרים כלליים על חינוך ולדורף או דפי בית') >= 0, 'forbids generic Waldorf pages');
assert(lock.indexOf('do not require Hebrew results') >= 0, 'allows English results without Hebrew');
assert(lock.indexOf('DO NOT remove or exclude the Rudolf Steiner Archive') >= 0, 'keeps RSArchive as a core source');
assert(lock.indexOf(pgs.RSARCHIVE_GENERIC_TITLE) >= 0, 'renames generic RSArchive titles instead of dropping them');

const live = pgs.sanitizePerplexityLiveLinks([
  { title: 'Botany in Waldorf education', url: 'https://www.waldorflibrary.org/articles/botany-grade-5' },
  { title: 'search', url: 'https://rsarchive.org/Lectures/GA293/English/AP1938/' },
  { title: 'זר', url: 'https://example.com/not-approved' },
  { title: 'כפול', url: 'https://jobs.waldorftoday.com/https://adamolam.co.il/post' },
  'https://adamolam.co.il/waldorf-botany/',
], query);
assert(live.length === 3, 'keeps three approved live citations');
assert(live[0].url.indexOf('waldorflibrary.org') >= 0, 'keeps English library citation');
assert(live[1].title === pgs.RSARCHIVE_GENERIC_TITLE, 'generic RSArchive title is renamed and kept');
assert(live[1].url.indexOf('rsarchive.org/Lectures') >= 0, 'keeps RSArchive lecture URL');
assert(live[2].url.indexOf('adamolam.co.il') >= 0, 'keeps adamolam citation');
assert(!live.some(function (item) { return /example\.com|jobs\.waldorftoday/.test(item.url); }), 'drops foreign and chained URLs');

const rsarchiveNamed = pgs.sanitizePerplexityLiveLinks([
  { title: 'Sidebar', url: 'https://rsarchive.org/Lectures/GA293/English/AP1938/botany' },
  { title: 'The Rudolf Steiner Archive', url: 'https://rsarchive.org/Search.php?q=' + encodeURIComponent(query) },
], query);
assert(rsarchiveNamed.length >= 2, 'keeps RSArchive lecture and search pages');
assert(rsarchiveNamed[0].title === pgs.RSARCHIVE_GENERIC_TITLE, 'Sidebar title is renamed, not discarded');
assert(rsarchiveNamed[1].title === pgs.RSARCHIVE_GENERIC_TITLE, 'The Rudolf Steiner Archive title is renamed, not discarded');
assert(rsarchiveNamed.some(function (item) {
  return item.url === 'https://rsarchive.org/Search.php?q=' + encodeURIComponent(query);
}), 'keeps RSArchive search URL');
assert(rsarchiveNamed.length >= 3, 'pads below three links with guaranteed search fallbacks');
assert(rsarchiveNamed.some(function (item) {
  return item.url === 'https://www.waldorflibrary.org/search?q=' + encodeURIComponent(query);
}), 'adds Waldorf Library search fallback');

const droppedGeneric = pgs.sanitizePerplexityLiveLinks([
  { title: 'חינוך ולדורף', url: 'https://adamolam.co.il/' },
  { title: 'Waldorf education', url: 'https://www.waldorflibrary.org/' },
  { title: 'Ботаника', url: 'https://www.waldorflibrary.org/articles/botany-ru' },
]);
assert(droppedGeneric.length === 0, 'drops homepages, generic overviews, and non Hebrew/English titles');

const englishOnly = pgs.sanitizePerplexityLiveLinks([
  { title: 'Arithmetic in Waldorf education', url: 'https://www.waldorflibrary.org/articles/arithmetic-grade-1' },
], query);
assert(englishOnly[0].title === 'Arithmetic in Waldorf education', 'keeps English Waldorf Library titles');
assert(englishOnly.length >= 3, 'English-only results are kept and padded without requiring Hebrew pages');

const citationItems = perplexityClient.extractCitationItems({
  citations: ['https://rsarchive.org/Lectures/GA1'],
  search_results: [
    { title: 'Library botany', url: 'https://www.waldorflibrary.org/articles/12' },
  ],
});
assert(citationItems.length === 2, 'extracts search_results and citations');
assert(citationItems[0].title === 'Library botany', 'keeps search_results title');

const curated = pgs.buildCuratedRelevantLinks(query);
const fromGemini = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [
    { title: 'search', url: 'https://waldorflibrary.org/articles/1090' },
  ],
}, { query: query });
assert(
  JSON.stringify(fromGemini.relevant_links) === JSON.stringify(curated),
  'normalize ignores Gemini URLs and falls back to curated searches'
);

const merged = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  curriculum: [{ day: 1, topic: 'יום', content: 'תוכן', art: 'אמנות' }],
  relevant_links: [{ title: 'ניחוש', url: 'https://waldorflibrary.org/articles/1090' }],
}, {
  query: query,
  periodBlock: true,
  liveLinks: [
    { title: 'Botany lecture', url: 'https://rsarchive.org/Lectures/GA293/botany' },
    { title: 'ספרייה', url: 'https://www.waldorflibrary.org/articles/botany' },
  ],
});
assert(merged.curriculum.length === 15, 'period table still comes from Gemini/normalize');
assert(merged.relevant_links.length >= 3, 'fewer than three live links are padded with search fallbacks');
assert(merged.relevant_links[0].url.indexOf('rsarchive.org') >= 0, 'merged first live link');
assert(
  merged.relevant_links.some(function (item) {
    return item.url === 'https://rsarchive.org/Search.php?q=' + encodeURIComponent(query)
      || item.url === 'https://www.waldorflibrary.org/search?q=' + encodeURIComponent(query);
  }),
  'guaranteed Steiner Archive or Waldorf Library search is merged in'
);
assert(
  !merged.relevant_links.some(function (item) { return /articles\/1090/.test(item.url); }),
  'Gemini guessed article ID is not in the merged payload'
);

const archived = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [
    { title: 'מאמר חי', url: 'https://adamolam.co.il/live-botany/' },
  ],
}, { query: query, useArchivedLinks: true });
assert(archived.relevant_links.length >= 3, 'short archived lists get search fallbacks');
assert(archived.relevant_links[0].url.indexOf('adamolam.co.il') >= 0, 'archived adamolam URL kept');

const noPad = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [
    { title: 'כללי', url: 'https://adamolam.co.il/' },
  ],
}, { query: query, liveLinks: [] });
assert(noPad.relevant_links.length === 2, 'empty live results still get guaranteed search fallbacks');
assert(noPad.relevant_links[0].title === 'חיפוש בארכיון שטיינר', 'first fallback is RSArchive search');
assert(noPad.relevant_links[1].title === 'מאמרי ספריית ולדורף', 'second fallback is Waldorf Library search');

const overlayFresh = pgs.overlayArchivedPayloadWithLiveLinks({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [{ title: 'ישן', url: 'https://adamolam.co.il/old-broken/' }],
}, { query: query }, [
  { title: 'Botany now', url: 'https://www.waldorflibrary.org/articles/botany-now' },
]);
assert(overlayFresh.relevant_links.length >= 3, 'single live link is padded to at least three');
assert(overlayFresh.relevant_links[0].url.indexOf('botany-now') >= 0, 'old archive URL is replaced');
assert(overlayFresh.developmental_axis === 'ציר', 'archive overlay keeps pedagogical text');

const overlayEmpty = pgs.overlayArchivedPayloadWithLiveLinks({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [{ title: 'ישן', url: 'https://adamolam.co.il/old-broken/' }],
}, { query: query }, []);
assert(overlayEmpty.relevant_links.length === 2, 'empty overlay uses guaranteed search fallbacks');
assert(
  overlayEmpty.relevant_links[0].url === 'https://rsarchive.org/Search.php?q=' + encodeURIComponent(query),
  'empty overlay starts with RSArchive search'
);

const capped = pgs.sanitizePerplexityLiveLinks([
  { title: 'A', url: 'https://www.waldorflibrary.org/articles/a' },
  { title: 'B', url: 'https://rsarchive.org/Lectures/b' },
  { title: 'C', url: 'https://adamolam.co.il/c/' },
  { title: 'D', url: 'https://harduf.org.il/d/' },
  { title: 'E', url: 'https://anadom.co.il/e/' },
  { title: 'F', url: 'https://www.waldorflibrary.org/articles/f' },
  { title: 'G', url: 'https://adamolam.co.il/g/' },
], query);
assert(capped.length === 6, 'keeps at most six live citations');
assert(capped.some(function (item) { return /rsarchive\.org/.test(item.url); }), 'diversified list still includes RSArchive');

const sys = pgs.buildPeriodBlockSystemPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(sys.indexOf('Gemini אינו מייצר קישורים') >= 0, 'period system prompt forbids Gemini links');
assert(sys.indexOf('NEVER invent') >= 0, 'period system prompt forbids inventing URLs');

const user = pgs.buildPeriodBlockUserPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(user.indexOf('אל תכלול relevant_links') >= 0, 'period user prompt omits relevant_links');

const standard = pgs.buildStandardUserPrompt('בוטניקה');
assert(standard.indexOf('omit or return []') >= 0, 'standard search prompt omits links');
assert(standard.indexOf('Do NOT produce web URLs') >= 0, 'standard prompt does not ask for web URLs');

console.log('test-general-search-link-sanitize: ok');
