#!/usr/bin/env node
'use strict';

const pgs = require('../api/pure-general-search');
const hebrewTopicMatch = require('../hebrew-topic-match');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

assert(pgs.classifyPeriodSubjectFamily('התפתחות המדעים') === 'sciences', 'התפתחות המדעים → sciences');
assert(pgs.classifyPeriodSubjectFamily('מדעים') === 'sciences', 'מדעים → sciences');
assert(pgs.classifyPeriodSubjectFamily('רישום צורה') === 'form_drawing', 'רישום צורה → form_drawing');
assert(pgs.classifyPeriodSubjectFamily('היסטוריה') === 'history', 'היסטוריה → history');
assert(pgs.classifyPeriodSubjectFamily('מכניקה') === 'sciences', 'מכניקה → sciences');
assert(pgs.classifyPeriodSubjectFamily('רנסנס') === 'history', 'רנסנס → history');

const grade7 = { gradeId: '7', gradeLabel: 'כיתה ז׳' };
const lock = pgs.buildSubjectLockInstruction('התפתחות המדעים', grade7);
assert(lock.indexOf('100%') >= 0, 'lock states 100% subject stay');
assert(lock.indexOf('שיעורי מדעים בלבד') >= 0, 'lock forbids history drift on science queries');
assert(lock.indexOf('מכניקה') >= 0, 'grade 7 science lock includes מכניקה');
assert(lock.indexOf('כימיה של שריפה') >= 0, 'grade 7 science lock includes כימיה של שריפה');
assert(lock.indexOf('פיזיולוגיה') >= 0, 'grade 7 science lock includes פיזיולוגיה');
assert(lock.indexOf('רנסנס') >= 0, 'grade 7 science lock names Renaissance as forbidden');
assert(lock.indexOf('עידן התגליות') >= 0 || lock.indexOf('מגלי עולם') >= 0, 'grade 7 science lock names Age of Discovery as forbidden');
assert(lock.indexOf('המערכים הנלמדים') >= 0, 'lock requires daily topics to match the grade block');

const sys = pgs.buildPeriodBlockSystemPrompt('התפתחות המדעים', grade7);
assert(sys.indexOf('100%') >= 0, 'Gemini system prompt includes hard subject lock');
assert(sys.indexOf('מכניקה') >= 0, 'Gemini system prompt locks grade 7 sciences');

const user = pgs.buildPeriodBlockUserPrompt('התפתחות המדעים', grade7);
assert(user.indexOf('נעילת תחום דעת קשיחה') >= 0, 'user prompt includes subject lock heading');
assert(user.indexOf('שיעורי מדעים בלבד') >= 0, 'user prompt forbids history on science queries');

const historyLock = pgs.buildSubjectLockInstruction('היסטוריה', grade7);
assert(historyLock.indexOf('מגלי עולם') >= 0 || historyLock.indexOf('רנסנס') >= 0, 'history + grade 7 locks to explorers/Renaissance');
assert(historyLock.indexOf('תחום דעת נעול: היסטוריה') >= 0, 'history family is labeled');

const formLock = pgs.buildSubjectLockInstruction('רישום צורה', { gradeId: '3', gradeLabel: 'כיתה ג׳' });
assert(formLock.indexOf('רישום צורה') >= 0, 'form drawing stays form drawing');
assert(formLock.indexOf('אסור לגלוש להיסטוריה או למדעים') >= 0, 'form drawing forbids history/science drift');

assert(
  pgs.curriculumDriftsFromLockedSubject(
    { curriculum: [{ topic: 'רנסנס באיטליה', content: 'מגלי עולם ועידן התגליות', art: 'מפה' }] },
    'התפתחות המדעים',
    grade7
  ) === true,
  'Renaissance rows are drift on a science query'
);

assert(
  pgs.curriculumDriftsFromLockedSubject(
    { curriculum: [{ topic: 'מכניקה — מנופים', content: 'כימיה של שריפה ופיזיולוגיה/תזונה', art: 'שרטוט מנוף' }] },
    'התפתחות המדעים',
    grade7
  ) === false,
  'grade 7 science rows are not drift'
);

const physicsBlock = hebrewTopicMatch.findCurriculumTopicBlock('פיזיקה');
assert(physicsBlock, 'פיזיקה resolves to a curriculum block');
assert(String(physicsBlock.blockLabel).indexOf('מדעים') >= 0, 'פיזיקה is a science block, not Renaissance');
assert(String(physicsBlock.blockLabel).indexOf('רנסנס') < 0, 'פיזיקה must not map to Renaissance');

const renaissanceBlock = hebrewTopicMatch.findCurriculumTopicBlock('רנסנס');
assert(renaissanceBlock, 'רנסנס resolves');
assert(String(renaissanceBlock.blockLabel).indexOf('רנסנס') >= 0, 'רנסנס stays a history block');

console.log('test-period-subject-lock: ok');
