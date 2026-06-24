#!/usr/bin/env node
'use strict';

const cache = require('../api/cache');

function upgradedDay(day, topic) {
  return {
    day: day,
    topic: topic || ('יום ' + day),
    content:
      'תוכן עשיר ומפורט ליום ' + day + '. זרימת שיעור מלאה עם סיפור מחנך, חוויה כיתתית מעמיקה, ורישום ביומן. ' +
      'השיעור מכסה את כל שלבי העבודה בצורה פדגוגית מותאמת לגיל הילדים בכיתה.',
    art: 'אמנות ומעשה ליום ' + day + ' — ציור, חומרים טבעיים, ופעילות יצירתית מותאמת לגיל הכיתה.',
    hint: 'רמז ליום ' + day,
    contentExpansion: {
      classroomImplementation:
        'יישום כיתתי מפורט ליום ' + day + '. כולל הכנה לפני השיעור, זרימת שיעור מלאה, וסגירה רפלקטיבית. ' +
        'המורה מלווה את התלמידים בתנועה, סיפור, ועבודה יצירתית בהתאמה לגיל.',
      parentCommunityAspects:
        'היבט קהילתי והורים ליום ' + day + ' — שיתוף הורים, חג או אירוע קהילתי קטן, ותקשורת עם בית הספר.',
      practicalSteps: [
        'הכנת חומרים וסביבה לפני השיעור בכיתה',
        'פתיחה מחנכת עם שיר או תנועה קצרה',
        'העמקה בפעילות מרכזית ורישום ביומן',
        'סגירה רפלקטיבית ושיתוף תלמידים בקבוצה',
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

const formDrawingLegacySample = {
  blockPlan: {
    theory: {
      title: 'רישום צורה',
      sections: [{ heading: 'רקע', content: 'תיאוריה עשירה על רישום צורה בכיתה א.' }],
    },
    curriculum: Array.from({ length: 15 }, function (_, i) {
      return {
        day: i + 1,
        topic: 'יום ' + (i + 1),
        content: 'שורה קצרה אחת ליום ' + (i + 1) + ' ללא הרחבה פדגוגית.',
        art: 'ציור צורה פשוט',
      };
    }),
  },
  webResearch: { topic: 'רישום צורה', summary: 'תיאוריה עשירה על רישום צורה' },
};

const shallowExpansionSample = {
  blockPlan: {
    curriculum: Array.from({ length: 15 }, function (_, i) {
      return {
        day: i + 1,
        topic: 'יום ' + (i + 1),
        content: 'תוכן ארוך יחסית ליום ' + (i + 1) + ' עם משפט אחד בלבד שמתאר את זרימת השיעור בקצרה.',
        art: 'אמנות ומעשה ליום ' + (i + 1) + ' — ציור צורות גאומטריות.',
        contentExpansion: {
          classroomImplementation: 'יישום קצר מדי.',
          parentCommunityAspects: 'קצר.',
          practicalSteps: ['שלב אחד'],
          inspirationReferences: ['ספר'],
        },
      };
    }),
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
assert('form drawing legacy 15-day table is legacy', cache.isPhaseCCurriculumPayloadLegacy(formDrawingLegacySample));
assert('form drawing legacy triggers data corrupt check', cache.isPhaseCCurriculumDataCorrupt(formDrawingLegacySample));
assert('shallow expansion table is legacy', cache.isPhaseCCurriculumPayloadLegacy(shallowExpansionSample));
assert('empty curriculum payload is legacy', cache.isPhaseCCurriculumPayloadLegacy(emptyCurriculumSample));
assert('dash cache is corrupt', cache.isPhaseCCurriculumCacheCorrupt(body, corruptSample));
assert('dash cache has 0 upgraded days', cache.countValidPhaseCCurriculumDays(corruptSample) === 0);

if (failed) {
  console.error(failed + ' test(s) failed');
  process.exit(1);
}
console.log('All phase_c fail-safe tests passed');
