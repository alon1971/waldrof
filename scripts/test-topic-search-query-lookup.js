#!/usr/bin/env node
'use strict';

const archive = require('../api/community-drive-archive');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

assert(archive.GRADE_ESSENCE_SEARCH_QUERY === 'grade_essence', 'grade essence sentinel');
assert(
  archive.buildSearchQueryIlikeFilter('  רנסנס  ') === 'ilike.*רנסנס*',
  'ilike filter trims and wraps search_query like %topic%'
);
assert(
  archive.buildSearchQueryIlikeFilter('Renaissance') === 'ilike.*Renaissance*',
  'ilike filter keeps latin topic text'
);

const rows = [
  {
    search_query: 'grade_essence',
    grade_id: '7',
    summary_md: 'מהות הגיל לכיתה ז׳ — טקסט ארוך מספיק כדי לעבור את סף הארכיון.',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    search_query: 'רנסנס',
    grade_id: '7',
    summary_md: 'ציר זמן של הרנסנס בכיתה ז׳: פירנצה, פרספקטיבה, לאונרדו וגלילאו.',
    file_refs: [{ name: 'ציר זמן.docx', driveFileId: 'abc' }],
    updated_at: '2026-02-01T00:00:00Z',
  },
  {
    topic: 'רנסנס',
    search_query: '',
    grade_id: '7',
    summary_md: 'שורה ישנה לפי עמודת topic בלבד — לא אמורה לנצח את search_query.',
    updated_at: '2026-03-01T00:00:00Z',
  },
];

const ranked = archive.pickBestArchiveRowsBySearchQuery(rows, '  רנסנס ', '7');
assert(ranked.length === 1, 'drop grade_essence and empty search_query rows');
assert(ranked[0].search_query === 'רנסנס', 'prefer explicit search_query topic row');
assert(
  archive.collectFileRefsFromArchiveRows(ranked)[0].name === 'ציר זמן.docx',
  'linked archive files are collected from the matching row'
);
assert(
  /ציר זמן|לאונרדו/.test(archive.collectSummariesFromArchiveRows(ranked)[0] || ''),
  'row summary is ready to fill Stage B/C'
);

const otherGrade = archive.pickBestArchiveRowsBySearchQuery([
  {
    search_query: 'רנסנס',
    grade_id: '5',
    summary_md: 'תוכן רנסנס לכיתה ה׳ — מספיק ארוך לבדיקת דירוג לפי כיתה.',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    search_query: 'רנסנס',
    grade_id: '7',
    summary_md: 'תוכן רנסנס לכיתה ז׳ — זה השורה שצריכה להיבחר לכיתה ז׳.',
    updated_at: '2026-01-02T00:00:00Z',
  },
], 'רנסנס', '7');
assert(otherGrade[0].grade_id === '7', 'prefer matching grade when several topic rows exist');

const noGradeStillHits = archive.pickBestArchiveRowsBySearchQuery([
  {
    search_query: 'רנסנס',
    grade_id: '',
    summary_md: 'רשומת נושא בלי grade_id — עדיין חייבת להישלף לפי search_query.',
    file_refs: [{ name: 'ציר זמן.docx' }],
  },
], 'רנסנס', '7');
assert(noGradeStillHits.length === 1, 'topic row without grade_id is still returned');

const fromAltColumns = archive.extractArchiveRowContent({
  search_query: 'רנסנס',
  summary_md: '',
  content: 'תוכן שיעור רנסנס שמור בעמודת content ולא ב-summary_md.',
  json_data: { theory: { title: 'רנסנס', sections: [{ heading: 'מהות', content: 'פסקה מלאה על פרספקטיבה.' }] } },
});
assert(/עמודת content/.test(fromAltColumns.text), 'read text from content column');
assert(fromAltColumns.payload && fromAltColumns.payload.theory, 'read JSON payload from json_data');

console.log('OK: topic archive lookup uses search_query (not topic/subject)');
