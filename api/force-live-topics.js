'use strict';

/**
 * Topics that must always bypass archive cache and run live 3-chunk Perplexity generation.
 * Used after clean-slate wipes until upgraded tables are verified in production.
 */
const FORCE_LIVE_TARGETS = [
  {
    id: 'grade3-language',
    gradeId: '3',
    gradeLabel: 'כיתה ג׳',
    topicContains: 'לשון',
    topicCandidates: ['לשון ושפה', 'לשון', 'שפה ולשון', 'לשון ושפה כיתה ג׳'],
    supabaseTopicPattern: 'לשון',
  },
  {
    id: 'grade7-nutrition',
    gradeId: '7',
    gradeLabel: 'כיתה ז׳',
    topicContains: 'תזונה',
    topicCandidates: ['תזונה', 'תזונה ומערכי שיעור', 'תזונה ומערכי שיעור בכיתה ז׳', 'תזונה כיתה ז׳'],
    supabaseTopicPattern: 'תזונה',
  },
];

function normalizeGradeId(body) {
  return String(
    (body && (body.currentGrade ?? body.gradeId)) || ''
  ).trim();
}

function normalizeTopic(body) {
  return String((body && body.topic) || '').trim();
}

function topicMatchesTarget(topic, target) {
  const raw = String(topic || '').trim();
  if (!raw) return false;
  if (target.topicCandidates && target.topicCandidates.indexOf(raw) >= 0) return true;
  return raw.indexOf(target.topicContains) >= 0;
}

function findForceLiveTarget(body) {
  const gradeId = normalizeGradeId(body);
  const topic = normalizeTopic(body);
  if (!gradeId || !topic) return null;
  for (let i = 0; i < FORCE_LIVE_TARGETS.length; i++) {
    const target = FORCE_LIVE_TARGETS[i];
    if (target.gradeId === gradeId && topicMatchesTarget(topic, target)) {
      return target;
    }
  }
  return null;
}

function isForceLiveArchiveTopic(body) {
  return Boolean(findForceLiveTarget(body));
}

function applyForceLiveArchiveBypass(body) {
  const target = findForceLiveTarget(body);
  if (!target) return false;
  body.skipCache = true;
  body.forceFresh = true;
  body._forceLiveArchiveTopic = target.id;
  console.log(
    '[generate] FORCE_LIVE archive bypass:',
    body.topic,
    '@ grade',
    target.gradeId,
    'phase=',
    body.phase || ''
  );
  return true;
}

module.exports = {
  FORCE_LIVE_TARGETS,
  findForceLiveTarget,
  isForceLiveArchiveTopic,
  applyForceLiveArchiveBypass,
  topicMatchesTarget,
};
