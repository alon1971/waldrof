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

const gradeGuardCases = [
  {
    topic: 'רנסנס',
    gradeId: '3',
    gradeLabel: 'כיתה ג׳',
    expectMismatch: true,
    expectCanonicalGrade: '7',
    expectMessage: 'בחרת רנסנס לכיתה ג׳ — זהו נושא המיועד לכיתה ז׳. אנא בחר שנית או דייק את השאלה.',
  },
  {
    topic: 'רנסנס',
    gradeId: '7',
    expectMismatch: false,
  },
  {
    topic: 'נורדי',
    gradeId: '3',
    expectMismatch: true,
    expectCanonicalGrade: '4',
  },
  {
    topic: 'יוון',
    gradeId: '4',
    expectMismatch: true,
    expectCanonicalGrade: '5',
  },
  {
    topic: 'רומא',
    gradeId: '3',
    expectMismatch: true,
    expectCanonicalGrade: '6',
  },
  {
    topic: 'חקלאות',
    gradeId: '3',
    expectMismatch: false,
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

gradeGuardCases.forEach(function (c) {
  const mismatch = disambig.checkPedagogicalGradeGuardrail(
    c.gradeId,
    c.topic,
    c.gradeLabel || 'כיתה בדיקה'
  );
  const hasMismatch = Boolean(mismatch);
  const ok = hasMismatch === c.expectMismatch &&
    (!c.expectCanonicalGrade || (mismatch && mismatch.canonicalGradeId === c.expectCanonicalGrade));
  if (!ok) failed++;
  console.log((ok ? 'OK' : 'FAIL'), 'grade guard', JSON.stringify(c.topic), 'in grade', c.gradeId);
  if (mismatch) {
    console.log('  message:', disambig.buildGradeMismatchError(mismatch));
  }
  const partialAllowed = disambig.shouldOfferPartialArchiveSuggestion(
    c.topic,
    'תקופת בנייה',
    0.85,
    c.gradeId,
    'כיתה ג׳'
  );
  const partialOk = c.expectMismatch ? !partialAllowed : true;
  if (!partialOk) failed++;
  console.log((partialOk ? 'OK' : 'FAIL'), '  blocks partial suggestion:', !partialAllowed);
  if (c.expectMismatch && mismatch) {
    var msg = disambig.buildGradeMismatchError(mismatch);
    if (c.expectMessage) {
      var msgOk = msg === c.expectMessage;
      if (!msgOk) failed++;
      console.log((msgOk ? 'OK' : 'FAIL'), '  message format:', msg);
    }
  }
});

console.log('\npartial threshold:', disambig.ARCHIVE_PARTIAL_SUGGEST_MIN_SCORE);
console.log(failed ? failed + ' case(s) failed' : 'all cases passed');
process.exit(failed ? 1 : 0);
