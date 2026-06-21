#!/usr/bin/env node
'use strict';

const hm = require('../hebrew-topic-match');
const disambig = require('../api/archive-disambiguation');

const cases = [
  {
    query: 'רישום צורה',
    suggested: 'בראשית – תקופת תורה בכיתה ג\'',
    expectInvalid: true,
  },
  {
    query: 'חשבון',
    suggested: 'בראשית – תקופת תורה בכיתה ג\'',
    expectInvalid: true,
  },
  {
    query: 'סיפורי הצפון',
    suggested: 'מיתולוגיה נורדית',
    expectInvalid: false,
  },
  {
    query: 'רישום צורה',
    suggested: 'רישום צורה',
    expectInvalid: false,
  },
];

let failed = 0;
cases.forEach(function (c) {
  const invalid = hm.isInvalidCrossDomainTopicSuggestion(c.query, c.suggested);
  const score = hm.scoreHebrewTopicSimilarity(c.query, c.suggested, '');
  const bypass = hm.shouldBypassSemanticArchiveSuggestion(c.query);
  const ok = invalid === c.expectInvalid;
  if (!ok) failed++;
  console.log((ok ? 'OK' : 'FAIL'), JSON.stringify(c.query), '->', JSON.stringify(c.suggested));
  console.log('  invalid:', invalid, 'score:', score.toFixed(3), 'bypass:', bypass);
});

console.log('\npartial threshold:', disambig.ARCHIVE_PARTIAL_SUGGEST_MIN_SCORE);
console.log(failed ? failed + ' case(s) failed' : 'all cases passed');
process.exit(failed ? 1 : 0);
