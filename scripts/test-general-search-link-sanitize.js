#!/usr/bin/env node
'use strict';

const pgs = require('../api/pure-general-search');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

const query = 'בוטניקה';
const encodedTopic = encodeURIComponent(query);

assert(
  pgs.sanitizeRelevantLinkUrl('https://www.waldorflibrary.org/', query) === 'https://waldorflibrary.org/',
  'approved homepage is kept (www stripped, trailing slash)'
);
assert(
  pgs.sanitizeRelevantLinkUrl('https://rsarchive.org', query) === 'https://rsarchive.org/',
  'rsarchive homepage is kept'
);
assert(
  pgs.sanitizeRelevantLinkUrl('https://harduf.org.il/', query) === 'https://harduf.org.il/',
  'harduf homepage is kept'
);
assert(
  pgs.sanitizeRelevantLinkUrl('https://anadom.co.il/', query) === 'https://anadom.co.il/',
  'anadom homepage is kept'
);
assert(
  pgs.sanitizeRelevantLinkUrl('https://adamolam.co.il/', query) === 'https://adamolam.co.il/',
  'adamolam homepage is kept'
);

const numericArticle = pgs.sanitizeRelevantLinkUrl(
  'https://www.waldorflibrary.org/articles/1090',
  query
);
assert(
  numericArticle === 'https://www.waldorflibrary.org/search?q=' + encodedTopic,
  'numeric /articles/1090 becomes Waldorf Library site search'
);

const deepLibrary = pgs.sanitizeRelevantLinkUrl(
  'https://www.waldorflibrary.org/articles/made-up-botany-404',
  query
);
assert(
  deepLibrary === 'https://www.waldorflibrary.org/search?q=' + encodedTopic,
  'invented waldorflibrary path becomes native library search'
);

const deepArchive = pgs.sanitizeRelevantLinkUrl(
  'https://rsarchive.org/Lectures/GA293/English/made-up',
  query
);
assert(
  deepArchive === 'https://rsarchive.org/Search.php?q=' + encodedTopic,
  'invented rsarchive path becomes Archive Search.php'
);

const deepAdam = pgs.sanitizeRelevantLinkUrl(
  'https://adamolam.co.il/2024/01/made-up-article/',
  query
);
assert(
  deepAdam === 'https://adamolam.co.il/?s=' + encodedTopic,
  'invented adamolam path becomes ?s= search'
);

const chained = pgs.sanitizeRelevantLinkUrl(
  'https://jobs.waldorftoday.com/https://www.waldorflibrary.org/articles/1090',
  query
);
assert(
  chained === 'https://www.waldorflibrary.org/search?q=' + encodedTopic,
  'chained double-domain URL is rewritten to library search'
);
assert(
  pgs.hasChainedOrDoubleDomain('https://jobs.waldorftoday.com/https://www.waldorflibrary.org/articles/1090'),
  'double-domain detector flags jobs.waldorftoday.com/https://...'
);

const deepHarduf = pgs.sanitizeRelevantLinkUrl('https://harduf.org.il/http_new/fake-article', query);
assert(
  deepHarduf.indexOf('https://www.google.com/search?q=site:harduf.org.il+') === 0,
  'invented harduf path becomes Google site:harduf search'
);

const foreign = pgs.sanitizeRelevantLinkUrl('https://example.com/waldorf/botany-lesson', query);
assert(
  foreign === 'https://www.waldorflibrary.org/search?q=' + encodedTopic,
  'unapproved domain becomes Waldorf Library site search'
);

const goodSiteSearch = pgs.sanitizeRelevantLinkUrl(
  'https://www.google.com/search?q=site:rsarchive.org+botany',
  query
);
assert(
  goodSiteSearch === 'https://rsarchive.org/Search.php?q=' + encodedTopic,
  'Google site:rsarchive.org is upgraded to native Archive search'
);

const badSiteSearch = pgs.sanitizeRelevantLinkUrl(
  'https://www.google.com/search?q=site:spam-example.com+botany',
  query
);
assert(
  badSiteSearch === 'https://www.waldorflibrary.org/search?q=' + encodedTopic,
  'site: search on an unapproved domain is rewritten to library search'
);

assert(
  pgs.buildFocusedSearchUrl('waldorflibrary.org', query) ===
    'https://www.waldorflibrary.org/search?q=' + encodedTopic,
  'focused search builder matches Waldorf Library template'
);
assert(
  pgs.buildFocusedSearchUrl('rsarchive.org', query) ===
    'https://rsarchive.org/Search.php?q=' + encodedTopic,
  'focused search builder matches Steiner Archive template'
);
assert(
  pgs.buildFocusedSearchUrl('adamolam.co.il', query) ===
    'https://adamolam.co.il/?s=' + encodedTopic,
  'focused search builder matches Adam Olam template'
);

const normalized = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [
    { title: 'ספריית וולדורף — דף הבית', url: 'https://waldorflibrary.org/' },
    { title: 'מאמר 1090', url: 'https://waldorflibrary.org/articles/1090' },
    { title: 'אתר זר כפול', url: 'https://jobs.waldorftoday.com/https://rsarchive.org/Lectures/1' },
    { title: 'ארכיון שטיינר', url: 'https://rsarchive.org/' },
  ],
}, { query: query });

const urls = normalized.relevant_links.map(function (item) { return item.url; });
assert(urls.indexOf('https://waldorflibrary.org/') >= 0, 'normalize keeps library homepage');
assert(urls.indexOf('https://rsarchive.org/') >= 0, 'normalize keeps rsarchive homepage');
assert(
  urls.some(function (u) { return u.indexOf('https://www.waldorflibrary.org/search?q=') === 0; }),
  'normalize rewrites /articles/1090 to library search'
);
assert(
  urls.some(function (u) { return u.indexOf('https://rsarchive.org/Search.php?q=') === 0; }),
  'normalize rewrites chained rsarchive URL to Archive search'
);
assert(
  !urls.some(function (u) { return /jobs\.waldorftoday|\/articles\/1090/.test(u); }),
  'normalize drops chained hosts and numeric article paths'
);

const sys = pgs.buildPeriodBlockSystemPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(sys.indexOf('איסור מוחלט על ניחוש URL') >= 0, 'period system prompt forbids URL guessing');
assert(sys.indexOf('/articles/1090') >= 0, 'period system prompt forbids numeric article IDs');
assert(sys.indexOf('waldorflibrary.org/search') >= 0, 'period system prompt shows library search template');
assert(sys.indexOf('Search.php') >= 0, 'period system prompt shows Archive search template');

const user = pgs.buildPeriodBlockUserPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(user.indexOf('אסור לנחש /articles/{id}') >= 0, 'period user prompt forbids guessed article IDs');
assert(user.indexOf('דומיינים כפולים') >= 0, 'period user prompt forbids chained domains');

const standard = pgs.buildStandardUserPrompt('בוטניקה');
assert(standard.indexOf('איסור מוחלט על ניחוש URL') >= 0, 'standard search prompt forbids URL guessing');
assert(standard.indexOf('adamolam.co.il/?s=') >= 0, 'standard search prompt includes Adam Olam search');
assert(
  pgs.APPROVED_RELEVANT_LINK_DOMAINS.indexOf('anadom.co.il') >= 0 &&
  pgs.APPROVED_RELEVANT_LINK_DOMAINS.indexOf('harduf.org.il') >= 0 &&
  pgs.APPROVED_RELEVANT_LINK_DOMAINS.indexOf('adamolam.co.il') >= 0,
  'approved domain list includes the Hebrew Waldorf portals'
);

console.log('test-general-search-link-sanitize: ok');
