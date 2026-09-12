#!/usr/bin/env node
'use strict';

const jsonRepair = require('../api/json-repair');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

const thinkOpen = '<' + 'think>';
const thinkClose = '</' + 'think>';
const wrapped = thinkOpen + '\nreasoning chain\n' + thinkClose + '\n' +
  '{"theory":{"title":"רנסנס","sections":[{"heading":"רקע","content":"<p>תוכן עמוק על הרנסנס בכיתה ז׳.</p>"}]}}';
const stripped = jsonRepair.stripReasoningTokens(wrapped);
assert(stripped.indexOf('{') === 0, 'stripReasoningTokens keeps JSON after think block');
assert(!/think>/i.test(stripped), 'think tags removed');

const parsed = jsonRepair.parsePureModelJson(stripped, { phase: 'topic_master', context: { topic: 'רנסנס', grade: '7' } });
assert(parsed.parsed && parsed.parsed.theory, 'parsed topic_master JSON after reasoning strip');

console.log('OK: Perplexity JSON parsing uses prompt-only contract; reasoning strip preserves JSON');
