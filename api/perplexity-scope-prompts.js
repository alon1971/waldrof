/**
 * Perplexity prompt mapping for teacher curriculum-scope overrides.
 * Injected when pedagogicalScopeOverride is set on the request body.
 */
const hebrewTopicMatch = require('../hebrew-topic-match');

function resolveTopic(body) {
  return String((body && body.topic) || (body && body.activityTitle) || '').trim();
}

function resolveGradeLabel(body) {
  if (body && body.gradeLabel) return String(body.gradeLabel).trim();
  const gid = String((body && body.currentGrade) || (body && body.gradeId) || '').trim();
  if (gid && hebrewTopicMatch.gradeLabelForId) {
    return hebrewTopicMatch.gradeLabelForId(gid);
  }
  return gid ? ('כיתה ' + gid) : 'כיתה זו';
}

function isTruthyOverrideFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function coreOverrideInstruction(topic, gradeLabel) {
  if (hebrewTopicMatch && typeof hebrewTopicMatch.buildCurriculumOverrideAntiHallucinationInstruction === 'function') {
    return hebrewTopicMatch.buildCurriculumOverrideAntiHallucinationInstruction(topic, gradeLabel);
  }
  return (
    'The user has bypassed standard alignment and explicitly requested «' + topic + '» for «' + gradeLabel + '». ' +
    'Generate the contents based strictly on this combination. ' +
    'Do not hallucinate or generate irrelevant/fake placeholders — provide factual, pedagogically sound content ' +
    'adapted as realistically as possible for this age group.'
  );
}

/** Sonar web-search user prompt suffix when teacher bypasses scope warning. */
function buildOverrideSearchUserBlock(body) {
  const topic = resolveTopic(body);
  const gradeLabel = resolveGradeLabel(body);
  if (!topic) return '';
  return (
    '\n\n=== TEACHER CURRICULUM OVERRIDE (MANDATORY) ===\n' +
    coreOverrideInstruction(topic, gradeLabel) + '\n' +
    '=== END TEACHER CURRICULUM OVERRIDE ===\n'
  );
}

/** Structured synthesis system prompt block when teacher bypasses scope warning. */
function buildOverrideSynthesisSystemBlock(body) {
  const topic = resolveTopic(body);
  const gradeLabel = resolveGradeLabel(body);
  if (!topic) return '';
  return (
    ' TEACHER CURRICULUM OVERRIDE: ' + coreOverrideInstruction(topic, gradeLabel)
  );
}

/** Structured synthesis user prompt block when teacher bypasses scope warning. */
function buildOverrideSynthesisUserBlock(body) {
  const topic = resolveTopic(body);
  const gradeLabel = resolveGradeLabel(body);
  if (!topic) return '';
  return (
    '\n=== TEACHER CURRICULUM OVERRIDE (MANDATORY) ===\n' +
    coreOverrideInstruction(topic, gradeLabel) + '\n' +
    'Adapt all output to «' + topic + '» at «' + gradeLabel + '» without inventing curriculum placeholders.\n' +
    '=== END TEACHER CURRICULUM OVERRIDE ===\n'
  );
}

function isScopeOverrideActive(body) {
  if (!body) return false;
  return (
    isTruthyOverrideFlag(body.pedagogicalScopeOverride) ||
    isTruthyOverrideFlag(body.override) ||
    isTruthyOverrideFlag(body.bypassValidation)
  );
}

/** Normalize alternate override flags onto pedagogicalScopeOverride for downstream checks. */
function normalizeScopeOverrideFlags(body) {
  if (!body || !isScopeOverrideActive(body)) return;
  body.pedagogicalScopeOverride = true;
}

module.exports = {
  buildOverrideSearchUserBlock,
  buildOverrideSynthesisSystemBlock,
  buildOverrideSynthesisUserBlock,
  isScopeOverrideActive,
  normalizeScopeOverrideFlags,
  isTruthyOverrideFlag,
  coreOverrideInstruction,
};
