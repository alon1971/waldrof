#!/usr/bin/env node
'use strict';
const env = require('../api/env');
const url = env.getSupabaseUrl();
const key = env.getSupabaseServiceRoleKey();

const testId = '00000000-0000-4000-8000-000000000099';

async function tryInsert(payload) {
  const res = await fetch(url + '/rest/v1/user_subscriptions', {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, text: text };
}

async function cleanup() {
  await fetch(url + '/rest/v1/user_subscriptions?user_id=eq.' + testId, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
}

async function main() {
  const attempts = [
    { user_id: testId, tier: 'trial', trial_searches_used: 1 },
    { user_id: testId, tier: 'trial', trial_searches_used: 1, auto_renew: true },
    { user_id: testId, tier: 'trial', searches_used: 1 },
    { user_id: testId, tier: 'trial', search_count: 1 },
  ];
  for (let i = 0; i < attempts.length; i++) {
    await cleanup();
    const r = await tryInsert(attempts[i]);
    console.log('attempt', i, JSON.stringify(attempts[i]));
    console.log('  status:', r.status, r.text.slice(0, 300));
  }
  await cleanup();

  // OpenAPI columns
  const oa = await fetch(url + '/rest/v1/', {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/openapi+json' },
  });
  const spec = await oa.json();
  const def = spec.definitions && spec.definitions.user_subscriptions;
  if (def && def.properties) {
    console.log('\nOpenAPI user_subscriptions columns:', Object.keys(def.properties).join(', '));
  } else {
    console.log('\nNo OpenAPI definition found');
  }
}

main().catch(console.error);
