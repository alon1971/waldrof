/**
 * Gemini generateContent helper for routes that must return parseable JSON.
 * Always sets generationConfig.responseMimeType = 'application/json'
 * and maxOutputTokens >= 4096 so long 15-day curricula are not truncated.
 */
'use strict';

const env = require('./env');
const jsonRepair = require('./json-repair');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_FALLBACK_MODELS = ['gemini-2.5-pro'];
const MIN_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const PERIOD_MAX_OUTPUT_TOKENS = 16384;

function extractGeminiText(payload) {
  const candidates = payload && payload.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return '';
  const parts = candidates[0].content && candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(function (part) {
    return part && typeof part.text === 'string' ? part.text : '';
  }).join('').trim();
}

function extractFinishReason(payload) {
  const candidate = payload && payload.candidates && payload.candidates[0];
  return candidate && candidate.finishReason ? String(candidate.finishReason) : '';
}

function resolveMaxOutputTokens(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requested = parseInt(opts.maxOutputTokens, 10);
  const fallback = opts.periodBlock ? PERIOD_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.max(MIN_MAX_OUTPUT_TOKENS, requested > 0 ? requested : fallback);
}

async function postGeminiGenerateContent(model, systemPrompt, userPrompt, options) {
  const apiKey = env.getGeminiApiKey();
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured');
    err.code = 'GEMINI_KEY_MISSING';
    throw err;
  }
  const opts = options && typeof options === 'object' ? options : {};
  const generationConfig = {
    temperature: opts.temperature != null ? opts.temperature : 0.2,
    maxOutputTokens: resolveMaxOutputTokens(opts),
    responseMimeType: 'application/json',
  };
  if (opts.responseSchema && typeof opts.responseSchema === 'object') {
    generationConfig.responseSchema = opts.responseSchema;
  }

  const body = {
    systemInstruction: { parts: [{ text: String(systemPrompt || '') }] },
    contents: [{ role: 'user', parts: [{ text: String(userPrompt || '') }] }],
    generationConfig: generationConfig,
  };
  if (opts.googleSearch) {
    body.tools = [{ google_search: {} }];
  }

  const url = GEMINI_API_BASE + '/models/' + encodeURIComponent(model) + ':generateContent';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
  const rawHttp = await res.text();
  let payload = jsonRepair.safeParseJson(rawHttp);
  if (!payload || typeof payload !== 'object') {
    const err = new Error('Gemini returned a non-JSON HTTP envelope (' + res.status + ')');
    err.statusCode = res.status;
    throw err;
  }
  if (!res.ok) {
    const msg = payload && payload.error && payload.error.message
      ? payload.error.message
      : String(rawHttp || '').slice(0, 300);
    const err = new Error('Gemini error ' + res.status + ': ' + msg);
    err.statusCode = res.status;
    throw err;
  }
  return payload;
}

function parseModelJson(text, parseOpts) {
  const cleaned = jsonRepair.preprocessModelJson(text);
  return jsonRepair.parsePureModelJson(cleaned || text, parseOpts || {});
}

async function generateJson(systemPrompt, userPrompt, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const primary = opts.model || GEMINI_MODEL;
  const models = [primary].concat(
    (opts.fallbackModels || GEMINI_FALLBACK_MODELS).filter(function (name) {
      return name && name !== primary;
    })
  );
  let lastErr = null;

  for (let i = 0; i < models.length; i++) {
    const attemptOpts = [opts];
    if (opts.googleSearch) {
      attemptOpts.push(Object.assign({}, opts, { googleSearch: false }));
    }
    for (let a = 0; a < attemptOpts.length; a++) {
      try {
        const payload = await postGeminiGenerateContent(models[i], systemPrompt, userPrompt, attemptOpts[a]);
        const raw = extractGeminiText(payload);
        const finishReason = extractFinishReason(payload);
        if (String(finishReason).toUpperCase() === 'MAX_TOKENS') {
          console.warn('[gemini-json] MAX_TOKENS finishReason on', models[i], '— applying JSON repair');
        }
        if (!raw) {
          throw new Error('Gemini returned an empty JSON body');
        }
        const parsedResult = parseModelJson(raw, {
          phase: opts.phase || 'general_search',
          context: opts.context || {},
          unwrap: true,
        });
        return {
          raw: raw,
          parsed: parsedResult.parsed,
          parseFallback: Boolean(parsedResult.parseFallback),
          model: models[i],
          finishReason: finishReason,
        };
      } catch (err) {
        lastErr = err;
        console.warn(
          '[gemini-json] generateJson failed on',
          models[i] + (attemptOpts[a].googleSearch ? ' (search)' : '') + ':',
          err && err.message ? err.message : err
        );
      }
    }
  }
  throw lastErr || new Error('Gemini JSON generation failed');
}

async function repairToJson(brokenText, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const snippet = String(brokenText || '').trim().slice(0, 24000);
  if (!snippet) {
    const empty = parseModelJson('{}', opts);
    return {
      raw: '{}',
      parsed: empty.parsed,
      parseFallback: true,
      model: 'repair',
      finishReason: '',
    };
  }
  const systemPrompt = [
    opts.systemPrompt || '',
    'You repair malformed model JSON. Return ONE valid JSON object only.',
    'Strip markdown fences. Escape quotes inside strings. Turn raw newlines inside strings into \\n.',
    'Remove trailing commas. Do not add commentary.',
  ].filter(Boolean).join('\n');
  const userPrompt = [
    'Repair this output into valid JSON matching the required pedagogical schema:',
    snippet,
  ].join('\n\n');
  return generateJson(systemPrompt, userPrompt, Object.assign({}, opts, {
    googleSearch: false,
    temperature: 0,
  }));
}

module.exports = {
  GEMINI_MODEL,
  MIN_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  PERIOD_MAX_OUTPUT_TOKENS,
  extractGeminiText,
  resolveMaxOutputTokens,
  generateJson,
  repairToJson,
  parseModelJson,
};
