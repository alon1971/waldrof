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

function countBucket(items, re) {
  return items.filter(function (item) { return re.test(item.url); }).length;
}

const query = 'בוטניקה';
const queries = pgs.buildPerplexityLiveLinkQueries(query);

assert(queries.englishTopic.toLowerCase().indexOf('botany') >= 0, 'translates בוטניקה to botany');
assert(
  queries.rsarchive === 'site:rsarchive.org "' + queries.englishTopic + '"',
  'RSArchive query is site:rsarchive.org with English topic'
);
assert(queries.rsarchive.indexOf('בוטניקה') < 0, 'never sends Hebrew to rsarchive.org');
assert(
  queries.international === 'site:waldorflibrary.org OR site:waldorfeducation.org OR site:steinerwaldorf.org "' + queries.englishTopic + '"',
  'international query uses English topic on Waldorf library hosts'
);
assert(
  queries.israeli === 'site:harduf.org.il OR site:anadom.co.il OR site:waldorfisrael.org "' + query + '"',
  'Israeli query uses the original Hebrew topic without adamolam'
);
assert(queries.israeli.indexOf('adamolam') < 0, 'Israeli query excludes adamolam.co.il');

const lock = pgs.buildPerplexityLiveLinksInstructions(query);
assert(lock.indexOf('חובה מוחלטת') >= 0, 'topic lock is mandatory');
assert(lock.indexOf(query) >= 0, 'topic lock names the query');
assert(lock.indexOf(queries.rsarchive) >= 0, 'instructions include RSArchive site query');
assert(lock.indexOf(queries.international) >= 0, 'instructions include international site query');
assert(lock.indexOf(queries.israeli) >= 0, 'instructions include Israeli site query');
assert(lock.indexOf('exactly 2') >= 0, 'asks for exactly two links per bucket');
assert(lock.indexOf('adamolam.co.il') >= 0, 'explicitly forbids adamolam');
assert(lock.indexOf('Never send Hebrew to rsarchive.org') >= 0, 'forbids Hebrew RSArchive queries');

assert(pgs.buildGuaranteedSearchFallbacks(query).length === 0, 'does not generate Google or search fallbacks');
assert(pgs.buildWaldorfLibraryGoogleSearchUrl(query) === '', 'does not emit Waldorf Library Google search URLs');
assert(pgs.buildRsarchiveSearchUrl(query) === '', 'does not emit RSArchive Search.php fallbacks');
assert(pgs.buildApprovedSiteSearchUrl('waldorflibrary.org', query) === '', 'does not emit Google site-search URLs');
assert(pgs.buildCuratedRelevantLinks(query).length === 0, 'curated fallbacks are empty');

const live = pgs.sanitizePerplexityLiveLinks([
  { title: 'Botany in Waldorf education', url: 'https://www.waldorflibrary.org/articles/botany-grade-5' },
  { title: 'search', url: 'https://rsarchive.org/Lectures/GA293/English/AP1938/botany' },
  { title: 'זר', url: 'https://example.com/not-approved' },
  { title: 'כפול', url: 'https://jobs.waldorftoday.com/https://adamolam.co.il/post' },
  'https://adamolam.co.il/waldorf-botany/',
  { title: 'צמחיה בהרדוף', url: 'https://harduf.org.il/botany-lesson/' },
], query);
assert(live.some(function (item) { return item.url.indexOf('waldorflibrary.org') >= 0; }), 'keeps English library citation');
assert(live.some(function (item) { return item.title === pgs.RSARCHIVE_GENERIC_TITLE; }), 'generic RSArchive title is renamed and kept');
assert(live.some(function (item) { return item.url.indexOf('rsarchive.org/Lectures') >= 0; }), 'keeps RSArchive lecture URL');
assert(live.some(function (item) { return item.url.indexOf('harduf.org.il') >= 0; }), 'keeps Harduf Hebrew citation');
assert(!live.some(function (item) { return /adamolam\.co\.il/.test(item.url); }), 'drops adamolam citations');
assert(!live.some(function (item) { return /example\.com|jobs\.waldorftoday|google\.com/.test(item.url); }), 'drops foreign, chained, and Google URLs');

const hebrewRsarchive = pgs.sanitizePerplexityLiveLinks([
  { title: 'Lecture', url: 'https://rsarchive.org/Search.php?q=' + encodeURIComponent(query) },
  { title: 'Lecture HE', url: 'https://rsarchive.org/Lectures/GA293/' + encodeURIComponent('בוטניקה') },
], query);
assert(hebrewRsarchive.length === 0, 'drops RSArchive search pages and Hebrew RSArchive URLs');

const rsarchiveNamed = pgs.sanitizePerplexityLiveLinks([
  { title: 'Sidebar', url: 'https://rsarchive.org/Lectures/GA293/English/AP1938/botany' },
  { title: 'The Rudolf Steiner Archive', url: 'https://rsarchive.org/Search.php?q=' + encodeURIComponent('botany') },
], query);
assert(rsarchiveNamed.length === 1, 'keeps the lecture and drops Search.php');
assert(rsarchiveNamed[0].title === pgs.RSARCHIVE_GENERIC_TITLE, 'Sidebar title is renamed, not discarded');
assert(!rsarchiveNamed.some(function (item) {
  return /waldorflibrary\.org\/search|google\.com\/search|Search\.php/i.test(item.url);
}), 'never generates search-page fallbacks');

const droppedGeneric = pgs.sanitizePerplexityLiveLinks([
  { title: 'חינוך ולדורף', url: 'https://adamolam.co.il/' },
  { title: 'Waldorf education', url: 'https://www.waldorflibrary.org/' },
  { title: 'Ботаника', url: 'https://www.waldorflibrary.org/articles/botany-ru' },
]);
assert(droppedGeneric.length === 0, 'drops homepages, generic overviews, and non Hebrew/English titles');

const englishOnly = pgs.sanitizePerplexityLiveLinks([
  { title: 'Arithmetic in Waldorf education', url: 'https://www.waldorflibrary.org/articles/arithmetic-grade-1' },
], query);
assert(englishOnly.some(function (item) {
  return item.title === 'Arithmetic in Waldorf education';
}), 'keeps original English Waldorf Library titles');
assert(englishOnly.length === 1, 'does not pad missing buckets with Google or search pages');

const citationItems = perplexityClient.extractCitationItems({
  citations: ['https://rsarchive.org/Lectures/GA1'],
  search_results: [
    { title: 'Library botany', url: 'https://www.waldorflibrary.org/articles/12' },
  ],
});
assert(citationItems.length === 2, 'extracts search_results and citations');
assert(citationItems[0].title === 'Library botany', 'keeps search_results title');

const fromGemini = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [
    { title: 'search', url: 'https://waldorflibrary.org/articles/1090' },
  ],
}, { query: query });
assert(fromGemini.relevant_links.length === 0, 'normalize ignores Gemini URLs and does not invent search fallbacks');

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
assert(merged.relevant_links.length === 2, 'keeps only the live direct citations');
assert(merged.relevant_links.some(function (item) {
  return item.url.indexOf('rsarchive.org') >= 0;
}), 'merged payload keeps the RSArchive citation');
assert(merged.relevant_links.some(function (item) {
  return item.url.indexOf('waldorflibrary.org/articles/botany') >= 0;
}), 'merged payload keeps the library article');
assert(
  !merged.relevant_links.some(function (item) { return /waldorflibrary\.org\/search|google\.com\/search/i.test(item.url); }),
  'merged payload never uses Google or the 404 Waldorf Library search path'
);
assert(
  !merged.relevant_links.some(function (item) { return /articles\/1090/.test(item.url); }),
  'Gemini guessed article ID is not in the merged payload'
);

const archived = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [
    { title: 'מאמר חי', url: 'https://harduf.org.il/live-botany/' },
  ],
}, { query: query, useArchivedLinks: true });
assert(archived.relevant_links.length === 1, 'archived direct articles are kept without padding');
assert(archived.relevant_links[0].url.indexOf('harduf.org.il/live-botany') >= 0, 'archived Harduf URL kept');

const noPad = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [
    { title: 'כללי', url: 'https://adamolam.co.il/' },
  ],
}, { query: query, liveLinks: [] });
assert(noPad.relevant_links.length === 0, 'empty live results stay empty instead of Google fallbacks');

const overlayFresh = pgs.overlayArchivedPayloadWithLiveLinks({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [{ title: 'ישן', url: 'https://adamolam.co.il/old-broken/' }],
}, { query: query }, [
  { title: 'Botany now', url: 'https://www.waldorflibrary.org/articles/botany-now' },
]);
assert(overlayFresh.relevant_links.length === 1, 'single live article is kept without padding');
assert(overlayFresh.relevant_links[0].url.indexOf('botany-now') >= 0, 'old archive URL is replaced');
assert(!overlayFresh.relevant_links.some(function (item) {
  return /old-broken|adamolam/.test(item.url);
}), 'stale adamolam archive URL is not kept');
assert(overlayFresh.developmental_axis === 'ציר', 'archive overlay keeps pedagogical text');

const overlayEmpty = pgs.overlayArchivedPayloadWithLiveLinks({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [{ title: 'ישן', url: 'https://adamolam.co.il/old-broken/' }],
}, { query: query }, []);
assert(overlayEmpty.relevant_links.length === 0, 'empty overlay does not invent search fallbacks');

const balanced = pgs.sanitizePerplexityLiveLinks([
  { title: 'R1', url: 'https://rsarchive.org/Lectures/1' },
  { title: 'R2', url: 'https://rsarchive.org/Books/2' },
  { title: 'R3', url: 'https://rsarchive.org/Lectures/3' },
  { title: 'Library A', url: 'https://www.waldorflibrary.org/articles/a' },
  { title: 'AWSNA B', url: 'https://www.waldorfeducation.org/resources/b' },
  { title: 'SWSF C', url: 'https://www.steinerwaldorf.org/articles/c' },
  { title: 'הרדוף', url: 'https://harduf.org.il/d/' },
  { title: 'אנדום', url: 'https://anadom.co.il/e/' },
  { title: 'איגוד', url: 'https://waldorfisrael.org/f/' },
  { title: 'אדם עולם', url: 'https://adamolam.co.il/g/' },
  { title: 'גוגל', url: 'https://www.google.com/search?q=site:waldorflibrary.org+botany' },
], query);
assert(balanced.length === 6, 'assembles exactly six direct citations');
assert(countBucket(balanced, /rsarchive\.org/) === 2, 'keeps exactly two RSArchive lectures/books');
assert(countBucket(balanced, /waldorflibrary\.org|waldorfeducation\.org|steinerwaldorf\.org/) === 2, 'keeps exactly two international library articles');
assert(countBucket(balanced, /harduf\.org\.il|anadom\.co\.il|waldorfisrael\.org/) === 2, 'keeps exactly two Israeli Waldorf articles');
assert(!balanced.some(function (item) { return /adamolam|google\.com/.test(item.url); }), 'balanced set excludes adamolam and Google');
assert(balanced[0].title === 'R1' && balanced[1].title === 'R2', 'preserves original RSArchive titles in order');
assert(balanced[2].title === 'Library A' && balanced[3].title === 'AWSNA B', 'preserves original international titles');
assert(balanced[4].title === 'הרדוף' && balanced[5].title === 'אנדום', 'preserves original Hebrew titles');

const googleOnly = pgs.sanitizePerplexityLiveLinks([
  { title: 'search', url: 'https://www.google.com/search?q=חינוך+ולדורף+בוטניקה' },
  { title: 'Library search', url: 'https://www.waldorflibrary.org/search?q=botany' },
], query);
assert(googleOnly.length === 0, 'drops Google and broken library search pages instead of rewriting them');

const englishTopic = pgs.resolveEnglishSearchTopic('חשבון').toLowerCase();
assert(
  englishTopic.indexOf('math') >= 0 || englishTopic.indexOf('arithmetic') >= 0,
  'translates חשבון to math or arithmetic for international search'
);
assert(
  pgs.buildPerplexityLiveLinkQueries('חשבון').rsarchive.indexOf(encodeURIComponent(pgs.resolveEnglishSearchTopic('חשבון'))) < 0
    && pgs.buildPerplexityLiveLinkQueries('חשבון').rsarchive.indexOf(pgs.resolveEnglishSearchTopic('חשבון')) >= 0,
  'RSArchive query uses the English topic'
);

const humanAnimal = pgs.resolveEnglishSearchTopic('אדם וממלכת החי');
assert(
  /human and animal/i.test(humanAnimal) || /zoology/i.test(humanAnimal),
  'translates אדם וממלכת החי to Human and Animal / Zoology'
);
assert(
  pgs.isBrokenWaldorfLibrarySearchUrl('https://www.waldorflibrary.org/search?q=botany'),
  'detects the 404 Waldorf Library /search path'
);

const citationPathKept = pgs.sanitizePerplexityLiveLinks([
  { title: 'Lecture GA293', url: 'https://rsarchive.org/Lectures/GA293/English/AP1938/index.html' },
], query);
assert(
  citationPathKept.some(function (item) {
    return item.url === 'https://rsarchive.org/Lectures/GA293/English/AP1938/index.html';
  }),
  'keeps Perplexity citation path unchanged'
);
assert(citationPathKept[0].title === 'Lecture GA293', 'keeps original lecture title');

const markdownUrls = perplexityClient.extractHttpsUrlsFromText(
  'See [src](https://rsarchive.org/Books/GA011/foo) and https://www.waldorflibrary.org/articles/12.'
);
assert(markdownUrls[0] === 'https://rsarchive.org/Books/GA011/foo', 'extracts markdown HTTPS URLs as-is');
assert(markdownUrls[1] === 'https://www.waldorflibrary.org/articles/12', 'extracts bare HTTPS URLs as-is');

const sys = pgs.buildPeriodBlockSystemPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(sys.indexOf('Gemini אינו מייצר קישורים') >= 0, 'period system prompt forbids Gemini links');
assert(sys.indexOf('NEVER invent') >= 0, 'period system prompt forbids inventing URLs');

const user = pgs.buildPeriodBlockUserPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(user.indexOf('אל תכלול relevant_links') >= 0, 'period user prompt omits relevant_links');

const standard = pgs.buildStandardUserPrompt('בוטניקה');
assert(standard.indexOf('omit or return []') >= 0, 'standard search prompt omits links');
assert(standard.indexOf('Do NOT produce web URLs') >= 0, 'standard prompt does not ask for web URLs');

console.log('test-general-search-link-sanitize: ok');
