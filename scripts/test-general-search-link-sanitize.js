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

const curated = pgs.buildCuratedRelevantLinks(query);
assert(curated.length === 4, 'curated list has four on-site search links');
assert(curated[0].title === 'אדם עולם - מאמרים', 'Adam Olam title');
assert(curated[0].url === 'https://adamolam.co.il/?s=' + encodedTopic, 'Adam Olam search URL');
assert(curated[1].title === 'יוזמות ולדורף בישראל', 'Harduf title');
assert(curated[1].url === 'https://harduf.org.il/?s=' + encodedTopic, 'Harduf search URL');
assert(curated[2].title === 'ארכיון שטיינר (כתבים והרצאות)', 'Steiner Archive title');
assert(curated[2].url === 'https://rsarchive.org/Search.php?q=' + encodedTopic, 'Archive Search.php URL');
assert(curated[3].title === 'ספריית ולדורף הבינלאומית', 'Waldorf Library title');
assert(
  curated[3].url === 'https://www.waldorflibrary.org/search?q=' + encodedTopic,
  'Waldorf Library search URL'
);
assert(curated.every(function (item) { return pgs.isDisplayableRelevantLink(item); }), 'all curated links are displayable');

assert(
  !pgs.isDisplayableRelevantLink({ title: 'search', url: 'https://www.waldorflibrary.org/search?q=x' }),
  'opaque title "search" is rejected'
);
assert(
  !pgs.isDisplayableRelevantLink({ title: 'מאמר', url: 'http://adamolam.co.il/?s=x' }),
  'non-https URL is rejected'
);
assert(
  !pgs.isDisplayableRelevantLink({
    title: 'מאמר',
    url: 'https://jobs.waldorftoday.com/https://waldorflibrary.org/articles/1090',
  }),
  'chained double-domain URL is rejected'
);

const numericArticle = pgs.sanitizeRelevantLinkUrl(
  'https://www.waldorflibrary.org/articles/1090',
  query
);
assert(
  numericArticle === 'https://www.waldorflibrary.org/search?q=' + encodedTopic,
  'numeric /articles/1090 becomes Waldorf Library site search'
);

const chained = pgs.sanitizeRelevantLinkUrl(
  'https://jobs.waldorftoday.com/https://www.waldorflibrary.org/articles/1090',
  query
);
assert(
  chained === 'https://www.waldorflibrary.org/search?q=' + encodedTopic,
  'chained double-domain URL is rewritten to library search'
);

const deepHarduf = pgs.sanitizeRelevantLinkUrl('https://harduf.org.il/http_new/fake-article', query);
assert(
  deepHarduf === 'https://harduf.org.il/?s=' + encodedTopic,
  'invented harduf path becomes Harduf ?s= search'
);

const normalized = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [
    { title: 'search', url: 'https://waldorflibrary.org/articles/1090' },
    { title: 'אתר זר', url: 'https://jobs.waldorftoday.com/https://rsarchive.org/Lectures/1' },
  ],
}, { query: query });

assert(
  JSON.stringify(normalized.relevant_links) === JSON.stringify(curated),
  'normalize ignores model URLs and injects curated on-site searches'
);

const sys = pgs.buildPeriodBlockSystemPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(sys.indexOf('השרת מזין אותם') >= 0, 'period system prompt says the server injects links');
assert(sys.indexOf('NEVER invent') >= 0, 'period system prompt forbids inventing URLs');

const user = pgs.buildPeriodBlockUserPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(user.indexOf('תמיד מערך ריק') >= 0, 'period user prompt asks for empty relevant_links');

const standard = pgs.buildStandardUserPrompt('בוטניקה');
assert(standard.indexOf('always return []') >= 0, 'standard search prompt asks for empty relevant_links');

console.log('test-general-search-link-sanitize: ok');
