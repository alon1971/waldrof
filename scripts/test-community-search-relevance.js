#!/usr/bin/env node
'use strict';

const pedagogicalScope = require('../api/pedagogical-scope');
const cache = require('../api/cache');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

// --- Curriculum inference ---
const greece = pedagogicalScope.inferTopicCurriculumBlock('יוון');
assert(greece && greece.gradeId === '5', 'יוון must map to grade 5');

const rome = pedagogicalScope.inferTopicCurriculumBlock('רומא');
assert(rome && rome.gradeId === '6', 'רומא must map to grade 6');

const norse = pedagogicalScope.inferTopicCurriculumBlock('מיתולוגיה נורדית');
assert(norse && norse.gradeId === '4', 'מיתולוגיה נורדית must map to grade 4');

// --- Hard grade filter: Rome must not keep grade-1 ghost ---
const romeFilter = pedagogicalScope.filterCommunityHitsByCurriculumGrade('רומא', [
  { id: 'ghost-1', gradeId: '1', topic: 'רומא', title: 'רומא', catalogTopic: 'רומא' },
  { id: 'ok-6', gradeId: '6', topic: 'רומא', title: 'האימפריה הרומית', catalogTopic: 'רומא' },
  { id: 'empty', gradeId: '', topic: 'רומא', title: 'רומא', catalogTopic: 'רומא' },
]);
assert(romeFilter.filtered === true, 'Rome filter should drop wrong-grade hits');
assert(romeFilter.hits.length === 2, 'Rome filter keeps grade 6 + exact empty-grade Rome');
assert(romeFilter.hits.every(function (h) {
  return h.id !== 'ghost-1';
}), 'Grade-1 Rome ghost must be removed');

// --- Hard topic filter: Greece must not keep Norse mythology ---
const greeceFilter = pedagogicalScope.filterCommunityHitsByCurriculumGrade('יוון', [
  {
    id: 'norse',
    gradeId: '4',
    topic: 'מיתולוגיה נורדית',
    title: 'סיפורי הצפון — אזכור ליוון',
    catalogTopic: 'מיתולוגיה נורדית',
  },
  {
    id: 'greece',
    gradeId: '5',
    topic: 'יוון',
    title: 'מיתולוגיה יוונית',
    catalogTopic: 'יוון',
  },
]);
assert(greeceFilter.hits.length === 1, 'Greece filter keeps only Greece hit');
assert(greeceFilter.hits[0].id === 'greece', 'Surviving hit must be the Greece folder');

// --- Central match: content mention is not enough ---
const norseRow = {
  id: 'kb-norse',
  grade_id: '4',
  topic: 'מיתולוגיה נורדית',
  title: 'מיתולוגיה נורדית',
  file_name: 'norse.pdf',
  content: 'לפעמים משווים את המיתולוגיה הנורדית למיתולוגיה של יוון העתיקה',
};
const norseHit = {
  id: 'kb-norse',
  gradeId: '4',
  topic: 'מיתולוגיה נורדית',
  title: 'מיתולוגיה נורדית',
  catalogTopic: 'מיתולוגיה נורדית',
  fileName: 'norse.pdf',
};
assert(
  cache.isCentralCommunityTopicMatch('יוון', norseHit, norseRow) === false,
  'Incidental יוון inside Norse content must not be a central match'
);

const greeceHit = {
  id: 'mat-greece',
  gradeId: '5',
  topic: 'יוון',
  title: 'חומר על יוון',
  catalogTopic: 'יוון',
  fileName: 'greece.pdf',
};
assert(
  cache.isCentralCommunityTopicMatch('יוון', greeceHit, { topic: 'יוון', file_name: 'greece.pdf' }) === true,
  'Genuine Greece folder must be a central match'
);

const keywordHits = cache.keywordSubstringMatchCommunity(
  'יוון',
  [
    {
      id: 'mat-norse',
      grade_level: '4',
      topic: 'מיתולוגיה נורדית',
      file_name: 'norse.pdf',
      notes: 'כולל השוואה קצרה ליוון',
      file_path: 'community/norse.pdf',
    },
    {
      id: 'mat-greece',
      grade_level: '5',
      topic: 'יוון',
      file_name: 'greece.pdf',
      notes: '',
      file_path: 'community/greece.pdf',
    },
  ],
  [],
  { limit: 8 }
);
assert(keywordHits.length === 1, 'Keyword match returns only Greece material');
assert(keywordHits[0].id === 'mat-greece', 'Keyword match id must be Greece material');

const romeKeywordHits = cache.keywordSubstringMatchCommunity(
  'רומא',
  [
    {
      id: 'mat-rome-g1',
      grade_level: '1',
      topic: 'רומא',
      file_name: 'רומא',
      notes: '',
      file_path: '',
    },
    {
      id: 'mat-rome-g6',
      grade_level: '6',
      topic: 'רומא',
      file_name: 'rome-unit.pdf',
      notes: '',
      file_path: 'community/rome-unit.pdf',
    },
  ],
  [],
  { limit: 8 }
);
// Keyword layer may still surface both; curriculum filter is the hard gate.
const romeAfterGrade = pedagogicalScope.filterCommunityHitsByCurriculumGrade('רומא', romeKeywordHits);
assert(
  romeAfterGrade.hits.every(function (h) { return String(h.gradeId) === '6' || !h.gradeId; }),
  'After grade filter, Rome hits must not include grade 1'
);
assert(
  romeAfterGrade.hits.some(function (h) { return h.id === 'mat-rome-g6'; }),
  'Grade-6 Rome material must survive'
);

console.log('OK community-search-relevance tests');
