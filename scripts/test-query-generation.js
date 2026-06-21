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

// Pinterest: three physically distinct phrases
const pinUrls = qg.generatePinterestQueries('8', 'מהפכות');
assert('Pinterest generates three unique URLs', pinUrls.length === 3);
assert('Pinterest Set dedupe — all URLs unique', new Set(pinUrls).size === pinUrls.length);
assert('Pinterest URLs are encoded Pinterest search links', pinUrls.every(function (u) {
  return /^https:\/\/www\.pinterest\.com\/search\/pins\/\?q=/.test(u);
}));

const pinQueries = pinUrls.map(function (u) { return decodeURIComponent(u.split('q=')[1]); });
assert('Pinterest variant 1 is Waldorf Class', /^Waldorf Class 8 revolutions/i.test(pinQueries[0]));
assert('Pinterest variant 2 is topic-first main lesson book', /^Waldorf revolutions.*main lesson book/i.test(pinQueries[1]));
assert('Pinterest variant 3 is topic-first chalkboard drawing', /^Waldorf revolutions.*chalkboard drawing/i.test(pinQueries[2]));
assert('Pinterest phrases are all different', pinQueries[0] !== pinQueries[1] && pinQueries[1] !== pinQueries[2]);
assert('Pinterest has no Hebrew', pinQueries.every(function (q) { return !/[\u0590-\u05FF]/.test(q); }));

const pin8 = qg.buildPinterestSearchQuery('המהפכה הצרפתית', 'המהפכה הצרפתית', body8);
assert('buildPinterestSearchQuery matches first variant', pin8 === pinQueries[0]);

// Gallery preserves three distinct URLs
const gallery = qg.buildPinterestGalleryForTopic('מהפכות', body8);
assert('Gallery has three entries', gallery.length === 3);
assert('Gallery URLs are all unique', new Set(gallery.map(function (g) { return g.url; })).size === 3);
assert('Gallery pins mention revolutions', gallery.every(function (g) { return /revolution/i.test(g.pin); }));

const sanitizedGallery = qg.sanitizePinterestGallery(gallery, body8);
assert('Sanitize preserves distinct gallery URLs', sanitizedGallery.length === 3);
assert('Sanitize keeps unique URLs after filter', new Set(sanitizedGallery.map(function (g) { return g.url; })).size === 3);

// Grade-topic isolation
assert('Revolutions blocked for grade 3', qg.validateGradeTopicScope('3', 'מהפכה צרפתית'));
assert('Construction blocked for grade 8', qg.validateGradeTopicScope('8', 'בניית בית'));
assert('Grade 3 agriculture allowed', !qg.validateGradeTopicScope('3', 'חקלאות'));

// Article: simple site: queries — no quotes choke, no open Google
const articleUrl = qg.buildPerDomainArticleSearchUrl('elyashev.co.il', 'מהפכות', 'כיתה ח');
assert('Article URL is Google search', /^https:\/\/www\.google\.com\/search\?q=/.test(articleUrl));
const decoded = decodeURIComponent(articleUrl.split('q=')[1]);
assert('Article query is simple site:elyashev', decoded === 'site:elyashev.co.il מהפכות');

const zomerUrl = qg.buildPerDomainArticleSearchUrl('zomer.org.il', 'מהפכות', 'כיתה ח');
const zomerQ = decodeURIComponent(zomerUrl.split('q=')[1]);
assert('Zomer query uses quoted וולדורף anchor', zomerQ === 'site:zomer.org.il "וולדורף" מהפכות');

const articleRows = qg.generateArticleQueries('8', 'מהפכות', 'כיתה ח');
assert('Article generator has trusted domains plus global repo', articleRows.length === qg.TRUSTED_DOMAINS.length + 1);
assert('No generic open Hebrew search', !articleRows.some(function (r) { return r.source === 'google_he_open'; }));
assert('No generic open English search', !articleRows.some(function (r) { return r.source === 'google_en_global'; }));
assert('Waldorf Library global repo exists', articleRows.some(function (r) {
  return r.source === 'waldorflibrary' && /site:waldorflibrary\.org/.test(decodeURIComponent(r.url));
}));

// Fallback resources
const fallbacks = qg.buildWebInspirationFallbackResources('מהפכות', 'כיתה ח');
assert('Fallback generates trusted + library', fallbacks.length === qg.TRUSTED_DOMAINS.length + 1);
assert('Fallback URLs are all Google site searches', fallbacks.every(function (f) { return /google\.com\/search/.test(f.url); }));
assert('Fallback URLs are unique', new Set(fallbacks.map(function (f) { return f.url; })).size === fallbacks.length);
assert('Fallback has no OR-chain open search', fallbacks.every(function (f) {
  return decodeURIComponent(f.url.split('q=')[1] || '').indexOf(' OR ') === -1;
}));

// Web seed sanitizer — legacy paths become simple site: on same host
const sanitized = webSeed.sanitizePedagogicalResourceUrl(
  'https://www.harduf-waldorf.org.il/some/guessed/path',
  'מהפכות',
  { gradeLabel: 'כיתה ח' }
);
assert('Israeli path becomes Google search', /google\.com\/search/.test(sanitized));
const sanitizedQ = decodeURIComponent(sanitized.split('q=')[1]);
assert('Sanitized query targets harduf hostname simply', sanitizedQ === 'site:harduf-waldorf.org.il מהפכות');

// Trusted domains exclude removed schools
assert('Shaked not in trusted domains', qg.TRUSTED_DOMAINS.indexOf('shakedwaldorf.org.il') === -1);
assert('Harduf not in trusted domains', qg.TRUSTED_DOMAINS.indexOf('harduf-waldorf.org.il') === -1);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
