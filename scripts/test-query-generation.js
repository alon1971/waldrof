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

// Article: open web queries — no site: restrictions
const articleUrl = qg.buildPerDomainArticleSearchUrl('example.org', 'מהפכות', 'כיתה ח');
assert('Article URL is Google search', /^https:\/\/www\.google\.com\/search\?q=/.test(articleUrl));
const decoded = decodeURIComponent(articleUrl.split('q=')[1]);
assert('Article query is open web with topic', decoded.indexOf('מהפכות') >= 0);
assert('Article query has no site: operator', !/(^|\s)site:/i.test(decoded));

const articleRows = qg.generateArticleQueries('8', 'מהפכות', 'כיתה ח');
assert('Article generator returns single open-web row', articleRows.length === 1);
assert('Article row is open_web source', articleRows[0].source === 'open_web');
assert('Article row has no site: in URL', !/site%3A|site:/i.test(articleRows[0].url));

// Fallback resources — no hardcoded site stubs
const fallbacks = qg.buildWebInspirationFallbackResources('מהפכות', 'כיתה ח');
assert('Fallback returns empty array', fallbacks.length === 0);

assert('Web seed domains list is empty', webSeed.WALDORF_WEB_SEED_DOMAINS.length === 0);
assert('Web seed fallback is empty', webSeed.buildWebInspirationFallbackResources('מהפכות', 'כיתה ח').length === 0);

const brokenSiteSearch = 'https://www.google.com/search?q=' + encodeURIComponent('site:adamolam.co.il מהפכות');
assert('Site-restricted Google URL is rejected', !webSeed.isAllowedPedagogicalUrl(brokenSiteSearch));

assert('shouldForceArticleSearchRedirect is disabled', !qg.shouldForceArticleSearchRedirect('https://www.example-waldorf.org/article'));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
