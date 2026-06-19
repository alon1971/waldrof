#!/usr/bin/env node
'use strict';
/**
 * Delete community_materials rows that are Google Docs/Drive test links,
 * plus any community_knowledge_base chunks tied to those catalog ids.
 * Uses SUPABASE_SERVICE_ROLE_KEY from .env (required).
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

const url = String(process.env.SUPABASE_URL || process.env.SUPABASE_URI || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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

function isGoogleLinkRow(row) {
  if (!row || typeof row !== 'object') return false;
  const filePath = String(row.file_path || '').trim().toLowerCase();
  const fileName = String(row.file_name || '').trim().toLowerCase();
  const googleDocsUrl = String(row.google_docs_url || '').trim().toLowerCase();
  if (filePath.indexOf('docs.google.com') !== -1) return true;
  if (filePath.indexOf('drive.google.com') !== -1) return true;
  if (googleDocsUrl.indexOf('docs.google.com') !== -1) return true;
  if (googleDocsUrl.indexOf('drive.google.com') !== -1) return true;
  if (fileName.indexOf('google docs') !== -1) return true;
  if (fileName.indexOf('google drive') !== -1) return true;
  if (String(row.file_type || '').trim() === 'application/link') return true;
  return false;
}

async function listAllMaterials() {
  const result = await restGet('/rest/v1/' + MATERIALS_TABLE + '?select=*&order=created_at.desc');
  if (!result.ok) {
    throw new Error('Failed to list materials (' + result.status + '): ' + String(result.text).slice(0, 300));
  }
  return Array.isArray(result.body) ? result.body : [];
}

async function deleteKbByMaterialId(materialId) {
  if (!materialId) return 0;
  const result = await restDelete(
    '/rest/v1/' + KB_TABLE + '?source_material_id=eq.' + encodeURIComponent(String(materialId))
  );
  if (!result.ok && result.status !== 404) {
    console.warn('  KB delete warning for', materialId, result.status, String(result.text).slice(0, 120));
    return 0;
  }
  return Array.isArray(result.body) ? result.body.length : 0;
}

async function deleteMaterialRow(materialId) {
  const result = await restDelete(
    '/rest/v1/' + MATERIALS_TABLE + '?id=eq.' + encodeURIComponent(String(materialId))
  );
  if (!result.ok) {
    throw new Error('Delete failed for ' + materialId + ' (' + result.status + '): ' + String(result.text).slice(0, 300));
  }
  return Array.isArray(result.body) ? result.body.length : 0;
}

async function main() {
  const dryRun = process.argv.indexOf('--dry-run') !== -1;
  console.log('Listing community_materials from', url);
  const rows = await listAllMaterials();
  const targets = rows.filter(isGoogleLinkRow);
  console.log('Total materials:', rows.length);
  console.log('Google Docs/Drive link rows to delete:', targets.length);
  if (!targets.length) {
    console.log('Nothing to delete.');
    return;
  }
  targets.forEach(function (row) {
    console.log(' -', row.id, '|', row.grade_level, '|', row.topic, '|', row.file_name || row.file_path);
  });
  if (dryRun) {
    console.log('Dry run only — no rows deleted.');
    return;
  }
  let deletedMaterials = 0;
  let deletedKbChunks = 0;
  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const id = String(row.id || '').trim();
    if (!id) continue;
    const kbCount = await deleteKbByMaterialId(id);
    deletedKbChunks += kbCount;
    const count = await deleteMaterialRow(id);
    deletedMaterials += count;
    console.log('Deleted material', id, '(kb chunks:', kbCount + ')');
  }
  console.log('Done. Deleted', deletedMaterials, 'material row(s) and', deletedKbChunks, 'KB chunk(s).');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
