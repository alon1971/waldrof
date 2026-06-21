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

// Pinterest: English, unquoted
const pin8 = qg.buildPinterestSearchQuery('המהפכה הצרפתית', 'המהפכה הצרפתית', body8);
assert('Pinterest query is English unquoted', pin8 === 'Waldorf Class 8 revolutions');
assert('Pinterest query has no Hebrew quotes', !/["'«»]/.test(pin8));
assert('Pinterest query has no Hebrew chars', !/[\u0590-\u05FF]/.test(pin8));

const pinUrl = qg.buildPinterestSearchUrl(pin8);
assert('Pinterest URL uses single encodeURIComponent', pinUrl === 'https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(pin8));

// Grade-topic isolation
const mismatch = qg.validateGradeTopicScope('3', 'מהפכה צרפתית');
assert('Revolutions blocked for grade 3', mismatch && mismatch.canonicalGradeId === '8');
const mismatch2 = qg.validateGradeTopicScope('8', 'בניית בית');
assert('Construction blocked for grade 8', mismatch2 && mismatch2.canonicalGradeId === '3');
assert('Grade 3 agriculture allowed', !qg.validateGradeTopicScope('3', 'חקלאות'));

const blockedPin = qg.buildPinterestSearchQuery('מהפכות', 'מהפכות', body3);
assert('Cross-grade Pinterest query blocked', blockedPin === '');

// Article Google site search
const articleUrl = qg.buildArticleGoogleSearchUrl('המהפכה הצרפתית', 'כיתה ח');
assert('Article URL is Google search', /^https:\/\/www\.google\.com\/search\?q=/.test(articleUrl));
const decoded = decodeURIComponent(articleUrl.split('q=')[1]);
assert('Article query uses OR site:', /site:waldorf\.org\.il OR site:harduf-waldorf\.org\.il/.test(decoded));
assert('Article query quotes topic', decoded.indexOf('"המהפכה הצרפתית"') >= 0);
assert('Article query includes grade', decoded.indexOf('כיתה ח') >= 0);
assert('Article query includes pedagogy anchors', /וולדורף/.test(decoded) && /Main Lesson/.test(decoded));

// Web seed sanitizer forces Israeli paths to Google search
const sanitized = webSeed.sanitizePedagogicalResourceUrl(
  'https://www.harduf-waldorf.org.il/some/guessed/path',
  'המהפכה הצרפתית',
  { gradeLabel: 'כיתה ח' }
);
assert('Israeli domain sanitized to Google search', /^https:\/\/www\.google\.com\/search\?q=/.test(sanitized));

// Gallery sanitization strips Hebrew quoted pins
const gallery = qg.sanitizePinterestGallery([
  { board: 'test', title: 'test', pin: '"חינוך וולדורף" "כיתה ח" מהפכות' },
], body8);
assert('Gallery rewrites to English pin', gallery.length === 1 && gallery[0].pin === 'Waldorf Class 8 revolutions');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
