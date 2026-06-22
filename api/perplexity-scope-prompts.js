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

function coreOverrideInstruction(topic, gradeLabel) {
  if (hebrewTopicMatch && typeof hebrewTopicMatch.buildCurriculumOverrideAntiHallucinationInstruction === 'function') {
    return hebrewTopicMatch.buildCurriculumOverrideAntiHallucinationInstruction(topic, gradeLabel);
  }
  return (
    'The user has explicitly requested ' + topic + ' for ' + gradeLabel +
    ', which is outside the standard curriculum. Do not hallucinate or generate irrelevant/fake placeholders. ' +
    'Provide factual, pedagogically sound content adapted as realistically as possible for this age group, ' +
    'or professionally guide the user on how this topic can be introduced accurately to this developmental stage without making things up.'
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
  return Boolean(body && (body.pedagogicalScopeOverride === true || body.pedagogicalScopeOverride === 'true'));
}

module.exports = {
  buildOverrideSearchUserBlock,
  buildOverrideSynthesisSystemBlock,
  buildOverrideSynthesisUserBlock,
  isScopeOverrideActive,
  coreOverrideInstruction,
};
