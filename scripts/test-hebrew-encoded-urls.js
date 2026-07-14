/**
 * Smoke test: Hebrew percent-encoded source URLs must stay intact and readable.
 */
const phaseC = require('../api/pure-phase-c');

const HEBREW_URL =
  'https://daniel-zahavi.co.il/' +
  encodeURIComponent('ולדורף') + '/' +
  encodeURIComponent('מאמר-ארוך-על-חינוך-ולדורף-והתפתחות-הילד');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

assert(phaseC.isValidPhaseCExternalUrl(HEBREW_URL), 'valid Hebrew-encoded deep link rejected by isValidPhaseCExternalUrl');
assert(!phaseC.isDeadPhaseCFallbackUrl(HEBREW_URL), 'Hebrew-encoded deep link marked dead');

const cleaned = phaseC.cleanHarvestedUrl(HEBREW_URL);
assert(cleaned === HEBREW_URL, 'cleanHarvestedUrl dropped Hebrew URL: ' + cleaned);

const readable = phaseC.readableLabelFromEncodedUrl(HEBREW_URL);
assert(readable && /[\u0590-\u05FF]/.test(readable), 'readable label missing Hebrew: ' + readable);
assert(readable.indexOf('%D7') < 0, 'readable label still percent-encoded: ' + readable);

const md = '[' + HEBREW_URL + '](' + HEBREW_URL + ')';
const linkified = phaseC.linkifyFallbackSegment(md, 'ולדורף');
assert(linkified.html.indexOf('href="') >= 0, 'markdown Hebrew URL not linkified');
assert(linkified.html.indexOf('https://daniel-](') < 0, 'broken markdown split detected in html');
assert(linkified.html.indexOf(HEBREW_URL) >= 0, 'original href missing from anchor');
assert(linkified.html.indexOf('%D7') < 0 || /href="[^"]*%D7/.test(linkified.html), 'encoded text leaked outside href');

// Hostnames with hyphens must not be split by title/url patterns.
const hyphenHost = 'See also https://daniel-zahavi.co.il/about';
const hyphenLinkified = phaseC.linkifyFallbackSegment(hyphenHost, '');
assert(hyphenLinkified.html.indexOf('https://daniel-](') < 0, 'hyphen host split into broken markdown');

console.log('OK: Hebrew percent-encoded URLs accepted and rendered.');
console.log('readable:', readable);
