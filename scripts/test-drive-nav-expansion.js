#!/usr/bin/env node
'use strict';

const hebrewTopicMatch = require('../hebrew-topic-match');
const catalogTopics = require('../api/catalog-topics');
const driveQueryExpand = require('../api/drive-query-expand');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

const block = hebrewTopicMatch.findCurriculumTopicBlock('אדם חיה');
assert(block && block.blockLabel === 'אדם וממלכת החי', 'אדם חיה maps to curriculum block');

const aliases = catalogTopics.expandCatalogTopicAliases(['אדם חיה']);
assert(aliases.some(function (a) { return /ממלכת החי/.test(a); }), 'aliases include ממלכת החי');
assert(aliases.some(function (a) { return a === 'אדם וחיות' || a === 'אדם חיות'; }), 'aliases include אדם וחיות');

const local = driveQueryExpand.expandDriveNavigationQueryLocal('אדם חיה');
assert(local.phrases.some(function (p) { return /ממלכת החי|אדם וחיות|אדם חיות/.test(p); }), 'phrases expanded');

assert(
  driveQueryExpand.isCentralDriveHitRelevant('אדם חיה', {
    fileName: 'גילגמש',
    catalogTopic: 'מיתולוגיה',
    locationPath: 'כיתה ה׳ > מיתוסים',
  }, local) === false,
  'reject Gilgamesh false positive'
);

assert(
  driveQueryExpand.isCentralDriveHitRelevant('אדם חיה', {
    fileName: 'האדם בממלכת החי',
    catalogTopic: 'אדם וחיות',
    locationPath: 'כיתה ד׳ > אדם וחיות',
  }, local) === true,
  'accept האדם בממלכת החי'
);

assert(
  driveQueryExpand.isCentralDriveHitRelevant('אדם חיה', {
    fileName: 'אדם חיות.pdf',
    catalogTopic: 'אדם חיות',
    locationPath: 'כיתה ד׳ > אדם חיות',
  }, local) === true,
  'accept אדם חיות'
);

const nutrition = driveQueryExpand.expandDriveNavigationQueryLocal('תזונה');
assert(
  nutrition.phrases.some(function (p) { return /אדם עולם|בריאות|adam olam/i.test(p); }),
  'תזונה phrases expand to אדם עולם / בריאות'
);
assert(
  nutrition.allTerms.some(function (t) { return t === 'תזונה'; })
    && nutrition.phrases.some(function (p) { return p === 'תזונה'; }),
  'raw query תזונה must stay in Drive search terms (not dropped by longer aliases)'
);
assert(
  driveQueryExpand.isCentralDriveHitRelevant('תזונה', {
    fileName: 'תזונה ונשימה מחברת תלמיד .pdf',
    catalogTopic: 'אדם עולם',
    locationPath: 'מאגר קהילתי',
  }, nutrition) === true,
  'accept root תזונה file by name'
);

const norseLocal = driveQueryExpand.expandDriveNavigationQueryLocal('מיתולוגיה נורדית');
assert(
  !norseLocal.allTerms.some(function (t) { return /יוון|greek|רומא|roman/i.test(t); }),
  'Norse expansion must not include Greek/Roman terms'
);
assert(
  driveQueryExpand.isCentralDriveHitRelevant('מיתולוגיה נורדית', {
    fileName: 'מיתולוגיה יוונית',
    catalogTopic: 'יוון',
    locationPath: 'כיתה ה׳ > יוון',
  }, norseLocal) === false,
  'Norse query rejects Greek mythology hit'
);

console.log('OK drive navigation expansion + relevance tests');
