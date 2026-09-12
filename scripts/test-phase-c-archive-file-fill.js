#!/usr/bin/env node
'use strict';

const phaseC = require('../api/pure-phase-c');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

const generic = 'בגיל שלוש-עשרה הילד מתעורר. הנושא «רנסנס» מציע הזדמנות לחבר בין התוכן לבין מצפן הגיל.';
assert(phaseC.isThinGenericPhaseCPayload({
  theory: { sections: [{ heading: 'מצפן', content: generic }] },
  core_emphases: generic,
  key_points: [generic],
}), 'detect repeating generic compass stub as thin');

assert(phaseC.isThinGenericPhaseCPayload({
  theory: { sections: [{ heading: 'x', content: 'קצר' }] },
  core_emphases: 'גם זה קצר',
}), 'detect short stub as thin');

const richFileEssay = [
  '=== קובץ מאגר: ציר זמן.docx ===',
  'תקופת הרנסנס בכיתה ז׳ נבנית כציר זמן חי: מגלות, בנקים, אמנות הפרספקטיבה, ודמויות כמו לאונרדו וגלילאו.',
  'שבוע 1 — פתיחה: סיפור על פירנצה, ציור פרספקטיבה בלוח, ושיר מסע. מטרה: לעורר תחושת גילוי.',
  'שבוע 2 — מגלי עולם: מפות, כלי ניווט, וניסוי מצפן. התלמידים בונים ציר זמן משותף במחברת הראשית.',
  'שבוע 3 — אמנות ומדע: ביוגרפיה של לאונרדו, רישום אנטומי עדין, ודיון על האדם כמידה.',
  'שבוע 4 — סיכום: הצגת ציר הזמן, דרמה קצרה, ומטרות הערכה דרך חוויה ולא מבחן.',
  'המורה שומרת על קצב של שיעור ראשי: היזכרות, סיפור, עבודה אמנותית, וסגירה בתנועה.',
].join('\n');

const fromFile = phaseC.buildPhaseCFromSourceEssay(richFileEssay, 'כיתה ז׳', 'רנסנס', {
  files: [{ name: 'ציר זמן.docx', text: richFileEssay }],
});
assert(fromFile && fromFile.theory, 'build Phase C from extracted archive file text');
const fromFileText = JSON.stringify(fromFile);
assert(/ציר זמן|לאונרדו|פירנצה|פרספקטיבה/.test(fromFileText), 'file content reaches Stage B/C fields');
assert(!/מציע הזדמנות לחבר בין התוכן לבין מצפן הגיל/.test(fromFileText), 'file-built payload has no generic compass stub');
assert(!phaseC.isThinGenericPhaseCPayload(fromFile), 'file-built payload is not thin');

const stripped = phaseC.stripGenericCompassFallbackSentences(
  'פסקה אמיתית על הרנסנס. הנושא «רנסנס» מציע הזדמנות לחבר בין התוכן לבין מצפן הגיל.'
);
assert(/פסקה אמיתית על הרנסנס/.test(stripped), 'preserve real prose');
assert(!/מציע הזדמנות לחבר בין התוכן לבין מצפן הגיל/.test(stripped), 'strip generic compass sentence');

const promptBlock = phaseC.buildArchiveSourcePromptBlock({
  essay: richFileEssay,
  files: [{ name: 'ציר זמן.docx' }],
});
assert(/ציר זמן\.docx/.test(promptBlock), 'prompt names the archive file');
assert(/PRIMARY/.test(promptBlock), 'prompt treats archive files as primary source');

const defaults = phaseC.buildGradeDefaultCoreEmphasesParagraphs('כיתה ז׳', 'רנסנס').join('\n');
assert(!/מציע הזדמנות לחבר בין התוכן לבין מצפן הגיל/.test(defaults), 'grade defaults no longer append the generic sentence');

console.log('OK: Phase C archive-file fill + thin generic fallback rejection');
