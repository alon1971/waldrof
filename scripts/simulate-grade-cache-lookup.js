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
process.chdir(ROOT);

const cache = require('../api/cache');

async function main() {
  const body = {
    phase: 'grade',
    currentGrade: '1',
    gradeId: '1',
    gradeLabel: 'כיתה א׳',
    age: '6-7',
  };
  cache.normalizeGradeCacheRequest(body);
  const key = cache.buildCacheKey(body);
  console.log('Built cache key:', key);

  const result = await cache.getCachedResult(body);
  console.log('getCachedResult:', result ? { fromCache: result.meta.fromCache, source: result.meta.source } : null);
}

main().catch(console.error);
