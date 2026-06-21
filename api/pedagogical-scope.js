/**
 * Waldorf curriculum topic ↔ grade alignment validation.
 * Blocks cross-grade pedagogical hallucinations (e.g. Odysseus in Grade 2).
 */
const catalogTopics = require('./catalog-topics');
const hebrewTopicMatch = require('../hebrew-topic-match');

const GRADE_LABEL_BY_ID = {
  '1': 'כיתה א׳',
  '2': 'כיתה ב׳',
  '3': 'כיתה ג׳',
  '4': 'כיתה ד׳',
  '5': 'כיתה ה׳',
  '6': 'כיתה ו׳',
  '7': 'כיתה ז׳',
  '8': 'כיתה ח׳',
};

/** Grade-appropriate topic suggestions when redirecting after a mismatch. */
const GRADE_TOPIC_SUGGESTIONS = {
  '1': ['אגדות', 'סיפורי טבע'],
  '2': ['סיפורי צדיקים', 'משלי חיות'],
  '3': ['סיפורי תנ״ך', 'חקלאות'],
  '4': ['מיתולוגיה נורדית', 'גיאוגרפיה מקומית'],
  '5': ['יוון העתיקה', 'בוטניקה'],
  '6': ['רומא', 'גיאולוגיה'],
  '7': ['תקופת מגלי עולם', 'רנסנס'],
  '8': ['מהפכה צרפתית', 'כימיה אורגנית'],
};

/**
 * Canonical Waldorf main-lesson blocks — primary grade ownership.
 * aliases: Hebrew / English forms teachers may type or ask about.
 */
const CURRICULUM_BLOCKS = [
  {
    gradeId: '1',
    blockLabel: 'אגדות וסיפורי טבע',
    aliases: [
      'אגדות', 'אגדה', 'אגדת', 'סיפורי פיות', 'סיפור פיות', 'פיות',
      'סיפורי טבע', 'fairy tale', 'fairy tales', 'nature stories',
    ],
  },
  {
    gradeId: '2',
    blockLabel: 'משלי חיות וסיפורי צדיקים',
    aliases: [
      'משלי חיות', 'משל חיות', 'משלי', 'fables', 'animal fables',
      'סיפורי צדיקים', 'סיפור צדיקים', 'צדיקים', 'קדושים', 'saints', 'saint stories',
    ],
  },
  {
    gradeId: '3',
    blockLabel: 'תנ״ך וסיפורי מקרא',
    aliases: [
      'תנ״ך', 'תנך', 'מקרא', 'בראשית', 'נח', 'אברהם', 'משה', 'דוד וגוליית',
      'חקלאות', 'בית בנין', 'בניית בית', 'old testament', 'bible stories',
    ],
  },
  {
    gradeId: '4',
    blockLabel: 'מיתולוגיה נורדית',
    aliases: [
      'נורדית', 'נורד', 'נורדים', 'אסגארד', 'אודין', 'תור', 'thor', 'odin', 'norse', 'norse mythology',
      'גיאוגרפיה מקומית', 'local geography',
    ],
  },
  {
    gradeId: '5',
    blockLabel: 'יוון העתיקה',
    aliases: [].concat(
      catalogTopics.CATALOG_TOPIC_ALIAS_CLUSTERS[0] || [],
      catalogTopics.CATALOG_TOPIC_ALIAS_CLUSTERS[1] || [],
      ['מיתולוגיה יוונית', 'יוונית', 'הומרוס', 'הומר', 'homer', 'greek mythology', 'ancient greece']
    ),
  },
  {
    gradeId: '5',
    blockLabel: 'בוטניקה',
    aliases: ['בוטניקה', 'צמחים', 'צמח', 'botany', 'plants'],
  },
  {
    gradeId: '6',
    blockLabel: 'רומא וימי ביניים',
    aliases: [
      'רומא', 'רומאית', 'היסטוריה רומית', 'rome', 'roman', 'roman history',
      'ימי ביניים', 'אמצעי ימים', 'medieval', 'middle ages',
      'גיאולוגיה', 'מינרלוגיה', 'geology', 'mineralogy',
    ],
  },
  {
    gradeId: '7',
    blockLabel: 'תקופת מגלי עולם ורנסנס',
    aliases: [
      'מגלי עולם', 'מגלים', 'מסעות גילוי', 'גילוי העולם', 'age of exploration', 'explorers',
      'רנסנס', 'renaissance', 'גלילאו', 'galileo',
      'פיזיקה', 'אסטרונומיה', 'physics', 'astronomy',
    ],
  },
  {
    gradeId: '8',
    blockLabel: 'מהפכות והיסטוריה מודרנית',
    aliases: [
      'מהפכה', 'מהפכות', 'מהפכה צרפתית', 'מהפכה אמריקאית', 'revolution', 'revolutions',
      'כימיה אורגנית', 'organic chemistry',
      'היסטוריה מודרנית', 'modern history',
    ],
  },
];

/** Phases that write into the active grade curriculum view — grade-lock enforced here only. */
const SCOPE_VALIDATION_PHASES = new Set([
  'topic',
  'phase_c',
  'pedagogy_deep_dive',
]);

/**
 * Side-chat modes decoupled from the active UI grade (see resolveChatPromptMode in api/chat.js).
 * gemini_kb / community_match = free-form pedagogical Q&A; expansion = deeper side-chat follow-up.
 */
const CHAT_SCOPE_EXEMPT_MODES = new Set(['gemini_kb', 'community_match', 'expansion']);

const CHAT_GRADE_DECOUPLED_INSTRUCTION =
  '\n=== SIDE CHAT — GRADE DECOUPLED (MANDATORY) ===\n' +
  'This side-chat is INDEPENDENT of the teacher\'s currently selected UI grade. ' +
  'Infer the appropriate Waldorf grade from the teacher\'s question and topic ' +
  '(e.g. Odysseus / Greek mythology → Grade 5; saints / animal fables → Grade 2). ' +
  'Tailor all pedagogical guidance, materials, and recommendations to that topic\'s canonical grade — ' +
  'never refuse or redirect based on the UI screen grade.\n' +
  'NEVER reply with a grade-mismatch refusal or redirect (e.g. «נושא זה (...) שייך באופן מובהק לתוכנית הלימודים של...»). ' +
  'That template is ONLY for main lesson generation — NOT for side-chat. Always answer the question fully for the topic\'s canonical grade.\n' +
  '=== END SIDE CHAT — GRADE DECOUPLED ===\n';

const PEDAGOGICAL_SCOPE_GUARDRAIL_INSTRUCTION =
  '\n=== PEDAGOGICAL SCOPE — WALDORF CURRICULUM (CRITICAL — MANDATORY) ===\n' +
  'Before generating or expanding ANY pedagogical content, verify that the requested topic ' +
  'belongs to currentGrade according to established Waldorf / Steiner curriculum rhythms.\n' +
  'If the teacher requests a topic that historically or developmentally belongs to a COMPLETELY DIFFERENT grade ' +
  '(e.g. Greek Mythology / Odysseus / Ancient Greece → Grade 5 ONLY; fairy tales / nature stories → early grades ONLY, NOT Grade 7; ' +
  'saints stories / animal fables → Grade 2; Age of Exploration → Grade 7), you MUST NOT hallucinate, invent, or force pedagogical justifications ' +
  'to teach it in the wrong grade.\n' +
  'NEVER stretch developmental theory to justify cross-grade topics.\n' +
  'Instead, reply cleanly and professionally in Hebrew: state which grade owns the topic, ' +
  'explain it does not fit the current grade\'s developmental picture, and offer to switch grade or suggest grade-appropriate alternatives.\n' +
  '=== END PEDAGOGICAL SCOPE ===\n';

function stableNormalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function stripGradePhrases(text) {
  return String(text || '')
    .replace(/(?:^|\s)(?:ו|ב|ל|ש)?כיתה\s+[א-ת]['׳]?(?:\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topicTextMatchesAlias(textNorm, alias) {
  const aliasNorm = stableNormalize(alias);
  if (!aliasNorm || !textNorm) return false;
  if (textNorm === aliasNorm) return true;
  if (aliasNorm.length >= 3 && textNorm.indexOf(aliasNorm) >= 0) return true;
  if (textNorm.length >= 4 && aliasNorm.indexOf(textNorm) >= 0) return true;
  return false;
}

function findCurriculumBlockForTopic(topicText) {
  const cleaned = stripGradePhrases(topicText);
  const norm = stableNormalize(cleaned);
  if (!norm || norm.length < 2) return null;

  let best = null;
  let bestAliasLen = 0;

  for (let i = 0; i < CURRICULUM_BLOCKS.length; i++) {
    const block = CURRICULUM_BLOCKS[i];
    for (let j = 0; j < block.aliases.length; j++) {
      const alias = block.aliases[j];
      if (!topicTextMatchesAlias(norm, alias)) continue;
      const aliasLen = stableNormalize(alias).length;
      if (!best || aliasLen > bestAliasLen) {
        best = block;
        bestAliasLen = aliasLen;
      }
    }
  }
  return best;
}

function displayTopicLabel(topicText, block) {
  const raw = String(topicText || '').trim();
  if (!raw) return block ? block.blockLabel : '';
  const norm = stableNormalize(stripGradePhrases(raw));
  for (let i = 0; i < (block && block.aliases ? block.aliases.length : 0); i++) {
    const alias = block.aliases[i];
    if (topicTextMatchesAlias(norm, alias)) return String(alias).trim();
  }
  return raw.length > 48 ? raw.slice(0, 48) + '…' : raw;
}

function gradeLabel(gradeId) {
  return GRADE_LABEL_BY_ID[String(gradeId || '').trim()] || ('כיתה ' + gradeId);
}

function suggestedAlternativesForGrade(gradeId) {
  return GRADE_TOPIC_SUGGESTIONS[String(gradeId || '').trim()] || [];
}

/**
 * @returns {null|object} mismatch details when topic does not belong to gradeId
 */
function validatePedagogicalScope(gradeId, topicText) {
  const gid = String(gradeId || '').trim();
  const topic = String(topicText || '').trim();
  if (!gid || !topic) return null;

  const block = findCurriculumBlockForTopic(topic);
  if (!block || block.gradeId === gid) return null;

  return {
    requestedTopic: displayTopicLabel(topic, block),
    requestedTopicRaw: topic,
    currentGradeId: gid,
    currentGradeLabel: gradeLabel(gid),
    canonicalGradeId: block.gradeId,
    canonicalGradeLabel: gradeLabel(block.gradeId),
    blockLabel: block.blockLabel,
    suggestedAlternatives: suggestedAlternativesForGrade(gid),
  };
}

function isAgeExpansionRequest(body) {
  return Boolean(
    body &&
    body.phase === 'pedagogy_deep_dive' &&
    (body.expansionScope === 'age' || body.expansionScope === 'grade')
  );
}

/**
 * Side-chat (chat_followup) is always decoupled from the active UI grade.
 * promptMode (gemini_kb | community_match | expansion) is informational only.
 */
function shouldBypassPedagogicalScopeForChat(body, promptMode) {
  if (!body || body.phase !== 'chat_followup') return false;
  const mode = String(promptMode || '').trim();
  if (!mode || CHAT_SCOPE_EXEMPT_MODES.has(mode)) return true;
  return true;
}

/**
 * Grade-lock applies only to main generation phases that write into the active grade view.
 */
function shouldEnforcePedagogicalScope(body, promptMode) {
  if (!body || !body.phase) return false;
  if (shouldBypassPedagogicalScopeForChat(body, promptMode)) return false;
  if (!SCOPE_VALIDATION_PHASES.has(body.phase)) return false;
  if (isAgeExpansionRequest(body)) return false;
  const gradeId = String(body.currentGrade ?? body.gradeId ?? '').trim();
  return Boolean(gradeId);
}

function shouldValidatePedagogicalScope(body, promptMode) {
  return shouldEnforcePedagogicalScope(body, promptMode);
}

function extractTopicsFromBody(body) {
  const topics = [];
  const seen = new Set();
  function add(value) {
    const text = String(value || '').trim();
    if (!text) return;
    const key = stableNormalize(text);
    if (seen.has(key)) return;
    seen.add(key);
    topics.push(text);
  }

  if (body.topic) add(body.topic);
  if (body.phase === 'pedagogy_deep_dive' && body.activityTitle) add(body.activityTitle);

  return topics;
}

function checkPedagogicalScopeForBody(body, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const promptMode = opts.promptMode;
  if (!shouldEnforcePedagogicalScope(body, promptMode)) return null;
  const gradeId = String(body.currentGrade ?? body.gradeId ?? '').trim();
  const topics = extractTopicsFromBody(body);
  for (let i = 0; i < topics.length; i++) {
    const mismatch = validatePedagogicalScope(gradeId, topics[i]);
    if (mismatch) return mismatch;
  }
  return null;
}

function inferTopicCurriculumBlock(topicText) {
  return findCurriculumBlockForTopic(topicText);
}

/**
 * When the teacher asks about a canonical Waldorf block topic, steer Gemini to that grade.
 */
function buildChatInferredGradeBlock(userMessage) {
  const block = inferTopicCurriculumBlock(userMessage);
  if (!block) return '';
  return (
    '\n=== SIDE CHAT — INFERRED TOPIC GRADE (MANDATORY) ===\n' +
    'The teacher\'s question maps to «' + block.blockLabel + '» — canonical grade: ' +
    gradeLabel(block.gradeId) + ' (id ' + block.gradeId + ').\n' +
    'Answer fully for ' + gradeLabel(block.gradeId) + ' only. Ignore the UI-selected screen grade entirely.\n' +
    '=== END SIDE CHAT — INFERRED TOPIC GRADE ===\n'
  );
}

function buildScopeMismatchWarning(mismatch) {
  if (hebrewTopicMatch && typeof hebrewTopicMatch.buildGradeMismatchMessage === 'function') {
    return hebrewTopicMatch.buildGradeMismatchMessage(mismatch);
  }
  const m = mismatch || {};
  const topic = m.requestedTopic || m.requestedTopicRaw || 'נושא זה';
  return (
    'בחרת ' + topic + ' לכיתה ' + (m.currentGradeLabel || '') +
    ' — זהו נושא המיועד לכיתה ' + (m.canonicalGradeLabel || '') +
    '. אנא בחר שנית או דייק את השאלה.'
  );
}

function buildPedagogicalScopeUserBlock(body, options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (!shouldEnforcePedagogicalScope(body, opts.promptMode)) return '';
  const mismatch = checkPedagogicalScopeForBody(body, opts);
  if (mismatch) {
    return (
      '\n=== PEDAGOGICAL SCOPE MISMATCH (DETECTED — DO NOT GENERATE CROSS-GRADE CONTENT) ===\n' +
      buildScopeMismatchWarning(mismatch) + '\n' +
      'Reply with ONLY this guidance — do not generate lesson content for the mismatched topic.\n' +
      '=== END PEDAGOGICAL SCOPE MISMATCH ===\n'
    );
  }
  return '';
}

function buildScopeMismatchChatPayload(mismatch) {
  const warning = buildScopeMismatchWarning(mismatch);
  return {
    chatReply: {
      answer: warning,
      pedagogicalScopeMismatch: true,
    },
  };
}

function buildScopeMismatchGenerateResult(body, mismatch, communityProbe) {
  const warning = buildScopeMismatchWarning(mismatch);
  const isChat = body && body.phase === 'chat_followup';
  const data = isChat
    ? buildScopeMismatchChatPayload(mismatch)
    : Object.assign(
      { pedagogicalScopeMismatch: true, scopeWarning: warning },
      body && body.phase === 'topic'
        ? {
          webResearch: {
            topic: mismatch.requestedTopicRaw || mismatch.requestedTopic || '',
            summary: warning,
            connections: [],
            highlights: [],
          },
        }
        : {}
    );

  const meta = {
    fromCache: false,
    pedagogicalScopeMismatch: true,
    scopeMismatch: mismatch,
    skipCommunityAlert: true,
  };

  if (communityProbe && typeof communityProbe === 'object') {
    meta.communityMatchCount = communityProbe.count || 0;
  }

  return { data: data, meta: meta };
}

module.exports = {
  GRADE_LABEL_BY_ID,
  GRADE_TOPIC_SUGGESTIONS,
  CURRICULUM_BLOCKS,
  CHAT_GRADE_DECOUPLED_INSTRUCTION,
  CHAT_SCOPE_EXEMPT_MODES,
  SCOPE_VALIDATION_PHASES,
  PEDAGOGICAL_SCOPE_GUARDRAIL_INSTRUCTION,
  validatePedagogicalScope,
  inferTopicCurriculumBlock,
  checkPedagogicalScopeForBody,
  shouldEnforcePedagogicalScope,
  shouldValidatePedagogicalScope,
  shouldBypassPedagogicalScopeForChat,
  extractTopicsFromBody,
  buildScopeMismatchWarning,
  buildChatInferredGradeBlock,
  buildPedagogicalScopeUserBlock,
  buildScopeMismatchChatPayload,
  buildScopeMismatchGenerateResult,
};
