#!/usr/bin/env node
'use strict';
/**
 * Purge ghost / mis-graded community_materials rows that pollute catalog search.
 *
 * Targets:
 * 1) Empty rows (no usable file_path / URL)
 * 2) Curriculum-mismatched folders (e.g. topic רומא under grade 1, יוון under grade 4)
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env
 *
 * Usage:
 *   node scripts/cleanup-community-ghost-folders.js --dry-run
 *   node scripts/cleanup-community-ghost-folders.js
 */
const fs = require('fs');
const path = require('path');
const pedagogicalScope = require('../api/pedagogical-scope');

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

const url = String(process.env.SUPABASE_URL || process.env.SUPABASE_URI || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const dryRun = process.argv.indexOf('--dry-run') >= 0;

if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env');
  process.exit(1);
}

const MATERIALS_TABLE = 'community_materials';
const KB_TABLE = 'community_knowledge_base';

function headers() {
  return {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };
}

async function restGet(pathSuffix) {
  const res = await fetch(url + pathSuffix, { method: 'GET', headers: headers() });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = text; }
  }
  return { ok: res.ok, status: res.status, body: body, text: text };
}

async function restDelete(pathSuffix) {
  const res = await fetch(url + pathSuffix, {
    method: 'DELETE',
    headers: Object.assign({}, headers(), { Prefer: 'return=representation' }),
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = text; }
  }
  return { ok: res.ok, status: res.status, body: body, text: text };
}

function hasUsableFileLink(row) {
  const filePath = String(row.file_path || '').trim();
  if (filePath) return true;
  // Some legacy rows store the only link inside notes.
  const notes = String(row.notes || '');
  if (/https?:\/\//i.test(notes)) return true;
  if (/\[driveFileId:[^\]]+\]/i.test(notes)) return true;
  return false;
}

function isEmptyGhost(row) {
  if (hasUsableFileLink(row)) return false;
  const fileName = String(row.file_name || '').trim();
  const topic = String(row.topic || '').trim();
  // Folder-like placeholder: no file link, and file_name empty or identical to topic.
  return !fileName || fileName === topic;
}

function isCurriculumMismatch(row) {
  const topic = String(row.topic || '').trim();
  if (!topic) return false;
  const grade = String(row.grade_level || '').trim();
  if (!grade || grade === 'general') return false;
  const block = pedagogicalScope.inferTopicCurriculumBlock(topic);
  if (!block || !block.gradeId) return false;
  return String(block.gradeId) !== grade;
}

function reasonFor(row) {
  const reasons = [];
  if (isEmptyGhost(row)) reasons.push('empty_ghost');
  if (isCurriculumMismatch(row)) {
    const block = pedagogicalScope.inferTopicCurriculumBlock(row.topic);
    reasons.push(
      'wrong_grade(topic=' + row.topic +
      ', rowGrade=' + row.grade_level +
      ', canonical=' + (block && block.gradeId) + ')'
    );
  }
  return reasons.join('; ');
}

async function listAllMaterials() {
  const rows = [];
  let offset = 0;
  const pageSize = 500;
  for (;;) {
    const pathSuffix =
      '/rest/v1/' + MATERIALS_TABLE +
      '?select=id,grade_level,topic,file_name,file_path,notes,created_at' +
      '&order=created_at.desc&limit=' + pageSize + '&offset=' + offset;
    const res = await restGet(pathSuffix);
    if (!res.ok) {
      throw new Error('List failed (' + res.status + '): ' + (res.text || '').slice(0, 300));
    }
    const batch = Array.isArray(res.body) ? res.body : [];
    rows.push.apply(rows, batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function deleteMaterialAndKb(id) {
  const kbDel = await restDelete(
    '/rest/v1/' + KB_TABLE + '?source_material_id=eq.' + encodeURIComponent(id)
  );
  if (!kbDel.ok && kbDel.status !== 404) {
    console.warn('KB delete warning for', id, kbDel.status, (kbDel.text || '').slice(0, 160));
  }
  const matDel = await restDelete(
    '/rest/v1/' + MATERIALS_TABLE + '?id=eq.' + encodeURIComponent(id)
  );
  if (!matDel.ok) {
    throw new Error('Material delete failed for ' + id + ': ' + matDel.status + ' ' + (matDel.text || '').slice(0, 200));
  }
  return Array.isArray(matDel.body) ? matDel.body.length : 1;
}

async function main() {
  console.log(dryRun ? 'DRY RUN — no deletes will be performed' : 'LIVE — deleting ghost / mis-graded rows');
  console.log('Listing community_materials from', url);
  const rows = await listAllMaterials();
  console.log('Total rows:', rows.length);

  const targets = rows.filter(function (row) {
    return isEmptyGhost(row) || isCurriculumMismatch(row);
  });

  if (!targets.length) {
    console.log('No ghost / mis-graded rows found.');
    return;
  }

  console.log('Targets (' + targets.length + '):');
  targets.forEach(function (row) {
    console.log(
      '-', row.id,
      '| grade=', row.grade_level,
      '| topic=', JSON.stringify(row.topic),
      '| file=', JSON.stringify(row.file_name),
      '|', reasonFor(row)
    );
  });

  if (dryRun) {
    console.log('Dry run complete. Re-run without --dry-run to delete.');
    return;
  }

  let deleted = 0;
  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const n = await deleteMaterialAndKb(row.id);
    deleted += n;
    console.log('Deleted', row.id, '(' + reasonFor(row) + ')');
  }
  console.log('Done. Deleted materials:', deleted);
}

main().catch(function (err) {
  console.error(err.message || err);
  process.exit(1);
});
