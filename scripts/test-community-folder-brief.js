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

const chatBlocked = brief.tryBuildCommunityFolderBrief(
  { userMessage: 'יוון', phase: 'chat_followup' },
  probe
);
if (chatBlocked !== null) {
  console.error('FAIL: chat_followup must not build folder brief');
  process.exit(1);
}

const archiveResult = brief.tryBuildCommunityFolderBrief(
  { userMessage: 'יוון', phase: 'topic' },
  probe
);
if (!archiveResult) {
  console.error('FAIL: expected folder brief for archive topic probe');
  process.exit(1);
}

const answer = archiveResult.data.chatReply.answer;
const expected =
  'נמצאה במאגר הקהילתי תיקיית חומרים על יוון השייכת לכיתה ה׳! במקום להציג את כל התוכן כאן, תוכל לבחור כיצד להמשיך:';

if (answer !== expected) {
  console.error('FAIL: message mismatch');
  console.error(' got:', answer);
  console.error('want:', expected);
  process.exit(1);
}

const noMatch = brief.tryBuildCommunityFolderBrief({ userMessage: 'חשבון', phase: 'topic' }, probe);
if (noMatch) {
  console.error('FAIL: should not brief for unrelated query');
  process.exit(1);
}

console.log('OK community-folder-brief tests');
