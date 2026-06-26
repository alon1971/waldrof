/**
 * Smoke test: Phase C narrative fields must be prose-only — no <details>, anchors, or leaked attributes.
 */
const phaseC = require('../api/pure-phase-c');

const SAMPLE_HTML = [
  '<p>פסקת עומק על מספרים כאיכויות בכיתה א׳.</p>',
  "<details class='border p-4 rounded mb-2'>",
  "<summary class='cursor-pointer text-green-700 font-bold hover:underline'>הרחבה ואספקטים פרקטיים</summary>",
  "<div class='mt-3 text-gray-800'><p>שלבי יישום מעשיים בכיתה עם ציור צורות ותנועה.</p></div>",
  '</details>',
  "<a href='https://waldorflibrary.org/articles/math' target='_blank' class='text-green-700 underline font-bold'>[ספריית וולדורף]</a>",
  'https://rsarchive.org/example',
  'ראו מקור [2] לעומק נוסף.',
].join('');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

const normalized = phaseC.normalizePhaseCResponse({
  core_emphases: SAMPLE_HTML,
  key_points: [SAMPLE_HTML.replace('א׳', 'א׳ — נקודה ייחודית')],
  relevant_links: [{ title: 'ארכיון שטיינר — מתמטיקה', url: 'https://rsarchive.org/' }],
  theory: { title: 'test', sections: [{ heading: 'h', content: SAMPLE_HTML }], bibliography: { books: [], articles: [], websites: [] } },
}, 'כיתה א׳', 'מתמטיקה');

const sanitized = phaseC.applyPhaseCTextSanitizationChain(normalized);
const deduped = phaseC.deduplicateTab3Fields(sanitized, 'כיתה א׳', 'מתמטיקה');

const core = String(deduped.core_emphases || '');
const keyHtml = String(deduped.key_points[0] || '');

assert(!/<details[\s>]/i.test(core), 'core_emphases must not contain <details>');
assert(!/text-green-700/i.test(core), 'leaked anchor class in core_emphases');
assert(!/target\s*=/i.test(core), 'leaked target= attribute in core_emphases');
assert(!/\[2\]/.test(core), 'citation bracket in core_emphases');
assert(!/https?:\/\//i.test(core), 'raw URL in core_emphases');
assert(deduped.key_points.length, 'key_points emptied');
assert(!/<details[\s>]/i.test(keyHtml), 'key_points must not contain <details>');
assert(keyHtml.length > 40, 'key_points stripped too aggressively');

console.log('OK: Phase C narrative pipeline strips links, details, and citation markup.');
