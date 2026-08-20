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
const encodedTopic = encodeURIComponent(query);

const searchQuery = pgs.buildPerplexityLiveLinksQuery(query);
assert(searchQuery.indexOf('site:adamolam.co.il') >= 0, 'live-link query includes adamolam');
assert(searchQuery.indexOf('site:harduf.org.il') >= 0, 'live-link query includes harduf');
assert(searchQuery.indexOf('site:anadom.co.il') >= 0, 'live-link query includes anadom');
assert(searchQuery.indexOf('site:waldorflibrary.org') >= 0, 'live-link query includes library');
assert(searchQuery.indexOf('site:rsarchive.org') >= 0, 'live-link query includes rsarchive');
assert(searchQuery.indexOf('"' + query + '"') >= 0, 'live-link query quotes the topic');

const live = pgs.sanitizePerplexityLiveLinks([
  { title: 'Botany in Waldorf education', url: 'https://www.waldorflibrary.org/articles/botany-grade-5' },
  { title: 'search', url: 'https://rsarchive.org/Lectures/GA293/English/AP1938/' },
  { title: 'זר', url: 'https://example.com/not-approved' },
  { title: 'כפול', url: 'https://jobs.waldorftoday.com/https://adamolam.co.il/post' },
  'https://adamolam.co.il/waldorf-botany/',
]);
assert(live.length === 3, 'keeps three approved live citations');
assert(live[0].url.indexOf('waldorflibrary.org') >= 0, 'keeps library citation');
assert(live[1].title === 'ארכיון שטיינר (כתבים והרצאות)', 'opaque citation title is replaced');
assert(live[2].url.indexOf('adamolam.co.il') >= 0, 'keeps adamolam citation');
assert(!live.some(function (item) { return /example\.com|jobs\.waldorftoday/.test(item.url); }), 'drops foreign and chained URLs');

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
assert(merged.relevant_links.length === 2, 'final JSON uses Perplexity live links');
assert(merged.relevant_links[0].url.indexOf('rsarchive.org') >= 0, 'merged first live link');
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
assert(archived.relevant_links.length === 1, 'cache keeps archived live links');
assert(archived.relevant_links[0].url.indexOf('adamolam.co.il') >= 0, 'archived adamolam URL kept');

const sys = pgs.buildPeriodBlockSystemPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(sys.indexOf('Gemini אינו מייצר קישורים') >= 0, 'period system prompt forbids Gemini links');
assert(sys.indexOf('NEVER invent') >= 0, 'period system prompt forbids inventing URLs');

const user = pgs.buildPeriodBlockUserPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(user.indexOf('אל תכלול relevant_links') >= 0, 'period user prompt omits relevant_links');

const standard = pgs.buildStandardUserPrompt('בוטניקה');
assert(standard.indexOf('omit or return []') >= 0, 'standard search prompt omits links');
assert(standard.indexOf('Do NOT produce web URLs') >= 0, 'standard prompt does not ask for web URLs');

console.log('test-general-search-link-sanitize: ok');
