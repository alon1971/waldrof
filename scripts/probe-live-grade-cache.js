#!/usr/bin/env node
'use strict';

async function main() {
  const body = {
    phase: 'grade',
    currentGrade: '1',
    gradeId: '1',
    gradeLabel: 'כיתה א׳',
    age: '6-7',
  };
  const res = await fetch('https://waldrof.onrender.com/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log('Status:', res.status);
  const json = await res.json();
  console.log('meta:', JSON.stringify(json.meta || {}, null, 2));
  if (json.meta && json.meta.fromCache) {
    console.log('CACHE HIT on production');
  } else {
    console.log('CACHE MISS on production — regenerated from network');
  }
}

main().catch(console.error);
