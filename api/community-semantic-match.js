/**
 * Hybrid semantic matcher for community materials chat probe.
 * 1. OpenAI lightweight classifier (gpt-4o-mini) when OPENAI_API_KEY is set.
 * 2. Embedding cosine similarity fallback (text-embedding-3-small).
 */
const env = require('./env');
const embeddings = require('./embeddings');
const jsonRepair = require('./json-repair');

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const SEMANTIC_CHAT_MODEL = 'gpt-4o-mini';
const EMBEDDING_MATCH_THRESHOLD = 0.42;
const LLM_MIN_CONFIDENCE = 0.65;

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildCatalogLine(entry, index) {
  let line = (index + 1) + '. [' + entry.key + '] «' + entry.title + '»';
  if (entry.topic) line += ' | נושא: ' + entry.topic;
  if (entry.description) line += ' | ' + String(entry.description).slice(0, 140);
  return line;
}

function buildCatalogText(entries) {
  return entries.slice(0, 48).map(buildCatalogLine).join('\n');
}

function mapSemanticResults(entries, matches, matchType) {
  const byKey = {};
  entries.forEach(function (entry) {
    if (entry && entry.key) byKey[entry.key] = entry;
  });

  const hits = [];
  (matches || []).forEach(function (match) {
    const key = String((match && match.key) || '').trim();
    const entry = byKey[key];
    if (!entry || !entry.hit) return;
    const confidence = Number(match.confidence);
    if (!Number.isFinite(confidence) || confidence < LLM_MIN_CONFIDENCE) return;
    const hit = Object.assign({}, entry.hit, {
      similarity: confidence,
      matchType: matchType,
      semanticReason: match.reason || '',
    });
    hits.push(hit);
  });

  return hits.sort(function (a, b) { return (b.similarity || 0) - (a.similarity || 0); });
}

async function callOpenAiSemanticClassifier(userQuery, entries) {
  const apiKey = env.getOpenAiApiKey();
  if (!apiKey || !entries.length) return [];

  const catalogText = buildCatalogText(entries);
  const systemPrompt =
    'You are a Hebrew pedagogical librarian. Given a teacher question and a numbered catalog of community-uploaded files, ' +
    'identify which files are SEMANTICALLY relevant to the teacher intent — including indirect links ' +
    '(e.g. «הומרוס» or «מיתולוגיה יוונית» → «מסעות אודיסאוס»). ' +
    'Return ONLY valid JSON: {"matches":[{"key":"catalog:uuid-or-kb:uuid","confidence":0.0-1.0,"reason":"brief Hebrew"}]}. ' +
    'Include ONLY keys from the catalog. Use confidence >= 0.65 only for genuine semantic relevance. Return {"matches":[]} when none apply.';

  const userPrompt =
    'שאלת המורה: «' + String(userQuery || '').trim() + '»\n\n' +
    'קטלוג חומרי קהילה:\n' + catalogText;

  let res;
  try {
    res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: SEMANTIC_CHAT_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (fetchErr) {
    console.warn('[community-semantic] OpenAI classifier failed:', fetchErr.message || fetchErr);
    return [];
  }

  if (!res.ok) {
    const errText = await res.text().catch(function () { return ''; });
    console.warn('[community-semantic] OpenAI classifier HTTP', res.status, errText.slice(0, 200));
    return [];
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    console.warn('[community-semantic] OpenAI classifier non-JSON response');
    return [];
  }

  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '').trim()
    : '';
  if (!content) return [];

  let parsed;
  try {
    parsed = jsonRepair.cleanAndParseJSON(content, { fallbackOnError: false, unwrap: true });
  } catch (jsonErr) {
    parsed = jsonRepair.safeParseJson(content);
  }
  if (!parsed || typeof parsed !== 'object') return [];

  const rows = Array.isArray(parsed.matches) ? parsed.matches : [];
  return mapSemanticResults(entries, rows, 'semantic_llm');
}

async function embeddingSemanticMatch(userQuery, entries) {
  if (!entries.length || !embeddings.resolveEmbeddingApiKey()) return [];

  let queryVector;
  try {
    queryVector = await embeddings.embedText(userQuery);
  } catch (embedErr) {
    console.warn('[community-semantic] query embed failed:', embedErr.message || embedErr);
    return [];
  }
  if (!Array.isArray(queryVector) || !queryVector.length) return [];

  const texts = entries.map(function (entry) {
    return [entry.title, entry.topic, entry.description].filter(Boolean).join(' — ').trim();
  });

  let vectors;
  try {
    vectors = await embeddings.embedTexts(texts);
  } catch (batchErr) {
    console.warn('[community-semantic] catalog embed failed:', batchErr.message || batchErr);
    return [];
  }

  const scored = [];
  entries.forEach(function (entry, index) {
    const vector = vectors[index];
    if (!vector) return;
    const score = cosineSimilarity(queryVector, vector);
    if (score >= EMBEDDING_MATCH_THRESHOLD) {
      scored.push({
        key: entry.key,
        confidence: score,
        reason: 'התאמה סמנטית (וקטור)',
        entry: entry,
      });
    }
  });

  scored.sort(function (a, b) { return b.confidence - a.confidence; });
  return mapSemanticResults(
    entries,
    scored.slice(0, 8).map(function (row) {
      return { key: row.key, confidence: row.confidence, reason: row.reason };
    }),
    'semantic_embedding'
  );
}

/**
 * Run semantic matching when keyword passes found nothing.
 * Tries LLM classifier first, then embedding similarity.
 */
async function findSemanticCommunityMatches(userQuery, entries) {
  const query = String(userQuery || '').trim();
  if (!query || !Array.isArray(entries) || !entries.length) return [];

  const llmHits = await callOpenAiSemanticClassifier(query, entries);
  if (llmHits.length) {
    console.log('[community-semantic] LLM matched', llmHits.length, 'material(s)');
    return llmHits;
  }

  const embedHits = await embeddingSemanticMatch(query, entries);
  if (embedHits.length) {
    console.log('[community-semantic] embedding matched', embedHits.length, 'material(s)');
    return embedHits;
  }

  return [];
}

module.exports = {
  findSemanticCommunityMatches,
  cosineSimilarity,
  LLM_MIN_CONFIDENCE,
  EMBEDDING_MATCH_THRESHOLD,
};
