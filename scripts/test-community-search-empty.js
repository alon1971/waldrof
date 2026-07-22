#!/usr/bin/env node
'use strict';

const communitySearch = require('../api/community-search');
const communityDriveArchive = require('../api/community-drive-archive');
const communitySummarizer = require('../api/community-summarizer');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

const EMPTY = 'אין חומר מהארכיון עבור נושא וכיתה זו';
const HEADING = 'סיכום נושא מתוך המאגר הקהילתי';

assert(communitySearch.COMMUNITY_SUMMARY_EMPTY === EMPTY, 'community-search empty copy');
assert(communitySearch.COMMUNITY_SUMMARY_HEADING === HEADING, 'community-search heading');
assert(communityDriveArchive.COMMUNITY_SUMMARY_EMPTY === EMPTY, 'archive empty copy');
assert(communityDriveArchive.COMMUNITY_SUMMARY_HEADING === HEADING, 'archive heading');
assert(communitySummarizer.COMMUNITY_SUMMARY_EMPTY === EMPTY, 'summarizer empty copy');
assert(communitySummarizer.COMMUNITY_SUMMARY_HEADING === HEADING, 'summarizer heading');
assert(
  communitySearch.EMPTY_COMMUNITY_PROBE.communitySummary == null,
  'EMPTY_COMMUNITY_PROBE has no auto summary'
);

assert(
  communitySearch.resolveSearchMode({ mode: 'navigation' }) === communitySearch.MODE_NAVIGATION,
  'mode navigation'
);
assert(
  communitySearch.resolveSearchMode({ summarize: true }) === communitySearch.MODE_NAVIGATION,
  'summarize true still navigation (summarizer is decoupled)'
);
assert(
  communitySearch.resolveSearchMode({ phase: 'general_search' }) === communitySearch.MODE_NAVIGATION,
  'hybrid phase → navigation only (no Gemini in live search)'
);

const citations = communitySearch.buildCommunityCitations([
  {
    fileName: 'מיתוס.pdf',
    gradeLabel: 'כיתה ה׳',
    catalogTopic: 'יוון',
    webViewLink: 'https://drive.google.com/file/d/abc/view',
    driveFileId: 'abc',
  },
]);
assert(citations.length === 1, 'one citation');
assert(citations[0].locationPath === 'כיתה ה׳ > יוון', 'citation path uses >');
assert(citations[0].webViewLink.indexOf('drive.google.com') >= 0, 'citation has webViewLink');

const navMeta = communitySearch.attachCommunityHybridMeta({}, {
  matches: [],
  count: 0,
  communityMode: communitySearch.MODE_NAVIGATION,
  communityStatus: 'empty',
  communityCitations: [],
});
assert(navMeta.communitySummary == null, 'navigation mode has no Gemini summary');
assert(navMeta.directDriveSearch === true, 'navigation flagged as directDriveSearch');

const pedMeta = communitySearch.attachCommunityHybridMeta({}, {
  matches: [{ fileName: 'x' }],
  count: 1,
  communityMode: communitySearch.MODE_PEDAGOGICAL,
  communityStatus: 'ok',
  communitySummary: 'should be stripped',
});
assert(pedMeta.communitySummary == null, 'live search never attaches Gemini summary');
assert(pedMeta.directDriveSearch === true, 'pedagogical alias still citations-only');

const withLinks = communitySearch.appendCitationsMarkdown('סיכום', citations);
assert(/מראי מקום/.test(withLinks), 'appends citations heading');
assert(/מיתוס\.pdf/.test(withLinks), 'appends file name');
assert(/drive\.google\.com/.test(withLinks), 'appends drive link');

assert(communitySummarizer.SUMMARIZER_PHASE === 'community_summarizer', 'summarizer phase key');

assert(
  communityDriveArchive.resolveMultimodalMime('application/pdf', 'x.pdf') === 'application/pdf',
  'pdf mime'
);
assert(
  communityDriveArchive.resolveMultimodalMime('', 'scan.PDF') === 'application/pdf',
  'pdf by extension'
);
assert(
  communityDriveArchive.resolveMultimodalMime('image/jpeg', 'a.jpg') === 'image/jpeg',
  'jpeg mime'
);
assert(
  communityDriveArchive.isMultimodalCandidate({ mimeType: 'application/pdf', name: 't.pdf' }) === true,
  'pdf is multimodal candidate'
);
assert(
  communityDriveArchive.isMultimodalCandidate({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 't.docx' }) === false,
  'docx is not multimodal candidate'
);
assert(
  communityDriveArchive.MAX_GEMINI_MULTIMODAL_BYTES >= communityDriveArchive.MAX_GEMINI_INLINE_BYTES,
  'multimodal cap >= inline cap'
);

console.log('OK community-search + community-summarizer empty-copy + mode tests');
