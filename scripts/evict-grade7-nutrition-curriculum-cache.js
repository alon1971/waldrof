#!/usr/bin/env node
'use strict';
/**
 * One-time eviction: Grade 7 (כיתה ז׳) Nutrition (תזונה) curriculum cache.
 * Deletes phase_c curriculum rows and strips embedded legacy curriculum from topic rows
 * so the next load triggers fresh 3-chunk Perplexity generation.
 *
 * Usage:
 *   node scripts/evict-grade7-nutrition-curriculum-cache.js --dry-run
 *   node scripts/evict-grade7-nutrition-curriculum-cache.js --execute
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

const GRADE_ID = '7';
const GRADE_LABEL = 'כיתה ז׳';
const TOPIC_CANDIDATES = [
  'תזונה',
  'תזונה ומערכי שיעור',
  'תזונה ומערכי שיעור בכיתה ז׳',
  'תזונה כיתה ז׳',
];
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

function isNutritionTopic(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return raw.indexOf('תזונה') >= 0;
}

function rowLooksLikeCurriculumPhaseC(row) {
  if (!row || row.phase !== 'phase_c') return false;
  const data = row.result_data || {};
  const bp = data.blockPlan || {};
  if (Array.isArray(bp.curriculum) && bp.curriculum.length) return true;
  if (Array.isArray(bp.days) && bp.days.length) return true;
  const key = String(row.cache_key || '');
  const curriculumKey = buildPhaseCKey(row.topic || '', 'curriculum');
  return !!(curriculumKey && key === curriculumKey);
}

function buildTopicKey(topic, gradeLabel) {
  return cacheDb.buildCacheKey({
    phase: 'topic',
    topic: topic,
    currentGrade: GRADE_ID,
    gradeId: GRADE_ID,
    gradeLabel: gradeLabel || GRADE_LABEL,
  });
}

function buildPhaseCKey(topic, cTab, gradeLabel) {
  return cacheDb.buildCacheKey({
    phase: 'phase_c',
    cTab: cTab,
    topic: topic,
    currentGrade: GRADE_ID,
    gradeId: GRADE_ID,
    gradeLabel: gradeLabel || GRADE_LABEL,
  });
}

async function fetchGrade7NutritionRows() {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  if (!url || !headers.apikey) return [];

  const params = new URLSearchParams();
  params.set(
    'select',
    'cache_key,phase,grade_id,grade_label,topic,query_text,created_at,hit_count,result_data'
  );
  params.set('grade_id', 'eq.' + GRADE_ID);
  params.set('or', '(topic.ilike.*תזונה*,query_text.ilike.*תזונה*)');
  params.set('order', 'created_at.desc');

  const res = await fetch(url + '/rest/v1/' + TABLE + '?' + params.toString(), { headers: headers });
  const body = await res.json();
  if (!res.ok) {
    throw new Error('Supabase query failed (' + res.status + '): ' + JSON.stringify(body));
  }
  const gradeRows = Array.isArray(body) ? body : [];

  const phaseParams = new URLSearchParams();
  phaseParams.set(
    'select',
    'cache_key,phase,grade_id,grade_label,topic,query_text,created_at,hit_count,result_data'
  );
  phaseParams.set('phase', 'eq.phase_c');
  phaseParams.set('topic', 'ilike.*תזונה*');
  phaseParams.set('order', 'created_at.desc');

  const phaseRes = await fetch(url + '/rest/v1/' + TABLE + '?' + phaseParams.toString(), { headers: headers });
  const phaseBody = await phaseRes.json();
  if (!phaseRes.ok) {
    throw new Error('Supabase phase_c query failed (' + phaseRes.status + '): ' + JSON.stringify(phaseBody));
  }
  const phaseRows = Array.isArray(phaseBody) ? phaseBody : [];

  const merged = gradeRows.slice();
  const seen = new Set(gradeRows.map(function (r) { return r.cache_key; }));
  phaseRows.forEach(function (row) {
    if (!row || !row.cache_key || seen.has(row.cache_key)) return;
    if (String(row.grade_id || '') !== GRADE_ID && String(row.grade_id || '') !== '') return;
    seen.add(row.cache_key);
    merged.push(row);
  });
  return merged;
}

function removeFromLocalFallback(keysToDelete, topicRowsToPatch) {
  const localPath = path.join(ROOT, 'data', 'cached_results.json');
  if (!fs.existsSync(localPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const deleteSet = new Set(keysToDelete);
    const patchMap = new Map();
    (topicRowsToPatch || []).forEach(function (entry) {
      patchMap.set(entry.cache_key, entry.result_data);
    });

    let removed = 0;
    let patched = 0;
    const kept = rows.map(function (row) {
      if (!row || !row.cache_key) return row;
      if (deleteSet.has(row.cache_key)) {
        removed++;
        return null;
      }
      if (patchMap.has(row.cache_key)) {
        patched++;
        return Object.assign({}, row, { result_data: patchMap.get(row.cache_key) });
      }
      return row;
    }).filter(Boolean);

    if (!removed && !patched) return;
    fs.writeFileSync(localPath, JSON.stringify({
      version: parsed.version || 1,
      updatedAt: new Date().toISOString(),
      rows: kept,
    }, null, 2));
    console.log('Local fallback: removed', removed, 'row(s), patched', patched, 'topic row(s).');
  } catch (err) {
    console.warn('Local fallback cleanup skipped:', err.message || err);
  }
}

function stripCurriculumFromTopicData(data) {
  data = cacheDb.coerceArchiveLessonResultData(cacheDb.coerceCachedResultData(data)) || data;
  if (!data || !data.blockPlan || typeof data.blockPlan !== 'object') return null;
  if (!data.blockPlan.curriculum && !data.blockPlan.days) return null;
  delete data.blockPlan.curriculum;
  delete data.blockPlan.days;
  return data;
}

async function patchTopicRow(cacheKey, resultData) {
  const url = supabaseUrl();
  const headers = supabaseHeaders();
  const res = await fetch(
    url + '/rest/v1/' + TABLE + '?cache_key=eq.' + encodeURIComponent(cacheKey),
    {
      method: 'PATCH',
      headers: Object.assign({}, headers, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ result_data: resultData }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('PATCH failed for ' + cacheKey + ': ' + res.status + ' ' + errText.slice(0, 200));
  }
  return true;
}

async function main() {
  if (!DRY_RUN && !EXECUTE) {
    console.log('Usage: node scripts/evict-grade7-nutrition-curriculum-cache.js --dry-run|--execute');
    process.exit(1);
  }

  const explicitKeys = new Set();
  TOPIC_CANDIDATES.forEach(function (topic) {
    const topicKey = buildTopicKey(topic);
    const curriculumKey = buildPhaseCKey(topic, 'curriculum');
    if (topicKey) explicitKeys.add(topicKey);
    if (curriculumKey) explicitKeys.add(curriculumKey);
    console.log('Topic:', topic);
    console.log('  topic cache_key:', topicKey);
    console.log('  phase_c curriculum cache_key:', curriculumKey);
  });

  const dbRows = await fetchGrade7NutritionRows();
  console.log('\nSupabase rows (grade 7 + תזונה):', dbRows.length);
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

  const keysToDelete = new Set();
  const topicPatches = [];

  dbRows.forEach(function (row) {
    if (!row || !row.cache_key) return;
    if (row.phase === 'phase_c') {
      if (rowLooksLikeCurriculumPhaseC(row)) {
        keysToDelete.add(row.cache_key);
      }
      return;
    }
    if (row.phase === 'topic' && isNutritionTopic(row.topic || row.query_text)) {
      const stripped = stripCurriculumFromTopicData(row.result_data);
      if (stripped) {
        topicPatches.push({ cache_key: row.cache_key, result_data: stripped, topic: row.topic });
      }
      const curriculumKey = buildPhaseCKey(row.topic || 'תזונה', 'curriculum', row.grade_label);
      if (curriculumKey) keysToDelete.add(curriculumKey);
    }
  });

  explicitKeys.forEach(function (key) {
    const phaseCRow = dbRows.find(function (r) { return r.cache_key === key; });
    if (!phaseCRow) return;
    if (phaseCRow.phase === 'phase_c') keysToDelete.add(key);
  });

  TOPIC_CANDIDATES.forEach(function (topic) {
    const curriculumKey = buildPhaseCKey(topic, 'curriculum');
    if (curriculumKey) keysToDelete.add(curriculumKey);
  });

  console.log('\nPlanned DELETE keys (' + keysToDelete.size + '):');
  Array.from(keysToDelete).forEach(function (key) { console.log('  DELETE', key); });
  console.log('\nPlanned topic PATCH (strip curriculum) (' + topicPatches.length + '):');
  topicPatches.forEach(function (entry) {
    console.log('  PATCH', entry.cache_key, 'topic=', entry.topic);
  });

  if (DRY_RUN) {
    console.log('\nDry run only — no changes applied.');
    return;
  }

  for (const key of keysToDelete) {
    const deleted = await cacheDb.deleteCachedRowByKey(key);
    console.log(deleted ? 'Deleted' : 'Delete miss', key);
  }

  for (let i = 0; i < topicPatches.length; i++) {
    const entry = topicPatches[i];
    if (cacheDb.isSupabaseCacheEnabled && cacheDb.isSupabaseCacheEnabled()) {
      await patchTopicRow(entry.cache_key, entry.result_data);
    }
    console.log('Stripped curriculum from topic row', entry.cache_key);
  }

  for (let t = 0; t < TOPIC_CANDIDATES.length; t++) {
    await cacheDb.stripLegacyCurriculumFromTopicRow({
      topic: TOPIC_CANDIDATES[t],
      currentGrade: GRADE_ID,
      gradeId: GRADE_ID,
      gradeLabel: GRADE_LABEL,
    });
  }

  await Promise.all(dbRows.map(function (row) {
    if (!row || row.phase !== 'topic' || !isNutritionTopic(row.topic || row.query_text)) return Promise.resolve();
    return cacheDb.stripLegacyCurriculumFromTopicRow({
      topic: row.topic || 'תזונה',
      currentGrade: GRADE_ID,
      gradeId: GRADE_ID,
      gradeLabel: row.grade_label || GRADE_LABEL,
    });
  }));

  removeFromLocalFallback(Array.from(keysToDelete), topicPatches);

  const remaining = await fetchGrade7NutritionRows();
  const remainingCurriculum = remaining.filter(function (row) {
    return row.phase === 'phase_c' && rowLooksLikeCurriculumPhaseC(row);
  });
  const remainingTopicWithCurr = remaining.filter(function (row) {
    if (row.phase !== 'topic') return false;
    const bp = (row.result_data && row.result_data.blockPlan) || {};
    return Array.isArray(bp.curriculum) && bp.curriculum.length;
  });

  console.log('\nAfter eviction:');
  console.log('  remaining grade-7 nutrition rows:', remaining.length);
  console.log('  remaining phase_c curriculum rows:', remainingCurriculum.length);
  console.log('  remaining topic rows with embedded curriculum:', remainingTopicWithCurr.length);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
