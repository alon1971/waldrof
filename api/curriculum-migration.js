/**
 * Silent self-healing migration for legacy / empty phase_c curriculum tables.
 * Regenerates ONLY the 15-day curriculum in 3 chunked Perplexity calls, preserves theory/inspiration.
 */
const cacheDb = require('./cache');
const perplexityClient = require('./perplexity-client');
const jsonRepair = require('./json-repair');
const archiveCoerce = require('../archive-coerce');

const CURRICULUM_CHUNKS = [
  { start: 1, end: 5 },
  { start: 6, end: 10 },
  { start: 11, end: 15 },
];

const EXPANSION_OBJECT_SCHEMA =
  '{ "classroomImplementation": "1-2 Hebrew paragraphs: practical in-class implementation", ' +
  '"parentCommunityAspects": "Hebrew paragraph on parents/community when relevant", ' +
  '"practicalSteps": ["4-8 concrete classroom steps for the teacher"], ' +
  '"inspirationReferences": ["3-6 named books/articles/Waldorf projects — NO URLs"], ' +
  '"expansionHtml": "<p>Optional rich Hebrew HTML</p>" }';

const CURRICULUM_INLINE_EXPANSION_INSTRUCTION =
  '\n=== CURRICULUM DAY INLINE EXPANSION — «הרחבה ואספקטים פרקטיים» (MANDATORY) ===\n' +
  'Each curriculum day MUST include a complete contentExpansion object (and optionally artExpansion, hintExpansion).\n' +
  'Shape: ' + EXPANSION_OBJECT_SCHEMA + '\n' +
  'FORBIDDEN: URLs, Pinterest phrases, gallery pins, enrichment_links, or code blocks.\n' +
  '=== END CURRICULUM INLINE EXPANSION ===\n';

const migrationInflight = new Map();

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

async function ensureTopicResearchBlock(topicBody) {
  const cachedRaw = await cacheDb.getRawPerplexityCache(topicBody);
  if (cachedRaw && String(cachedRaw.content || '').trim()) {
    return cachedRaw;
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
    '\n=== PHASE C CURRICULUM CHUNK (SILENT ARCHIVE MIGRATION) ===\n' +
    'Synthesize ONLY the «curriculum» tab for Waldorf block «' + topic + '» at grade «' + (topicBody.gradeLabel || '') + '».\n' +
    'currentGrade: ' + (topicBody.currentGrade || topicBody.gradeId || '') + '\n' +
    'Generate EXACTLY ' + dayCount + ' day objects for days ' + dayStart + ' through ' + dayEnd + ' ONLY.\n' +
    'Day numbers MUST be ' + dayStart + ', ' + (dayStart + 1) + ', … ' + dayEnd + ' — no other days.\n' +
    CURRICULUM_INLINE_EXPANSION_INSTRUCTION +
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

async function fetchCurriculumChunk(topicBody, apiKey, dayStart, dayEnd, researchBlock, theoryEssence) {
  const prompt = buildChunkCurriculumPrompt(topicBody, dayStart, dayEnd, theoryEssence, researchBlock);
  const system =
    'You are an expert Waldorf curriculum designer. Write pedagogical content in Hebrew. ' +
    'Ground claims in the provided web research. Return raw JSON only — no markdown fences.';

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
      const rows = parseChunkCurriculumRows(raw, dayStart, dayEnd);
      const expected = dayEnd - dayStart + 1;
      if (countUpgradedRows(rows) >= expected) {
        return rows;
      }
      lastErr = new Error('chunk days ' + dayStart + '-' + dayEnd + ' failed validation (got ' + countUpgradedRows(rows) + '/' + expected + ')');
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

async function purgeLegacyCurriculumCaches(topicBody) {
  const phaseBody = {
    phase: 'phase_c',
    cTab: 'curriculum',
    topic: topicBody.topic,
    currentGrade: topicBody.currentGrade ?? topicBody.gradeId,
    gradeId: topicBody.gradeId || topicBody.currentGrade,
    gradeLabel: topicBody.gradeLabel || null,
  };
  const phaseKey = cacheDb.buildCacheKey(phaseBody);
  if (phaseKey) await cacheDb.deleteCachedRowByKey(phaseKey);
  await cacheDb.stripLegacyCurriculumFromTopicRow(phaseBody);
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
  const apiKey = perplexityClient.resolveApiKey();
  if (!apiKey) {
    console.warn('[curriculum-migration] skip — PERPLEXITY_API_KEY not configured');
    return null;
  }

  const topic = String(topicBody.topic || '').trim();
  const gradeId = String(topicBody.currentGrade ?? topicBody.gradeId ?? '').trim();
  if (!topic || !gradeId) return null;

  console.log('[curriculum-migration] silent regen start:', topic, '@', gradeId);

  await purgeLegacyCurriculumCaches(topicBody);

  const theoryEssence = extractTheoryEssenceFromTopicData(topicData);
  const researchRaw = await ensureTopicResearchBlock(topicBody);
  const researchBlock = buildResearchBlock(researchRaw);

  const phaseBody = Object.assign({}, topicBody, {
    phase: 'phase_c',
    cTab: 'curriculum',
    currentGrade: gradeId,
    gradeId: gradeId,
  });

  const allRows = [];
  for (let c = 0; c < CURRICULUM_CHUNKS.length; c++) {
    const chunk = CURRICULUM_CHUNKS[c];
    console.log('[curriculum-migration] chunk', chunk.start + '-' + chunk.end, 'for', topic);
    const rows = await fetchCurriculumChunk(
      phaseBody,
      apiKey,
      chunk.start,
      chunk.end,
      researchBlock,
      theoryEssence
    );
    rows.forEach(function (row) { allRows.push(row); });
  }

  const upgradedCount = countUpgradedRows(allRows);
  if (upgradedCount < cacheDb.PHASE_C_CURRICULUM_REQUIRED_DAYS) {
    console.warn(
      '[curriculum-migration] regen incomplete:',
      topic,
      'upgradedDays=' + upgradedCount + '/' + cacheDb.PHASE_C_CURRICULUM_REQUIRED_DAYS
    );
    return null;
  }

  const merged = await persistMigratedCurriculum(topicBody, topicData, allRows);
  console.log('[curriculum-migration] silent regen complete:', topic, 'days=' + upgradedCount);
  return merged;
}

async function healTopicCurriculumIfNeeded(topicBody, topicData, options) {
  if (!topicPayloadNeedsCurriculumMigration(topicData)) {
    return topicData;
  }

  const cacheKey = cacheDb.buildCacheKey({
    phase: 'topic',
    topic: topicBody.topic,
    currentGrade: topicBody.currentGrade ?? topicBody.gradeId,
    gradeId: topicBody.gradeId || topicBody.currentGrade,
  });
  if (!cacheKey) return topicData;

  if (migrationInflight.has(cacheKey)) {
    return migrationInflight.get(cacheKey);
  }

  const healPromise = regenerateTopicCurriculumChunked(topicBody, topicData, options || {})
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
  topicHasMigratableEssence,
  healTopicCurriculumIfNeeded,
  regenerateTopicCurriculumChunked,
  extractTheoryEssenceFromTopicData,
  CURRICULUM_CHUNKS,
};
