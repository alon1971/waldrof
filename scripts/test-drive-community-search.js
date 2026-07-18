#!/usr/bin/env node
'use strict';

const drive = require('../api/drive-catalog-sync');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

// --- q builder: name + fullText ---
const qRome = drive.buildDriveKeywordSearchQuery('רומא');
assert(qRome.indexOf("fullText contains 'רומא'") >= 0, 'q must search fullText');
assert(qRome.indexOf("name contains 'רומא'") >= 0, 'q must search name');
assert(qRome.indexOf('trashed=false') >= 0, 'q must exclude trash');

const qEscaped = drive.buildDriveKeywordSearchQuery("rome's");
assert(qEscaped.indexOf("rome\\'s") >= 0, 'q must escape single quotes');

const qParent = drive.buildDriveKeywordSearchQuery('יוון', {
  parentFolderIds: ['folderABC'],
});
assert(qParent.indexOf("'folderABC' in parents") >= 0, 'q may scope to parent folder');

// --- Strict scope resolution ---
const romeScope = drive.resolveDriveSearchScope('רומא', {});
assert(romeScope.gradeId === '6', 'רומא → grade 6');
assert(romeScope.topic === 'רומא', 'רומא → topic רומא');

const greeceScope = drive.resolveDriveSearchScope('יוון', { gradeId: '1' });
assert(greeceScope.gradeId === '5', 'curriculum grade wins over UI grade 1');
assert(greeceScope.topic === 'יוון', 'יוון → topic יוון');

const uiScope = drive.resolveDriveSearchScope('חשבון', { gradeId: '3', topic: 'חשבון' });
assert(uiScope.gradeId === '3', 'non-curriculum query keeps UI grade');
assert(uiScope.topic === 'חשבון', 'selected topic is preserved');

// --- Folder allow-list filter ---
const fakeIndex = {
  byFolderId: {
    root: { gradeId: '', catalogTopic: '', path: [], parentId: '' },
    g6: { gradeId: '6', catalogTopic: '', path: ['כיתה ו׳'], parentId: 'root' },
    rome: { gradeId: '6', catalogTopic: 'רומא', path: ['כיתה ו׳', 'רומא'], parentId: 'g6' },
    geo: { gradeId: '6', catalogTopic: 'גיאולוגיה', path: ['כיתה ו׳', 'גיאולוגיה'], parentId: 'g6' },
    g1: { gradeId: '1', catalogTopic: 'אגדות', path: ['כיתה א׳', 'אגדות'], parentId: 'root' },
    g5: { gradeId: '5', catalogTopic: 'יוון', path: ['כיתה ה׳', 'יוון'], parentId: 'root' },
  },
  gradeRootFolders: { '6': 'g6', '1': 'g1', '5': 'g5' },
  topicFolders: {
    '6': { 'רומא': 'rome', 'גיאולוגיה': 'geo' },
    '5': { 'יוון': 'g5' },
  },
};

const romeFolders = drive.resolveStrictDriveScopeFolderIds(fakeIndex, '6', 'רומא');
assert(romeFolders.has('rome'), 'Rome scope includes Rome folder');
assert(!romeFolders.has('geo'), 'Rome scope excludes geology folder');
assert(!romeFolders.has('g1'), 'Rome scope excludes grade 1');

const grade6Only = drive.resolveStrictDriveScopeFolderIds(fakeIndex, '6', '');
assert(grade6Only.has('rome') && grade6Only.has('geo') && grade6Only.has('g6'), 'Grade-only scope keeps all grade-6 folders');

assert(drive.topicsStrictlyCompatible('רומא', 'רומא העתיקה') === true, 'Rome aliases compatible');
assert(drive.topicsStrictlyCompatible('יוון', 'מיתולוגיה נורדית') === false, 'Greece ≠ Norse');

console.log('OK drive-community-search tests');
