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

function buildJsonParseAttempts(text) {
  const stripped = stripMarkdownJsonFences(text);
  const normalized = normalizeJsonSmartQuotes(stripped);
  const extracted = extractJsonPayload(normalized) || normalized;
  const quoteFixed = repairUnescapedInnerQuotesInJsonStrings(extracted);
  const literalFixed = repairJsonText(extracted);
  const quoteAndLiteral = repairJsonText(quoteFixed);

  const cores = [
    extracted,
    quoteFixed,
    literalFixed,
    quoteAndLiteral,
    repairTruncatedJson(extracted),
    repairTruncatedJson(quoteFixed),
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
    !parsed.archiveSearch &&
    !parsed.pedagogyDeepDive
  ) {
    return parsed.data;
  }
  return parsed;
}

function parseJsonFromModel(text) {
  if (!text || !String(text).trim()) throw new Error('Empty model response');
  const parsed = parseJsonLenient(text);
  return unwrapParsedModelPayload(parsed);
}

module.exports = {
  stripMarkdownJsonFences,
  normalizeJsonSmartQuotes,
  extractJsonPayload,
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
  isJsonSyntaxError,
};
