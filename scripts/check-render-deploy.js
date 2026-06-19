#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SERVICE_ID = 'srv-d8ldhe8js32c7396nr80';
const API = 'https://api.render.com/v1';

(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
})();

async function main() {
  const token = String(process.env.RENDER_API_KEY || '').trim();
  if (!token) {
    console.error('RENDER_API_KEY not set — cannot query Render deploy status.');
    process.exit(2);
  }

  const git = require('child_process').execSync(
    '"C:\\Program Files\\Git\\bin\\git.exe" -C "' + path.join(__dirname, '..') + '" rev-parse HEAD',
    { encoding: 'utf8' }
  ).trim();

  const res = await fetch(API + '/services/' + SERVICE_ID + '/deploys?limit=5', {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
  });
  const rows = await res.json();
  if (!res.ok) {
    console.error('Render API error:', rows && rows.message ? rows.message : res.status);
    process.exit(1);
  }

  console.log('Local HEAD:', git);
  console.log('Recent Render deploys:');
  (rows || []).forEach(function (row) {
    const d = row.deploy || row;
    console.log([
      d.id,
      d.status,
      d.commit && d.commit.id ? d.commit.id.slice(0, 12) : '(no commit)',
      d.finishedAt || d.updatedAt || d.createdAt || '',
    ].join(' | '));
  });

  const live = (rows || []).find(function (row) {
    const d = row.deploy || row;
    return d.status === 'live';
  });
  const liveDeploy = live && (live.deploy || live);
  if (liveDeploy && liveDeploy.commit && liveDeploy.commit.id) {
    const deployed = liveDeploy.commit.id;
    console.log('Live commit:', deployed);
    console.log('Matches local HEAD:', deployed === git || deployed.startsWith(git) || git.startsWith(deployed));
  }

  const health = await fetch('https://waldrof.onrender.com/health');
  console.log('Health check:', health.status, await health.text());
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
