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

// Pinterest: three distinct English variants per spec
const pinUrls = qg.generatePinterestQueries('8', 'מהפכות');
assert('Pinterest generates three unique URLs', pinUrls.length === 3);
assert('Pinterest URLs are encoded Pinterest search links', pinUrls.every(function (u) {
  return /^https:\/\/www\.pinterest\.com\/search\/pins\/\?q=/.test(u);
}));

const pinQueries = pinUrls.map(function (u) { return decodeURIComponent(u.split('q=')[1]); });
assert('Pinterest variant 1 is Waldorf Class', /^Waldorf Class 8 revolutions/i.test(pinQueries[0]));
assert('Pinterest variant 2 is main lesson book', /main lesson book revolutions/i.test(pinQueries[1]));
assert('Pinterest variant 3 is blackboard drawing', /blackboard drawing revolutions/i.test(pinQueries[2]));
assert('Pinterest has no Hebrew', pinQueries.every(function (q) { return !/[\u0590-\u05FF]/.test(q); }));
assert('Pinterest has no quotes', pinQueries.every(function (q) { return !/["'«»]/.test(q); }));

const pin8 = qg.buildPinterestSearchQuery('המהפכה הצרפתית', 'המהפכה הצרפתית', body8);
assert('buildPinterestSearchQuery matches first variant', pin8 === pinQueries[0]);

// Topic-centric gallery — three spec variants, topic-anchored clutter allowed
const gallery = qg.buildPinterestGalleryForTopic('מהפכות', body8);
assert('Gallery has three topic-focused entries', gallery.length === 3);
assert('Gallery pins mention revolutions', gallery.every(function (g) { return /revolution/i.test(g.pin); }));
assert('Gallery allows topic-anchored notebook variant', gallery.some(function (g) {
  return /main lesson book/i.test(g.pin) && !qg.isGenericPinterestClutter(g.pin, 'מהפכות');
}));

// Grade-topic isolation
assert('Revolutions blocked for grade 3', qg.validateGradeTopicScope('3', 'מהפכה צרפתית'));
assert('Construction blocked for grade 8', qg.validateGradeTopicScope('8', 'בניית בית'));
assert('Grade 3 agriculture allowed', !qg.validateGradeTopicScope('3', 'חקלאות'));

// Article tier 1: trusted domain, quoted Hebrew per spec
const articleUrl = qg.buildPerDomainArticleSearchUrl('adamolam.co.il', 'מהפכות', 'כיתה ח');
assert('Article URL is Google search', /^https:\/\/www\.google\.com\/search\?q=/.test(articleUrl));
const decoded = decodeURIComponent(articleUrl.split('q=')[1]);
assert('Article query is single trusted domain', /^site:adamolam\.co\.il\b/.test(decoded));
assert('Article query uses quoted Hebrew topic and grade', /"מהפכות"/.test(decoded) && /"כיתה ח"/.test(decoded));
assert('Article query ends with וולדורף', /וולדורף\s*$/.test(decoded));

// Article two-tier generator
const articleRows = qg.generateArticleQueries('8', 'מהפכות', 'כיתה ח');
assert('Article generator has trusted domains plus open tiers', articleRows.length === qg.TRUSTED_DOMAINS.length + 2);
assert('Article open Hebrew tier uses OR chain', articleRows.some(function (r) {
  return r.source === 'google_he_open' && decodeURIComponent(r.url).indexOf(' OR ') >= 0;
}));
assert('Article open English tier exists', articleRows.some(function (r) { return r.source === 'google_en_global'; }));

// Fallback resources — full two-tier set
const fallbacks = qg.buildWebInspirationFallbackResources('מהפכות', 'כיתה ח');
assert('Fallback generates trusted + open tiers', fallbacks.length === qg.TRUSTED_DOMAINS.length + 2);
assert('Fallback URLs are all Google', fallbacks.every(function (f) { return /google\.com\/search/.test(f.url); }));
assert('Fallback URLs are unique', new Set(fallbacks.map(function (f) { return f.url; })).size === fallbacks.length);
assert('Fallback includes anatta trusted source', fallbacks.some(function (f) {
  return /site:anatta\.co\.il/.test(decodeURIComponent(f.url.split('q=')[1] || ''));
}));

// Web seed sanitizer — legacy Israeli school paths become site: search on same host
const sanitized = webSeed.sanitizePedagogicalResourceUrl(
  'https://www.harduf-waldorf.org.il/some/guessed/path',
  'מהפכות',
  { gradeLabel: 'כיתה ח' }
);
assert('Israeli path becomes Google search', /google\.com\/search/.test(sanitized));
const sanitizedQ = decodeURIComponent(sanitized.split('q=')[1]);
assert('Sanitized query targets harduf hostname', /site:harduf-waldorf\.org\.il/.test(sanitizedQ));

// Sanitize gallery rewrites off-topic pins
const cleaned = qg.sanitizePinterestGallery([
  { board: 'מחברת', title: 'מחברת תקופה', pin: 'Waldorf main lesson book' },
  { board: 'נושא', title: 'מהפכות', pin: 'revolutions Waldorf' },
], body8);
assert('Gallery drops generic notebook pin without topic', cleaned.every(function (g) {
  return !/^Waldorf main lesson book$/i.test(g.pin);
}));
assert('Gallery keeps topic pin', cleaned.some(function (g) { return /revolution/i.test(g.pin); }));

// Trusted domains exclude removed schools
assert('Shaked not in trusted domains', qg.TRUSTED_DOMAINS.indexOf('shakedwaldorf.org.il') === -1);
assert('Harduf not in trusted domains', qg.TRUSTED_DOMAINS.indexOf('harduf-waldorf.org.il') === -1);
assert('Waldorf forum org il not in trusted list', qg.TRUSTED_DOMAINS.indexOf('waldorf.org.il') === -1);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
