'use strict';
require('../api/env');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_CATALOG_ROOT_FOLDER_ID,
  FOLDER_MIME,
  resolveDriveAccessToken,
  listDriveChildren,
  fetchDriveFileMeta,
} = require('../api/drive-catalog-sync');

const ROOT_ID = process.argv[2] || DEFAULT_CATALOG_ROOT_FOLDER_ID;
const OUT = path.join(__dirname, 'drive-tree-report.txt');

function sortByName(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), 'he');
}

(async function main() {
  const lines = [];
  function log(s) {
    lines.push(s);
    console.log(s);
  }

  const token = await resolveDriveAccessToken({ write: false });
  const rootMeta = await fetchDriveFileMeta(
    ROOT_ID,
    token,
    'id,name,mimeType,driveId,owners,capabilities,shared,teamDriveId'
  );

  const isSharedDrive = !!(rootMeta.driveId || rootMeta.teamDriveId);
  log('ROOT: ' + rootMeta.name + ' (' + rootMeta.id + ')');
  log('mimeType: ' + rootMeta.mimeType);
  log('driveId: ' + (rootMeta.driveId || '(none)'));
  log('teamDriveId: ' + (rootMeta.teamDriveId || '(none)'));
  log('shared: ' + rootMeta.shared);
  log('looksLikeSharedDrive: ' + isSharedDrive);
  log('');

  const grades = (await listDriveChildren(ROOT_ID, token)).sort(sortByName);
  let totalTopics = 0;
  let totalFiles = 0;

  for (const grade of grades) {
    if (grade.mimeType !== FOLDER_MIME) {
      log('- [file] ' + grade.name + ' | ' + grade.mimeType + ' | ' + grade.id);
      totalFiles++;
      continue;
    }
    log('GRADE: ' + grade.name + ' (' + grade.id + ')');
    const topics = (await listDriveChildren(grade.id, token)).sort(sortByName);
    for (const topic of topics) {
      if (topic.mimeType !== FOLDER_MIME) {
        log('  - [file] ' + topic.name + ' | ' + topic.mimeType + ' | ' + topic.id);
        totalFiles++;
        continue;
      }
      totalTopics++;
      const children = (await listDriveChildren(topic.id, token)).sort(sortByName);
      const files = children.filter(function (c) { return c.mimeType !== FOLDER_MIME; });
      const subfolders = children.filter(function (c) { return c.mimeType === FOLDER_MIME; });
      totalFiles += files.length;
      log('  TOPIC: ' + topic.name + ' (' + topic.id + ') — ' + files.length + ' file(s)' +
        (subfolders.length ? ', ' + subfolders.length + ' subfolder(s)' : ''));
      for (const f of files) {
        log('    - ' + f.name + ' | ' + f.mimeType + ' | ' + f.id);
      }
      for (const sf of subfolders) {
        log('    [subfolder] ' + sf.name + ' | ' + sf.mimeType + ' | ' + sf.id);
      }
    }
    log('');
  }

  log('=== SUMMARY ===');
  log('gradeFoldersOrItems: ' + grades.length);
  log('topicFolders: ' + totalTopics);
  log('filesListedUnderTopics: ' + totalFiles);
  log('looksLikeSharedDrive: ' + isSharedDrive);

  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.log('\nSaved: ' + OUT);
})().catch(function (err) {
  console.error('FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
