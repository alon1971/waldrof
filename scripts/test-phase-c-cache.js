#!/usr/bin/env node
'use strict';

const cache = require('../api/cache');

const goodSample = {
  blockPlan: {
    curriculum: [
      { day: 1, topic: 'א', content: 'תוכן עשיר יום 1', art: 'אמנות 1' },
      { day: 2, topic: 'ב', content: 'תוכן עשיר יום 2', art: 'אמנות 2' },
      { day: 3, topic: 'ג', content: 'תוכן עשיר יום 3', art: 'אמנות 3' },
      { day: 4, topic: 'ד', content: 'תוכן עשיר יום 4', art: 'אמנות 4' },
      { day: 5, topic: 'ה', content: 'תוכן עשיר יום 5', art: 'אמנות 5' },
    ],
  },
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

assert('good cache passes corrupt check', !cache.isPhaseCCurriculumCacheCorrupt(body, goodSample));
assert('good cache has 5 valid days', cache.countValidPhaseCCurriculumDays(goodSample) === 5);
assert('dash cache is corrupt', cache.isPhaseCCurriculumCacheCorrupt(body, corruptSample));
assert('dash cache has <5 valid days', cache.countValidPhaseCCurriculumDays(corruptSample) < 5);

if (failed) {
  console.error(failed + ' test(s) failed');
  process.exit(1);
}
console.log('All phase_c fail-safe tests passed');
