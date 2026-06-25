#!/usr/bin/env node
'use strict';
/**
 * TOTAL archive wipe — deletes ALL cached_results rows for configured grade/topic targets.
 * No partial strip — every cached row for the target (topic, perplexity_raw, legacy rows, etc.) is removed.
 *
 * Usage:
 *   node scripts/wipe-topic-archive-total.js --dry-run
 *   node scripts/wipe-topic-archive-total.js --execute
 */
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
const env = require('../api/env');

const WIPE_TARGETS = [
  {
    id: 'grade3-language',
    gradeId: '3',
    topicContains: 'לשון',
    topicCandidates: ['לשון ושפה', 'לשון', 'שפה ולשון', 'לשון ושפה כיתה ג׳'],
    supabaseTopicPattern: 'לשון',
  },
  {
    id: 'grade7-nutrition',
    gradeId: '7',
    topicContains: 'תזונה',
    topicCandidates: ['תזונה', 'תזונה ומערכי שיעור', 'תזונה ומערכי שיעור בכיתה ז׳', 'תזונה כיתה ז׳'],
    supabaseTopicPattern: 'תזונה',
  },
];

function topicMatchesTarget(topic, target) {
  const raw = String(topic || '').trim();
  if (!raw) return false;
  if (target.topicCandidates && target.topicCandidates.indexOf(raw) >= 0) return true;
  return raw.indexOf(target.topicContains) >= 0;
}

const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');
const TABLE = cacheDb.TABLE_NAME || 'cached_results';

function supabaseHeaders() {
  const key = env.getSupabaseServiceRoleKey() || env.getSupabaseAnonKey();
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function supabaseUrl() {
  return String(env.getSupabaseUrl() || '').replace(/\/$/, '');
}

function rowMatchesTarget(row, target) {
  if (!row) return false;
  if (String(row.grade_id || '') !== target.gradeId) return false;
  const topic = String(row.topic || row.query_text || '').trim();
  return topicMatchesTarget(topic, target);
}

async function fetchRowsForTarget(target) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  if (!url || !headers.apikey) return [];

  const params = new URLSearchParams();
  params.set(
    'select',
    'cache_key,phase,grade_id,grade_label,topic,query_text,created_at,hit_count'
  );
  params.set('grade_id', 'eq.' + target.gradeId);
  params.set(
    'or',
    '(topic.ilike.*' + target.supabaseTopicPattern + '*,query_text.ilike.*' + target.supabaseTopicPattern + '*)'
  );
  params.set('order', 'created_at.desc');

  const res = await fetch(url + '/rest/v1/' + TABLE + '?' + params.toString(), { headers: headers });
  const body = await res.json();
  if (!res.ok) {
    throw new Error('Supabase query failed for ' + target.id + ' (' + res.status + '): ' + JSON.stringify(body));
  }
  return Array.isArray(body) ? body.filter(function (row) { return rowMatchesTarget(row, target); }) : [];
}

function collectExplicitKeys(target) {
  const keys = new Set();
  const phases = ['topic', 'perplexity_raw'];
  (target.topicCandidates || []).forEach(function (topic) {
    phases.forEach(function (phase) {
      const key = cacheDb.buildCacheKey({
        phase: phase,
        topic: topic,
        currentGrade: target.gradeId,
        gradeId: target.gradeId,
        gradeLabel: target.gradeLabel,
      });
      if (key) keys.add(key);
    });
  });
  return keys;
}

function removeFromLocalFallback(keysToDelete) {
  const localPath = path.join(ROOT, 'data', 'cached_results.json');
  if (!fs.existsSync(localPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const deleteSet = new Set(keysToDelete);
    let removed = 0;
    const kept = rows.filter(function (row) {
      if (row && row.cache_key && deleteSet.has(row.cache_key)) {
        removed++;
        return false;
      }
      return true;
    });
    if (!removed) return;
    fs.writeFileSync(localPath, JSON.stringify({
      version: parsed.version || 1,
      updatedAt: new Date().toISOString(),
      rows: kept,
    }, null, 2));
    console.log('Local fallback: removed', removed, 'row(s).');
  } catch (err) {
    console.warn('Local fallback cleanup skipped:', err.message || err);
  }
}

async function wipeTarget(target) {
  console.log('\n=== TARGET:', target.id, 'grade', target.gradeId, 'pattern', target.supabaseTopicPattern, '===');
  const dbRows = await fetchRowsForTarget(target);
  console.log('Supabase rows found:', dbRows.length);
  dbRows.forEach(function (row, i) {
    console.log(
      (i + 1) + '.',
      JSON.stringify({
        cache_key: row.cache_key,
        phase: row.phase,
        topic: row.topic,
        query_text: row.query_text,
        created_at: row.created_at,
      })
    );
  });

  const keysToDelete = new Set(collectExplicitKeys(target));
  dbRows.forEach(function (row) {
    if (row && row.cache_key) keysToDelete.add(row.cache_key);
  });

  console.log('Planned TOTAL DELETE:', keysToDelete.size, 'key(s)');
  Array.from(keysToDelete).forEach(function (key) { console.log('  DELETE', key); });

  if (DRY_RUN) return { deleted: 0, remaining: dbRows.length };

  let deleted = 0;
  for (const key of keysToDelete) {
    const ok = await cacheDb.deleteCachedRowByKey(key);
    if (ok) deleted++;
    console.log(ok ? 'Deleted' : 'Delete miss', key);
  }

  removeFromLocalFallback(Array.from(keysToDelete));

  const remaining = await fetchRowsForTarget(target);
  console.log('After wipe — remaining rows:', remaining.length);
  return { deleted: deleted, remaining: remaining.length };
}

async function main() {
  if (!DRY_RUN && !EXECUTE) {
    console.log('Usage: node scripts/wipe-topic-archive-total.js --dry-run|--execute');
    process.exit(1);
  }

  let totalDeleted = 0;
  for (let i = 0; i < WIPE_TARGETS.length; i++) {
    const result = await wipeTarget(WIPE_TARGETS[i]);
    totalDeleted += result.deleted || 0;
  }

  if (DRY_RUN) {
    console.log('\nDry run only — no changes applied.');
    return;
  }

  console.log('\nTotal keys deleted:', totalDeleted);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
