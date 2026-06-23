#!/usr/bin/env node
'use strict';

const archiveCoerce = require('../archive-coerce');
const cache = require('../api/cache');

const fullSample = {
  blockPlan: {
    curriculum: [
      { day: 1, topic: 'האות א', content: 'תוכן עשיר על האות א עם סיפור ומסע.', art: 'ציור האות בגיר על הלוח.', hint: 'רמז' },
      { day: 2, topic: 'האות ב', content: 'יום שני בתוכן מלא.', art: 'יצירה בנייר.', hint: '' },
    ],
    rawContent: 'יום 1: האות א\nתוכן ארוך\nאמנות ומעשה: ציור',
  },
};

const dashSample = {
  blockPlan: {
    curriculum: [
      { day: 1, topic: 'יום 1', content: '—', art: '—', contentExpansion: { classroomImplementation: 'תוכן מלא מההרחבה' } },
    ],
    rawContent: 'יום 1\nתוכן מלא שאמור להישמר',
  },
};

function summarize(rows) {
  return (rows || []).map(function (r) {
    return { day: r.day, content: r.content, art: r.art };
  });
}

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    failed++;
  } else {
    console.log('ok:', name);
  }
}

const coerced = archiveCoerce.coerceArchiveLessonResultData(JSON.parse(JSON.stringify(fullSample)));
assert('coerce keeps full content', coerced.blockPlan.curriculum[0].content.indexOf('תוכן עשיר') === 0);
assert('coerce keeps full art', coerced.blockPlan.curriculum[0].art.indexOf('ציור') === 0);

const prepared = cache.preparePhaseCResultForCache(
  { phase: 'phase_c', cTab: 'curriculum' },
  fullSample
);
assert('cache prepare keeps content', prepared.blockPlan.curriculum[0].content === fullSample.blockPlan.curriculum[0].content);
assert('cache prepare keeps art', prepared.blockPlan.curriculum[0].art === fullSample.blockPlan.curriculum[0].art);

const dashPrepared = cache.preparePhaseCResultForCache(
  { phase: 'phase_c', cTab: 'curriculum' },
  dashSample
);
assert(
  'cache prepare lifts expansion when content is dash',
  dashPrepared.blockPlan.curriculum[0].content.indexOf('תוכן מלא') >= 0
);

const lifted = archiveCoerce.liftArchivePhaseCFields(
  { curriculum: fullSample.blockPlan.curriculum.slice() },
  fullSample
);
assert('lift keeps preserved rows', lifted.curriculum[0].content.indexOf('תוכן עשיר') === 0);

if (failed) {
  console.error(failed + ' test(s) failed');
  process.exit(1);
}
console.log('All phase_c cache tests passed');
