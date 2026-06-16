#!/usr/bin/env node
/**
 * Push selected project files to GitHub without the git CLI.
 *
 * Usage:
 *   set GITHUB_TOKEN=ghp_xxxxxxxx   (Windows CMD)
 *   node upload-to-github.js
 *
 * Token needs "Contents: Read and write" on repo alon1971/waldrof.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OWNER = 'alon1971';
const REPO = 'waldrof';
const BRANCH = 'main';
const COMMIT_MESSAGE =
  'fix: restore mandatory Google auth on production with correct OAuth redirect';

const ROOT = __dirname;

// Files changed for layout, recent searches, Word export, and Render deployment.
const FILES_TO_UPLOAD = [
  'index.html',
  'languages.js',
  'chat-sidebar.js',
  'search-history.js',
  'share-materials.js',
  'auth-subscription.js',
  'package.json',
  'render.yaml',
  'server.js',
  '.env.example',
  'upload-to-github.js',
  'api/cache.js',
  'api/config.js',
  'api/embeddings.js',
  'api/env.js',
  'api/generate.js',
  'api/knowledge-chunks.js',
  'api/knowledge-ingest.js',
  'api/knowledge-seed.js',
  'api/rag.js',
  'api/search-history.js',
  'api/share-material.js',
  'scripts/upload-text.js',
  'supabase/cached_results.sql',
  'supabase/cached_results_user.sql',
  'supabase/knowledge_base.sql',
  'supabase/knowledge_base_community.sql',
  'supabase/setup_knowledge_base.sql',
];

(function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
})();

function getToken() {
  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      'Missing GitHub token. Set GITHUB_TOKEN before running.\n' +
      'Create one at: https://github.com/settings/tokens (scope: repo)'
    );
  }
  return token;
}

async function githubRequest(method, apiPath, body) {
  const token = getToken();
  const url = 'https://api.github.com' + apiPath;
  const res = await fetch(url, {
    method: method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'waldrof-upload-script',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  }

  if (!res.ok) {
    const msg = (data && data.message) || text || res.statusText;
    throw new Error('GitHub API ' + method + ' ' + apiPath + ' failed (' + res.status + '): ' + msg);
  }
  return data;
}

function discoverFilesFromGit() {
  const gitCandidates = [
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'git',
  ];
  let git = null;
  for (let i = 0; i < gitCandidates.length; i++) {
    try {
      if (gitCandidates[i] === 'git') {
        execSync('git --version', { stdio: 'ignore' });
        git = 'git';
        break;
      }
      if (fs.existsSync(gitCandidates[i])) {
        git = gitCandidates[i];
        break;
      }
    } catch (e) { /* try next */ }
  }
  if (!git) return null;

  try {
    const modified = execSync('"' + git + '" diff --name-only HEAD', {
      cwd: ROOT,
      encoding: 'utf8',
    }).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);

    const untracked = execSync('"' + git + '" ls-files --others --exclude-standard', {
      cwd: ROOT,
      encoding: 'utf8',
    }).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);

    const combined = Array.from(new Set(modified.concat(untracked).concat(['upload-to-github.js'])));
    return combined.length ? combined : null;
  } catch (e) {
    return null;
  }
}

function resolveFilesToUpload() {
  const discovered = discoverFilesFromGit();
  if (discovered && discovered.length) {
    console.log('Detected', discovered.length, 'changed/new files via git.');
    return discovered.sort();
  }
  console.log('Git not available — using built-in file list (' + FILES_TO_UPLOAD.length + ' files).');
  return FILES_TO_UPLOAD.slice().sort();
}

function readFileBase64(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    throw new Error('File not found: ' + relPath);
  }
  return fs.readFileSync(abs).toString('base64');
}

async function main() {
  const files = resolveFilesToUpload().filter(function (rel) {
    if (rel.startsWith('node_modules/')) return false;
    if (rel === '.env') return false;
    if (rel.startsWith('data/cached_results')) return false;
    return true;
  });

  if (!files.length) {
    console.log('Nothing to upload.');
    return;
  }

  console.log('Repository: ' + OWNER + '/' + REPO + ' (' + BRANCH + ')');
  console.log('Files to upload:');
  files.forEach(function (f) { console.log('  - ' + f); });

  const ref = await githubRequest('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  const parentSha = ref.object.sha;
  const parentCommit = await githubRequest('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + parentSha);
  const baseTreeSha = parentCommit.tree.sha;

  console.log('\nCreating blobs...');
  const treeEntries = [];
  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    process.stdout.write('  [' + (i + 1) + '/' + files.length + '] ' + rel + ' ... ');
    const blob = await githubRequest('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
      content: readFileBase64(rel),
      encoding: 'base64',
    });
    treeEntries.push({
      path: rel.replace(/\\/g, '/'),
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
    console.log('ok');
  }

  console.log('\nCreating tree and commit...');
  const tree = await githubRequest('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  const commit = await githubRequest('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: COMMIT_MESSAGE,
    tree: tree.sha,
    parents: [parentSha],
  });

  await githubRequest('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, {
    sha: commit.sha,
  });

  console.log('\nDone! Pushed to https://github.com/' + OWNER + '/' + REPO + '/commit/' + commit.sha);
  console.log('Render should auto-deploy if connected to this repo.');
}

main().catch(function (err) {
  console.error('\nUpload failed:', err.message || err);
  process.exit(1);
});
