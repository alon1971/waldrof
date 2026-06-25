/**
 * Lenient JSON parsing for LLM / streaming model output.
 * Strips fences, repairs common defects, and closes truncated brackets.
 */

function stripMarkdownJsonFences(text) {
  let raw = String(text || '').replace(/^\uFEFF/, '').trim();
  const fenced = raw.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  else {
    raw = raw.replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/```\s*$/gi, '').trim();
  }
  raw = raw.replace(/^json\s*:/i, '').trim();
  if (/^["'\u201c\u201d]/.test(raw) && /["'\u201c\u201d]\s*$/.test(raw)) {
    const unwrapped = raw.replace(/^["'\u201c\u201d]+/, '').replace(/["'\u201c\u201d]+\s*$/, '').trim();
    if (unwrapped.indexOf('{') >= 0 || unwrapped.indexOf('[') >= 0) raw = unwrapped;
  }
  return raw;
}

function normalizeJsonSmartQuotes(raw) {
  return String(raw || '')
    .replace(/[\u201c\u201d\u05f4]/g, '"')
    .replace(/[\u2018\u2019\u05f3]/g, "'");
}

function extractJsonPayload(raw) {
  if (!raw) return '';
  const text = String(raw);
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  let start = -1;
  let openChar = '{';
  let closeChar = '}';
  if (objStart >= 0 && (arrStart < 0 || objStart <= arrStart)) {
    start = objStart;
  } else if (arrStart >= 0) {
    start = arrStart;
    openChar = '[';
    closeChar = ']';
  }
  if (start < 0) return text;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  const end = text.lastIndexOf(closeChar);
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

function repairUnescapedInnerQuotesInJsonStrings(raw) {
  if (!raw) return '';
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) {
        result += c;
        escaped = false;
        continue;
      }
      if (c === '\\') {
        result += c;
        escaped = true;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < raw.length && /[\s\n\r\t]/.test(raw[j])) j++;
        const next = raw[j];
        if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
          inString = false;
          result += c;
        } else {
          result += "'";
        }
        continue;
      }
      result += c;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
      continue;
    }
    result += c;
  }
  return result;
}

function repairJsonStringLiterals(raw) {
  if (!raw) return '';
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) {
        result += c;
        escaped = false;
        continue;
      }
      if (c === '\\') {
        result += c;
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        result += c;
        continue;
      }
      if (c === '\r') {
        if (raw[i + 1] === '\n') i++;
        result += '\\n';
        continue;
      }
      if (c === '\n') {
        result += '\\n';
        continue;
      }
      if (c === '\t') {
        result += '\\t';
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        result += '\\u' + ('000' + code.toString(16)).slice(-4);
        continue;
      }
      result += c;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
      continue;
    }
    result += c;
  }
  return result;
}

/** Strip trailing commas, single-quoted keys, and other common LLM JSON defects. */
function repairCommonJsonDefects(raw) {
  let text = String(raw || '');
  text = text.replace(/,\s*([}\]])/g, '$1');
  text = text.replace(/([{\[])\s*,+/g, '$1');
  text = text.replace(/,\s*,+/g, ',');
  text = text.replace(/:\s*,/g, ': null,');
  text = text.replace(/:\s*undefined\b/g, ': null');
  text = text.replace(/:\s*NaN\b/g, ': null');
  text = text.replace(/:\s*-?Infinity\b/g, ': null');
  text = text.replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(\s*:)/g, '$1"$2"$3');
  return text;
}

function repairJsonText(raw) {
  return repairJsonStringLiterals(repairCommonJsonDefects(raw));
}

function repairTruncatedJson(raw) {
  let s = String(raw).trim();
  if (!s) return s;

  let inString = false;
  let escaped = false;
  const closers = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') closers.push('}');
    else if (ch === '[') closers.push(']');
    else if ((ch === '}' || ch === ']') && closers.length && closers[closers.length - 1] === ch) {
      closers.pop();
    }
  }

  if (escaped) s = s.slice(0, -1);
  if (inString) s += '"';

  s = s.replace(/:\s*$/u, ': null');
  s = s.replace(/,\s*$/u, '');
  if (closers.length && closers[closers.length - 1] === '}') {
    s = s.replace(/,\s*"([^"\\]|\\.)*"\s*$/u, '');
  }

  while (closers.length) s += closers.pop();
  return s;
}

/**
 * Extract JSON between the first opening bracket and the last closing bracket.
 * Ignores markdown fences, preamble, and trailing prose outside those bounds.
 */
function extractJsonByRegex(text) {
  const s = String(text || '');
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  if (objStart >= 0 && (arrStart < 0 || objStart <= arrStart)) {
    const end = s.lastIndexOf('}');
    if (end > objStart) return s.slice(objStart, end + 1);
  }
  if (arrStart >= 0) {
    const end = s.lastIndexOf(']');
    if (end > arrStart) return s.slice(arrStart, end + 1);
  }
  return '';
}

/** Strip invisible control characters and zero-width marks that break JSON.parse. */
function cleanseJsonCharacters(raw) {
  let text = String(raw || '').replace(/^\uFEFF/, '');
  text = text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  return text;
}

/** Fix lone backslashes inside JSON string literals (invalid escape sequences). */
function repairInvalidEscapeSequences(raw) {
  if (!raw) return '';
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) {
        if (!/["\\/bfnrtu]/.test(c)) {
          result += '\\' + c;
        } else {
          result += c;
        }
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        result += c;
        continue;
      }
      if (c === '"') inString = false;
      result += c;
      continue;
    }
    if (c === '"') inString = true;
    result += c;
  }
  if (escaped) result += '\\\\';
  return result;
}

function plainTextFromModelOutput(text) {
  const stripped = stripMarkdownJsonFences(text);
  return String(stripped || '').trim();
}

function modelTextToHtml(text) {
  const plain = plainTextFromModelOutput(text);
  const html = plain
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>');
  return '<p>' + (html || 'לא ניתן לעבד את תשובת המודל.') + '</p>';
}

/**
 * Phase-shaped fallback when the model reply cannot be parsed as JSON.
 * Keeps the client usable instead of surfacing a fatal parse error.
 */
function buildModelParseFallback(phase, rawText, context) {
  const ctx = context || {};
  const plain = plainTextFromModelOutput(rawText);
  const wrap = modelTextToHtml(rawText);

  if (phase === 'grade') {
    return {
      gradeInsights: {
        part1AgePictureHtml: wrap,
        part1DevelopmentBullets: [],
        archivesSynthesisHtml: '',
        developmentBullets: [],
        part2ClassroomIdeasHtml: '',
        part2ClassroomIdeas: [],
        part3CommunityExpansionsHtml: '',
        part3CommunityIdeas: [],
        globalCurricula: [],
        typicalBlocks: [],
        sources: [],
      },
      teacherSummaries: [],
      _parseFallback: true,
    };
  }

  if (phase === 'topic') {
    const topic = String(ctx.topic || '').trim();
    return {
      webResearch: {
        topic: topic,
        summary: plain.slice(0, 2000),
        connections: [],
        highlights: [],
      },
      blockPlan: {
        theory: {
          title: topic || 'תוכן שנוצר',
          sections: [{ heading: 'סיכום', icon: 'fa-compass', content: wrap, quotes: [] }],
        },
      },
      _parseFallback: true,
    };
  }

  if (phase === 'chat_followup') {
    return {
      chatReply: { answer: plain || 'לא ניתן לעבד את תשובת המודל.' },
      _parseFallback: true,
    };
  }

  if (phase === 'pedagogy_deep_dive') {
    return {
      pedagogyDeepDive: {
        title: String(ctx.activityTitle || ''),
        contentHtml: wrap,
      },
      _parseFallback: true,
    };
  }

  if (phase === 'archive_summary') {
    return {
      archiveSummary: {
        title: String(ctx.sourceTitle || ''),
        summaryHtml: wrap,
      },
      _parseFallback: true,
    };
  }

  if (phase === 'drive') {
    return { driveMerge: { summary: plain.slice(0, 2000) }, _parseFallback: true };
  }

  if (phase === 'test') {
    return { ok: true, message: plain || 'fallback', _parseFallback: true };
  }

  if (phase === 'topic_master' || phase === 'pure_phase_c') {
    const topic = String(ctx.topic || 'נושא').trim();
    const grade = String(ctx.grade || ctx.gradeLabel || '').trim();
    const titleSuffix = grade ? (grade + ' · ' + topic) : topic;
    return {
      theory: {
        title: 'רקע תיאורטי — ' + titleSuffix,
        sections: [{
          heading: 'תוכן שנוצר',
          icon: 'fa-compass',
          content: wrap || '<p>לא ניתן לפרסר את תשובת המודל כ-JSON — מוצג תוכן גולמי.</p>',
        }],
        bibliography: { books: [], articles: [], websites: [] },
      },
      inspiration: {
        title: 'השראה פדגוגית — ' + topic,
        global: plain ? [{ title: 'השראה', items: [plain] }] : [],
        podcast: { title: 'תובנות', episodes: [] },
        narrative: [],
      },
      pinterest_links: [],
      pedagogical_resources: [],
      core_emphases: plain,
      key_points: [],
      recommended_reading: [],
      relevant_links: [],
      _parseFallback: true,
    };
  }

  if (phase === 'general_search' || phase === 'pure_general_search') {
    return {
      developmental_axis: plain.slice(0, 8000),
      core_pedagogical_emphases: plain.slice(0, 8000),
      recommended_literature: [],
      relevant_links: [],
      _parseFallback: true,
    };
  }

  return { rawText: plain, _parseFallback: true };
}

/**
 * Bulletproof parser for pure Perplexity routes — never throws on malformed model JSON.
 * @returns {{ parsed: object, parseFallback: boolean }}
 */
function parsePureModelJson(raw, options) {
  const opts = options || {};
  const phase = opts.phase || 'topic_master';
  const context = opts.context || {};
  const text = String(raw || '');

  if (!text.trim()) {
    return {
      parsed: buildModelParseFallback(phase, '', context),
      parseFallback: true,
    };
  }

  const safe = safeParseJson(text);
  if (safe && typeof safe === 'object' && !Array.isArray(safe)) {
    return {
      parsed: opts.unwrap === false ? safe : unwrapParsedModelPayload(safe),
      parseFallback: false,
    };
  }

  try {
    const parsed = parseJsonLenient(text);
    return {
      parsed: opts.unwrap === false ? parsed : unwrapParsedModelPayload(parsed),
      parseFallback: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      '[json-repair] parsePureModelJson fallback for',
      phase + ':',
      msg,
      '| preview:',
      text.slice(0, 180)
    );
    return {
      parsed: buildModelParseFallback(phase, text, context),
      parseFallback: true,
    };
  }
}

function buildJsonParseAttempts(text) {
  const stripped = stripMarkdownJsonFences(text);
  const normalized = normalizeJsonSmartQuotes(cleanseJsonCharacters(stripped));
  const regexExtracted = extractJsonByRegex(normalized);
  const extracted = extractJsonPayload(normalized) || regexExtracted || normalized;
  const quoteFixed = repairUnescapedInnerQuotesInJsonStrings(extracted);
  const escapeFixed = repairInvalidEscapeSequences(quoteFixed);
  const literalFixed = repairJsonText(extracted);
  const quoteAndLiteral = repairJsonText(escapeFixed);

  const cores = [
    extracted,
    regexExtracted,
    quoteFixed,
    escapeFixed,
    literalFixed,
    quoteAndLiteral,
    repairTruncatedJson(extracted),
    repairTruncatedJson(regexExtracted),
    repairTruncatedJson(quoteFixed),
    repairTruncatedJson(escapeFixed),
    repairTruncatedJson(literalFixed),
    repairTruncatedJson(quoteAndLiteral),
  ];

  const seen = new Set();
  const attempts = [];
  for (let i = 0; i < cores.length; i++) {
    const candidate = cores[i];
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    attempts.push(candidate);
  }
  return attempts;
}

function isJsonSyntaxError(err) {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /JSON|Unexpected token|position \d+|property name/i.test(msg);
}

function parseJsonLenient(text) {
  const attempts = buildJsonParseAttempts(text);
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return JSON.parse(attempts[i]);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Invalid JSON from model');
}

function safeParseJson(text) {
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (directErr) {
    try {
      return parseJsonLenient(trimmed);
    } catch (repairErr) {
      return null;
    }
  }
}

/** Parse a single SSE data line from Perplexity streaming; returns null on failure. */
function parseSseJsonPayload(payload) {
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch (directErr) {
    const repaired = safeParseJson(payload);
    if (repaired && typeof repaired === 'object') return repaired;
    return null;
  }
}

function unwrapParsedModelPayload(parsed) {
  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.data &&
    typeof parsed.data === 'object' &&
    !parsed.gradeInsights &&
    !parsed.blockPlan &&
    !parsed.webResearch &&
    !parsed.pedagogyDeepDive
  ) {
    return parsed.data;
  }
  return parsed;
}

/**
 * Global strict LLM JSON parser — extract, cleanse, parse, and fall back gracefully.
 * @param {string} text - Raw model output
 * @param {{ phase?: string, context?: object, fallbackOnError?: boolean, unwrap?: boolean }} [options]
 * @returns {object} Parsed payload or phase-shaped fallback (never throws when fallbackOnError + phase)
 */
function cleanAndParseJSON(text, options) {
  const opts = options || {};
  const phase = opts.phase;
  const context = opts.context || {};
  const fallbackOnError = opts.fallbackOnError !== false;
  const unwrap = opts.unwrap !== false;
  const raw = String(text || '');

  if (!raw.trim()) {
    if (fallbackOnError && phase) return buildModelParseFallback(phase, '', context);
    throw new Error('Empty model response');
  }

  try {
    const parsed = parseJsonLenient(raw);
    return unwrap ? unwrapParsedModelPayload(parsed) : parsed;
  } catch (err) {
    if (fallbackOnError && phase) {
      console.warn(
        '[json-repair] cleanAndParseJSON fallback for phase',
        phase + ':',
        err instanceof Error ? err.message : String(err)
      );
      return buildModelParseFallback(phase, raw, context);
    }
    throw err;
  }
}

function parseJsonFromModel(text, options) {
  return cleanAndParseJSON(text, options);
}

module.exports = {
  stripMarkdownJsonFences,
  normalizeJsonSmartQuotes,
  extractJsonPayload,
  extractJsonByRegex,
  cleanseJsonCharacters,
  repairInvalidEscapeSequences,
  plainTextFromModelOutput,
  modelTextToHtml,
  buildModelParseFallback,
  cleanAndParseJSON,
  repairUnescapedInnerQuotesInJsonStrings,
  repairJsonStringLiterals,
  repairCommonJsonDefects,
  repairJsonText,
  repairTruncatedJson,
  buildJsonParseAttempts,
  parseJsonLenient,
  safeParseJson,
  parseSseJsonPayload,
  unwrapParsedModelPayload,
  parseJsonFromModel,
  parsePureModelJson,
  isJsonSyntaxError,
};
