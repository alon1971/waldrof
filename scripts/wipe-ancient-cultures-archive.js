#!/usr/bin/env node
'use strict';
/**
 * TOTAL wipe of every cached_results / community row related to «תרבויות קדומות».
 *
 * Usage:
 *   node scripts/wipe-ancient-cultures-archive.js --dry-run
 *   node scripts/wipe-ancient-cultures-archive.js --execute
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

const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');
const TABLE = cacheDb.TABLE_NAME || 'cached_results';
const TOPIC_NEEDLE = 'תרבויות קדומות';
const TOPIC_CANDIDATES = [
  'תרבויות קדומות',
  'תרבות קדומה',
  'תרבויות עתיקות',
  'תרבויות קדומות כיתה ה',
  'תרבויות קדומות כיתה ה׳',
  'תקופת תרבויות קדומות',
];

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

function rowBlob(row) {
  return [
    row && row.topic,
    row && row.query_text,
    row && row.grade_label,
    row && row.title,
    row && row.name,
    row && row.file_name,
    row && row.notes,
  ].map(function (v) { return String(v || ''); }).join(' ');
}

function matchesAncientCultures(row) {
  const blob = rowBlob(row);
  if (!blob) return false;
  if (blob.indexOf(TOPIC_NEEDLE) >= 0) return true;
  if (blob.indexOf('תרבויות') >= 0 && /קדומ/.test(blob)) return true;
  if (blob.indexOf('תרבות קדומה') >= 0) return true;
  if (blob.indexOf('תרבויות עתיקות') >= 0) return true;
  return false;
}

async function fetchCachedMatches() {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  if (!url || !headers.apikey) throw new Error('Supabase is not configured');

  const patterns = ['תרבויות קדומות', 'תרבויות', 'קדומות'];
  const byKey = new Map();

  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    const params = new URLSearchParams();
    params.set(
      'select',
      'cache_key,phase,grade_id,grade_label,topic,query_text,created_at,hit_count'
    );
    params.set(
      'or',
      '(topic.ilike.*' + p + '*,query_text.ilike.*' + p + '*)'
    );
    params.set('order', 'created_at.desc');
    params.set('limit', '500');
    const res = await fetch(url + '/rest/v1/' + TABLE + '?' + params.toString(), { headers: headers });
    const body = await res.json();
    if (!res.ok) {
      throw new Error('cached_results query failed (' + res.status + '): ' + JSON.stringify(body));
    }
    (Array.isArray(body) ? body : []).forEach(function (row) {
      if (!row || !row.cache_key || !matchesAncientCultures(row)) return;
      byKey.set(row.cache_key, row);
    });
  }
  return Array.from(byKey.values());
}

async function fetchCommunityMatches(tableName, selectCols) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  if (!url || !headers.apikey) return [];
  const params = new URLSearchParams();
  params.set('select', selectCols);
  params.set(
    'or',
    '(topic.ilike.*תרבויות*,title.ilike.*תרבויות*,name.ilike.*תרבויות*,notes.ilike.*תרבויות*,file_name.ilike.*תרבויות*)'
  );
  params.set('limit', '200');
  const res = await fetch(url + '/rest/v1/' + tableName + '?' + params.toString(), { headers: headers });
  const body = await res.json();
  if (!res.ok) {
    console.warn('[wipe] ' + tableName + ' query skipped:', res.status, JSON.stringify(body).slice(0, 200));
    return [];
  }
  return (Array.isArray(body) ? body : []).filter(matchesAncientCultures);
}

function collectExplicitKeys(rows) {
  const keys = new Set();
  rows.forEach(function (row) {
    if (row && row.cache_key) keys.add(row.cache_key);
  });

  const grades = new Set();
  rows.forEach(function (row) {
    if (row && row.grade_id != null && String(row.grade_id).trim()) {
      grades.add(String(row.grade_id).trim());
    }
  });
  // Also try common elementary grades in case only general_search rows exist.
  ['1', '2', '3', '4', '5', '6', '7', '8'].forEach(function (g) { grades.add(g); });

  const phases = [
    'topic',
    'topic_master',
    'perplexity_raw',
    'pedagogy_deep_dive',
    'archive_summary',
    'grade',
  ];
  grades.forEach(function (gradeId) {
    TOPIC_CANDIDATES.forEach(function (topic) {
      phases.forEach(function (phase) {
        const key = cacheDb.buildCacheKey({
          phase: phase,
          topic: topic,
          query: topic,
          currentGrade: gradeId,
          gradeId: gradeId,
        });
        if (key) keys.add(key);
      });
    });
  });

  TOPIC_CANDIDATES.forEach(function (topic) {
    const gsKey = cacheDb.buildCacheKey({
      phase: 'general_search',
      query: topic,
      topic: topic,
      archiveQuery: topic,
    });
    if (gsKey) keys.add(gsKey);
  });

  return keys;
}

function removeFromLocalFallback(keysToDelete) {
  const localPath = path.join(ROOT, 'data', 'cached_results.json');
  if (!fs.existsSync(localPath)) {
    console.log('Local fallback: file missing (ok).');
    return 0;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const deleteSet = new Set(keysToDelete);
    let removed = 0;
    const kept = rows.filter(function (row) {
      const blob = rowBlob(row);
      const byKey = row && row.cache_key && deleteSet.has(row.cache_key);
      const byTopic = matchesAncientCultures(row) || (blob && blob.indexOf(TOPIC_NEEDLE) >= 0);
      if (byKey || byTopic) {
        removed++;
        return false;
      }
      return true;
    });
    if (removed) {
      fs.writeFileSync(localPath, JSON.stringify({
        version: parsed.version || 1,
        updatedAt: new Date().toISOString(),
        rows: kept,
      }, null, 2));
    }
    console.log('Local fallback: removed', removed, 'row(s).');
    return removed;
  } catch (err) {
    console.warn('Local fallback cleanup skipped:', err.message || err);
    return 0;
  }
}

async function deleteCommunityRows(tableName, idField, rows) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  let deleted = 0;
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i] && rows[i][idField];
    if (id == null) continue;
    if (DRY_RUN) {
      console.log('  [dry-run] DELETE', tableName, idField + '=' + id);
      continue;
    }
    const res = await fetch(
      url + '/rest/v1/' + tableName + '?' + idField + '=eq.' + encodeURIComponent(String(id)),
      { method: 'DELETE', headers: headers }
    );
    if (res.ok) {
      deleted++;
      console.log('Deleted', tableName, id);
    } else {
      const body = await res.text();
      console.warn('Delete miss', tableName, id, res.status, body.slice(0, 160));
    }
  }
  return deleted;
}

async function main() {
  if (!DRY_RUN && !EXECUTE) {
    console.log('Usage: node scripts/wipe-ancient-cultures-archive.js --dry-run|--execute');
    process.exit(1);
  }

  console.log('=== Wipe «תרבויות קדומות» archive ===');
  console.log('Mode:', DRY_RUN ? 'DRY-RUN' : 'EXECUTE');

  const cachedRows = await fetchCachedMatches();
  console.log('\nSupabase cached_results matches:', cachedRows.length);
  cachedRows.forEach(function (row, i) {
    console.log(
      (i + 1) + '.',
      JSON.stringify({
        cache_key: row.cache_key,
        phase: row.phase,
        grade_id: row.grade_id,
        topic: row.topic,
        query_text: row.query_text,
        created_at: row.created_at,
      })
    );
  });

  const materials = await fetchCommunityMatches(
    'community_materials',
    'id,topic,title,name,file_name,notes,created_at'
  );
  console.log('\ncommunity_materials matches:', materials.length);
  materials.forEach(function (row, i) {
    console.log((i + 1) + '.', JSON.stringify(row));
  });

  const kb = await fetchCommunityMatches(
    'community_knowledge_base',
    'id,topic,title,name,notes,created_at'
  );
  console.log('\ncommunity_knowledge_base matches:', kb.length);
  kb.forEach(function (row, i) {
    console.log((i + 1) + '.', JSON.stringify(row));
  });

  const keysToDelete = collectExplicitKeys(cachedRows);
  console.log('\nPlanned cached_results DELETE keys:', keysToDelete.size);

  if (DRY_RUN) {
    Array.from(keysToDelete).forEach(function (key) { console.log('  [dry-run] DELETE', key); });
    console.log('\nDry run only — no changes applied.');
    return;
  }

  let deleted = 0;
  for (const key of keysToDelete) {
    const ok = await cacheDb.deleteCachedRowByKey(key);
    if (ok) deleted++;
    console.log(ok ? 'Deleted' : 'Delete miss', key);
  }

  removeFromLocalFallback(Array.from(keysToDelete));
  const deletedMaterials = await deleteCommunityRows('community_materials', 'id', materials);
  const deletedKb = await deleteCommunityRows('community_knowledge_base', 'id', kb);

  const remaining = await fetchCachedMatches();
  console.log('\nAfter wipe — remaining cached_results:', remaining.length);
  console.log('Deleted cache keys:', deleted);
  console.log('Deleted community_materials:', deletedMaterials);
  console.log('Deleted community_knowledge_base:', deletedKb);

  if (remaining.length) {
    console.error('WARNING: some matching cache rows still remain.');
    process.exit(2);
  }
  console.log('\nWipe complete — topic starts from a clean slate.');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
