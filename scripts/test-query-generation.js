'use strict';

const qg = require('../waldorf-query-generation.js');
const webSeed = require('../waldorf-web-seed.js');

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    passed++;
    console.log('OK', label);
  } else {
    failed++;
    console.error('FAIL', label);
  }
}

const body8 = { currentGrade: '8', gradeId: '8', gradeLabel: 'כיתה ח׳', topic: 'המהפכה הצרפתית' };
const body3 = { currentGrade: '3', gradeId: '3', gradeLabel: 'כיתה ג׳', topic: 'חקלאות' };

// Pinterest: topic-first English
const pin8 = qg.buildPinterestSearchQuery('המהפכה הצרפתית', 'המהפכה הצרפתית', body8);
assert('Pinterest leads with topic keyword', /^revolutions/i.test(pin8));
assert('Pinterest includes Waldorf anchor', /waldorf/i.test(pin8));
assert('Pinterest has no Hebrew', !/[\u0590-\u05FF]/.test(pin8));
assert('Pinterest has no quotes', !/["'«»]/.test(pin8));
assert('Pinterest is not generic notebook clutter', !qg.isGenericPinterestClutter(pin8));

const pinUrl = qg.buildPinterestSearchUrl(pin8);
assert('Pinterest URL encodes once', pinUrl === 'https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(pin8));

// Topic-centric gallery — no מחברת תקופה clutter
const gallery = qg.buildPinterestGalleryForTopic('מהפכות', body8);
assert('Gallery has topic-focused entries', gallery.length >= 2);
assert('Gallery pins mention revolutions', gallery.every(function (g) { return /revolution/i.test(g.pin); }));
assert('Gallery rejects notebook clutter', gallery.every(function (g) { return !qg.isGenericPinterestClutter(g.pin); }));

// Grade-topic isolation
assert('Revolutions blocked for grade 3', qg.validateGradeTopicScope('3', 'מהפכה צרפתית'));
assert('Construction blocked for grade 8', qg.validateGradeTopicScope('8', 'בניית בית'));
assert('Grade 3 agriculture allowed', !qg.validateGradeTopicScope('3', 'חקלאות'));

// Article: single domain, Hebrew-only, short
const articleUrl = qg.buildPerDomainArticleSearchUrl('harduf-waldorf.org.il', 'המהפכה הצרפתית', 'כיתה ח');
assert('Article URL is Google search', /^https:\/\/www\.google\.com\/search\?q=/.test(articleUrl));
const decoded = decodeURIComponent(articleUrl.split('q=')[1]);
assert('Article query is single-domain', /^site:harduf-waldorf\.org\.il\b/.test(decoded));
assert('Article query has no OR chain', decoded.indexOf(' OR ') === -1);
assert('Article query has no English Main Lesson', decoded.indexOf('Main Lesson') === -1);
assert('Article query has no quotes', decoded.indexOf('"') === -1);
assert('Article query uses short Hebrew topic', /מהפכות/.test(decoded));
assert('Article query ends with וולדורף only', /וולדורף\s*$/.test(decoded));

// Fallback resources — distinct per-domain URLs
const fallbacks = qg.buildWebInspirationFallbackResources('מהפכות', 'כיתה ח');
assert('Fallback generates multiple sources', fallbacks.length >= 3);
assert('Fallback URLs are all Google', fallbacks.every(function (f) { return /google\.com\/search/.test(f.url); }));
assert('Fallback URLs are unique', new Set(fallbacks.map(function (f) { return f.url; })).size === fallbacks.length);
fallbacks.forEach(function (f, i) {
  var q = decodeURIComponent(f.url.split('q=')[1] || '');
  assert('Fallback #' + (i + 1) + ' is Hebrew-only site search', !/Main Lesson|pedagogy/i.test(q));
});

// Web seed sanitizer
const sanitized = webSeed.sanitizePedagogicalResourceUrl(
  'https://www.harduf-waldorf.org.il/some/guessed/path',
  'מהפכות',
  { gradeLabel: 'כיתה ח' }
);
assert('Israeli path becomes simple Google search', /google\.com\/search/.test(sanitized));
const sanitizedQ = decodeURIComponent(sanitized.split('q=')[1]);
assert('Sanitized query targets harduf domain', /site:harduf-waldorf\.org\.il/.test(sanitizedQ));

// Sanitize gallery rewrites off-topic pins
const cleaned = qg.sanitizePinterestGallery([
  { board: 'מחברת', title: 'מחברת תקופה', pin: 'Waldorf main lesson book' },
  { board: 'נושא', title: 'מהפכות', pin: 'revolutions Waldorf' },
], body8);
assert('Gallery drops generic notebook pin', cleaned.every(function (g) { return !/main lesson book/i.test(g.pin); }));
assert('Gallery keeps topic pin', cleaned.some(function (g) { return /revolution/i.test(g.pin); }));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
