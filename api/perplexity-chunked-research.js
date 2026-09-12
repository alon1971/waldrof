/**
 * Two-segment sonar-reasoning-pro research for Phase C — stable streaming, lower OOM risk.
 */
const perplexityClient = require('./perplexity-client');
const shared = require('./pure-api-shared');
const jsonRepair = require('./json-repair');

const CHUNK_NETWORK_RETRY_ATTEMPTS = 3;
const CHUNK_NETWORK_RETRY_BASE_DELAY_MS = 1200;
/** Generous per-segment budget (8k–10k range) without single 16k+ monolith. */
const CHUNK_MAX_TOKENS_SEGMENT = 9000;
const CHUNK_DEFAULT_MAX_TOKENS = CHUNK_MAX_TOKENS_SEGMENT;

const SEGMENT_DEPTH_NUDGE =
  'Use the full token budget for THIS segment. Write dense, anthroposophically rich Hebrew prose — deep paragraphs, never stubs; complete each JSON field without truncating mid-sentence.';

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isChunkRetriableError(err) {
  if (!err) return false;
  if (err.statusCode === 429 || err.statusCode === 401 || err.statusCode === 403) return false;
  if (shared.isRetriableCommunicationError && shared.isRetriableCommunicationError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR|שגיאת רשת|network/i.test(msg);
}

async function withChunkNetworkRetry(operation, label) {
  let lastErr = null;
  for (let attempt = 0; attempt < CHUNK_NETWORK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isChunkRetriableError(err) || attempt >= CHUNK_NETWORK_RETRY_ATTEMPTS - 1) throw err;
      const delayMs = CHUNK_NETWORK_RETRY_BASE_DELAY_MS * (attempt + 1);
      console.warn(
        '[perplexity-chunk] transient error on',
        label || 'chunk',
        '— retry',
        attempt + 1,
        '/',
        CHUNK_NETWORK_RETRY_ATTEMPTS - 1,
        'in',
        delayMs,
        'ms:',
        err.message || err
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function deepMergeJsonParts(into, from) {
  if (!from || typeof from !== 'object') return into;
  if (!into || typeof into !== 'object') into = {};
  Object.keys(from).forEach(function (key) {
    const val = from[key];
    if (val == null) return;
    const existing = into[key];
    if (
      val && typeof val === 'object' && !Array.isArray(val) &&
      existing && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      into[key] = deepMergeJsonParts(Object.assign({}, existing), val);
    } else {
      into[key] = val;
    }
  });
  return into;
}

async function invokePerplexityChunk(messages, options) {
  const opts = options || {};
  const requestBody = {
    apiKey: opts.apiKey,
    model: perplexityClient.PERPLEXITY_MODEL,
    stream: opts.stream !== false,
    temperature: opts.temperature != null ? opts.temperature : 0.35,
    max_tokens: opts.max_tokens != null ? opts.max_tokens : CHUNK_DEFAULT_MAX_TOKENS,
    idleTimeoutMs: opts.idleTimeoutMs || perplexityClient.REQUEST_TIMEOUT_MS,
    onDelta: typeof opts.onDelta === 'function' ? opts.onDelta : undefined,
    messages: messages,
  };
  if (typeof opts.totalTimeoutMs === 'number' && opts.totalTimeoutMs > 0) {
    requestBody.totalTimeoutMs = opts.totalTimeoutMs;
  }
  return perplexityClient.callPerplexityChatWithCitations(requestBody);
}

async function runSequentialResearchChunks(segments, context) {
  const ctx = context || {};
  const parseFn = ctx.parseChunk;
  const mergeFn = ctx.mergePart || deepMergeJsonParts;
  const callOpts = ctx.callOptions || {};
  const merged = {};
  const allCitations = [];
  const rawParts = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const label = segment.id || ('segment-' + (i + 1));
    console.log(
      '[perplexity-chunk] start',
      label,
      '(' + (i + 1) + '/' + segments.length + ')',
      'keys=',
      (segment.keys || []).join(',')
    );

    const apiResult = await withChunkNetworkRetry(function () {
      return invokePerplexityChunk(
        [
          { role: 'system', content: segment.systemPrompt },
          { role: 'user', content: segment.userPrompt },
        ],
        Object.assign({}, callOpts, segment.callOptions || {})
      );
    }, label);

    rawParts.push(apiResult.content || '');
    if (Array.isArray(apiResult.citations)) {
      apiResult.citations.forEach(function (url) {
        if (url && allCitations.indexOf(url) === -1) allCitations.push(url);
      });
    }

    const rawContent = apiResult.content || '';
    const repairedContent = jsonRepair.repairSegmentJson(rawContent) || rawContent;
    let part = parseFn(repairedContent, segment);
    if (!part || typeof part !== 'object') {
      part = parseFn(rawContent, segment);
    }
    if (!part || typeof part !== 'object') {
      part = jsonRepair.salvageParseModelJson(repairedContent, ctx.salvageParseOptions || { unwrap: true });
    }
    if (part && typeof part === 'object') {
      mergeFn(merged, part);
    } else {
      console.warn('[perplexity-chunk] segment parse failed after repair:', label);
    }
    console.log('[perplexity-chunk] done', label, 'mergedKeys=', Object.keys(merged).join(','));
  }

  return {
    merged: merged,
    citations: allCitations,
    rawCombined: rawParts.join('\n\n--- CHUNK ---\n\n'),
  };
}

/**
 * Phase C — exactly 2 segments: (1) theory & intro, (2) practice, structure & resources.
 */
function buildPhaseCChunkSegments(systemPromptBase, userPromptBase, grade, topic) {
  const continuity = [
    'Grade: ' + grade,
    'Topic: ' + topic,
    'Two-part Waldorf teacher manual. Do NOT duplicate content across segments.',
    'Respond ONLY with valid JSON (no markdown fences). Include ONLY the keys listed for this segment.',
  ].join('\n');

  const sharedUser = continuity + '\n\n' + userPromptBase;
  const tokenOpts = { max_tokens: CHUNK_MAX_TOKENS_SEGMENT };

  return [
    {
      id: 'phase_c_theory_intro',
      keys: ['theory', 'core_emphases'],
      systemPrompt: systemPromptBase +
        '\nSEGMENT 1/2: JSON with ONLY "theory" and "core_emphases" — exhaustive anthroposophical background, developmental axis, and full introductory pedagogical essay.',
      userPrompt: sharedUser +
        '\n\n=== SEGMENT 1/2 — THEORETICAL BACKGROUND & ANTHROPOSOPHIC INTRO ===\n' +
        SEGMENT_DEPTH_NUDGE +
        '\nProduce ONLY "theory" (4-6 deep sections) and "core_emphases" (6-8 rich paragraphs with Developmental Compass). No other keys.',
      callOptions: tokenOpts,
    },
    {
      id: 'phase_c_practice_resources',
      keys: [
        'inspiration',
        'key_points',
        'pinterest_links',
        'pedagogical_resources',
        'recommended_reading',
        'relevant_links',
      ],
      systemPrompt: systemPromptBase +
        '\nSEGMENT 2/2: JSON with ONLY inspiration, key_points, pinterest_links, pedagogical_resources, recommended_reading, relevant_links.',
      userPrompt: sharedUser +
        '\n\n=== SEGMENT 2/2 — ACTIVITIES, INSPIRATION, STRUCTURE & COMMUNITY RESOURCES ===\n' +
        SEGMENT_DEPTH_NUDGE +
        '\nProduce inspiration blocks, key_points, pinterest_links, pedagogical_resources, recommended_reading, relevant_links — full depth, no other keys.',
      callOptions: tokenOpts,
    },
  ];
}

module.exports = {
  CHUNK_MAX_TOKENS_SEGMENT,
  CHUNK_DEFAULT_MAX_TOKENS,
  CHUNK_NETWORK_RETRY_ATTEMPTS,
  withChunkNetworkRetry,
  deepMergeJsonParts,
  runSequentialResearchChunks,
  invokePerplexityChunk,
  buildPhaseCChunkSegments,
};
