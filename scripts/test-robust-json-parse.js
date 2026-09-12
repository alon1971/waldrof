#!/usr/bin/env node
'use strict';

const jsonRepair = require('../api/json-repair');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

const fenced = [
  'הנה התשובה:',
  '```json',
  '{',
  '  "theory": { "title": "רנסנס", "sections": [{ "heading": "מהות", "content": "פסקה על ״פרספקטיבה״ בכיתה ז׳" }] },',
  '  "core_emphases": "מצפן התפתחותי לרנסנס"',
  '}',
  '```',
].join('\n');

const extracted = jsonRepair.extractRobustJsonObject(fenced);
assert(extracted.charAt(0) === '{', 'robust extract starts at first {');
assert(extracted.charAt(extracted.length - 1) === '}', 'robust extract ends at last }');
assert(!/```/.test(extracted), 'fences stripped');

const parsed = jsonRepair.parsePureModelJson(fenced, {
  phase: 'topic_master',
  context: { topic: 'רנסנס', grade: 'כיתה ז׳' },
  unwrap: true,
});
assert(parsed && parsed.parsed && parsed.parsed.theory, 'fenced Hebrew JSON parses');
assert(!parsed.parseFallback, 'fenced sample is not a parse fallback');
assert(/רנסנס|פרספקטיבה|מצפן/.test(JSON.stringify(parsed.parsed)), 'Hebrew content preserved');

const brokenQuotes = 'prefix {"theory":{"title":"רנסנס","sections":[{"heading":"x","content":"טקסט"}]},"core_emphases":"גיל"} trailing';
const parsed2 = jsonRepair.parsePureModelJson(brokenQuotes, {
  phase: 'topic_master',
  unwrap: true,
});
assert(parsed2 && parsed2.parsed && parsed2.parsed.core_emphases, 'first-{ last-} extract parses prose wrapper');

console.log('OK: robust JSON extract + parse for fenced / Hebrew model replies');
