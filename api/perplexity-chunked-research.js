/**
 * Chunked sonar-reasoning-pro research — sequential focused API calls with per-chunk retry.
 * Used by /api/pure-phase-c and decoupled grade/topic synthesis in generate.js only.
 */
const perplexityClient = require('./perplexity-client');
const shared = require('./pure-api-shared');

/** Optional hard wall cap per chunk (0 = rely on streaming + idle timeout only). */
const CHUNK_PER_REQUEST_WALL_MS = 0;
const CHUNK_NETWORK_RETRY_ATTEMPTS = 3;
const CHUNK_NETWORK_RETRY_BASE_DELAY_MS = 1200;
/** Default segment budget — match sonar-reasoning-pro pro ceiling so outputs are not truncated. */
const CHUNK_DEFAULT_MAX_TOKENS = perplexityClient.PERPLEXITY_MAX_OUTPUT_TOKENS_PRO;
/** Rich narrative segments (theory, inspiration, structure). */
const CHUNK_MAX_TOKENS_DEEP = CHUNK_DEFAULT_MAX_TOKENS;
/** Resource / link segments (still full prose in snippets and notes). */
const CHUNK_MAX_TOKENS_RESOURCES = Math.min(14000, CHUNK_DEFAULT_MAX_TOKENS);
/** Compact JSON slices (summaries, webResearch overview). */
const CHUNK_MAX_TOKENS_COMPACT = Math.min(10000, CHUNK_DEFAULT_MAX_TOKENS);

const SEGMENT_DEPTH_NUDGE =
  'Use the FULL max_tokens output budget for this segment. Write deep, book-length Hebrew prose — never summarize, never truncate mid-field.';

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

/**
 * Automatic retry for transient network failures (2–3 attempts, short backoff).
 */
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
  } else if (CHUNK_PER_REQUEST_WALL_MS > 0) {
    requestBody.totalTimeoutMs = CHUNK_PER_REQUEST_WALL_MS;
  }
  return perplexityClient.callPerplexityChatWithCitations(requestBody);
}

/**
 * Run ordered research segments; parseFn(raw) → object; mergeFn(accumulator, part).
 */
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

    const part = parseFn(apiResult.content, segment);
    if (part && typeof part === 'object') {
      mergeFn(merged, part);
    }
    console.log('[perplexity-chunk] done', label, 'mergedKeys=', Object.keys(merged).join(','));
  }

  return {
    merged: merged,
    citations: allCitations,
    rawCombined: rawParts.join('\n\n--- CHUNK ---\n\n'),
  };
}

function buildPhaseCChunkSegments(systemPromptBase, userPromptBase, grade, topic) {
  const continuity = [
    'Grade: ' + grade,
    'Topic: ' + topic,
    'This is one segment of a multi-part Waldorf teacher manual. Do NOT repeat content from other segments.',
    'Respond ONLY with valid JSON (no markdown fences). Include ONLY the keys listed for this segment.',
  ].join('\n');

  const sharedUser = continuity + '\n\n' + userPromptBase;

  return [
    {
      id: 'phase_c_background_theory',
      keys: ['theory'],
      systemPrompt: systemPromptBase + '\nSEGMENT SCOPE: Return a JSON object with ONLY the "theory" key (exhaustive background, developmental axis, lesson architecture in theory sections).',
      userPrompt: sharedUser + '\n\n=== SEGMENT 1/4 — BACKGROUND & THEORETICAL DEPTH ===\n' + SEGMENT_DEPTH_NUDGE + '\nProduce ONLY "theory" with 4-6 deep sections (6-10 paragraphs each). No other keys.',
      callOptions: { max_tokens: CHUNK_MAX_TOKENS_DEEP },
    },
    {
      id: 'phase_c_inspiration',
      keys: ['inspiration'],
      systemPrompt: systemPromptBase + '\nSEGMENT SCOPE: Return a JSON object with ONLY the "inspiration" key (storytelling, movement, blackboard art, classroom inspiration blocks).',
      userPrompt: sharedUser + '\n\n=== SEGMENT 2/4 — INSPIRATION & CREATIVE ACTIVITIES ===\n' + SEGMENT_DEPTH_NUDGE + '\nProduce ONLY "inspiration" (3-4 global blocks × 8-12 rich multi-sentence items). No other keys.',
      callOptions: { max_tokens: CHUNK_MAX_TOKENS_DEEP },
    },
    {
      id: 'phase_c_structure',
      keys: ['core_emphases', 'key_points', 'pinterest_links'],
      systemPrompt: systemPromptBase + '\nSEGMENT SCOPE: Return JSON with ONLY "core_emphases", "key_points", and "pinterest_links".',
      userPrompt: sharedUser + '\n\n=== SEGMENT 3/4 — STRUCTURE & LESSON ARCHITECTURE ===\n' + SEGMENT_DEPTH_NUDGE + '\nProduce core_emphases (6-8 long paragraphs), key_points (6-8 items × 4-7 sentences each), pinterest_links (4-8 live URLs). No other keys.',
      callOptions: { max_tokens: CHUNK_MAX_TOKENS_DEEP },
    },
    {
      id: 'phase_c_resources',
      keys: ['pedagogical_resources', 'recommended_reading', 'relevant_links'],
      systemPrompt: systemPromptBase + '\nSEGMENT SCOPE: Return JSON with ONLY "pedagogical_resources", "recommended_reading", and "relevant_links".',
      userPrompt: sharedUser + '\n\n=== SEGMENT 4/4 — RESOURCES & VERIFIED LINKS ===\n' + SEGMENT_DEPTH_NUDGE + '\nProduce pedagogical_resources (substantive snippets), recommended_reading (6-8 with 2-4 sentence notes), relevant_links (6-12 HTTPS Waldorf portals). No other keys.',
      callOptions: { max_tokens: CHUNK_MAX_TOKENS_RESOURCES },
    },
  ];
}

function buildGradeSynthesisChunkSegments(systemContent, userPromptBase) {
  const base = userPromptBase;
  return [
    {
      id: 'grade_portrait_part1',
      keys: ['gradeInsights'],
      systemPrompt: systemContent + '\nSEGMENT 1/3: JSON with ONLY gradeInsights containing part1AgePictureHtml, part1DevelopmentBullets, archivesSynthesisHtml, developmentBullets.',
      userPrompt: base + '\n\n=== SEGMENT 1/3 — AGE PICTURE & ARCHIVE SYNTHESIS ===\n' + SEGMENT_DEPTH_NUDGE + '\nReturn ONLY those gradeInsights fields inside gradeInsights.',
      callOptions: { max_tokens: CHUNK_MAX_TOKENS_DEEP },
    },
    {
      id: 'grade_portrait_part2',
      keys: ['gradeInsights'],
      systemPrompt: systemContent + '\nSEGMENT 2/3: JSON with ONLY gradeInsights containing part2ClassroomIdeasHtml, part2ClassroomIdeas, part3CommunityExpansionsHtml, part3CommunityIdeas, globalCurricula, typicalBlocks, sources.',
      userPrompt: base + '\n\n=== SEGMENT 2/3 — CLASSROOM & COMMUNITY ===\n' + SEGMENT_DEPTH_NUDGE + '\nReturn ONLY those gradeInsights fields inside gradeInsights.',
      callOptions: { max_tokens: CHUNK_MAX_TOKENS_DEEP },
    },
    {
      id: 'grade_teacher_summaries',
      keys: ['teacherSummaries'],
      systemPrompt: systemContent + '\nSEGMENT 3/3: JSON with ONLY "teacherSummaries" (exactly 3 entries).',
      userPrompt: base + '\n\n=== SEGMENT 3/3 — TEACHER SUMMARIES ===\n' + SEGMENT_DEPTH_NUDGE + '\nReturn ONLY teacherSummaries array (each body = rich multi-sentence Hebrew).',
      callOptions: { max_tokens: CHUNK_MAX_TOKENS_COMPACT },
    },
  ];
}

function buildTopicSynthesisChunkSegments(systemContent, userPromptBase) {
  const base = userPromptBase;
  return [
    {
      id: 'topic_web_research',
      keys: ['webResearch'],
      systemPrompt: systemContent + '\nSEGMENT 1/2: JSON with ONLY "webResearch" object.',
      userPrompt: base + '\n\n=== SEGMENT 1/2 — TOPIC ESSENCE OVERVIEW ===\n' + SEGMENT_DEPTH_NUDGE + '\nReturn ONLY webResearch (rich summary and highlights).',
      callOptions: { max_tokens: CHUNK_MAX_TOKENS_COMPACT },
    },
    {
      id: 'topic_block_theory',
      keys: ['blockPlan'],
      systemPrompt: systemContent + '\nSEGMENT 2/2: JSON with ONLY "blockPlan" containing theory (title + sections) — no other blockPlan keys.',
      userPrompt: base + '\n\n=== SEGMENT 2/2 — BLOCK THEORY SECTIONS ===\n' + SEGMENT_DEPTH_NUDGE + '\nReturn ONLY blockPlan.theory depth sections (2-4 sections, full HTML paragraphs).',
      callOptions: { max_tokens: CHUNK_MAX_TOKENS_DEEP },
    },
  ];
}

module.exports = {
  CHUNK_PER_REQUEST_WALL_MS,
  CHUNK_NETWORK_RETRY_ATTEMPTS,
  CHUNK_DEFAULT_MAX_TOKENS,
  CHUNK_MAX_TOKENS_DEEP,
  CHUNK_MAX_TOKENS_RESOURCES,
  CHUNK_MAX_TOKENS_COMPACT,
  withChunkNetworkRetry,
  deepMergeJsonParts,
  runSequentialResearchChunks,
  invokePerplexityChunk,
  buildPhaseCChunkSegments,
  buildGradeSynthesisChunkSegments,
  buildTopicSynthesisChunkSegments,
};
