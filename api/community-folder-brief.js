/**
 * Community folder brief — deterministic archive notification + action buttons.
 * Built by the community search pipeline (findCommunityMaterials), not chat short-circuit.
 */
const catalogTopics = require('./catalog-topics');
const cacheDb = require('./cache');
const pedagogicalScope = require('./pedagogical-scope');

const FOLDER_DOWNLOAD_LABEL = 'הורדת התיקייה';

function stableNormalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function gradeLabelForId(gradeId) {
  return cacheDb.resolveGradeLabelFromId(gradeId, null) || ('כיתה ' + gradeId);
}

function accessGradeButtonLabel(gradeId) {
  const label = gradeLabelForId(gradeId);
  return 'לגשת ל' + label;
}

function displayTopicForQuery(query, block, catalogTopic) {
  const q = String(query || '').trim();
  if (q && q.length <= 24) return q;
  if (catalogTopic) return String(catalogTopic).trim();
  return block && block.blockLabel ? block.blockLabel : q;
}

function buildBriefMessage(topicDisplay, gradeLabel) {
  return (
    'נמצאה במאגר הקהילתי תיקיית חומרים על ' + topicDisplay +
    ' השייכת ל' + gradeLabel +
    '! במקום להציג את כל התוכן כאן, תוכל לבחור כיצד להמשיך:'
  );
}

function topicFolderMatchesQuery(query, match) {
  if (!match || !query) return false;
  const catalogTopic = cacheDb.resolveCommunityCatalogTopic(match);
  const aliases = catalogTopics.expandCatalogTopicAliases([
    query,
    catalogTopic,
    match.bundleTopic,
    match.topic,
    match.title,
    match.pathLabels,
    match.fileName,
  ]);
  const qNorm = stableNormalize(query);
  if (!qNorm) return false;
  return aliases.some(function (alias) {
    const n = stableNormalize(alias);
    if (!n) return false;
    return n === qNorm
      || (n.length >= 2 && qNorm.indexOf(n) >= 0)
      || (qNorm.length >= 2 && n.indexOf(qNorm) >= 0);
  });
}

function resolveMatchGradeId(match) {
  return String(match.gradeId || match.grade_id || match.grade_level || '').trim();
}

function filterMatchesForInferredGrade(probe, query, gradeId) {
  const matches = (probe && Array.isArray(probe.matches)) ? probe.matches : [];
  return matches.filter(function (match) {
    const matchGrade = resolveMatchGradeId(match);
    if (matchGrade && matchGrade !== String(gradeId)) return false;
    return topicFolderMatchesQuery(query, match);
  });
}

function resolveParentCatalogTopicFromMatch(match, query) {
  return cacheDb.resolveParentCommunityFolderTopic(match, query);
}

/**
 * Build folder-brief for repository search when a nested file matched but the query
 * did not exactly name the parent topic folder (e.g. יוון → מסעות אודיסאוס).
 */
function tryBuildRepositorySearchFolderBrief(body, probe) {
  if (body && body.phase === 'chat_followup') return null;
  if (!probe || !probe.count || !Array.isArray(probe.matches) || !probe.matches.length) {
    return null;
  }

  const query = String((body && body.userMessage) || probe.query || '').trim();
  const primary = probe.matches[0];
  const gradeId = resolveMatchGradeId(primary);
  const parentTopic = resolveParentCatalogTopicFromMatch(primary, query);
  if (!gradeId || !parentTopic) return null;

  const gradeLabel = gradeLabelForId(gradeId);
  const fileTitle = String(primary.displayTitle || primary.title || primary.fileName || '').trim();
  const parentNorm = stableNormalize(parentTopic);
  const fileNorm = stableNormalize(fileTitle);
  const message = fileTitle && fileNorm && parentNorm && fileNorm !== parentNorm
    ? (
      'נמצא במאגר הקהילתי קובץ «' + fileTitle + '» בתוך תיקיית «' + parentTopic +
      '» (' + gradeLabel + '). תוכלו לגשת לתיקייה המלאה או להוריד את כל החומרים:'
    )
    : buildBriefMessage(parentTopic, gradeLabel);

  const matched = probe.matches.filter(function (match) {
    return resolveMatchGradeId(match) === gradeId
      && stableNormalize(resolveParentCatalogTopicFromMatch(match, query)) === parentNorm;
  });

  return {
    data: {
      chatReply: {
        answer: message,
        communityFolderBrief: true,
        gradeId: gradeId,
        gradeLabel: gradeLabel,
        catalogTopic: parentTopic,
        topicDisplay: parentTopic,
        accessGradeLabel: accessGradeButtonLabel(gradeId) + ' — ' + parentTopic,
        downloadFolderLabel: FOLDER_DOWNLOAD_LABEL,
        communityMatches: (matched.length ? matched : [primary]).slice(0, 8).map(function (m) {
          return cacheDb.withCatalogNavigationFields(m);
        }),
      },
    },
    meta: {
      communityFolderBrief: true,
      skipCommunityAlert: true,
      gradeId: gradeId,
      catalogTopic: parentTopic,
      repositorySearch: true,
    },
  };
}

/**
 * Build a folder-brief payload when a community topic folder matches
 * the query and Waldorf grade inference (Community Archive search pipeline).
 */
function tryBuildCommunityFolderBrief(body, probe) {
  if (body && body.phase === 'chat_followup') return null;

  if (!probe || !probe.count || !Array.isArray(probe.matches) || !probe.matches.length) {
    return null;
  }

  const query = String((body && body.userMessage) || probe.query || '').trim();
  if (!query || query.length < 2) return null;

  if (body && body.repositorySearch) {
    const repoBrief = tryBuildRepositorySearchFolderBrief(body, probe);
    if (repoBrief) return repoBrief;
  }

  const block = pedagogicalScope.inferTopicCurriculumBlock(query);
  if (!block || !block.gradeId) {
    return null;
  }

  const gradeId = String(block.gradeId).trim();
  const matched = filterMatchesForInferredGrade(probe, query, gradeId);
  if (!matched.length) {
    return null;
  }

  const primary = matched[0];
  const catalogTopic = cacheDb.resolveCommunityCatalogTopic(primary) || block.blockLabel || query;
  const gradeLabel = gradeLabelForId(gradeId);
  const topicDisplay = displayTopicForQuery(query, block, catalogTopic);
  const message = buildBriefMessage(topicDisplay, gradeLabel);

  return {
    data: {
      chatReply: {
        answer: message,
        communityFolderBrief: true,
        gradeId: gradeId,
        gradeLabel: gradeLabel,
        catalogTopic: catalogTopic,
        topicDisplay: topicDisplay,
        accessGradeLabel: accessGradeButtonLabel(gradeId),
        downloadFolderLabel: FOLDER_DOWNLOAD_LABEL,
        communityMatches: matched.slice(0, 8).map(function (m) {
          return cacheDb.withCatalogNavigationFields(m);
        }),
      },
    },
    meta: {
      communityFolderBrief: true,
      skipCommunityAlert: true,
      gradeId: gradeId,
      catalogTopic: catalogTopic,
    },
  };
}

module.exports = {
  FOLDER_DOWNLOAD_LABEL,
  accessGradeButtonLabel,
  buildBriefMessage,
  resolveParentCatalogTopicFromMatch,
  tryBuildCommunityFolderBrief,
  tryBuildRepositorySearchFolderBrief,
};
