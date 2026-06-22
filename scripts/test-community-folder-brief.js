#!/usr/bin/env node
'use strict';

const brief = require('../api/community-folder-brief');

const probe = {
  count: 2,
  query: 'יוון',
  matchMethod: 'keyword_substring',
  matches: [
    {
      gradeId: '5',
      gradeLabel: 'כיתה ה׳',
      topic: 'יוון העתיקה',
      catalogTopic: 'יוון',
      bundleTopic: 'יוון',
      title: 'חומר על אודיסאוס',
      similarity: 0.9,
    },
    {
      gradeId: '5',
      topic: 'יוון העתיקה',
      catalogTopic: 'יוון',
      title: 'מיתולוגיה',
      similarity: 0.85,
    },
  ],
};

const body = { userMessage: 'יוון' };
const result = brief.tryBuildCommunityFolderBrief(body, probe);

if (!result) {
  console.error('FAIL: expected folder brief for יוון');
  process.exit(1);
}

const answer = result.data.chatReply.answer;
const expected =
  'נמצאה במאגר הקהילתי תיקיית חומרים על יוון השייכת לכיתה ה׳! במקום להציג את כל התוכן כאן, תוכל לבחור כיצד להמשיך:';

if (answer !== expected) {
  console.error('FAIL: message mismatch');
  console.error(' got:', answer);
  console.error('want:', expected);
  process.exit(1);
}

if (result.data.chatReply.accessGradeLabel !== 'לגשת לכיתה ה׳') {
  console.error('FAIL: access button label', result.data.chatReply.accessGradeLabel);
  process.exit(1);
}

if (result.data.chatReply.downloadFolderLabel !== 'הורדת התיקייה') {
  console.error('FAIL: download button label');
  process.exit(1);
}

if (result.data.chatReply.gradeId !== '5') {
  console.error('FAIL: gradeId');
  process.exit(1);
}

const noMatch = brief.tryBuildCommunityFolderBrief({ userMessage: 'חשבון' }, probe);
if (noMatch) {
  console.error('FAIL: should not brief for unrelated query');
  process.exit(1);
}

console.log('OK community-folder-brief tests');
