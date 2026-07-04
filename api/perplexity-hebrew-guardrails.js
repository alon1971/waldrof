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
  '- חציית הרוביקון הראשונה (גיל 9) — for the first Rubicon crossing (around age 9)\n' +
  '- חציית הרוביקון השנייה (גיל 12) — for the second Rubicon crossing (around age 12)\n' +
  'Example heading: "מצפן התפתחותי לכיתה ד׳: חציית הרוביקון הראשונה (גיל 9)" — NOT "הלידה הראשונה".\n' +
  '=== END RUBICON TERMINOLOGY ===\n';

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
  PERPLEXITY_SCHOLAR_CORE_IDENTITY_INSTRUCTION +
  PERPLEXITY_ZERO_HALLUCINATION_POLICY_INSTRUCTION;

/** Post-processing fixes for common Hebrew terminology errors in AI output (headings + prose). */
const HEBREW_AUTO_REPLACEMENTS = [
  { pattern: /הלידה\s+השנייה/g, replacement: 'חציית הרוביקון השנייה (גיל 12)' },
  { pattern: /הלידה\s+השניה/g, replacement: 'חציית הרוביקון השנייה (גיל 12)' },
  { pattern: /הלידה\s+הראשונה/g, replacement: 'חציית הרוביקון הראשונה (גיל 9)' },
  { pattern: /לידה\s+שנייה/g, replacement: 'חציית הרוביקון השנייה (גיל 12)' },
  { pattern: /לידה\s+שניה/g, replacement: 'חציית הרוביקון השנייה (גיל 12)' },
  { pattern: /לידה\s+ראשונה/g, replacement: 'חציית הרוביקון הראשונה (גיל 9)' },
  // AI misspelling of דוח (developmental report) — with/without niqqud; avoid matching דורחת
  { pattern: /ד[\u0591-\u05C7]*ו[\u0591-\u05C7]*ר[\u0591-\u05C7]*ח[\u0591-\u05C7]*(?!ת)/g, replacement: 'דוח' },
  { pattern: /דוראך/g, replacement: 'דוח' },
  { pattern: /סטיינר/g, replacement: 'שטיינר' },
];

function applyHebrewAutoReplacements(text) {
  if (text == null || typeof text !== 'string') return text;
  var out = text;
  HEBREW_AUTO_REPLACEMENTS.forEach(function (rule) {
    out = out.replace(rule.pattern, rule.replacement);
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
  PERPLEXITY_SCHOLAR_CORE_IDENTITY_INSTRUCTION,
  PERPLEXITY_ZERO_HALLUCINATION_POLICY_INSTRUCTION,
  PERPLEXITY_HEBREW_GUARDRAILS,
  HEBREW_AUTO_REPLACEMENTS,
  applyHebrewAutoReplacements,
  applyHebrewAutoReplacementsDeep,
};
