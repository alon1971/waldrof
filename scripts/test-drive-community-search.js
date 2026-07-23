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
assert(greeceScope.gradeId === '1', 'UI grade lock wins over curriculum grade');
assert(greeceScope.topic === 'יוון', 'יוון → topic יוון');

const greeceCurriculumOnly = drive.resolveDriveSearchScope('יוון', {});
assert(greeceCurriculumOnly.gradeId === '5', 'without UI grade, curriculum still maps יוון → 5');

const broadGreece = drive.resolveDriveSearchScope('יוון', { globalScan: true });
assert(broadGreece.gradeId === '', 'broad/global scan does not invent a grade lock');
assert(broadGreece.topic === 'יוון', 'broad scan still resolves topic');

const uiScope = drive.resolveDriveSearchScope('חשבון', { gradeId: '3', topic: 'חשבון' });
assert(uiScope.gradeId === '3', 'non-curriculum query keeps UI grade');
assert(uiScope.topic === 'חשבון', 'selected topic is preserved');

const qScopedParents = drive.buildDriveKeywordSearchQuery('רומא', {
  parentFolderIds: ['rome', 'geo'],
});
assert(qScopedParents.indexOf("'rome' in parents") >= 0, 'multi-parent scope includes rome');
assert(qScopedParents.indexOf("'geo' in parents") >= 0, 'multi-parent scope includes geo');

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

const broadAll = drive.resolveStrictDriveScopeFolderIds(fakeIndex, '', '');
assert(broadAll.has('rome') && broadAll.has('g1') && broadAll.has('g5'), 'empty grade+topic allow-list keeps all graded folders');
assert(!broadAll.has('root'), 'root without grade is excluded from broad allow-list');

const grade6Branch = drive.resolveDescendantFolderIds(fakeIndex, 'g6');
assert(grade6Branch.has('g6') && grade6Branch.has('rome') && grade6Branch.has('geo'), 'grade parent includes nested topic folders');
assert(!grade6Branch.has('g1') && !grade6Branch.has('root'), 'grade parent excludes other grades and root');

const resolvedParent = drive.resolveDriveParentFolderId(fakeIndex, { gradeId: '6' });
assert(resolvedParent === 'g6', 'gradeId resolves to grade root folder id');
const explicitParent = drive.resolveDriveParentFolderId(fakeIndex, {
  gradeId: '6',
  parentFolderId: 'rome',
});
assert(explicitParent === 'rome', 'explicit parentFolderId wins over grade root');

assert(drive.topicsStrictlyCompatible('רומא', 'רומא העתיקה') === true, 'Rome aliases compatible');
assert(drive.topicsStrictlyCompatible('יוון', 'מיתולוגיה נורדית') === false, 'Greece ≠ Norse');
assert(drive.topicsStrictlyCompatible('מיתולוגיה נורדית', 'מיתולוגיה יוונית') === false, 'Norse excludes Greek mythology');
assert(drive.topicsStrictlyCompatible('מיתולוגיה נורדית', 'רומא') === false, 'Norse excludes Rome');
assert(drive.topicsStrictlyCompatible('תזונה', 'אדם-עולם') === true, 'תזונה ↔ אדם-עולם (hyphen)');
assert(drive.topicsStrictlyCompatible('תזונה', 'תזונה ובריאות') === true, 'תזונה includes substring folder');
assert(drive.nameMatchesTopicCentrally('תזונה ונשימה מחברת תלמיד .pdf', 'תזונה', 'תזונה') === true, 'fuzzy name match תזונה');
assert(drive.nameMatchesTopicCentrally('תזונת הטמפרמנטים.docx', 'תזונה', 'תזונה') === true, 'תזונת* matches תזונה');
assert(drive.parseGradeIdFromFolderName('כיתה ז תשפו') === '7', 'parse grade from כיתה ז תשפו');
assert(drive.parseGradeIdFromFolderName("כיתה-ז'") === '7', 'parse grade from כיתה-ז');

const catalogTopics = require('../api/catalog-topics');
assert(catalogTopics.extractGradeIdFromQuery("פיזיקה כיתה ו'") === '6', 'extract grade from פיזיקה כיתה ו');
assert(catalogTopics.extractGradeIdFromQuery('התפתחות המדעים') === '', 'cross-cutting has no embedded grade');
assert(catalogTopics.isCrossCuttingTopic('התפתחות המדעים') === true, 'התפתחות המדעים is cross-cutting');
assert(catalogTopics.isCrossCuttingTopic('התפתחות השפה') === true, 'התפתחות השפה is cross-cutting');

const nutritionAliases = catalogTopics.expandCatalogTopicAliases(['תזונה']);
assert(nutritionAliases.some(function (a) { return /אדם עולם|adam olam/i.test(a); }), 'תזונה expands to אדם עולם');
assert(nutritionAliases.some(function (a) { return a === 'בריאות'; }), 'תזונה expands to בריאות');

const explorersAliases = catalogTopics.expandCatalogTopicAliases(['מגלי עולם']);
assert(
  !explorersAliases.some(function (a) { return a === 'תזונה' || a === 'בריאות'; }),
  'מגלי עולם must not expand into תזונה/בריאות'
);

const crossScope = drive.resolveDriveSearchScope('התפתחות המדעים', {});
assert(crossScope.broadScan === true, 'cross-cutting without grade → broadScan');
assert(crossScope.gradeId === '', 'cross-cutting without grade → no grade lock');

const physicsStrict = drive.resolveDriveSearchScope("פיזיקה כיתה ו'", {});
assert(physicsStrict.gradeId === '6', 'פיזיקה כיתה ו → strict grade 6');
assert(physicsStrict.broadScan === false, 'explicit query grade is not broad');

const norseExclude = catalogTopics.getExcludedTermsForQuery('מיתולוגיה נורדית');
assert(norseExclude.some(function (t) { return /יוון|greek/i.test(t); }), 'Norse excludes Greek terms');
assert(norseExclude.some(function (t) { return /רומא|roman/i.test(t); }), 'Norse excludes Roman terms');

console.log('OK drive-community-search tests');
