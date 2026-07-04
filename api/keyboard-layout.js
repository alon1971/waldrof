/**
 * Fix Hebrew typed while the OS keyboard was still on English layout
 * (e.g. "nvpfu," → "מהפכות"). Used on API ingress so gibberish never hits cache keys.
 */

const EN_TO_HE_KEYBOARD_MAP = {
  q: '/', w: "'", e: 'ק', r: 'ר', t: 'א', y: 'ט', u: 'ו', i: 'ן', o: 'ם', p: 'פ',
  a: 'ש', s: 'ד', d: 'ג', f: 'כ', g: 'ע', h: 'י', j: 'ח', k: 'ל', l: 'ך',
  z: 'ז', x: 'ס', c: 'ב', v: 'ה', b: 'נ', n: 'מ', m: 'צ',
  ',': 'ת', '.': 'ץ', ';': 'ף', "'": ',', '/': '.', '`': ';',
};

const KNOWN_ENGLISH_TOPIC_WORDS = {
  art: 1, arts: 1, music: 1, math: 1, maths: 1, mathematics: 1, science: 1, history: 1,
  geography: 1, nature: 1, animal: 1, animals: 1, plant: 1, plants: 1, farming: 1,
  season: 1, seasons: 1, spring: 1, summer: 1, autumn: 1, fall: 1, winter: 1,
  festival: 1, festivals: 1, fairy: 1, tale: 1, tales: 1, story: 1, stories: 1,
  montessori: 1, waldorf: 1, steiner: 1, rudolf: 1, anthroposophy: 1,
  shakespeare: 1, goethe: 1, photosynthesis: 1, evolution: 1, revolution: 1,
  education: 1, pedagogy: 1, curriculum: 1, lesson: 1, lessons: 1, grade: 1,
  kindergarten: 1, teacher: 1, teachers: 1, child: 1, children: 1,
  english: 1, hebrew: 1, language: 1, languages: 1,
};

function convertEnglishLayoutToHebrew(text) {
  return String(text == null ? '' : text).split('').map(function (ch) {
    const lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(EN_TO_HE_KEYBOARD_MAP, lower)) {
      return EN_TO_HE_KEYBOARD_MAP[lower];
    }
    return ch;
  }).join('');
}

function isLatinKeyboardOnlyText(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  if (/[\u0590-\u05FF]/.test(s)) return false;
  if (!/^[a-zA-Z\s,'`.;/\-]+$/.test(s)) return false;
  if (!/[a-zA-Z]/.test(s)) return false;
  return true;
}

function isExplicitEnglishTopicWord(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  return Boolean(w && KNOWN_ENGLISH_TOPIC_WORDS[w]);
}

function shouldFixReversedKeyboardInput(text) {
  if (!isLatinKeyboardOnlyText(text)) return false;
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  let allExplicitEnglish = true;
  for (let i = 0; i < words.length; i++) {
    if (!isExplicitEnglishTopicWord(words[i])) {
      allExplicitEnglish = false;
      break;
    }
  }
  if (allExplicitEnglish) return false;
  const converted = convertEnglishLayoutToHebrew(text);
  if (converted === text) return false;
  if (!/[\u0590-\u05FF]/.test(converted)) return false;
  return true;
}

function applyReversedKeyboardCorrection(text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed || !shouldFixReversedKeyboardInput(trimmed)) return trimmed;
  const corrected = convertEnglishLayoutToHebrew(trimmed);
  if (corrected && corrected !== trimmed) {
    console.log('[keyboard-fix]', trimmed, '→', corrected);
    return corrected;
  }
  return trimmed;
}

module.exports = {
  applyReversedKeyboardCorrection,
  convertEnglishLayoutToHebrew,
  shouldFixReversedKeyboardInput,
};
