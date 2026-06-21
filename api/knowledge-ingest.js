/**
 * Insert & background-learn into knowledge_base (community shares + AI refinements).
 * Schema: title, author, content, contributor_email (see supabase/setup_knowledge_base.sql)
 */
const chunks = require('./knowledge-chunks');
const env = require('./env');

const TABLE_NAME = 'knowledge_base';
const INGEST_PHASES = new Set(['grade', 'topic', 'chat_followup']);

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServerKey(),
  };
}

function isIngestEnabled() {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && cfg.key);
}

async function supabaseInsert(rows, schema) {
  const cfg = getSupabaseConfig();
  const payload = rows.map(function (row) {
    if (schema === 'legacy') {
      return {
        content: row.content,
        document_title: row.title,
        source_author: row.author || null,
        source_type: 'article',
      };
    }
    if (schema === 'minimal') {
      return {
        content: row.content,
        title: row.title,
      };
    }
    return {
      content: row.content,
      title: row.title,
      author: row.author || null,
    };
  });

  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error('knowledge_base insert failed (' + res.status + '): ' + text.slice(0, 300));
    err.statusCode = res.status;
    err.responseText = text;
    throw err;
  }
  return text ? JSON.parse(text) : [];
}
async function supabaseInsertRows(rows) {
  try {
    return await supabaseInsert(rows, 'app');
  } catch (err) {
    if (isMissingAuthorColumn(err)) {
      return supabaseInsert(rows, 'minimal');
    }
    if (isMissingAppColumns(err)) {
      return supabaseInsert(rows, 'legacy');
    }
    throw err;
  }
}

function isMissingAuthorColumn(err) {
  const msg = String((err && err.message) || err || '');
  return /Could not find the 'author' column/i.test(msg);
}

function isMissingAppColumns(err) {
  const msg = String((err && err.message) || err || '');
  return /Could not find the '(title|author)' column/i.test(msg)
    || /PGRST204.*(title|author)/i.test(msg);
}

function buildRowsFromChunks(chunkList, meta) {
  const m = meta || {};
  const title = m.title || m.documentTitle || 'חומר ללא כותרת';
  const author = m.author || m.sourceAuthor || null;

  return chunkList.map(function (content) {
    const row = {
      content: content,
      title: title,
      author: author,
    };
    if (m.contributorEmail) row.contributor_email = m.contributorEmail;
    if (m.gradeId) row.grade_id = m.gradeId;
    if (m.topic) row.topic = m.topic;
    return row;
  });
}

async function insertKnowledgeText(text, meta) {
  const normalized = chunks.normalizeText(text);
  if (normalized.length < 80) {
    return { inserted: 0, chunks: 0, reason: 'too_short' };
  }

  const chunkList = chunks.chunkText(normalized, meta && meta.chunkOptions);
  if (!chunkList.length) {
    return { inserted: 0, chunks: 0, reason: 'no_chunks' };
  }

  const rows = buildRowsFromChunks(chunkList, meta);
  const batchSize = 24;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const saved = await supabaseInsertRows(rows.slice(i, i + batchSize));
    inserted += Array.isArray(saved) ? saved.length : 0;
  }

  return { inserted: inserted, chunks: chunkList.length };
}

function collectStringsFromObject(obj, out, depth) {
  if (!obj || depth > 4) return;
  if (typeof obj === 'string') {
    const plain = chunks.stripHtml(obj);
    if (plain.length >= 80) out.push(plain);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach(function (item) { collectStringsFromObject(item, out, depth + 1); });
    return;
  }
  if (typeof obj === 'object') {
    Object.keys(obj).forEach(function (key) {
      if (/url|pin|src|icon|id$/i.test(key)) return;
      collectStringsFromObject(obj[key], out, depth + 1);
    });
  }
}

function appendBlockPlanParts(plan, parts) {
  if (!plan || typeof plan !== 'object') return;
  if (plan.theory && Array.isArray(plan.theory.sections)) {
    plan.theory.sections.forEach(function (sec) {
      if (sec && sec.content) {
        var heading = sec.heading ? sec.heading + ':\n' : '';
        parts.push(heading + sec.content);
      }
    });
  }
  if (plan.inspiration && plan.inspiration.global) {
    plan.inspiration.global.forEach(function (block) {
      if (!block) return;
      var items = Array.isArray(block.items) ? block.items.join(' ') : '';
      parts.push((block.title || 'השראה') + ': ' + items);
    });
  }
  if (Array.isArray(plan.pedagogicalResources) && plan.pedagogicalResources.length) {
    plan.pedagogicalResources.forEach(function (res) {
      if (!res) return;
      parts.push(
        (res.label || 'מקור וולדורף') + ': ' + (res.title || '') +
        (res.source ? ' (' + res.source + ')' : '') +
        (res.snippet ? ' — ' + res.snippet : '')
      );
    });
  }
  if (Array.isArray(plan.curriculum)) {
    plan.curriculum.slice(0, 15).forEach(function (day) {
      if (!day) return;
      parts.push(
        'יום ' + (day.day || '') + ' — ' + (day.topic || '') + ': ' +
        chunks.stripHtml(day.content || '') + (day.art ? ' | אמנות: ' + day.art : '')
      );
    });
  }
}

function appendChatMessages(messages, parts) {
  if (!Array.isArray(messages)) return;
  messages.forEach(function (msg, i) {
    if (!msg || msg.role !== 'assistant' || msg.isGreeting) return;
    var body = msg.html || msg.text || msg.content || '';
    if (body) parts.push('תיקון פדגוגי ' + (i + 1) + ':\n' + body);
  });
}

function extractLearnableText(phase, data, body) {
  if (!data || typeof data !== 'object') return '';
  const parts = [];

  if (phase === 'topic') {
    if (data.webResearch && data.webResearch.summary) parts.push(data.webResearch.summary);
    if (data.blockPlan) appendBlockPlanParts(data.blockPlan, parts);
  } else if (phase === 'grade' && data.gradeInsights) {
    const gi = data.gradeInsights;
    ['part1AgePictureHtml', 'part2ClassroomIdeasHtml', 'archivesSynthesisHtml', 'part3CommunityExpansionsHtml']
      .forEach(function (key) {
        if (gi[key]) parts.push(gi[key]);
      });
  } else if (phase === 'chat_followup') {
    if (data.chatReply) {
      if (data.chatReply.answer) parts.push(data.chatReply.answer);
      else if (data.chatReply.answerHtml) parts.push(data.chatReply.answerHtml);
    }
    if (body && body.researchContext) {
      parts.push(String(body.researchContext).slice(0, 4000));
    }
  }

  if (!parts.length) {
    const fallback = [];
    collectStringsFromObject(data, fallback, 0);
    parts.push(fallback.slice(0, 5).join('\n\n'));
  }

  return chunks.stripHtml(parts.join('\n\n')).slice(0, 12000);
}

function extractLearnableFromLessonSnapshot(snapshot, chatMessages) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const parts = [];

  if (snapshot.webResearch && snapshot.webResearch.summary) {
    parts.push(snapshot.webResearch.summary);
  }
  if (snapshot.blockPlan) appendBlockPlanParts(snapshot.blockPlan, parts);
  appendChatMessages(chatMessages || snapshot.chatHistory, parts);

  return chunks.stripHtml(parts.join('\n\n')).slice(0, 14000);
}

function buildAiLearnMeta(body) {
  const topic = body.topic || body.archiveQuery || '';
  const gradeLabel = body.gradeLabel || body.currentGrade || body.gradeId || '';
  const gradeId = body.gradeId || body.currentGrade || '';
  const titleParts = [];
  if (topic) titleParts.push('«' + topic + '»');
  if (gradeLabel) titleParts.push(gradeLabel);
  const phaseLabel = body.phase === 'chat_followup' ? 'שיחת מורה' : 'מחקר AI';

  return {
    title: (titleParts.length ? titleParts.join(' · ') : phaseLabel) + ' — ' + phaseLabel,
    author: 'Waldrof AI',
    origin: 'ai_background',
    gradeId: gradeId || null,
    topic: topic || null,
    chunkOptions: { minChars: 100, maxChars: 1400 },
  };
}

function buildLessonSnapshotMeta(body, teacher) {
  const topic = String((body && body.topic) || '').trim();
  const gradeLabel = String((body && body.gradeLabel) || '').trim();
  const gradeId = String((body && body.gradeId) || (body && body.currentGrade) || '').trim();
  const titleParts = [];
  if (topic) titleParts.push('«' + topic + '»');
  if (gradeLabel) titleParts.push(gradeLabel);
  const contributor = teacher || {};
  const authorName = contributor.name || contributor.displayName || contributor.email || 'Waldrof מורה';

  return {
    title: (titleParts.length ? titleParts.join(' · ') : 'תכנית שיעור') + ' — תכנית שיעור מעודכנת',
    author: authorName,
    contributorEmail: contributor.email || null,
    gradeId: gradeId || null,
    topic: topic || null,
    origin: 'lesson_auto_sync',
    chunkOptions: { minChars: 100, maxChars: 1400 },
  };
}

async function ingestFromGenerateResult(body, resultData) {
  if (!isIngestEnabled() || !body || !INGEST_PHASES.has(body.phase)) {
    return { skipped: true };
  }
  if (body.skipKnowledgeIngest) return { skipped: true };

  const text = extractLearnableText(body.phase, resultData, body);
  if (text.length < 120) return { skipped: true, reason: 'insufficient_text' };

  return insertKnowledgeText(text, buildAiLearnMeta(body));
}

function ingestFromGenerateResultAsync(body, resultData) {
  ingestFromGenerateResult(body, resultData).catch(function (err) {
    console.warn('[knowledge-ingest] background learn failed:', err.message || err);
  });
}

async function ingestLessonSnapshot(body, teacher, snapshot, chatMessages) {
  if (!isIngestEnabled()) return { skipped: true, reason: 'ingest_disabled' };
  if (body && body.skipKnowledgeIngest) return { skipped: true };

  const text = extractLearnableFromLessonSnapshot(snapshot, chatMessages);
  if (text.length < 120) return { skipped: true, reason: 'insufficient_text' };

  return insertKnowledgeText(text, buildLessonSnapshotMeta(body, teacher));
}

function ingestLessonSnapshotAsync(body, teacher, snapshot, chatMessages) {
  ingestLessonSnapshot(body, teacher, snapshot, chatMessages).catch(function (err) {
    console.warn('[knowledge-ingest] lesson snapshot sync failed:', err.message || err);
  });
}

module.exports = {
  TABLE_NAME,
  isIngestEnabled,
  insertKnowledgeText,
  ingestFromGenerateResult,
  ingestFromGenerateResultAsync,
  ingestLessonSnapshot,
  ingestLessonSnapshotAsync,
  extractLearnableText,
  extractLearnableFromLessonSnapshot,
};
