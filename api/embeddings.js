/**
 * Text embeddings for knowledge_base RAG (OpenAI-compatible API).
 * Env: OPENAI_API_KEY (optional — without it, upload script skips vectors; server uses text search).
 */
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;

function resolveEmbeddingApiKey() {
  const candidates = [
    process.env.OPENAI_API_KEY,
    process.env.EMBEDDING_API_KEY,
  ];
  for (let i = 0; i < candidates.length; i++) {
    const key = candidates[i];
    if (key && String(key).trim()) return String(key).trim();
  }
  return null;
}

function resolveEmbeddingBaseUrl() {
  return String(process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
}

async function embedTexts(texts, options) {
  const apiKey = (options && options.apiKey) || resolveEmbeddingApiKey();
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY not set — embeddings unavailable');
    err.code = 'NO_EMBEDDING_KEY';
    throw err;
  }

  const input = (Array.isArray(texts) ? texts : [texts])
    .map(function (t) { return String(t || '').trim(); })
    .filter(Boolean);

  if (!input.length) {
    const err = new Error('No text to embed');
    err.code = 'EMPTY_INPUT';
    throw err;
  }

  const baseUrl = (options && options.baseUrl) || resolveEmbeddingBaseUrl();
  const res = await fetch(baseUrl + '/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: (options && options.model) || EMBEDDING_MODEL,
      input: input,
    }),
  });

  const responseText = await res.text();
  if (!res.ok) {
    throw new Error('Embeddings API ' + res.status + ': ' + responseText.slice(0, 300));
  }

  let data;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch (parseErr) {
    throw new Error('Embeddings API returned non-JSON');
  }

  const rows = data && data.data;
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('Embeddings API returned no vectors');
  }

  rows.sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
  return rows.map(function (row) { return row.embedding; });
}

async function embedText(text, options) {
  const vectors = await embedTexts([text], options);
  return vectors[0];
}

module.exports = {
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  resolveEmbeddingApiKey,
  embedText,
  embedTexts,
};
