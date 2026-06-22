#!/usr/bin/env node
/**
 * One-time migration: upgrade cached Waldorf lesson plans in Supabase.
 *
 * Fetches rows from cached_results, sends existing result_data to Gemini (stable v1 REST API)
 * for deep pedagogical enrichment, then PATCHes the upgraded JSON back to Supabase.
 *
 * Usage:
 *   node scripts/upgradeArchive.js --dry-run
 *   node scripts/upgradeArchive.js --phase topic --limit 5
 *   node scripts/upgradeArchive.js --phase grade --cache-key <sha256>
 *   node scripts/upgradeArchive.js --skip-upgraded --delay 3000
 *
 * Env (.env):
 *   SUPABASE_URL or SUPABASE_URI
 *   SUPABASE_SERVICE_ROLE_KEY (required for writes)
 *   GEMINI_API_KEY
 */
'use strict';

console.error(
  '[upgradeArchive] DISABLED — Gemini archive writes are permanently blocked.\n' +
  'Use Perplexity generation (api/generate.js) or rollbackArchiveToTimestamp.js to restore pre-Gemini state.'
);
process.exit(1);

const fs = require('fs');
const path = require('path');
const env = require('../api/env');
const cacheDb = require('../api/cache');
const jsonRepair = require('../api/json-repair');

const TABLE = cacheDb.TABLE_NAME;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const UPGRADE_VERSION = '2025-06-archive-v1';
const PAGE_SIZE = 50;
const MAX_PARSE_ATTEMPTS = 2;
const MAX_API_RETRIES = 6;

function parseRetryAfterMs(message) {
  const match = String(message || '').match(/retry in ([0-9.]+)s/i);
  if (!match) return 0;
  const seconds = parseFloat(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.ceil(seconds * 1000) + 500;
}

function isRetriableGeminiError(err) {
  const msg = err instanceof Error ? err.message : String(err || '');
  return /Gemini v1 error (429|503)\b/.test(msg) || /high demand/i.test(msg) || /quota/i.test(msg);
}

const JSON_ONLY_INSTRUCTION =
  'Return ONLY the raw, valid JSON object matching the requested schema. ' +
  'Do not include markdown fences or any text before or after the JSON object.';

const UPGRADE_SYSTEM_PROMPT =
  'You are an expert Waldorf / Steiner-Waldorf pedagogy researcher performing a ONE-TIME ARCHIVE UPGRADE. ' +
  'Your task is to take EXISTING cached lesson content (provided as raw JSON) and transform it into a DEEP, RICH, ' +
  'FULLY STRUCTURED Waldorf pedagogical lesson plan in the exact output schema requested. ' +
  'Preserve the original topic, grade level, and every accurate pedagogical fact from the source. ' +
  'Expand thin, legacy, or incomplete fields into rich Hebrew pedagogical prose grounded in authentic Waldorf practice: ' +
  'child development (body/soul/spirit), main lesson blocks, biography, artistic integration, and Steiner/GA fidelity. ' +
  'Do NOT invent citations — list source names only, never URLs. ' +
  'Write all pedagogical content in Hebrew. ' +
  'Never use LaTeX or math markup. ' +
  JSON_ONLY_INSTRUCTION;

function parseArgs(argv) {
  const opts = {
    phase: 'all',
    limit: 0,
    offset: 0,
    delayMs: 4500,
    dryRun: false,
    skipUpgraded: false,
    cacheKey: '',
    model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--phase' && argv[i + 1]) { opts.phase = argv[++i]; continue; }
    if (arg === '--limit' && argv[i + 1]) { opts.limit = parseInt(argv[++i], 10) || 0; continue; }
    if (arg === '--offset' && argv[i + 1]) { opts.offset = parseInt(argv[++i], 10) || 0; continue; }
    if (arg === '--delay' && argv[i + 1]) { opts.delayMs = parseInt(argv[++i], 10) || opts.delayMs; continue; }
    if (arg === '--cache-key' && argv[i + 1]) { opts.cacheKey = argv[++i]; continue; }
    if (arg === '--model' && argv[i + 1]) { opts.model = argv[++i]; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--skip-upgraded') { opts.skipUpgraded = true; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
  }

  return opts;
}

function printHelp() {
  console.log(
    'Upgrade cached Waldorf lesson plans via Gemini v1 API.\n\n' +
    'Options:\n' +
    '  --phase <topic|grade|all>   Which cached_results phases to upgrade (default: all)\n' +
    '  --limit <n>                 Max rows to process (0 = no limit)\n' +
    '  --offset <n>                Skip first n matching rows\n' +
    '  --cache-key <key>           Upgrade a single row by cache_key\n' +
    '  --delay <ms>                Pause between Gemini calls (default: 2500)\n' +
    '  --model <name>              Gemini model id (default: gemini-2.5-flash)\n' +
    '  --skip-upgraded             Skip rows already tagged with _archiveUpgrade\n' +
    '  --dry-run                   Fetch and call Gemini but do not write to Supabase\n' +
    '  --help                      Show this help\n'
  );
}

function getSupabaseConfig() {
  const url = env.getSupabaseUrl();
  const key = env.getSupabaseServerKey();
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL/SUPABASE_URI and SUPABASE_SERVICE_ROLE_KEY (or anon key).');
  }
  return { url, key };
}

async function supabaseRequest(relativePath, options) {
  const cfg = getSupabaseConfig();
  const headers = Object.assign({
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
  }, options.headers || {});
  return fetch(cfg.url + relativePath, Object.assign({}, options, { headers }));
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function phasesForFilter(phaseOpt) {
  const p = String(phaseOpt || 'all').trim().toLowerCase();
  if (p === 'topic') return ['topic'];
  if (p === 'grade') return ['grade'];
  return ['topic', 'grade'];
}

function isAlreadyUpgraded(resultData) {
  const data = cacheDb.coerceCachedResultData(resultData);
  if (!data || typeof data !== 'object') return false;
  const meta = data._archiveUpgrade;
  return Boolean(meta && meta.version === UPGRADE_VERSION);
}

function stampUpgradeMetadata(resultData) {
  const data = cacheDb.coerceCachedResultData(resultData);
  if (!data || typeof data !== 'object') return resultData;
  data._archiveUpgrade = {
    version: UPGRADE_VERSION,
    upgradedAt: new Date().toISOString(),
  };
  return data;
}

function getTopicResponseSchema() {
  const bibItemSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      author: { type: 'string' },
      publisher: { type: 'string' },
      year: { type: 'string' },
      lang: { type: 'string' },
    },
  };
  const bibliographySchema = {
    type: 'object',
    properties: {
      books: { type: 'array', items: bibItemSchema },
      articles: { type: 'array', items: bibItemSchema },
      websites: { type: 'array', items: bibItemSchema },
    },
    required: ['books', 'articles', 'websites'],
  };
  const curriculumDaySchema = {
    type: 'object',
    properties: {
      day: { type: 'integer' },
      topic: { type: 'string' },
      content: { type: 'string' },
      art: { type: 'string' },
      hint: { type: 'string' },
    },
    required: ['day', 'topic', 'content', 'art'],
  };
  return {
    type: 'object',
    properties: {
      webResearch: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          summary: { type: 'string' },
          connections: { type: 'array', items: { type: 'string' } },
          highlights: { type: 'array', items: { type: 'string' } },
        },
        required: ['topic', 'summary', 'connections', 'highlights'],
      },
      blockPlan: {
        type: 'object',
        properties: {
          theory: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              sections: { type: 'array', items: { type: 'object' } },
              bibliography: bibliographySchema,
            },
            required: ['title', 'sections', 'bibliography'],
          },
          inspiration: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              global: { type: 'array', items: { type: 'object' } },
              podcast: { type: 'object' },
              narrative: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'global', 'podcast', 'narrative'],
          },
          sources: bibliographySchema,
          curriculum: {
            type: 'array',
            items: curriculumDaySchema,
            minItems: 15,
            maxItems: 15,
          },
        },
        required: ['theory', 'inspiration', 'sources', 'curriculum'],
      },
      gallery: { type: 'array', items: { type: 'object' } },
      pedagogicalResources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            label: { type: 'string' },
            source: { type: 'string' },
            snippet: { type: 'string' },
          },
          required: ['title', 'url', 'label'],
        },
      },
    },
    required: ['webResearch', 'blockPlan', 'gallery'],
  };
}

function getGradeResponseSchema() {
  const ideaSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      detail: { type: 'string' },
    },
    required: ['title', 'detail'],
  };
  const teacherSummarySchema = {
    type: 'object',
    properties: {
      author: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['author', 'title', 'body'],
  };
  return {
    type: 'object',
    properties: {
      gradeInsights: {
        type: 'object',
        properties: {
          part1AgePictureHtml: { type: 'string' },
          part1DevelopmentBullets: { type: 'array', items: { type: 'string' } },
          archivesSynthesisHtml: { type: 'string' },
          developmentBullets: { type: 'array', items: { type: 'string' } },
          part2ClassroomIdeasHtml: { type: 'string' },
          part2ClassroomIdeas: { type: 'array', items: ideaSchema },
          part3CommunityExpansionsHtml: { type: 'string' },
          part3CommunityIdeas: { type: 'array', items: ideaSchema },
          globalCurricula: { type: 'array', items: { type: 'string' } },
          typicalBlocks: { type: 'array', items: { type: 'string' } },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'part1AgePictureHtml',
          'part1DevelopmentBullets',
          'part2ClassroomIdeasHtml',
          'part2ClassroomIdeas',
          'sources',
        ],
      },
      teacherSummaries: { type: 'array', items: teacherSummarySchema },
    },
    required: ['gradeInsights'],
  };
}

function validateTopicBlockPlan(blockPlan) {
  if (!blockPlan || typeof blockPlan !== 'object') return false;
  if (!blockPlan.inspiration || typeof blockPlan.inspiration !== 'object') return false;
  if (!blockPlan.sources || typeof blockPlan.sources !== 'object') return false;
  if (!Array.isArray(blockPlan.curriculum) || blockPlan.curriculum.length !== 15) return false;
  if (!blockPlan.theory || typeof blockPlan.theory !== 'object') return false;
  for (let i = 0; i < blockPlan.curriculum.length; i++) {
    const day = blockPlan.curriculum[i];
    if (!day || typeof day !== 'object') return false;
    if (!day.topic && !day.content && !day.art) return false;
  }
  return true;
}

function validateUpgradedPayload(phase, data) {
  if (!data || typeof data !== 'object') return false;
  if (phase === 'topic') return validateTopicBlockPlan(data.blockPlan);
  if (phase === 'grade') return Boolean(cacheDb.normalizeGradeResultForCache(data));
  return false;
}

function buildUpgradeUserPrompt(row) {
  const phase = row.phase;
  const existing = cacheDb.coerceCachedResultData(row.result_data);
  const existingJson = JSON.stringify(existing, null, 2);
  const gradeLabel = row.grade_label || row.grade_id || '';
  const topic = row.topic || row.query_text || '';

  const header =
    '=== ARCHIVE UPGRADE TASK ===\n' +
    'phase: ' + phase + '\n' +
    'cache_key: ' + row.cache_key + '\n' +
    'grade_id: ' + (row.grade_id || '') + '\n' +
    'grade_label: ' + gradeLabel + '\n' +
    'topic: ' + topic + '\n' +
    'query_text: ' + (row.query_text || '') + '\n\n' +
    'EXISTING RAW CONTENT (baseline — preserve accurate facts, expand everything else):\n' +
    existingJson + '\n\n';

  if (phase === 'topic') {
    return (
      header +
      'Upgrade this legacy topic cache into a FULL Waldorf main-lesson block plan.\n' +
      'Requirements:\n' +
      '- webResearch: rich Hebrew summary, connections, highlights for grade «' + gradeLabel + '» and topic «' + topic + '»\n' +
      '- blockPlan.theory: deep Hebrew HTML sections with bibliography (books, articles, websites — no URLs)\n' +
      '- blockPlan.inspiration: global ideas, podcast themes, narrative paragraphs\n' +
      '- blockPlan.sources: same bibliography shape as theory.bibliography\n' +
      '- pedagogicalResources: verified HTTPS links from open web search — subject + Waldorf context only; empty array if none verified; label each (מאמר פדגוגי, מערך שיעור מאתר בית ספר, וכו׳)\n' +
      '- blockPlan.curriculum: EXACTLY 15 day objects (days 1–15) with day, topic, content, art, optional hint\n' +
      '- gallery: 4–8 Pinterest visual inspiration entries (Hebrew titles, search phrases in pin — no URLs)\n' +
      'Return JSON only matching the topic schema.'
    );
  }

  if (phase === 'grade') {
    return (
      header +
      'Upgrade this legacy grade cache into a FULL Waldorf grade insights portrait.\n' +
      'Requirements:\n' +
      '- gradeInsights: rich Hebrew HTML for age picture, classroom ideas, community expansions\n' +
      '- Multiple detailed bullet arrays and structured idea objects\n' +
      '- globalCurricula and typicalBlocks in Hebrew\n' +
      '- sources: 8–12 source names only (no URLs)\n' +
      '- teacherSummaries: exactly 3 plausible community folder summaries\n' +
      'Grade focus: «' + gradeLabel + '» (id: ' + (row.grade_id || '') + ').\n' +
      'Return JSON only matching the grade schema.'
    );
  }

  throw new Error('Unsupported phase: ' + phase);
}

function extractGeminiText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || !candidates[0]) return '';
  const parts = candidates[0].content && candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(function (part) {
    return part && typeof part.text === 'string' ? part.text : '';
  }).join('').trim();
}

async function callGeminiV1(systemPrompt, userPrompt, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const apiKey = env.getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const model = opts.model || DEFAULT_MODEL;
  const url = GEMINI_API_BASE + '/models/' + encodeURIComponent(model) + ':generateContent';

  const generationConfig = {
    temperature: opts.temperature != null ? opts.temperature : 0.35,
    responseMimeType: 'application/json',
  };
  if (opts.responseSchema && typeof opts.responseSchema === 'object') {
    generationConfig.responseSchema = opts.responseSchema;
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: generationConfig,
  };

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      throw new Error('Gemini v1 returned non-JSON response (' + res.status + '): ' + raw.slice(0, 300));
    }

    if (!res.ok) {
      const msg = payload.error && payload.error.message ? payload.error.message : raw.slice(0, 300);
      lastError = new Error('Gemini v1 error ' + res.status + ': ' + msg);
      if (attempt < MAX_API_RETRIES && (res.status === 429 || res.status === 503)) {
        const waitMs = parseRetryAfterMs(msg) || (attempt * 15000);
        console.warn('[upgradeArchive] Rate limited — retry %d/%d in %ds', attempt, MAX_API_RETRIES, Math.round(waitMs / 1000));
        await sleep(waitMs);
        continue;
      }
      throw lastError;
    }

    const text = extractGeminiText(payload);
    if (!text) {
      throw new Error('Gemini v1 returned empty text.');
    }
    return text;
  }

  throw lastError || new Error('Gemini v1 request failed after retries.');
}

async function upgradeRowWithGemini(row, model) {
  const phase = row.phase;
  const responseSchema = phase === 'topic' ? getTopicResponseSchema() : getGradeResponseSchema();
  const userPrompt = buildUpgradeUserPrompt(row);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS; attempt++) {
    const retrySuffix = attempt > 1
      ? '\n\nCRITICAL RETRY: Previous reply was invalid. Return raw JSON only — first char {, last char }.'
      : '';
    const text = await callGeminiV1(UPGRADE_SYSTEM_PROMPT, userPrompt + retrySuffix, {
      model: model,
      responseSchema: responseSchema,
    });

    let parsed;
    try {
      parsed = jsonRepair.parseJsonFromModel(text);
      parsed = jsonRepair.unwrapParsedModelPayload(parsed);
    } catch (err) {
      lastError = err;
      continue;
    }

    if (phase === 'grade') {
      parsed = cacheDb.normalizeGradeResultForCache(parsed);
    }

    if (validateUpgradedPayload(phase, parsed)) {
      return stampUpgradeMetadata(parsed);
    }

    lastError = new Error('Upgraded payload failed validation for phase ' + phase);
  }

  throw lastError || new Error('Gemini upgrade failed');
}

async function fetchRowsPage(phases, offset, pageSize) {
  const params = new URLSearchParams();
  params.set('select', 'cache_key,phase,grade_id,grade_label,topic,query_text,result_data,hit_count,created_at');
  params.set('order', 'created_at.asc');
  params.set('limit', String(pageSize));
  params.set('offset', String(offset));
  if (phases.length === 1) {
    params.set('phase', 'eq.' + phases[0]);
  } else {
    params.set('phase', 'in.(' + phases.join(',') + ')');
  }

  const res = await supabaseRequest('/rest/v1/' + TABLE + '?' + params.toString(), { method: 'GET' });
  const body = await res.json();
  if (!res.ok) {
    throw new Error('Supabase fetch failed (' + res.status + '): ' + JSON.stringify(body).slice(0, 400));
  }
  if (!Array.isArray(body)) {
    throw new Error('Unexpected Supabase response: ' + JSON.stringify(body).slice(0, 400));
  }
  return body;
}

async function fetchRowByCacheKey(cacheKey) {
  const params = new URLSearchParams();
  params.set('select', 'cache_key,phase,grade_id,grade_label,topic,query_text,result_data,hit_count,created_at');
  params.set('cache_key', 'eq.' + cacheKey);
  params.set('limit', '1');

  const res = await supabaseRequest('/rest/v1/' + TABLE + '?' + params.toString(), { method: 'GET' });
  const body = await res.json();
  if (!res.ok) {
    throw new Error('Supabase fetch failed (' + res.status + '): ' + JSON.stringify(body).slice(0, 400));
  }
  return Array.isArray(body) && body[0] ? body[0] : null;
}

async function patchResultData(cacheKey, resultData) {
  const safe = cacheDb.sanitizeForJsonStorage(resultData);
  const res = await supabaseRequest(
    '/rest/v1/' + TABLE + '?cache_key=eq.' + encodeURIComponent(cacheKey),
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: cacheDb.safeJsonStringify({ result_data: safe }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Supabase PATCH failed (' + res.status + '): ' + errText.slice(0, 400));
  }
}

async function collectRows(opts) {
  if (opts.cacheKey) {
    const row = await fetchRowByCacheKey(opts.cacheKey);
    return row ? [row] : [];
  }

  const phases = phasesForFilter(opts.phase);
  const rows = [];
  let pageOffset = 0;

  while (true) {
    const page = await fetchRowsPage(phases, pageOffset, PAGE_SIZE);
    if (!page.length) break;
    rows.push.apply(rows, page);
    if (page.length < PAGE_SIZE) break;
    pageOffset += PAGE_SIZE;
  }

  return rows;
}

function shouldProcessRow(row, opts) {
  if (!row || !row.result_data) return false;
  if (opts.skipUpgraded && isAlreadyUpgraded(row.result_data)) return false;
  return row.phase === 'topic' || row.phase === 'grade';
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }

  if (!env.getGeminiApiKey()) {
    throw new Error('GEMINI_API_KEY is required.');
  }
  if (!cacheDb.isSupabaseCacheEnabled()) {
    throw new Error('Supabase is not configured (SUPABASE_URL + key).');
  }

  console.log('[upgradeArchive] Starting migration');
  console.log('[upgradeArchive] phase=%s dryRun=%s model=%s', opts.phase, opts.dryRun, opts.model);

  const allRows = await collectRows(opts);
  console.log('[upgradeArchive] Fetched %d candidate rows', allRows.length);

  let skipped = 0;
  let eligibleSeen = 0;
  let succeeded = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    if (!shouldProcessRow(row, opts)) {
      skipped++;
      continue;
    }

    if (eligibleSeen < opts.offset) {
      eligibleSeen++;
      skipped++;
      continue;
    }

    if (opts.limit > 0 && succeeded + failed >= opts.limit) {
      break;
    }

    const label = [
      row.phase,
      row.grade_label || row.grade_id || '',
      row.topic || row.query_text || '',
      row.cache_key.slice(0, 12),
    ].filter(Boolean).join(' | ');

    console.log('\n[%d/%d] Upgrading: %s', i + 1, allRows.length, label);

    try {
      const upgraded = await upgradeRowWithGemini(row, opts.model);
      if (opts.dryRun) {
        console.log('[dry-run] Valid upgrade produced (%d bytes JSON)', JSON.stringify(upgraded).length);
      } else {
        await patchResultData(row.cache_key, upgraded);
        console.log('[ok] Patched cache_key=%s', row.cache_key.slice(0, 16));
      }
      succeeded++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error('[fail] %s — %s', row.cache_key.slice(0, 16), message);
      failures.push({ cache_key: row.cache_key, phase: row.phase, error: message });
    }

    if (opts.delayMs > 0 && i < allRows.length - 1) {
      await sleep(opts.delayMs);
    }
  }

  console.log('\n[upgradeArchive] Done');
  console.log('  succeeded: %d', succeeded);
  console.log('  failed:    %d', failed);
  console.log('  skipped:   %d', skipped);

  if (failures.length) {
    const logPath = path.join(__dirname, 'upgradeArchive-failures.json');
    fs.writeFileSync(logPath, JSON.stringify(failures, null, 2), 'utf8');
    console.log('  failures logged to %s', logPath);
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(function (err) {
  console.error('[upgradeArchive] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
