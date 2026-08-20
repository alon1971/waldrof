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

const deepLibrary = pgs.sanitizeRelevantLinkUrl(
  'https://www.waldorflibrary.org/articles/made-up-botany-404',
  query
);
assert(
  deepLibrary.indexOf('https://www.google.com/search?q=site:waldorflibrary.org+') === 0,
  'invented waldorflibrary path becomes site: search'
);
assert(decodeURIComponent(deepLibrary).indexOf('בוטניקה') >= 0, 'site: search includes the topic');

const deepHarduf = pgs.sanitizeRelevantLinkUrl('https://harduf.org.il/http_new/fake-article', query);
assert(
  deepHarduf.indexOf('https://www.google.com/search?q=site:harduf.org.il+') === 0,
  'invented harduf path becomes site:harduf search'
);

const foreign = pgs.sanitizeRelevantLinkUrl('https://example.com/waldorf/botany-lesson', query);
assert(
  foreign.indexOf('https://www.google.com/search?q=site:waldorflibrary.org+') === 0,
  'unapproved domain becomes site:waldorflibrary.org search'
);

const goodSiteSearch = pgs.sanitizeRelevantLinkUrl(
  'https://www.google.com/search?q=site:rsarchive.org+botany',
  query
);
assert(
  goodSiteSearch.indexOf('https://www.google.com/search?q=site:rsarchive.org+') === 0,
  'existing site: search on an approved domain is kept on that domain'
);

const badSiteSearch = pgs.sanitizeRelevantLinkUrl(
  'https://www.google.com/search?q=site:spam-example.com+botany',
  query
);
assert(
  badSiteSearch.indexOf('https://www.google.com/search?q=site:waldorflibrary.org+') === 0,
  'site: search on an unapproved domain is rewritten to waldorflibrary.org'
);

const normalized = pgs.normalizeGeneralSearchResponse({
  developmental_axis: 'ציר',
  core_pedagogical_emphases: 'דגשים',
  relevant_links: [
    { title: 'ספריית וולדורף — דף הבית', url: 'https://waldorflibrary.org/' },
    { title: 'מאמר מומצא', url: 'https://waldorflibrary.org/articles/does-not-exist' },
    { title: 'אתר זר', url: 'https://not-approved.org/deep/path' },
    { title: 'ארכיון שטיינר', url: 'https://rsarchive.org/' },
  ],
}, { query: query });

const urls = normalized.relevant_links.map(function (item) { return item.url; });
assert(urls.indexOf('https://waldorflibrary.org/') >= 0, 'normalize keeps library homepage');
assert(urls.indexOf('https://rsarchive.org/') >= 0, 'normalize keeps rsarchive homepage');
assert(
  urls.some(function (u) { return u.indexOf('site:waldorflibrary.org+') >= 0; }),
  'normalize rewrites invented deep path to site: search'
);
assert(
  !urls.some(function (u) { return /not-approved\.org/.test(u); }),
  'normalize drops unapproved hosts'
);

const sys = pgs.buildPeriodBlockSystemPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(sys.indexOf('איסור מוחלט על ניחוש URL') >= 0, 'period system prompt forbids URL guessing');
assert(sys.indexOf('site:waldorflibrary.org') >= 0, 'period system prompt shows site-search pattern');

const user = pgs.buildPeriodBlockUserPrompt('בוטניקה', { gradeId: '5', gradeLabel: 'כיתה ה׳' });
assert(user.indexOf('אסור לנחש נתיבים פנימיים') >= 0, 'period user prompt forbids guessed paths');

const standard = pgs.buildStandardUserPrompt('בוטניקה');
assert(standard.indexOf('איסור מוחלט על ניחוש URL') >= 0, 'standard search prompt forbids URL guessing');
assert(
  pgs.APPROVED_RELEVANT_LINK_DOMAINS.indexOf('anadom.co.il') >= 0 &&
  pgs.APPROVED_RELEVANT_LINK_DOMAINS.indexOf('harduf.org.il') >= 0 &&
  pgs.APPROVED_RELEVANT_LINK_DOMAINS.indexOf('adamolam.co.il') >= 0,
  'approved domain list includes the Hebrew Waldorf portals'
);

console.log('test-general-search-link-sanitize: ok');
