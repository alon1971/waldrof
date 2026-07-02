#!/usr/bin/env node
'use strict';
/**
 * Backfill user_email, user_full_name, user_phone on user_subscriptions.
 * Uses Supabase service role + auth admin API + profiles.
 *
 * Run: node scripts/backfill-subscription-contacts.js
 */
const env = require('../api/env');
const billingDb = require('../api/billing-db');

const TABLE = 'user_subscriptions';

function cfg() {
  const url = env.getSupabaseUrl();
  const serviceKey = env.getSupabaseServiceRoleKey();
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  return { url: url, serviceKey: serviceKey };
}

function authHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

async function readResponse(res, label) {
  const text = await res.text();
  if (!res.ok) {
    let message = (text || '').trim() || (label || 'request') + ' failed';
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.message) message = String(parsed.message);
    } catch (e) { /* keep */ }
    throw new Error(message);
  }
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

async function fetchAllSubscriptions(url, serviceKey) {
  const params = new URLSearchParams();
  params.set('select', 'user_id,user_email,user_full_name,user_phone');
  params.set('order', 'updated_at.desc');
  const res = await fetch(url + '/rest/v1/' + TABLE + '?' + params.toString(), {
    headers: authHeaders(serviceKey),
  });
  const rows = await readResponse(res, 'list subscriptions');
  return Array.isArray(rows) ? rows : [];
}

async function fetchAuthUser(url, serviceKey, userId) {
  const res = await fetch(url + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
    headers: authHeaders(serviceKey),
  });
  return readResponse(res, 'auth user');
}

async function fetchProfile(url, serviceKey, userId) {
  const params = new URLSearchParams();
  params.set('select', 'email,display_name');
  params.set('id', 'eq.' + userId);
  params.set('limit', '1');
  const res = await fetch(url + '/rest/v1/profiles?' + params.toString(), {
    headers: authHeaders(serviceKey),
  });
  const rows = await readResponse(res, 'profile');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function extractPhoneFromAuthUser(authUser) {
  if (!authUser) return '';
  const meta = authUser.user_metadata || authUser.raw_user_meta_data || {};
  const candidates = [meta.phone, meta.phone_number, meta.mobile, authUser.phone];
  for (let i = 0; i < candidates.length; i++) {
    const value = String(candidates[i] || '').trim();
    if (value) return value;
  }
  return '';
}

function extractFullNameFromAuthUser(authUser) {
  if (!authUser) return '';
  const meta = authUser.user_metadata || authUser.raw_user_meta_data || {};
  return String(meta.full_name || meta.name || '').trim();
}

function buildContactPatch(row, authUser, profile) {
  const patch = {};
  const email = String(
    row.user_email ||
    (profile && profile.email) ||
    (authUser && authUser.email) ||
    ''
  ).trim().toLowerCase();
  const fullName = String(
    row.user_full_name ||
    (profile && profile.display_name) ||
    extractFullNameFromAuthUser(authUser) ||
    ''
  ).trim();
  const phone = String(
    row.user_phone ||
    extractPhoneFromAuthUser(authUser) ||
    ''
  ).trim();

  if (!String(row.user_email || '').trim() && email) patch.user_email = email;
  if (!String(row.user_full_name || '').trim() && fullName) patch.user_full_name = fullName;
  if (!String(row.user_phone || '').trim() && phone) patch.user_phone = phone;
  return patch;
}

async function patchSubscription(url, serviceKey, userId, patch) {
  const params = new URLSearchParams();
  params.set('user_id', 'eq.' + userId);
  const body = Object.assign({}, patch, { updated_at: new Date().toISOString() });
  const res = await fetch(url + '/rest/v1/' + TABLE + '?' + params.toString(), {
    method: 'PATCH',
    headers: authHeaders(serviceKey),
    body: JSON.stringify(body),
  });
  return readResponse(res, 'patch subscription');
}

async function main() {
  if (!billingDb.isEnabled()) {
    console.error('billing-db not enabled — set SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const { url, serviceKey } = cfg();
  const rows = await fetchAllSubscriptions(url, serviceKey);
  console.log('Subscriptions:', rows.length);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const userId = row.user_id;
    if (!userId) {
      skipped += 1;
      continue;
    }

    const hasEmail = Boolean(String(row.user_email || '').trim());
    const hasName = Boolean(String(row.user_full_name || '').trim());
    const hasPhone = Boolean(String(row.user_phone || '').trim());
    if (hasEmail && hasName && hasPhone) {
      skipped += 1;
      continue;
    }

    try {
      const authUser = await fetchAuthUser(url, serviceKey, userId);
      const profile = await fetchProfile(url, serviceKey, userId);
      const patch = buildContactPatch(row, authUser, profile);
      if (!Object.keys(patch).length) {
        skipped += 1;
        continue;
      }
      await patchSubscription(url, serviceKey, userId, patch);
      updated += 1;
      console.log('updated', userId, patch);
    } catch (err) {
      failed += 1;
      console.warn('failed', userId, err.message || err);
    }
  }

  console.log(JSON.stringify({ updated: updated, skipped: skipped, failed: failed }, null, 2));
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
