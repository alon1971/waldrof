#!/usr/bin/env node
'use strict';

const phaseC = require('../api/pure-phase-c');
const shared = require('../api/pure-api-shared');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

assert(shared.LIVE_SEARCH_BUDGET_MS >= 90000, 'LIVE_SEARCH_BUDGET_MS must be at least 90 seconds');
assert(typeof shared.withLiveSearchRetry === 'function', 'withLiveSearchRetry is exported');
assert(shared.isCommunicationError(new Error('fetch failed')), 'detect fetch failed as communication error');
assert(!shared.isCommunicationError(new Error('missing key')), 'do not treat other errors as communication');

const timeoutErr = shared.liveSearchTimeoutError();
assert(timeoutErr.code === 'LIVE_SEARCH_TIMEOUT', 'liveSearchTimeoutError code');
assert(shared.isLiveSearchTimeoutError(timeoutErr), 'detect timeout error object');

const started = Date.now();
shared.withHardTimeout(new Promise(function () { /* never settles */ }), 40, 'test')
  .then(function () {
    console.error('FAIL: withHardTimeout should reject');
    process.exit(1);
  })
  .catch(function (err) {
    assert(shared.isLiveSearchTimeoutError(err), 'withHardTimeout rejects as timeout');
    assert(Date.now() - started < 400, 'withHardTimeout fires quickly');

    return shared.withLiveSearchRetry(function () {
      return Promise.reject(new Error('fetch failed'));
    }, { retries: 1, budgetMs: 50 });
  })
  .then(function () {
    console.error('FAIL: withLiveSearchRetry should reject after retries');
    process.exit(1);
  })
  .catch(function (err) {
    assert(/fetch failed/i.test(err && err.message ? err.message : ''), 'retry exhausts communication errors');

    const fromMaster = phaseC.extractPhaseCFromArchiveMatch({
      resultData: {
        theory: {
          title: 'רנסנס',
          sections: [{ heading: 'מהות', content: 'רקע תיאורטי עשיר על הרנסנס בכיתה ז׳ עם מצפן התפתחותי ומעבר מעידן האבירות לעידן האדם.' }],
        },
        core_emphases: 'התלמיד בכיתה ז׳ פוגש את הרנסנס כגילוי של האדם העצמאי.',
        key_points: ['גילוי', 'אמנות', 'מדע'],
      },
    }, 'כיתה ז׳', 'רנסנס');
    assert(fromMaster && fromMaster.theory, 'extract Phase C from topic_master-shaped archive');

    const fromWrapped = phaseC.extractPhaseCFromArchiveMatch({
      resultData: {
        purePhaseC: {
          theory: {
            title: 'רנסנס',
            sections: [{ heading: 'רקע', content: 'תוכן ארכיון מפורט על תקופת הרנסנס ומגלי העולם בכיתה ז׳.' }],
          },
          core_emphases: 'מצפן התפתחותי לרנסנס בכיתה ז׳ — גילוי, אמנות וחשיבה עצמאית.',
          key_points: ['מגלי עולם'],
        },
      },
    }, 'כיתה ז׳', 'רנסנס');
    assert(fromWrapped && fromWrapped.theory, 'extract Phase C from wrapped purePhaseC archive');

    const fromBlockPlan = phaseC.extractPhaseCFromArchiveMatch({
      resultData: {
        blockPlan: {
          theory: {
            title: 'רנסנס',
            sections: [{ heading: 'רקע', content: 'רקע תיאורטי מתוך blockPlan על הרנסנס בכיתה ז׳.' }],
          },
          rawContent: 'מהות פדגוגית מתוך ארכיון ישן של תקופת הרנסנס.',
        },
      },
    }, 'כיתה ז׳', 'רנסנס');
    assert(fromBlockPlan && fromBlockPlan.theory, 'extract Phase C from legacy blockPlan archive');

    const template = phaseC.buildPhaseCPedagogicalTemplate('כיתה ז׳', 'רנסנס');
    assert(template && template.theory, 'pedagogical template has theory');
    const templateText = JSON.stringify(template);
    assert(!/לא השיב בזמן|שלד ראשוני|timeout_skeleton/i.test(templateText), 'template has no timeout/empty-skeleton copy');
    assert(/מצפן|כיתה ז|רנסנס/i.test(templateText), 'template uses existing grade compass prose for the topic');

    const unwrapped = phaseC.unwrapArchivePhaseCData({ purePhaseC: { theory: { title: 'x' } } });
    assert(unwrapped && unwrapped.theory && unwrapped.theory.title === 'x', 'unwrap purePhaseC wrapper');

    console.log('OK planner archive-first + 90s live search + pedagogical template');
  });
