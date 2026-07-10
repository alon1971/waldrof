/**
 * Archive search disambiguation guardrails — strict Waldorf curriculum routing.
 * Shared thresholds + LLM instructions; domain rules live in hebrew-topic-match.js.
 */
const hebrewTopicMatch = require('../hebrew-topic-match');

/** Minimum similarity to show "האם התכוונת ל…" partial archive suggestions. */
const ARCHIVE_PARTIAL_SUGGEST_MIN_SCORE = 0.72;

/** High-confidence partial suggestions only (substring / near-exact). */
const ARCHIVE_PARTIAL_HIGH_CONFIDENCE = 0.88;

const ARCHIVE_DISAMBIGUATION_LLM_INSTRUCTION =
  'Only offer a pedagogical alias or alternative topic when there is a direct historical, literal, ' +
  'or universally accepted Waldorf pedagogical equivalence ' +
  '(e.g. סיפורי הצפון → מיתולוגיה נורדית, or יוון → המיתולוגיה היוונית). ' +
  'Never mix core operational skills (רישום צורה / Form Drawing, חשבון / Arithmetic, ציור גיר, מחברות תקופה) ' +
  'with narrative epochs (בראשית, תורה, מיתולוגיה, תקופות היסטוריות). ' +
  'Never suggest a same-grade archive topic when the query names an epoch that belongs to a different grade ' +
  '(e.g. רנסנס in Grade 3 — block and return a grade-mismatch error instead of fuzzy-matching תקופת בנייה). ' +
  'If confidence is below ' + ARCHIVE_PARTIAL_HIGH_CONFIDENCE + ', return no suggestion.';

function checkPedagogicalGradeGuardrail(gradeId, topic, gradeLabel) {
  return hebrewTopicMatch.checkPedagogicalGradeMismatch(gradeId, topic, gradeLabel);
}

function buildGradeMismatchError(mismatch) {
  return hebrewTopicMatch.buildGradeMismatchMessage(mismatch);
}

function isMisleadingArchiveSuggestion(query, suggestedTopic, score) {
  if (hebrewTopicMatch.isInvalidCrossDomainTopicSuggestion(query, suggestedTopic)) return true;
  if (score != null && score >= ARCHIVE_PARTIAL_HIGH_CONFIDENCE) return false;
  // Pedagogical aliases (יוון העתיקה ↔ יוון) are valid longer-query → shorter-title matches.
  if (typeof hebrewTopicMatch.sharesAllowedPedagogicalAlias === 'function'
    && hebrewTopicMatch.sharesAllowedPedagogicalAlias(query, suggestedTopic)) {
    return false;
  }
  const q = hebrewTopicMatch.stableNormalize(query);
  const s = hebrewTopicMatch.stableNormalize(suggestedTopic);
  if (!q || !s || q === s) return false;
  if (s.length >= 3 && q.indexOf(s) >= 0 && q.length >= s.length * 1.35) return true;
  return false;
}

function shouldOfferPartialArchiveSuggestion(query, suggestedTopic, score, gradeId, gradeLabel) {
  const sim = Number(score) || 0;
  if (sim < ARCHIVE_PARTIAL_SUGGEST_MIN_SCORE) return false;
  if (gradeId && checkPedagogicalGradeGuardrail(gradeId, query, gradeLabel)) return false;
  if (isMisleadingArchiveSuggestion(query, suggestedTopic, sim)) return false;
  if (hebrewTopicMatch.shouldBypassSemanticArchiveSuggestion(query)) return false;
  return true;
}

module.exports = {
  ARCHIVE_PARTIAL_SUGGEST_MIN_SCORE,
  ARCHIVE_PARTIAL_HIGH_CONFIDENCE,
  ARCHIVE_DISAMBIGUATION_LLM_INSTRUCTION,
  checkPedagogicalGradeGuardrail,
  buildGradeMismatchError,
  isMisleadingArchiveSuggestion,
  shouldOfferPartialArchiveSuggestion,
  isDefinitiveOperationalSkillTitle: hebrewTopicMatch.isDefinitiveOperationalSkillTitle,
  shouldBypassSemanticArchiveSuggestion: hebrewTopicMatch.shouldBypassSemanticArchiveSuggestion,
  isInvalidCrossDomainTopicSuggestion: hebrewTopicMatch.isInvalidCrossDomainTopicSuggestion,
};
