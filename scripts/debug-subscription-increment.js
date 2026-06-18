#!/usr/bin/env node
'use strict';
/**
 * Active probe: list user_subscriptions schema + test PATCH/upsert increment.
 * Run: node scripts/debug-subscription-increment.js
 */
const env = require('../api/env');
const subscriptionApi = require('../api/subscription');

const TABLE = 'user_subscriptions';

function cfg() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServiceRoleKey() || env.getSupabaseAnonKey(),
  };
}

async function rawRequest(pathSuffix, options) {
  const c = cfg();
  const opts = options || {};
  const headers = Object.assign({
    apikey: c.key,
    Authorization: 'Bearer ' + c.key,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }, opts.headers || {});
  const res = await fetch(c.url + pathSuffix, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let body;
  try { body = text && text.trim() ? JSON.parse(text) : text; } catch (e) { body = text; }
  return { status: res.status, ok: res.ok, body: body, text: text };
}

async function main() {
  const c = cfg();
  console.log('SUPABASE_URL:', c.url || '(missing)');
  console.log('SERVICE_ROLE:', Boolean(env.getSupabaseServiceRoleKey()));
  console.log('subscription isEnabled:', subscriptionApi.isEnabled());

  const list = await rawRequest('/rest/v1/' + TABLE + '?select=*&limit=20', { method: 'GET' });
  console.log('\n=== LIST user_subscriptions ===');
  console.log('status:', list.status, 'ok:', list.ok);
  if (!list.ok) {
    console.log('error:', JSON.stringify(list.body, null, 2));
    return;
  }
  const rows = Array.isArray(list.body) ? list.body : [];
  console.log('row count:', rows.length);
  rows.forEach(function (row, i) {
    console.log('row[' + i + ']:', JSON.stringify(row));
  });
  if (rows[0]) {
    console.log('columns:', Object.keys(rows[0]).join(', '));
  }

  if (!rows.length) {
    console.log('\nNo rows — cannot test increment');
    return;
  }

  const target = rows[0];
  const userId = target.user_id;
  const before = Number(target.trial_searches_used) || 0;
  const next = before + 1;
  console.log('\n=== PATCH trial_searches_used', before, '->', next, 'user_id:', userId, '===');

  const patchBody = { trial_searches_used: next, tier: target.tier || 'trial' };
  const patch = await rawRequest(
    '/rest/v1/' + TABLE + '?user_id=eq.' + encodeURIComponent(userId),
    { method: 'PATCH', body: JSON.stringify(patchBody) }
  );
  console.log('PATCH status:', patch.status, 'ok:', patch.ok);
  console.log('PATCH response:', JSON.stringify(patch.body));
  console.log('PATCH rows affected:', Array.isArray(patch.body) ? patch.body.length : 0);

  const patchWithUpdatedAt = await rawRequest(
    '/rest/v1/' + TABLE + '?user_id=eq.' + encodeURIComponent(userId),
    { method: 'PATCH', body: JSON.stringify(Object.assign({}, patchBody, { updated_at: new Date().toISOString() })) }
  );
  console.log('\nPATCH+updated_at status:', patchWithUpdatedAt.status);
  if (!patchWithUpdatedAt.ok) {
    console.log('PATCH+updated_at error:', JSON.stringify(patchWithUpdatedAt.body));
  } else {
    console.log('PATCH+updated_at rows:', Array.isArray(patchWithUpdatedAt.body) ? patchWithUpdatedAt.body.length : 0);
    console.log('PATCH+updated_at body:', JSON.stringify(patchWithUpdatedAt.body));
  }

  const refetch = await rawRequest(
    '/rest/v1/' + TABLE + '?user_id=eq.' + encodeURIComponent(userId) + '&select=*',
    { method: 'GET' }
  );
  console.log('\n=== REFETCH after PATCH ===');
  console.log(JSON.stringify(refetch.body));

  console.log('\n=== recordSearch via API module ===');
  try {
    const result = await subscriptionApi.recordSearch(
      { id: userId, email: target.user_email || '', tier: target.tier || 'trial' },
      ''
    );
    console.log('recordSearch OK:', JSON.stringify(result));
  } catch (err) {
    console.log('recordSearch FAILED:', err.message || err);
    if (err.usage) console.log('usage:', JSON.stringify(err.usage));
  }

  const final = await rawRequest(
    '/rest/v1/' + TABLE + '?user_id=eq.' + encodeURIComponent(userId) + '&select=*',
    { method: 'GET' }
  );
  console.log('\n=== FINAL ROW ===');
  console.log(JSON.stringify(final.body));
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
