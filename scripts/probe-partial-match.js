#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
}
const cacheDb = require('../api/cache');

async function main() {
  for (const topic of ['יהודה', 'נצרות', 'רומא']) {
    const match = await cacheDb.findArchiveTopicSuggestion({ topic: topic, gradeId: '6' });
    console.log('\nquery:', topic);
    console.log(match ? JSON.stringify({
      matchType: match.matchType,
      topic: match.topic,
      similarity: match.similarity,
      cacheKey: match.cacheKey ? match.cacheKey.slice(0, 12) : null,
    }) : 'null');
  }
}
main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
