#!/usr/bin/env node
'use strict';

const cache = require('../api/cache');

function upgradedDay(day, topic) {
  return {
    day: day,
    topic: topic || ('יום ' + day),
    content: 'תוכן עשיר ומפורט ליום ' + day + ' עם זרימת שיעור מלאה, סיפור מחנך, וחוויה כיתתית מעמיקה שמכסה את כל שלבי השיעור בצורה פדגוגית.',
    art: 'אמנות ומעשה ליום ' + day + ' — ציור, חומרים טבעיים, ופעילות יצירתית מותאמת לגיל.',
    hint: 'רמז ליום ' + day,
    contentExpansion: {
      classroomImplementation: 'יישום כיתתי מפורט ליום ' + day + ' כולל הכנה לפני השיעור, זרימת שיעור, וסגירה רפלקטיבית עם התאמה לגיל הילדים בכיתה.',
      parentCommunityAspects: 'היבט קהילתי והורים ליום ' + day + ' — שיתוף הורים, חג או אירוע קהילתי קטן.',
      practicalSteps: [
        'הכנת חומרים וסביבה לפני השיעור',
        'פתיחה מחנכת עם שיר או תנועה',
        'העמקה בפעילות מרכזית ורישום ביומן',
        'סגירה רפלקטיבית ושיתוף תלמידים',
      ],
      inspirationReferences: ['רודולף שיינר — חינוך ואמנות', 'מאייר — חינוך לגיל הרך'],
    },
  };
}

const upgradedSample = {
  blockPlan: {
    curriculum: Array.from({ length: 15 }, function (_, i) {
      return upgradedDay(i + 1);
    }),
  },
};

const legacyBasicSample = {
  blockPlan: {
    curriculum: [
      { day: 1, topic: 'א', content: 'תוכן קצר', art: 'אמנות' },
      { day: 2, topic: 'ב', content: 'תוכן קצר', art: 'אמנות' },
      { day: 3, topic: 'ג', content: 'תוכן קצר', art: 'אמנות' },
      { day: 4, topic: 'ד', content: 'תוכן קצר', art: 'אמנות' },
      { day: 5, topic: 'ה', content: 'תוכן קצר', art: 'אמנות' },
    ],
  },
};

const emptyCurriculumSample = {
  blockPlan: {
    theory: { title: '', sections: [{ heading: 'רקע', content: 'תיאוריה עשירה על החשבון בכיתה א' }] },
    curriculum: [],
  },
  webResearch: { topic: 'חשבון', summary: 'תיאוריה עשירה' },
};

const corruptSample = {
  blockPlan: {
    curriculum: [
      { day: 1, topic: 'יום 1', content: '—', art: '—' },
      { day: 2, topic: 'יום 2', content: '', art: '' },
    ],
  },
};

const body = { phase: 'phase_c', cTab: 'curriculum' };

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    failed++;
  } else {
    console.log('ok:', name);
  }
}

assert('upgraded cache passes corrupt check', !cache.isPhaseCCurriculumCacheCorrupt(body, upgradedSample));
assert('upgraded cache has 15 valid days', cache.countValidPhaseCCurriculumDays(upgradedSample) === 15);
assert('legacy basic cache is corrupt', cache.isPhaseCCurriculumCacheCorrupt(body, legacyBasicSample));
assert('legacy basic cache has <15 upgraded days', cache.countValidPhaseCCurriculumDays(legacyBasicSample) < 15);
assert('empty curriculum payload is legacy', cache.isPhaseCCurriculumPayloadLegacy(emptyCurriculumSample));
assert('dash cache is corrupt', cache.isPhaseCCurriculumCacheCorrupt(body, corruptSample));
assert('dash cache has 0 upgraded days', cache.countValidPhaseCCurriculumDays(corruptSample) === 0);

if (failed) {
  console.error(failed + ' test(s) failed');
  process.exit(1);
}
console.log('All phase_c fail-safe tests passed');
