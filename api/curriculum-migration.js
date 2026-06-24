/**
 * Silent self-healing migration for legacy / empty phase_c curriculum tables.
 * Regenerates ONLY the 15-day curriculum in 3 chunked Perplexity calls, preserves theory/inspiration.
 */
const cacheDb = require('./cache');
const perplexityClient = require('./perplexity-client');
const jsonRepair = require('./json-repair');
const archiveCoerce = require('../archive-coerce');
const waldorfCurriculumPrompts = require('./waldorf-curriculum-prompts');

const CURRICULUM_CHUNKS = [
  { start: 1, end: 5 },
  { start: 6, end: 10 },
  { start: 11, end: 15 },
];

const CURRICULUM_INLINE_EXPANSION_INSTRUCTION = waldorfCurriculumPrompts.CURRICULUM_INLINE_EXPANSION_INSTRUCTION;
const WALDORF_CURRICULUM_DEPTH_INSTRUCTION = waldorfCurriculumPrompts.WALDORF_CURRICULUM_DEPTH_INSTRUCTION;

const migrationInflight = new Map();
const regenInflight = new Map();

function buildTopicRegenInflightKey(topicBody) {
  return cacheDb.buildCacheKey({
    phase: 'topic',
    topic: topicBody.topic,
    currentGrade: topicBody.currentGrade ?? topicBody.gradeId,
    gradeId: topicBody.gradeId || topicBody.currentGrade,
  });
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function topicHasMigratableEssence(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.webResearch && String(data.webResearch.summary || data.webResearch.rawContent || '').trim()) {
    return true;
  }
  const bp = data.blockPlan;
  if (!bp || typeof bp !== 'object') return false;
  if (String(bp.rawContent || '').trim()) return true;
  if (archiveCoerce.isMeaningfulInspiration(bp.inspiration)) return true;
  const theory = bp.theory;
  if (theory && Array.isArray(theory.sections)) {
    return theory.sections.some(function (sec) {
      return sec && String(sec.content || sec.heading || '').trim();
    });
  }
  return false;
}

function topicPayloadNeedsCurriculumMigration(data) {
  if (!topicHasMigratableEssence(data)) return false;
  return cacheDb.isPhaseCCurriculumPayloadLegacy(data);
}

/** True when topic has essence but no serve-ready deep 15-day curriculum (missing, stripped, or legacy). */
function topicNeedsCurriculumRegeneration(data) {
  if (!topicHasMigratableEssence(data)) return false;
  return !cacheDb.isPhaseCCurriculumServeReady(data);
}

function extractTheoryEssenceFromTopicData(data) {
  if (!data || typeof data !== 'object') return '';
  const chunks = [];
  if (data.webResearch) {
    const summary = stripHtml(data.webResearch.summary || data.webResearch.rawContent || '');
    if (summary) chunks.push('סיכום מחקר נושא:\n' + summary);
  }
  const bp = data.blockPlan;
  if (bp && bp.theory && Array.isArray(bp.theory.sections)) {
    bp.theory.sections.forEach(function (sec) {
      if (!sec) return;
      const content = stripHtml(sec.content || '');
      if (content) chunks.push(String(sec.heading || 'תיאוריה') + ':\n' + content);
    });
  }
  if (bp && archiveCoerce.isMeaningfulInspiration(bp.inspiration)) {
    const insp = bp.inspiration;
    if (String(insp.rawContent || '').trim()) {
      chunks.push('השראה:\n' + stripHtml(insp.rawContent));
    }
  }
  if (bp && String(bp.rawContent || '').trim()) {
    chunks.push(stripHtml(bp.rawContent));
  }
  return chunks.filter(Boolean).join('\n\n').slice(0, 6000);
}

function buildResearchBlock(rawPayload) {
  if (!rawPayload || !String(rawPayload.content || '').trim()) return '';
  const citations = Array.isArray(rawPayload.citations) ? rawPayload.citations : [];
  return (
    '\n=== PERPLEXITY WEB RESEARCH (PRIMARY FACTUAL SOURCE — MANDATORY) ===\n' +
    String(rawPayload.content).trim() + '\n' +
    (citations.length
      ? '\nReference URLs from Perplexity:\n' + citations.map(function (url, i) {
        return (i + 1) + '. ' + url;
      }).join('\n') + '\n'
      : '') +
    '=== END PERPLEXITY WEB RESEARCH ===\n\n'
  );
}

async function ensureTopicResearchBlock(topicBody, options) {
  const forceFresh = !!(options && (options.forceFresh || options.skipCache));
  if (forceFresh) {
    await cacheDb.deleteRawPerplexityCache(topicBody);
    console.log('[curriculum-migration] perplexity_raw bypass — live web search for', topicBody.topic);
  } else {
    const cachedRaw = await cacheDb.getRawPerplexityCache(topicBody);
    if (cachedRaw && String(cachedRaw.content || '').trim()) {
      return cachedRaw;
    }
  }

  const gradeLabel = topicBody.gradeLabel || '';
  const gradeId = topicBody.currentGrade || topicBody.gradeId || '';
  const topic = String(topicBody.topic || '').trim();
  const searchUser =
    'Perform a factual web search on Waldorf/Steiner pedagogy for this main-lesson block.\n' +
    'Grade: ' + gradeLabel + ' (id: ' + gradeId + ')\n' +
    'Block topic: «' + topic + '»\n\n' +
    'Return a detailed Hebrew research report on classroom practice, main-lesson flow, art integration, and developmental context for a 15-day period plan.';

  const searchResult = await perplexityClient.callPerplexitySearch({
    messages: [
      {
        role: 'system',
        content: 'You are a factual Waldorf pedagogy research assistant. Perform live web search and return accurate Hebrew pedagogical research.',
      },
      { role: 'user', content: searchUser },
    ],
    stream: true,
  });

  const rawPayload = {
    content: searchResult.content,
    citations: searchResult.citations || [],
    searchedAt: new Date().toISOString(),
    topic: topic,
    gradeId: gradeId,
  };

  try {
    await cacheDb.setRawPerplexityCache(topicBody, rawPayload);
  } catch (saveErr) {
    console.warn('[curriculum-migration] raw Perplexity save failed:', saveErr.message || saveErr);
  }

  return rawPayload;
}

function buildChunkCurriculumPrompt(topicBody, dayStart, dayEnd, theoryEssence, researchBlock) {
  const topic = String(topicBody.topic || '').replace(/"/g, '');
  const dayCount = dayEnd - dayStart + 1;
  const theoryBlock = theoryEssence
    ? '\nPHASE B ESSENCE + ARCHIVE CONTEXT (preserve alignment — do NOT duplicate verbatim):\n' + theoryEssence + '\n'
    : '';

  return (
    researchBlock +
    theoryBlock +
    '\n=== PHASE C CURRICULUM CHUNK (LIVE GENERATION — ALL GRADES 1–8) ===\n' +
    'Synthesize ONLY the «curriculum» tab for Waldorf block «' + topic + '» at grade «' + (topicBody.gradeLabel || '') + '».\n' +
    'currentGrade: ' + (topicBody.currentGrade || topicBody.gradeId || '') + '\n' +
    'Generate EXACTLY ' + dayCount + ' day objects for days ' + dayStart + ' through ' + dayEnd + ' ONLY.\n' +
    'Day numbers MUST be ' + dayStart + ', ' + (dayStart + 1) + ', … ' + dayEnd + ' — no other days.\n' +
    waldorfCurriculumPrompts.buildGlobalCurriculumUserPromptBlocks() +
    'CRITICAL — blockPlan.curriculum MUST be a JSON ARRAY of exactly ' + dayCount + ' objects.\n' +
    'Each day object MUST use: "day", "topic", "content" (4-6 rich Hebrew sentences), "art" (2-4 Hebrew sentences), "hint" (optional), "contentExpansion" (mandatory).\n' +
    'FORBIDDEN: blockPlan.theory, blockPlan.inspiration, blockPlan.sources, gallery, URLs.\n' +
    'Return JSON only — reply MUST start with { and end with }:\n' +
    '{\n' +
    '  "blockPlan": {\n' +
    '    "curriculum": [{ "day": ' + dayStart + ', "topic": "Hebrew", "content": "...", "art": "...", "hint": "", "contentExpansion": { "classroomImplementation": "...", "practicalSteps": ["..."], "parentCommunityAspects": "...", "inspirationReferences": ["..."] } }]\n' +
    '  }\n' +
    '}\n' +
    '=== END CURRICULUM CHUNK ===\n'
  );
}

function parseChunkCurriculumRows(raw, dayStart, dayEnd) {
  const parsed = jsonRepair.cleanAndParseJSON(raw, {
    phase: 'phase_c',
    context: { phase: 'phase_c', cTab: 'curriculum' },
    fallbackOnError: false,
    unwrap: true,
  });
  const rows = archiveCoerce.coerceCurriculumRows(
    parsed && parsed.blockPlan && parsed.blockPlan.curriculum
  );
  const filtered = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const dayNum = Number(row.day);
    if (dayNum >= dayStart && dayNum <= dayEnd) filtered.push(row);
  }
  return filtered;
}

function countUpgradedRows(rows) {
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    if (cacheDb.isPhaseCCurriculumDayUpgraded(rows[i])) count++;
  }
  return count;
}

function filterChunkRows(rows, dayStart, dayEnd) {
  const filtered = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const dayNum = Number(row.day);
    if (dayNum >= dayStart && dayNum <= dayEnd) filtered.push(row);
  }
  return filtered;
}

async function persistCurriculumChunkToCache(topicBody, dayStart, dayEnd, rows) {
  const chunkBody = cacheDb.buildCurriculumChunkCacheBody(topicBody, dayStart, dayEnd);
  if (!chunkBody || !rows || !rows.length) return false;
  const preserved = rows
    .map(archiveCoerce.preserveCurriculumRowForStorage)
    .filter(Boolean);
  try {
    await cacheDb.setCachedResult(chunkBody, cacheDb.stampPerplexityOnlyMetadata({
      blockPlan: { curriculum: preserved },
    }));
    console.log(
      '[curriculum-migration] chunk persisted to cache',
      dayStart + '-' + dayEnd,
      'for',
      String(topicBody.topic || '').trim()
    );
    return true;
  } catch (saveErr) {
    console.warn('[curriculum-migration] chunk persist failed:', saveErr.message || saveErr);
    return false;
  }
}

async function loadCurriculumRowsFromChunkCache(topicBody, dayStart, dayEnd) {
  const chunkBody = cacheDb.buildCurriculumChunkCacheBody(topicBody, dayStart, dayEnd);
  if (!chunkBody) return null;
  const cached = await cacheDb.getCachedResult(chunkBody, { requireEnhanced: false });
  const cachedRows = cached && cached.data && cached.data.blockPlan
    ? archiveCoerce.coerceCurriculumRows(cached.data.blockPlan.curriculum)
    : [];
  const filtered = filterChunkRows(cachedRows, dayStart, dayEnd);
  const expected = dayEnd - dayStart + 1;
  if (countUpgradedRows(filtered) < expected) return null;
  return filtered;
}

async function assembleCurriculumFromChunkCaches(topicBody) {
  const allRows = [];
  for (let c = 0; c < CURRICULUM_CHUNKS.length; c++) {
    const chunk = CURRICULUM_CHUNKS[c];
    const rows = await loadCurriculumRowsFromChunkCache(topicBody, chunk.start, chunk.end);
    if (!rows || !rows.length) return null;
    rows.forEach(function (row) { allRows.push(row); });
  }
  return allRows.length >= cacheDb.PHASE_C_CURRICULUM_REQUIRED_DAYS ? allRows : null;
}

async function measureCurriculumChunkProgress(topicBody) {
  let chunksComplete = 0;
  let upgradedDays = 0;
  for (let c = 0; c < CURRICULUM_CHUNKS.length; c++) {
    const chunk = CURRICULUM_CHUNKS[c];
    const rows = await loadCurriculumRowsFromChunkCache(topicBody, chunk.start, chunk.end);
    const expected = chunk.end - chunk.start + 1;
    if (rows && rows.length) {
      const upgraded = countUpgradedRows(rows);
      upgradedDays += upgraded;
      if (upgraded >= expected) chunksComplete++;
    }
  }
  return {
    chunksComplete: chunksComplete,
    chunksTotal: CURRICULUM_CHUNKS.length,
    upgradedDays: upgradedDays,
    requiredDays: cacheDb.PHASE_C_CURRICULUM_REQUIRED_DAYS,
  };
}

/**
 * Lightweight cache probe — no Perplexity. Stitches chunk caches into phase_c when complete.
 */
async function probeServeReadyPhaseCCurriculum(body) {
  const topic = String((body && body.topic) || '').trim();
  const gradeId = String((body && (body.currentGrade ?? body.gradeId)) || '').trim();
  if (!topic || !gradeId) {
    const err = new Error('חסרים נושא וכיתה לבדיקת תכנון התקופה');
    err.statusCode = 400;
    throw err;
  }

  const topicBody = {
    phase: 'topic',
    topic: topic,
    currentGrade: gradeId,
    gradeId: gradeId,
    gradeLabel: (body && body.gradeLabel) || null,
  };
  const phaseBody = Object.assign({}, topicBody, {
    phase: 'phase_c',
    cTab: 'curriculum',
  });

  const cached = await cacheDb.getCachedResult(phaseBody, { requireEnhanced: false });
  if (cached && cached.data && cacheDb.isPhaseCCurriculumServeReady(cached.data)) {
    return {
      ready: true,
      data: cached.data,
      meta: Object.assign({}, cached.meta || {}, {
        fromCache: true,
        source: (cached.meta && cached.meta.source) || 'supabase',
        upgradedDays: cacheDb.countValidPhaseCCurriculumDays(cached.data),
      }),
      progress: null,
    };
  }

  const stitched = await assembleCurriculumFromChunkCaches(topicBody);
  if (stitched && countUpgradedRows(stitched) >= cacheDb.PHASE_C_CURRICULUM_REQUIRED_DAYS) {
    let topicData = null;
    try {
      const topicCached = await cacheDb.getCachedResult(topicBody, { requireEnhanced: false });
      if (topicCached && topicCached.data) topicData = topicCached.data;
    } catch (topicReadErr) {
      console.warn('[curriculum-migration] probe topic read failed:', topicReadErr.message || topicReadErr);
    }
    topicData = topicData || { blockPlan: {} };
    const merged = await persistMigratedCurriculum(topicBody, topicData, stitched);
    const phasePayload = cacheDb.stampPerplexityOnlyMetadata({
      blockPlan: { curriculum: merged.blockPlan.curriculum },
    });
    return {
      ready: true,
      data: phasePayload,
      meta: {
        fromCache: true,
        source: 'chunk_stitch',
        upgradedDays: countUpgradedRows(stitched),
        curriculumRegenerated: true,
      },
      progress: null,
    };
  }

  const progress = await measureCurriculumChunkProgress(topicBody);
  return {
    ready: false,
    data: null,
    meta: { fromCache: true, source: 'curriculum_probe' },
    progress: progress,
  };
}

async function fetchCurriculumChunk(topicBody, apiKey, dayStart, dayEnd, researchBlock, theoryEssence, options) {
  const forceFresh = !!(options && (options.forceFresh || options.skipCache));
  const topic = String(topicBody.topic || '').trim();
  const phaseBody = Object.assign({}, topicBody, {
    phase: 'phase_c',
    cTab: 'curriculum',
    currentGrade: topicBody.currentGrade ?? topicBody.gradeId,
    gradeId: topicBody.gradeId || topicBody.currentGrade,
  });

  if (forceFresh) {
    const phaseKey = cacheDb.buildCacheKey(phaseBody);
    if (phaseKey) await cacheDb.deleteCachedRowByKey(phaseKey);
    await cacheDb.deleteCurriculumChunkCaches(topicBody, dayStart, dayEnd);
    console.log(
      '[curriculum-migration] chunk cache bypass — LIVE Perplexity',
      dayStart + '-' + dayEnd,
      'for',
      topic
    );
  } else {
    const chunkBody = cacheDb.buildCurriculumChunkCacheBody(topicBody, dayStart, dayEnd);
    if (chunkBody) {
      const cached = await cacheDb.getCachedResult(chunkBody, { requireEnhanced: false });
      const cachedRows = cached && cached.data && cached.data.blockPlan
        ? archiveCoerce.coerceCurriculumRows(cached.data.blockPlan.curriculum)
        : [];
      const filtered = [];
      for (let i = 0; i < cachedRows.length; i++) {
        const row = cachedRows[i];
        if (!row || typeof row !== 'object') continue;
        const dayNum = Number(row.day);
        if (dayNum >= dayStart && dayNum <= dayEnd) filtered.push(row);
      }
      const expected = dayEnd - dayStart + 1;
      if (countUpgradedRows(filtered) >= expected) {
        console.log('[curriculum-migration] chunk cache HIT', dayStart + '-' + dayEnd, 'for', topic);
        return filtered;
      }
    }
  }

  const prompt = buildChunkCurriculumPrompt(topicBody, dayStart, dayEnd, theoryEssence, researchBlock);
  const system = waldorfCurriculumPrompts.buildCurriculumChunkSystemPrompt();

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await perplexityClient.callPerplexityChat({
        apiKey: apiKey,
        temperature: attempt > 1 ? 0.2 : 0.35,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      });
      console.log(
        '[curriculum-migration] LIVE Perplexity response chunk',
        dayStart + '-' + dayEnd,
        'bytes=',
        String(raw || '').length
      );
      const rows = parseChunkCurriculumRows(raw, dayStart, dayEnd);
      const expected = dayEnd - dayStart + 1;
      const upgraded = countUpgradedRows(rows);
      if (upgraded >= expected) {
        console.log(
          '[curriculum-migration] chunk VALIDATED',
          dayStart + '-' + dayEnd,
          'upgraded=' + upgraded + '/' + expected
        );
        await persistCurriculumChunkToCache(topicBody, dayStart, dayEnd, rows);
        return rows;
      }
      console.warn(
        '[curriculum-migration] chunk validation FAILED',
        dayStart + '-' + dayEnd,
        'upgraded=' + upgraded + '/' + expected,
        'parsedRows=' + rows.length
      );
      lastErr = new Error('chunk days ' + dayStart + '-' + dayEnd + ' failed validation (got ' + upgraded + '/' + expected + ')');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('curriculum chunk failed');
}

function mergeCurriculumIntoTopicPayload(topicData, curriculumRows) {
  let merged;
  try {
    merged = JSON.parse(JSON.stringify(topicData));
  } catch (cloneErr) {
    merged = Object.assign({}, topicData);
  }
  if (!merged.blockPlan || typeof merged.blockPlan !== 'object') merged.blockPlan = {};
  const preserved = curriculumRows
    .map(archiveCoerce.preserveCurriculumRowForStorage)
    .filter(Boolean)
    .sort(function (a, b) { return (a.day || 0) - (b.day || 0); });
  merged.blockPlan.curriculum = preserved;
  merged.blockPlan.days = preserved.slice();
  return cacheDb.coerceArchiveLessonResultData(merged) || merged;
}

async function purgeLegacyCurriculumCaches(topicBody, options) {
  await cacheDb.purgeRegenerationCaches(topicBody);
}

async function persistMigratedCurriculum(topicBody, topicData, curriculumRows) {
  const merged = mergeCurriculumIntoTopicPayload(topicData, curriculumRows);
  const phaseBody = Object.assign({}, topicBody, {
    phase: 'phase_c',
    cTab: 'curriculum',
    currentGrade: topicBody.currentGrade ?? topicBody.gradeId,
  });
  const phasePayload = cacheDb.stampPerplexityOnlyMetadata({
    blockPlan: { curriculum: merged.blockPlan.curriculum },
  });

  await cacheDb.setCachedResult(phaseBody, phasePayload);
  await cacheDb.setCachedResult(
    Object.assign({}, topicBody, { phase: 'topic' }),
    cacheDb.stampPerplexityOnlyMetadata(merged)
  );

  return merged;
}

async function regenerateTopicCurriculumChunked(topicBody, topicData, options) {
  const inflightKey = buildTopicRegenInflightKey(topicBody);
  if (inflightKey && regenInflight.has(inflightKey)) {
    console.log('[curriculum-migration] regen join — awaiting in-flight pipeline for', topicBody.topic);
    return regenInflight.get(inflightKey);
  }

  const runPromise = regenerateTopicCurriculumChunkedInner(topicBody, topicData, options);
  if (inflightKey) regenInflight.set(inflightKey, runPromise);
  try {
    return await runPromise;
  } finally {
    if (inflightKey) regenInflight.delete(inflightKey);
  }
}

async function regenerateTopicCurriculumChunkedInner(topicBody, topicData, options) {
  const apiKey = perplexityClient.resolveApiKey();
  if (!apiKey) {
    console.warn('[curriculum-migration] skip — PERPLEXITY_API_KEY not configured');
    return null;
  }

  const topic = String(topicBody.topic || '').trim();
  const gradeId = String(topicBody.currentGrade ?? topicBody.gradeId ?? '').trim();
  if (!topic || !gradeId) return null;

  console.log('[curriculum-migration] regen start:', topic, '@', gradeId);

  const regenOptions = Object.assign({ forceFresh: true, skipCache: true }, options || {});
  await purgeLegacyCurriculumCaches(topicBody, regenOptions);

  console.log('[curriculum-migration] stage 1/4 — web research');
  const theoryEssence = extractTheoryEssenceFromTopicData(topicData);
  const researchRaw = await ensureTopicResearchBlock(topicBody, regenOptions);
  const researchBlock = buildResearchBlock(researchRaw);
  console.log(
    '[curriculum-migration] stage 1/4 complete — research chars=',
    String(researchRaw && researchRaw.content || '').length
  );

  const phaseBody = Object.assign({}, topicBody, {
    phase: 'phase_c',
    cTab: 'curriculum',
    currentGrade: gradeId,
    gradeId: gradeId,
  });

  const allRows = [];
  const chunkOptions = regenOptions;
  for (let c = 0; c < CURRICULUM_CHUNKS.length; c++) {
    const chunk = CURRICULUM_CHUNKS[c];
    console.log(
      '[curriculum-migration] stage',
      (c + 2) + '/4 — chunk',
      chunk.start + '-' + chunk.end,
      'for',
      topic
    );
    let rows;
    try {
      rows = await fetchCurriculumChunk(
        phaseBody,
        apiKey,
        chunk.start,
        chunk.end,
        researchBlock,
        theoryEssence,
        chunkOptions
      );
    } catch (chunkErr) {
      console.error(
        '[curriculum-migration] chunk FAILED',
        chunk.start + '-' + chunk.end,
        'for',
        topic,
        ':',
        chunkErr.message || chunkErr
      );
      throw chunkErr;
    }
    if (!rows || !rows.length) {
      const emptyErr = new Error('curriculum chunk ' + chunk.start + '-' + chunk.end + ' returned no rows');
      console.error('[curriculum-migration]', emptyErr.message, 'for', topic);
      throw emptyErr;
    }
    rows.forEach(function (row) { allRows.push(row); });
    console.log(
      '[curriculum-migration] stage',
      (c + 2) + '/4 complete — stitched rows=',
      allRows.length
    );
  }

  const upgradedCount = countUpgradedRows(allRows);
  console.log('[curriculum-migration] stage 4/4 — persist', upgradedCount + '/' + cacheDb.PHASE_C_CURRICULUM_REQUIRED_DAYS);
  if (upgradedCount < cacheDb.PHASE_C_CURRICULUM_REQUIRED_DAYS) {
    console.warn(
      '[curriculum-migration] regen incomplete:',
      topic,
      'upgradedDays=' + upgradedCount + '/' + cacheDb.PHASE_C_CURRICULUM_REQUIRED_DAYS
    );
    return null;
  }

  const merged = await persistMigratedCurriculum(topicBody, topicData, allRows);
  console.log('[curriculum-migration] regen complete:', topic, 'days=' + upgradedCount);
  return merged;
}

async function healTopicCurriculumIfNeeded(topicBody, topicData, options) {
  if (!topicNeedsCurriculumRegeneration(topicData)) {
    return topicData;
  }

  const cacheKey = buildTopicRegenInflightKey(topicBody);
  if (!cacheKey) return topicData;

  if (migrationInflight.has(cacheKey)) {
    return migrationInflight.get(cacheKey);
  }

  const healPromise = regenerateTopicCurriculumChunked(
    topicBody,
    topicData,
    Object.assign({ forceFresh: true, skipCache: true }, options || {})
  )
    .then(function (healed) {
      return healed || topicData;
    })
    .catch(function (err) {
      console.error('[curriculum-migration] silent regen failed:', err.message || err);
      return topicData;
    })
    .finally(function () {
      migrationInflight.delete(cacheKey);
    });

  migrationInflight.set(cacheKey, healPromise);
  return healPromise;
}

module.exports = {
  topicPayloadNeedsCurriculumMigration,
  topicNeedsCurriculumRegeneration,
  topicHasMigratableEssence,
  healTopicCurriculumIfNeeded,
  regenerateTopicCurriculumChunked,
  probeServeReadyPhaseCCurriculum,
  assembleCurriculumFromChunkCaches,
  loadCurriculumRowsFromChunkCache,
  extractTheoryEssenceFromTopicData,
  CURRICULUM_CHUNKS,
  WALDORF_CURRICULUM_DEPTH_INSTRUCTION,
};
