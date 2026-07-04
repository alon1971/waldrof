/**
 * Strict Hebrew output, scholarly identity, and zero-hallucination rules for Perplexity/Sonar prompts.
 * Includes post-processing auto-replacements for common Hebrew spelling errors.
 */
const PERPLEXITY_HEBREW_FORBIDDEN_TERMS_INSTRUCTION =
  '\n=== HEBREW OUTPUT — FORBIDDEN MACHINE-TRANSLATED TERMS (MANDATORY) ===\n' +
  'You are strictly forbidden from using literal machine translations of technical terms in the Hebrew output. ' +
  'Never use words like \'דורחת\', \'דורחת פרקטית\', \'מבוכה\' (as a translation for Perplexity), or \'לדרוס\' when presenting educational material or prompts to the user. ' +
  'Never write \'דורח\' or \'דוראך\' — always use \'דוח\' (e.g. דוח התפתחותי, never דורח התפתחותי).\n' +
  'Always use natural, professional Hebrew. If referencing the system, use \'פרפלקסיטי\' or \'המערכת\'.\n' +
  '=== END FORBIDDEN TERMS ===\n';

const PERPLEXITY_HEBREW_STEINER_SPELLING_INSTRUCTION =
  '\n=== HEBREW SPELLING — RUDOLF STEINER (MANDATORY) ===\n' +
  'In all Hebrew output, always write Rudolf Steiner\'s name as שטיינר (with shin ש), NEVER סטיינר (with samekh ס). ' +
  'Examples: רודולף שטיינר, השטיינר, ושטיינר, משטיינר, לשטיינר, בשטיינר — never הסטיינר, וסטיינר, מסטיינר, etc.\n' +
  '=== END STEINER SPELLING ===\n';

const PERPLEXITY_HEBREW_RUBICON_TERMINOLOGY_INSTRUCTION =
  '\n=== HEBREW TERMINOLOGY — RUBICON CROSSINGS (MANDATORY) ===\n' +
  'In ALL Hebrew output — including dynamic section headings, Developmental Compass titles (מצפן התפתחותי), core_emphases, and theory.sections headings — ' +
  'NEVER use the non-standard literal translations "הלידה הראשונה", "לידה ראשונה", "הלידה השנייה", or "לידה שנייה".\n' +
  'Always use the established Waldorf pedagogical terms:\n' +
  '- חציית הרוביקון הראשונה (גיל 9) — for the first Rubicon crossing (around age 9 / Grade 3)\n' +
  '- חציית הרוביקון השנייה (גיל 12) — for the second Rubicon crossing (around age 12 / Grade 6)\n' +
  'Example heading: "מצפן התפתחותי לכיתה ג׳: חציית הרוביקון הראשונה (גיל 9)" — NOT "הלידה הראשונה".\n' +
  'ABSOLUTE BAN: NEVER use רוביקון / Rubicon / חציית הרוביקון for Grade 1 (ages 6–7) or any early-childhood stage before age 9.\n' +
  '=== END RUBICON TERMINOLOGY ===\n';

/**
 * Locked anthroposophical developmental map (Rudolf Steiner) — non-negotiable system guardrail.
 * The model MUST bind every grade-specific claim to exactly these stages; no mixing, no invention.
 */
const PERPLEXITY_STEINER_DEVELOPMENTAL_STAGES_GUARDRAIL =
  '\n=== STEINER DEVELOPMENTAL STAGES MAP (LOCKED — ABSOLUTE — NO COMPROMISE) ===\n' +
  'You MUST adhere EXACTLY to Rudolf Steiner\'s anthroposophical developmental stages below in EVERY piece of content ' +
  '(מצפן התפתחותי, core_emphases, theory, grade insights, expansions, lesson plans). ' +
  'NEVER mix stages across grades. NEVER invent alternate names. NEVER apply a later stage to an earlier grade.\n\n' +
  'AGE 6–7 / GRADE 1 (כיתה א׳):\n' +
  '  • Stage: לידת הגוף האתרי והחלפת השיניים (birth of the etheric body and change of teeth).\n' +
  '  • Consciousness: gradual exit from תודעת החלום / העולם החלומי (dream consciousness / dream world).\n' +
  '  • FORBIDDEN mangled/mistranslated phrases: NEVER write "העולם החזלי", "העולם החזליי", or similar corruptions — ONLY תודעת החלום or העולם החלומי.\n' +
  '  • ABSOLUTE BAN: NEVER use רוביקון, Rubicon, חציית הרוביקון, הרוביקון הראשון, or הרוביקון השני at this stage.\n\n' +
  'AGE 9 / GRADE 3 (כיתה ג׳):\n' +
  '  • Stage: משבר גיל התשע וחציית "הרוביקון הראשון" — חציית הרוביקון הראשונה (גיל 9).\n' +
  '  • Experience: primary separation from the world, expulsion from paradise (גירוש מגן עדן), and loneliness in the soul (תחושת בדידות בנפש).\n' +
  '  • Use ONLY this Rubicon label for age 9 — never call it the second Rubicon, and never use "הלידה הראשונה".\n\n' +
  'AGE 12 / GRADE 6 (כיתה ו׳):\n' +
  '  • Stage: חציית "הרוביקון השני" — חציית הרוביקון השנייה (גיל 12).\n' +
  '  • Characterized by full landing into physicality and the physical world (התגשמות עמוקה בתוך הגוף / נחיתה מלאה אל הגשמיות).\n' +
  '  • Physiology: experience of muscle weight and hardening of the skeletal system (חוויית כובד השרירים והתקשות מערכת השלד) — gravity of the earth (כוח הכובד של האדמה).\n' +
  '  • Thinking: transition to causal-logical, intellectual, scientific thinking (חשיבה סיבתית-לוגית, אינטלקטואלית ומדעית) — cause and effect.\n' +
  '  • Use ONLY this Rubicon label for age 12 — never call it the first Rubicon, and never use "הלידה השנייה".\n\n' +
  'AGE 13–14 / GRADE 8 (כיתה ח׳):\n' +
  '  • Stage: לידת הגוף האסטרלי (birth of the astral body) — junction of sexual and soul adolescence (צומת גיל ההתבגרות המינית והנפשית).\n' +
  '  • Do NOT label this stage as a Rubicon crossing; Rubicon terms apply only at ages 9 and 12 as defined above.\n\n' +
  'CROSS-GRADE RULES:\n' +
  '  • Grade 1–2 content: etheric birth, tooth change, dream consciousness ONLY — zero Rubicon language.\n' +
  '  • Grade 3–4 content may reference the first Rubicon (age 9) when developmentally accurate.\n' +
  '  • Grade 6–7 content may reference the second Rubicon (age 12) when developmentally accurate.\n' +
  '  • Grade 8 content: astral body birth / adolescence — not Rubicon.\n' +
  '  • Never assign second-Rubicon physiology (skeleton/muscle gravity, causal intellect) to Grade 1–5.\n' +
  '  • Never assign first-Rubicon paradise-expulsion themes to Grade 1–2.\n' +
  '=== END STEINER DEVELOPMENTAL STAGES MAP ===\n';

const PERPLEXITY_HEBREW_WALDORF_TERMINOLOGY_INSTRUCTION =
  '\n=== HEBREW TERMINOLOGY — WALDORF EDUCATION (MANDATORY) ===\n' +
  'In ALL Hebrew output, always write Waldorf education as חינוך וולדרוף (noun form וולדרוף only).\n' +
  'NEVER use adjectival forms: וולדורפי, וולדורפית, וולדורפיים, וולדורפיות, וולדרופי, וולדרופית, הוולדורפי, הוולדורפית.\n' +
  'NEVER write "החינוך הוולדורפי", "פדגוגיה וולדורפית", or "פדגוגיה וולדרופית".\n' +
  'Correct: חינוך וולדרוף, פדגוגיית וולדרוף, בפדגוגיה וולדרוף, בתי ספר וולדרוף.\n' +
  'Keep established English terms inside parentheses in English — do NOT translate them ' +
  '(e.g. keep "(Waldorf)", "(Rubicon)", "(main lesson)", "(PDF)" as-is).\n' +
  '=== END WALDORF TERMINOLOGY ===\n';

const PERPLEXITY_SCHOLAR_CORE_IDENTITY_INSTRUCTION =
  '\n=== CORE SCHOLARLY IDENTITY (MANDATORY) ===\n' +
  'You are a world-class scholar and expert in Rudolf Steiner\'s philosophy, Anthroposophy, Waldorf pedagogy, and child development. ' +
  'Your tone must be deeply professional, authoritative, and perfectly aligned with established pedagogical terminology in both Hebrew and English.\n' +
  '=== END CORE IDENTITY ===\n';

const PERPLEXITY_ZERO_HALLUCINATION_POLICY_INSTRUCTION =
  '\n=== ZERO HALLUCINATION POLICY (MANDATORY) ===\n' +
  'Strictly adhere only to verified historical, pedagogical, and philosophical facts. ' +
  'You are absolutely forbidden from making up concepts, distorting Steiner\'s lectures, or inventing non-existent connections. ' +
  'If information or a specific connection is missing from your knowledge base or search results, state it clearly rather than hallucinating or fabricating a response.\n' +
  '=== END ZERO HALLUCINATION ===\n';

const PERPLEXITY_HEBREW_GUARDRAILS =
  PERPLEXITY_HEBREW_FORBIDDEN_TERMS_INSTRUCTION +
  PERPLEXITY_HEBREW_STEINER_SPELLING_INSTRUCTION +
  PERPLEXITY_HEBREW_RUBICON_TERMINOLOGY_INSTRUCTION +
  PERPLEXITY_STEINER_DEVELOPMENTAL_STAGES_GUARDRAIL +
  PERPLEXITY_HEBREW_WALDORF_TERMINOLOGY_INSTRUCTION +
  PERPLEXITY_SCHOLAR_CORE_IDENTITY_INSTRUCTION +
  PERPLEXITY_ZERO_HALLUCINATION_POLICY_INSTRUCTION;

/**
 * Adjectival Waldorf stems (וולדורפ* and misspelled וולדרופ*) with optional ה- prefix
 * and common suffixes י / ית / יים / יות.
 */
const WALDORF_ADJ_SUFFIX = '(?:ית|יים|יות|י)?';
const WALDORF_ADJ_DOR = 'וולדורפ' + WALDORF_ADJ_SUFFIX; // וולדורפי, וולדורפית, …
const WALDORF_ADJ_DRO = 'וולדרופ' + WALDORF_ADJ_SUFFIX; // וולדרופי, וולדרופית, …

/** Post-processing fixes for common Hebrew terminology errors in AI output (headings + prose + HTML). */
const HEBREW_AUTO_REPLACEMENTS = [
  { pattern: /הלידה\s+השנייה/g, replacement: 'חציית הרוביקון השנייה (גיל 12)' },
  { pattern: /הלידה\s+השניה/g, replacement: 'חציית הרוביקון השנייה (גיל 12)' },
  { pattern: /הלידה\s+הראשונה/g, replacement: 'חציית הרוביקון הראשונה (גיל 9)' },
  { pattern: /לידה\s+שנייה/g, replacement: 'חציית הרוביקון השנייה (גיל 12)' },
  { pattern: /לידה\s+שניה/g, replacement: 'חציית הרוביקון השנייה (גיל 12)' },
  { pattern: /לידה\s+ראשונה/g, replacement: 'חציית הרוביקון הראשונה (גיל 9)' },
  // Mangled "dream world / dream consciousness" (Grade 1) — never leave corruptions in archive text
  { pattern: /העולם\s+החזליי?/g, replacement: 'העולם החלומי' },
  { pattern: /תודעת\s+החזליי?/g, replacement: 'תודעת החלום' },
  { pattern: /החזליי?/g, replacement: 'החלומי' },
  // AI misspelling of דוח (developmental report) — with/without niqqud; avoid matching דורחת
  { pattern: /ד[\u0591-\u05C7]*ו[\u0591-\u05C7]*ר[\u0591-\u05C7]*ח[\u0591-\u05C7]*(?!ת)/g, replacement: 'דוח' },
  { pattern: /דוראך/g, replacement: 'דוח' },
  // Waldorf education — longest phrases first, then bare adjectival forms (incl. feminine/plural)
  { pattern: new RegExp('בפדגוגיה\\s+ה?' + WALDORF_ADJ_DOR, 'g'), replacement: 'בפדגוגיה וולדרוף' },
  { pattern: new RegExp('בפדגוגיה\\s+ה?' + WALDORF_ADJ_DRO, 'g'), replacement: 'בפדגוגיה וולדרוף' },
  { pattern: new RegExp('הפדגוגיה\\s+ה?' + WALDORF_ADJ_DOR, 'g'), replacement: 'חינוך וולדרוף' },
  { pattern: new RegExp('הפדגוגיה\\s+ה?' + WALDORF_ADJ_DRO, 'g'), replacement: 'חינוך וולדרוף' },
  { pattern: new RegExp('פדגוגיה\\s+ה?' + WALDORF_ADJ_DOR, 'g'), replacement: 'חינוך וולדרוף' },
  { pattern: new RegExp('פדגוגיה\\s+ה?' + WALDORF_ADJ_DRO, 'g'), replacement: 'חינוך וולדרוף' },
  { pattern: new RegExp('החינוך\\s+ה?' + WALDORF_ADJ_DOR, 'g'), replacement: 'חינוך וולדרוף' },
  { pattern: new RegExp('החינוך\\s+ה?' + WALDORF_ADJ_DRO, 'g'), replacement: 'חינוך וולדרוף' },
  { pattern: new RegExp('חינוך\\s+ה?' + WALDORF_ADJ_DOR, 'g'), replacement: 'חינוך וולדרוף' },
  { pattern: new RegExp('חינוך\\s+ה?' + WALDORF_ADJ_DRO, 'g'), replacement: 'חינוך וולדרוף' },
  { pattern: new RegExp('ה' + WALDORF_ADJ_DOR, 'g'), replacement: 'וולדרוף' },
  { pattern: new RegExp('ה' + WALDORF_ADJ_DRO, 'g'), replacement: 'וולדרוף' },
  { pattern: new RegExp(WALDORF_ADJ_DOR, 'g'), replacement: 'וולדרוף' },
  { pattern: new RegExp(WALDORF_ADJ_DRO, 'g'), replacement: 'וולדרוף' },
  { pattern: /סטיינר/g, replacement: 'שטיינר' },
];

function applyHebrewAutoReplacements(text) {
  if (text == null || typeof text !== 'string') return text;
  var out = text;
  // Protect English parentheticals from accidental mangling during replacements.
  var protectedChunks = [];
  out = out.replace(/\([A-Za-z][^)]{0,80}\)/g, function (match) {
    var idx = protectedChunks.length;
    protectedChunks.push(match);
    return '\u0000EP' + idx + '\u0000';
  });
  HEBREW_AUTO_REPLACEMENTS.forEach(function (rule) {
    out = out.replace(rule.pattern, rule.replacement);
  });
  protectedChunks.forEach(function (chunk, idx) {
    out = out.split('\u0000EP' + idx + '\u0000').join(chunk);
  });
  return out;
}

function applyHebrewAutoReplacementsDeep(value, depth) {
  if (depth == null) depth = 0;
  if (depth > 40) return value;
  if (value == null) return value;
  if (typeof value === 'string') return applyHebrewAutoReplacements(value);
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      value[i] = applyHebrewAutoReplacementsDeep(value[i], depth + 1);
    }
    return value;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(function (key) {
      value[key] = applyHebrewAutoReplacementsDeep(value[key], depth + 1);
    });
    return value;
  }
  return value;
}

module.exports = {
  PERPLEXITY_HEBREW_FORBIDDEN_TERMS_INSTRUCTION,
  PERPLEXITY_HEBREW_STEINER_SPELLING_INSTRUCTION,
  PERPLEXITY_HEBREW_RUBICON_TERMINOLOGY_INSTRUCTION,
  PERPLEXITY_STEINER_DEVELOPMENTAL_STAGES_GUARDRAIL,
  PERPLEXITY_HEBREW_WALDORF_TERMINOLOGY_INSTRUCTION,
  PERPLEXITY_SCHOLAR_CORE_IDENTITY_INSTRUCTION,
  PERPLEXITY_ZERO_HALLUCINATION_POLICY_INSTRUCTION,
  PERPLEXITY_HEBREW_GUARDRAILS,
  HEBREW_AUTO_REPLACEMENTS,
  applyHebrewAutoReplacements,
  applyHebrewAutoReplacementsDeep,
};
