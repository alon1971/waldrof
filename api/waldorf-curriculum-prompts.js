'use strict';
/**
 * Global Waldorf curriculum prompt blocks — grades 1–8, all subjects.
 * Single source of truth for live Perplexity 3-chunk generation and phase_c synthesis.
 */

const EXPANSION_OBJECT_SCHEMA =
  '{ "classroomImplementation": "1-2 Hebrew paragraphs: practical in-class implementation", ' +
  '"parentCommunityAspects": "Hebrew paragraph on parents/community when relevant", ' +
  '"practicalSteps": ["4-8 concrete classroom steps for the teacher"], ' +
  '"inspirationReferences": ["3-6 named books/articles/Waldorf projects — NO URLs"], ' +
  '"expansionHtml": "<p>Optional rich Hebrew HTML</p>" }';

const CURRICULUM_INLINE_EXPANSION_INSTRUCTION =
  '\n=== CURRICULUM DAY INLINE EXPANSION — «הרחבה ואספקטים פרקטיים» (MANDATORY — ALL GRADES 1–8) ===\n' +
  'Each of the 15 curriculum days MUST include a complete contentExpansion object (and optionally artExpansion, hintExpansion).\n' +
  'Shape: ' + EXPANSION_OBJECT_SCHEMA + '\n' +
  'The UI button toggles this pre-generated pedagogical text — NO second API call.\n' +
  'FORBIDDEN inside content/art/hint/expansion fields: URLs, Pinterest phrases, gallery pins, enrichment_links, raw search queries, or code blocks.\n' +
  'content and art MUST remain clean Waldorf narrative text; expansions hold theoretical + practical teaching depth only.\n' +
  '=== END CURRICULUM INLINE EXPANSION ===\n';

const WALDORF_CURRICULUM_DEPTH_INSTRUCTION =
  '\n=== WALDORF CURRICULUM — MANDATORY DEPTH (ALL GRADES 1–8, ALL SUBJECTS) ===\n' +
  'This applies equally to Grade 1 arithmetic, Grade 8 history, and every block in between — never shorten for older grades.\n' +
  'Never output thin one-line rows, placeholder text, lazy expansion buttons, or single-sentence summaries.\n' +
  'Each day MUST describe a complete Waldorf main-lesson arc: opening/recall, story or phenomenological introduction, ' +
  'guided practice, artistic activity with named materials, and closure/reflection.\n' +
  'content: 4–6 rich Hebrew sentences on narrative flow and classroom staging (multi-sentence paragraphs, not bullets).\n' +
  'art: 2–4 Hebrew sentences on drawing/painting/clay/cooking/handwork tied to the day.\n' +
  'hint: optional Hebrew teacher note when useful.\n' +
  'contentExpansion.classroomImplementation: 1–2 Hebrew paragraphs with concrete staging.\n' +
  'contentExpansion.practicalSteps: 4–8 numbered teacher actions for the classroom.\n' +
  'contentExpansion.parentCommunityAspects: Hebrew paragraph when parents/community are relevant.\n' +
  'contentExpansion.inspirationReferences: 3–6 named Waldorf books/projects — NO URLs.\n' +
  '=== END WALDORF CURRICULUM DEPTH ===\n';

const CURRICULUM_DAY_OBJECT_KEYS =
  '"day" (number), "topic" (Hebrew), "content" (4–6 rich Hebrew sentences), "art" (2–4 Hebrew sentences), ' +
  '"hint" (optional Hebrew), "contentExpansion" (mandatory object)';

function buildGlobalCurriculumUserPromptBlocks() {
  return (
    CURRICULUM_INLINE_EXPANSION_INSTRUCTION +
    WALDORF_CURRICULUM_DEPTH_INSTRUCTION +
    'CRITICAL — blockPlan.curriculum MUST be a JSON ARRAY of exactly 15 day objects (days 1–15).\n' +
    'Each day object MUST use: ' + CURRICULUM_DAY_OBJECT_KEYS + '.\n' +
    'content and art MUST be complete narrative text in this payload — never empty placeholders.\n' +
    'Do NOT nest curriculum under days/items/lessons — use blockPlan.curriculum as a flat array.\n'
  );
}

function buildCurriculumChunkSystemPrompt() {
  return (
    'You are an expert Waldorf / Steiner-Waldorf curriculum designer for grades 1 through 8. ' +
    'Write rich pedagogical content in Hebrew for the requested grade only. ' +
    'Every curriculum day must include multi-sentence content and art fields plus a complete contentExpansion object. ' +
    'Never output thin one-line summaries or placeholder text. ' +
    'Ground claims in the provided web research. Return raw JSON only — no markdown fences.'
  );
}

module.exports = {
  EXPANSION_OBJECT_SCHEMA,
  CURRICULUM_INLINE_EXPANSION_INSTRUCTION,
  WALDORF_CURRICULUM_DEPTH_INSTRUCTION,
  CURRICULUM_DAY_OBJECT_KEYS,
  buildGlobalCurriculumUserPromptBlocks,
  buildCurriculumChunkSystemPrompt,
};
