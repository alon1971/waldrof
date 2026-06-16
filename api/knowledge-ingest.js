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

async function supabaseInsert(rows) {
  const cfg = getSupabaseConfig();
  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error('knowledge_base insert failed (' + res.status + '): ' + text.slice(0, 300));
  }
  return text ? JSON.parse(text) : [];
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
    const saved = await supabaseInsert(rows.slice(i, i + batchSize));
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

function extractLearnableText(phase, data) {
  if (!data || typeof data !== 'object') return '';
  const parts = [];

  if (phase === 'topic') {
    if (data.webResearch && data.webResearch.summary) parts.push(data.webResearch.summary);
    if (data.blockPlan && data.blockPlan.theory && Array.isArray(data.blockPlan.theory.sections)) {
      data.blockPlan.theory.sections.forEach(function (sec) {
        if (sec && sec.content) parts.push(sec.content);
      });
    }
  } else if (phase === 'grade' && data.gradeInsights) {
    const gi = data.gradeInsights;
    ['part1AgePictureHtml', 'part2ClassroomIdeasHtml', 'archivesSynthesisHtml', 'part3CommunityExpansionsHtml']
      .forEach(function (key) {
        if (gi[key]) parts.push(gi[key]);
      });
  } else if (phase === 'chat_followup' && data.chatReply) {
    if (data.chatReply.answer) parts.push(data.chatReply.answer);
    else if (data.chatReply.answerHtml) parts.push(data.chatReply.answerHtml);
  }

  if (!parts.length) {
    const fallback = [];
    collectStringsFromObject(data, fallback, 0);
    parts.push(fallback.slice(0, 3).join('\n\n'));
  }

  return chunks.stripHtml(parts.join('\n\n')).slice(0, 6000);
}

function buildAiLearnMeta(body) {
  const topic = body.topic || body.archiveQuery || '';
  const gradeLabel = body.gradeLabel || body.currentGrade || body.gradeId || '';
  const titleParts = [];
  if (topic) titleParts.push('«' + topic + '»');
  if (gradeLabel) titleParts.push(gradeLabel);
  const phaseLabel = body.phase === 'chat_followup' ? 'שיחת מורה' : 'מחקר AI';

  return {
    title: (titleParts.length ? titleParts.join(' · ') : phaseLabel) + ' — ' + phaseLabel,
    author: 'Waldrof AI',
    origin: 'ai_background',
  };
}

async function ingestFromGenerateResult(body, resultData) {
  if (!isIngestEnabled() || !body || !INGEST_PHASES.has(body.phase)) {
    return { skipped: true };
  }
  if (body.skipKnowledgeIngest) return { skipped: true };

  const text = extractLearnableText(body.phase, resultData);
  if (text.length < 120) return { skipped: true, reason: 'insufficient_text' };

  return insertKnowledgeText(text, buildAiLearnMeta(body));
}

function ingestFromGenerateResultAsync(body, resultData) {
  ingestFromGenerateResult(body, resultData).catch(function (err) {
    console.warn('[knowledge-ingest] background learn failed:', err.message || err);
  });
}

module.exports = {
  TABLE_NAME,
  isIngestEnabled,
  insertKnowledgeText,
  ingestFromGenerateResult,
  ingestFromGenerateResultAsync,
  extractLearnableText,
};
