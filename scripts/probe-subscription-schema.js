#!/usr/bin/env node
'use strict';
const env = require('../api/env');

const url = env.getSupabaseUrl();
const key = env.getSupabaseServiceRoleKey() || env.getSupabaseAnonKey();

async function get(path) {
  const res = await fetch(url + path, {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body: body };
}

async function main() {
  console.log('url:', url);

  for (const table of ['user_subscriptions', 'cached_results', 'profiles']) {
    const r = await get('/rest/v1/' + table + '?select=*&limit=3');
    const rows = Array.isArray(r.body) ? r.body : [];
    console.log('\n' + table + ' status=' + r.status + ' rows=' + rows.length);
    if (!Array.isArray(r.body) && r.body && r.body.message) console.log('  msg:', r.body.message);
    if (rows[0]) console.log('  columns:', Object.keys(rows[0]).join(', '));
    if (rows[0]) console.log('  sample:', JSON.stringify(rows[0]));
  }

  // Test INSERT minimal subscription row
  const testId = '00000000-0000-4000-8000-000000000099';
  const insertRes = await fetch(url + '/rest/v1/user_subscriptions', {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      user_id: testId,
      tier: 'trial',
      trial_searches_used: 1,
      word_downloads_count: 0,
      monthly_searches_used: 0,
      usage_month: '2026-06',
      auto_renew: true,
    }),
  });
  const insertText = await insertRes.text();
  console.log('\nTEST INSERT status:', insertRes.status);
  console.log('TEST INSERT body:', insertText.slice(0, 500));

  if (insertRes.ok) {
    const del = await fetch(url + '/rest/v1/user_subscriptions?user_id=eq.' + testId, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    });
    console.log('TEST DELETE status:', del.status);
  }

  // Test INSERT with updated_at
  const insert2 = await fetch(url + '/rest/v1/user_subscriptions', {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      user_id: testId,
      tier: 'trial',
      trial_searches_used: 2,
      word_downloads_count: 0,
      monthly_searches_used: 0,
      usage_month: '2026-06',
      auto_renew: true,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }),
  });
  const t2 = await insert2.text();
  console.log('\nTEST INSERT+timestamps status:', insert2.status);
  console.log('body:', t2.slice(0, 500));
  if (insert2.ok) {
    await fetch(url + '/rest/v1/user_subscriptions?user_id=eq.' + testId, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    });
  }
}

main().catch(console.error);
