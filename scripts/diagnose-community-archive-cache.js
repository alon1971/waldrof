/**
 * One-shot diagnostic: community_drive_archive lookup for אדם וחיה / grade 4.
 * Usage: node scripts/diagnose-community-archive-cache.js
 */
require('../api/env');
const env = require('../api/env');
const archive = require('../api/community-drive-archive');

const TOPIC = process.argv[2] || 'אדם וחיה';
const GRADE_ID = String(process.argv[3] || '4').trim();

function maskUrl(url) {
  const u = String(url || '');
  if (!u) return 'MISSING';
  return u.replace(/^(https:\/\/)([^.]+)(.*)$/i, '$1$2.***');
}

function jwtRole(key) {
  try {
    const part = String(key || '').split('.')[1];
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded + '==='.slice((padded.length + 3) % 4), 'base64').toString('utf8');
    return JSON.parse(json).role || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

async function main() {
  const url = env.getSupabaseUrl();
  const key = env.getSupabaseServiceRoleKey() || env.getSupabaseServerKey();
  console.log('=== CONFIG ===');
  console.log('supabaseUrl:', maskUrl(url));
  console.log('hasServiceKey:', Boolean(key));
  console.log('keyRole:', jwtRole(key));

  if (!url || !key) {
    console.error('Missing SUPABASE_URL or service role key in .env');
    process.exit(1);
  }

  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
  };

  console.log('\n=== NORMALIZATION ===');
  console.log('request.topic:', JSON.stringify(TOPIC));
  console.log('request.gradeId:', JSON.stringify(GRADE_ID));
  console.log('canonicalTopic:', JSON.stringify(archive.resolveCanonicalCommunityTopic(TOPIC)));
  console.log('aliases sample:', archive.expandCommunityTopicAliases(TOPIC).slice(0, 12));
  const opts = {
    gradeId: GRADE_ID,
    topic: TOPIC,
    catalogTopic: TOPIC,
    phase: 'community_summarizer',
  };
  console.log('primaryArchiveKey:', archive.buildArchiveKey(TOPIC, opts));
  console.log(
    'candidateKeys:',
    archive.buildArchiveKeyCandidates(TOPIC, opts)
  );

  console.log('\n=== RAW: grade_id=eq.' + GRADE_ID + ' ===');
  let res = await fetch(
    url + '/rest/v1/community_drive_archive?select=archive_key,topic,search_query,grade_id,community_status,summary_md&grade_id=eq.'
      + encodeURIComponent(GRADE_ID)
      + '&limit=50',
    { headers: headers }
  );
  let text = await res.text();
  console.log('status:', res.status);
  console.log('fullQuery: /rest/v1/community_drive_archive?grade_id=eq.' + GRADE_ID);
  if (!res.ok) {
    console.error('FULL SUPABASE ERROR:', text);
  } else {
    const rows = JSON.parse(text);
    console.log('rows:', rows.length);
    rows.forEach(function (r) {
      console.log(JSON.stringify({
        topic: r.topic,
        search_query: r.search_query,
        grade_id: r.grade_id,
        status: r.community_status,
        summaryChars: String(r.summary_md || '').length,
        key: String(r.archive_key || '').slice(0, 12),
      }));
    });
  }

  console.log('\n=== RAW: topic/search contains אדם (any grade) ===');
  const adamFilter = new URLSearchParams();
  adamFilter.set('select', 'archive_key,topic,search_query,grade_id,community_status');
  adamFilter.set('or', '(topic.ilike.*אדם*,search_query.ilike.*אדם*)');
  adamFilter.set('limit', '50');
  res = await fetch(
    url + '/rest/v1/community_drive_archive?' + adamFilter.toString(),
    { headers: headers }
  );
  text = await res.text();
  console.log('status:', res.status);
  if (!res.ok) {
    console.error('FULL SUPABASE ERROR:', text);
  } else {
    const rows = JSON.parse(text);
    console.log('rows mentioning אדם:', rows.length);
    rows.forEach(function (r) {
      console.log(JSON.stringify(r));
    });
  }

  console.log('\n=== RAW: sample of all rows (grade histogram) ===');
  res = await fetch(
    url + '/rest/v1/community_drive_archive?select=grade_id,topic,community_status,archive_key&limit=100',
    { headers: headers }
  );
  text = await res.text();
  if (!res.ok) {
    console.error('FULL SUPABASE ERROR:', text);
  } else {
    const rows = JSON.parse(text);
    const grades = {};
    rows.forEach(function (r) {
      const g = String(r.grade_id);
      grades[g] = (grades[g] || 0) + 1;
    });
    console.log('sampleRows:', rows.length, 'grade_id histogram:', grades);
    console.log(
      'sample:',
      rows.slice(0, 20).map(function (r) {
        return r.grade_id + '|' + r.topic + '|' + r.community_status;
      })
    );
  }

  console.log('\n=== findCommunityArchiveMatch ===');
  const match = await archive.findCommunityArchiveMatch(TOPIC, {
    gradeId: GRADE_ID,
    currentGrade: GRADE_ID,
    topic: TOPIC,
    catalogTopic: TOPIC,
    phase: 'community_summarizer',
  });
  console.log(
    'match:',
    match
      ? {
        matchType: match.matchType,
        suggestedTopic: match.suggestedTopic,
        dbTopic: match.row && match.row.topic,
        dbGrade: match.row && match.row.grade_id,
        summaryChars: match.row && String(match.row.summary_md || '').length,
        key: match.archiveKey && String(match.archiveKey).slice(0, 12),
      }
      : null
  );

  console.log('\n=== PERSIST SCHEMA PROBE ===');
  const probeKey = 'diag-probe-do-not-keep-' + Date.now();
  const payload = {
    archive_key: probeKey,
    search_query: 'diag',
    query_text: 'diag',
    grade_id: GRADE_ID,
    grade_level: GRADE_ID,
    topic: 'diag-probe',
    summary_md: 'diag',
    summary_text: 'diag',
    community_status: 'empty',
    source_fingerprint: 'diag',
    drive_fingerprint: 'diag',
    source_file_ids: [],
    file_refs: [],
    model: null,
  };
  res = await fetch(url + '/rest/v1/community_drive_archive?on_conflict=archive_key', {
    method: 'POST',
    headers: Object.assign({}, headers, {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    body: JSON.stringify(payload),
  });
  text = await res.text();
  console.log('upsert probe status:', res.status);
  if (!res.ok) {
    console.error('PERSIST PROBE FULL SUPABASE ERROR:', text);
  } else {
    console.log('PERSIST PROBE OK — schema accepts archive_key + grade_id + topic');
    const del = await fetch(
      url + '/rest/v1/community_drive_archive?archive_key=eq.' + encodeURIComponent(probeKey),
      { method: 'DELETE', headers: headers }
    );
    console.log('cleanup status:', del.status, await del.text());
  }
}

main().catch(function (err) {
  console.error('FATAL', err);
  process.exit(1);
});
