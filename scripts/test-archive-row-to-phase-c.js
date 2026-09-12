#!/usr/bin/env node
'use strict';

const phaseC = require('../api/pure-phase-c');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

const markdown = [
  '# סיכום נושא מתוך המאגר הקהילתי: תקופת הרנסנס לכיתה ז\'',
  '',
  '## 1. רקע והדגשה פדגוגית',
  'תקופת ה**רנסנס**, שפירושה "תחייה", נלמדת בכיתה ז׳ מתוך מצפן הגיל.',
  'התלמידים פוגשים פרספקטיבה, מגלי עולם, ולאונרדו.',
  '',
  '## 2. סינתזה רחבה',
  'ציר הזמן החי מחבר בין פירנצה, בנקים, אמנות ומדע.',
  'המורה בונה שיעור ראשי של היזכרות, סיפור, ועבודה אמנותית.',
  '',
  '## 3. פעילויות יצירתיות',
  'ציור פרספקטיבה בלוח, שיר מסע, ודרמה קצרה בסוף התקופה.',
].join('\n');

const theory = phaseC.parseArchiveMarkdownToTheory(markdown, 'רנסנס', 'כיתה ז׳');
assert(theory.title.indexOf('רנסנס') >= 0, 'markdown H1 becomes theory.title');
assert(theory.sections.length >= 3, 'markdown H2 headings become theory.sections');
assert(theory.sections.every(function (sec) {
  return String(sec.content || '').trim().length > 20;
}), 'each section has real HTML content');
assert(/<p>/.test(theory.sections[0].content), 'section content is HTML paragraphs');
assert(!phaseC.phaseCHasFilledTheory({ theory: { title: '', sections: [] } }), 'empty theory is rejected');
assert(phaseC.phaseCHasFilledTheory({ theory: theory }), 'parsed markdown theory is filled');

const fromRow = phaseC.buildPhaseCFromArchiveRows([{
  search_query: 'רנסנס',
  grade_id: '7',
  summary_md: markdown,
  file_refs: [{ name: 'ציר זמן.docx', webViewLink: 'https://drive.google.com/file/d/abc' }],
}], 'כיתה ז׳', 'רנסנס');

assert(fromRow && fromRow.theory, 'archive row becomes Phase C payload');
assert(String(fromRow.theory.title || '').trim(), 'title is not empty');
assert(Array.isArray(fromRow.theory.sections) && fromRow.theory.sections.length, 'sections are not empty');
assert(/רנסנס|פרספקטיבה|לאונרדו|פירנצה/.test(JSON.stringify(fromRow)), 'real archive prose reaches Stage B/C');
assert(fromRow.relevant_links && fromRow.relevant_links[0] && /ציר זמן/.test(fromRow.relevant_links[0].title), 'linked files become sources');

assert(phaseC.isEmptyArchiveSourceLine(')'), 'bare ) is an empty source line');
assert(phaseC.isEmptyArchiveSourceLine('1. [](https://drive.google.com/file/d/abc)'), 'empty markdown link is empty');
assert(!phaseC.isEmptyArchiveSourceLine('1. [ציר זמן.docx](https://drive.google.com/file/d/abc)'), 'named file is kept');

const emptyBibMd = [
  '# נושא ארכיון',
  '',
  '## 1. רקע והדגשה פדגוגית',
  'פסקה אמיתית על ההוראה בכיתה ועל מצפן הגיל של התלמידים.',
  '',
  '## 5. מראי מקום והפניות למאגר',
  '1. )',
  '2. [](https://drive.google.com/file/d/abc)',
  '3. [ציר זמן.docx](https://drive.google.com/file/d/xyz)',
].join('\n');
const emptyBibTheory = phaseC.parseArchiveMarkdownToTheory(emptyBibMd, 'רנסנס', 'כיתה ז׳');
const bibSec = emptyBibTheory.sections.find(function (sec) {
  return /מראי מקום/.test(String(sec.heading || ''));
});
assert(bibSec, 'bibliography heading is kept when a real file exists');
assert(/ציר זמן\.docx/.test(bibSec.content), 'named archive file is shown');
assert(!/\)\s*</.test(bibSec.content) && bibSec.content.indexOf('>)') === -1, 'empty parentheses are not rendered');
assert(!/\[\]\(/.test(bibSec.content), 'empty markdown links are not rendered');

const onlyEmptyBibMd = [
  '# נושא ארכיון',
  '',
  '## 1. רקע והדגשה פדגוגית',
  'פסקה אמיתית על ההוראה בכיתה ועל מצפן הגיל של התלמידים.',
  '',
  '## 5. מראי מקום והפניות למאגר',
  '1. )',
  '2. ()',
].join('\n');
const onlyEmptyTheory = phaseC.parseArchiveMarkdownToTheory(onlyEmptyBibMd, 'רנסנס', 'כיתה ז׳');
assert(!onlyEmptyTheory.sections.some(function (sec) {
  return /מראי מקום/.test(String(sec.heading || ''));
}), 'empty bibliography section is omitted');

console.log('OK: archive markdown/JSON fills Stage B/C theory title and sections');
