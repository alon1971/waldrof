/**
 * Server-side Perplexity Sonar client — streaming by default to avoid ~60s proxy timeouts.
 */
const https = require('https');
const env = require('./env');
const jsonRepair = require('./json-repair');

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
/** Stable factual web-search model for hybrid routing (Perplexity → Gemini). */
const PERPLEXITY_SEARCH_MODEL = 'sonar';
/** Single premium synthesis model for ALL users — quality-first, no dynamic downgrade. */
const PERPLEXITY_MODEL = 'sonar-reasoning-pro';

/**
 * Perplexity accepts max_tokens up to 128000 (API schema). sonar-reasoning-pro's effective
 * completion output is model-bound (~8k), but we no longer impose a lower ceiling
 * of our own so the model emits the fullest possible book-length teacher manual.
 */
const PERPLEXITY_MAX_OUTPUT_TOKENS_PRO = 16000;
const PERPLEXITY_MAX_OUTPUT_TOKENS_SEARCH = 6000;
// Activity-based IDLE timeout for the upstream Perplexity connection. For STREAMING this is
// reset on every inbound byte/delta (see armTimer + readStreamResponse), so the request is
// aborted ONLY after this many ms of complete upstream silence — a long but healthy
// generation is never cut. This is generous (vs. the 45s browser-facing idle) because there
// is no heartbeat upstream to reset it before sonar-reasoning-pro emits its first token.
// For the NON-streaming https fallback it acts as a total request timeout.
const REQUEST_TIMEOUT_MS = 180000;
/** Up to 3 retries after a 429 (1s, 2s, 4s backoff) before surfacing an error. */
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function normalizeApiKey(apiKey) {
  return String(apiKey || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, '');
}

function resolveApiKey() {
  const key = env.getPerplexityApiKey();
  const normalized = normalizeApiKey(key);
  return normalized || null;
}

function buildHeaders(apiKey, streaming) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: streaming ? 'text/event-stream' : 'application/json',
    Authorization: 'Bearer ' + apiKey,
  };
  return headers;
}

function httpsPostJson(url, headers, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: target.hostname,
      port: 443,
      path: target.pathname,
      method: 'POST',
      headers: Object.assign({}, headers, {
        'Content-Length': Buffer.byteLength(payload),
      }),
      timeout: timeoutMs,
    }, function (res) {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { text += chunk; });
      res.on('end', function () {
        resolve({ status: res.statusCode || 0, text: text });
      });
    });
    req.on('error', reject);
    req.on('timeout', function () {
      req.destroy();
      reject(new Error('Perplexity request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

/** Pull the incremental text fragment out of one streamed SSE chunk (delta or full message). */
function extractStreamDelta(json) {
  if (!json || typeof json !== 'object') return '';
  const choice = json.choices && json.choices[0];
  if (!choice) return '';
  const delta = choice.delta && choice.delta.content;
  if (typeof delta === 'string' && delta) return delta;
  const message = choice.message && choice.message.content;
  if (typeof message === 'string' && message) return message;
  return '';
}

function appendStreamDelta(content, json) {
  const delta = extractStreamDelta(json);
  return delta ? content + delta : content;
}

function parseSsePayload(payload) {
  return jsonRepair.parseSseJsonPayload(payload);
}

/** Forward a streamed text fragment to an optional onDelta hook (errors never break the stream). */
function emitStreamDelta(onDelta, delta, content) {
  if (!delta || typeof onDelta !== 'function') return;
  try {
    onDelta(delta, content);
  } catch (e) { /* never let a UI hook break the upstream read */ }
}

async function readStreamResponse(res, onDelta, onActivity) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return parseSseText(text, onDelta);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    // Any inbound byte means the upstream is alive — keep the pipe (and the
    // browser-facing heartbeat) from being torn down, even before the first
    // parseable content delta arrives.
    if (typeof onActivity === 'function') {
      try { onActivity(); } catch (e) { /* never let keep-alive break the read */ }
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i].trim();
      if (!line || line.indexOf('data:') !== 0) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const parsed = parseSsePayload(payload);
      if (parsed) {
        const delta = extractStreamDelta(parsed);
        if (delta) { content += delta; emitStreamDelta(onDelta, delta, content); }
      }
    }
  }

  if (buffer.trim()) {
    const tail = buffer.trim();
    if (tail.indexOf('data:') === 0) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        const parsed = parseSsePayload(payload);
        if (parsed) {
          const delta = extractStreamDelta(parsed);
          if (delta) { content += delta; emitStreamDelta(onDelta, delta, content); }
        }
      }
    }
  }

  return content.trim();
}

function parseSseText(text, onDelta) {
  let content = '';
  String(text || '').split('\n').forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('data:') !== 0) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    const parsed = parseSsePayload(payload);
    if (parsed) {
      const delta = extractStreamDelta(parsed);
      if (delta) { content += delta; emitStreamDelta(onDelta, delta, content); }
    }
  });
  return content.trim();
}

function extractMessageContent(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output === 'string' && data.output.trim()) return data.output.trim();
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim();

  const choice = data.choices && data.choices[0];
  if (!choice) return '';

  const message = choice.message || choice.delta || choice;
  if (!message || typeof message !== 'object') return '';

  const content = message.content != null ? message.content : message.text;
  if (typeof content === 'string') return content.trim();

  if (Array.isArray(content)) {
    return content.map(function (part) {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    }).join('').trim();
  }

  return '';
}

function mapHttpError(status, responseText) {
  const detail = String(responseText || '').slice(0, 400);
  let err;
  if (status === 401 || status === 403) {
    err = new Error(
      'Perplexity API key invalid or unauthorized (HTTP ' + status + '). ' +
      'Verify PERPLEXITY_API_KEY in Render Environment Variables.'
    );
  } else {
    err = new Error('Perplexity API ' + status + ': ' + detail);
  }
  err.statusCode = status;
  return err;
}

function isRateLimitError(err) {
  if (!err) return false;
  if (err.statusCode === 429) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\bPerplexity API 429\b|\b429\b.*too many requests|rate limit/i.test(msg);
}

/**
 * Retry an upstream call on HTTP 429 with exponential backoff (1s → 2s → 4s).
 * Non-rate-limit errors fail immediately; the HTTP handler stays open so the client
 * loading UI is uninterrupted.
 */
async function withRateLimitRetry(operation, label) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt >= RATE_LIMIT_MAX_RETRIES) throw err;
      const delayMs = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        '[perplexity] Rate limit (429) on', label || 'request',
        '— retry', attempt + 1, '/', RATE_LIMIT_MAX_RETRIES, 'in', delayMs, 'ms'
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function extractCitations(data) {
  if (!data || typeof data !== 'object') return [];
  const raw = data.citations || (data.choices && data.choices[0] && data.choices[0].citations);
  if (!Array.isArray(raw)) return [];
  return raw.map(function (item) {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item.url === 'string') return item.url.trim();
    return '';
  }).filter(Boolean);
}

/**
 * Abort / idle-timeout: the request was already in flight (and likely billed) but the
 * upstream went silent. Retrying just doubles cost and can chain into multi-minute hangs,
 * so these errors STOP immediately with a clean, non-retriable message.
 */
function isAbortOrTimeoutError(msg) {
  return /\baborted\b|\babort\b|timeout|UND_ERR_(HEADERS_TIMEOUT|BODY_TIMEOUT|CONNECT_TIMEOUT)/i.test(String(msg || ''));
}

/**
 * Genuine pre-request connection failure (DNS/refused/reset) where no tokens were produced.
 * Safe to attempt the https fallback exactly once — never for aborts/timeouts.
 */
function isRetriableConnectionError(msg) {
  if (isAbortOrTimeoutError(msg)) return false;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|network/i.test(String(msg || ''));
}

/** Friendly, non-retriable error for an aborted/stuck Perplexity request. */
function abortedPerplexityError() {
  return new Error('הקריאה ל-Perplexity הופסקה עקב חוסר תגובה (timeout). נסו שוב בעוד רגע.');
}

async function fetchPerplexityResponseOnce(apiKey, body, useStream, onDelta) {
  const streaming = useStream !== false;
  const requestBody = Object.assign({}, body, { stream: streaming });
  const headers = buildHeaders(apiKey, streaming);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;

  // For streaming we use an IDLE timeout (reset on every token) so a long but
  // healthy generation is never aborted; non-streaming uses a fixed total timeout.
  function armTimer() {
    if (!controller) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      try { controller.abort(); } catch (e) { /* ignore */ }
    }, REQUEST_TIMEOUT_MS);
  }
  armTimer();

  try {
    const res = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody),
      signal: controller ? controller.signal : undefined,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw mapHttpError(res.status, errText);
    }

    if (streaming) {
      const streamOnDelta = function (delta, content) {
        armTimer();
        if (typeof onDelta === 'function') onDelta(delta, content);
      };
      // Reset the idle timeout on every upstream byte, not only on content deltas,
      // so a healthy-but-quiet research phase is never aborted mid-stream.
      const streamed = await readStreamResponse(res, streamOnDelta, armTimer);
      if (streamed) return { content: streamed, citations: [] };
      throw new Error('Perplexity החזיר תשובה ריקה — נסו שוב בעוד רגע.');
    }

    const responseText = await res.text();
    const data = jsonRepair.safeParseJson(responseText);
    if (!data) {
      throw new Error('Perplexity API returned non-JSON: ' + responseText.slice(0, 200));
    }
    const content = extractMessageContent(data);
    if (!content) throw new Error('Perplexity החזיר תשובה ריקה — נסו שוב בעוד רגע.');
    return { content: content, citations: extractCitations(data), rawResponseText: responseText };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchPerplexityResponse(apiKey, body, useStream, onDelta) {
  return fetchPerplexityResponseOnce(apiKey, body, useStream, onDelta);
}

async function fetchPerplexity(apiKey, body, useStream) {
  const result = await fetchPerplexityResponse(apiKey, body, useStream);
  return result.content;
}

async function httpsPerplexityOnce(apiKey, body) {
  const requestBody = Object.assign({}, body, { stream: false });
  const headers = buildHeaders(apiKey, false);
  const result = await httpsPostJson(PERPLEXITY_URL, headers, requestBody, REQUEST_TIMEOUT_MS);
  if (result.status < 200 || result.status >= 300) {
    throw mapHttpError(result.status, result.text);
  }
  const data = jsonRepair.safeParseJson(result.text);
  if (!data) {
    throw new Error('Perplexity API returned non-JSON: ' + String(result.text || '').slice(0, 200));
  }
  const content = extractMessageContent(data);
  if (!content) throw new Error('Perplexity החזיר תשובה ריקה — נסו שוב בעוד רגע.');
  return { content: content, citations: extractCitations(data), rawResponseText: result.text };
}

async function httpsPerplexity(apiKey, body) {
  return httpsPerplexityOnce(apiKey, body);
}

/** Fetch (streaming or not) with a single https fallback on connection failure. */
async function executePerplexityRequest(apiKey, body, useStream, onDelta) {
  try {
    return await fetchPerplexityResponseOnce(apiKey, body, useStream, onDelta);
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    // Aborted/stuck request — stop immediately, never re-call (avoids double-billing + hangs).
    if (isAbortOrTimeoutError(msg)) throw abortedPerplexityError();
    // Rate limits are retried at the outer wrapper — do not fall through to https.
    if (isRateLimitError(fetchErr)) throw fetchErr;
    // Only a genuine connection failure (no tokens produced) gets a single https fallback.
    if (!isRetriableConnectionError(msg)) throw fetchErr;

    console.warn('[perplexity] connection failed, single https fallback:', msg);
    try {
      return await httpsPerplexity(apiKey, body);
    } catch (httpsErr) {
      const httpsMsg = httpsErr instanceof Error ? httpsErr.message : String(httpsErr);
      if (isAbortOrTimeoutError(httpsMsg)) throw abortedPerplexityError();
      if (isRateLimitError(httpsErr)) throw httpsErr;
      throw new Error('שגיאת רשת בחיבור ל-Perplexity: ' + httpsMsg);
    }
  }
}

/**
 * Non-streaming Perplexity chat — returns assistant text, live citations, and raw API JSON.
 */
async function callPerplexityChatWithCitations(options) {
  const opts = options || {};
  const apiKey = normalizeApiKey(opts.apiKey || resolveApiKey());
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY is not configured');
  }

  const model = opts.model || PERPLEXITY_MODEL;
  const defaultMaxTokens = model === PERPLEXITY_SEARCH_MODEL
    ? PERPLEXITY_MAX_OUTPUT_TOKENS_SEARCH
    : PERPLEXITY_MAX_OUTPUT_TOKENS_PRO;
  const body = {
    model: model,
    temperature: opts.temperature != null ? opts.temperature : 0.35,
    max_tokens: opts.max_tokens != null ? opts.max_tokens : defaultMaxTokens,
    messages: opts.messages || [],
  };

  const result = await withRateLimitRetry(function () {
    return executePerplexityRequest(apiKey, body, false);
  }, 'chat-citations');
  return {
    content: result.content,
    citations: result.citations || [],
    rawResponseText: result.rawResponseText || '',
  };
}

/**
 * Call Perplexity chat completions — streaming first, https fallback on fetch failure.
 * Returns assistant text only (string).
 */
async function callPerplexityChat(options) {
  const opts = options || {};
  const apiKey = normalizeApiKey(opts.apiKey || resolveApiKey());
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY is not configured');
  }

  const model = opts.model || PERPLEXITY_MODEL;
  const defaultMaxTokens = model === PERPLEXITY_SEARCH_MODEL
    ? PERPLEXITY_MAX_OUTPUT_TOKENS_SEARCH
    : PERPLEXITY_MAX_OUTPUT_TOKENS_PRO;
  const body = {
    model: model,
    temperature: opts.temperature != null ? opts.temperature : 0.35,
    max_tokens: opts.max_tokens != null ? opts.max_tokens : defaultMaxTokens,
    messages: opts.messages || [],
  };

  const useStream = opts.stream !== false;
  const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;

  const result = await withRateLimitRetry(function () {
    return executePerplexityRequest(apiKey, body, useStream, onDelta);
  }, 'chat');
  return result.content;
}

/**
 * Factual web search via Perplexity Sonar — returns { content, citations }.
 */
async function callPerplexitySearch(options) {
  const opts = options || {};
  const apiKey = normalizeApiKey(opts.apiKey || resolveApiKey());
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY is not configured');
  }

  const body = {
    model: opts.model || PERPLEXITY_SEARCH_MODEL,
    temperature: opts.temperature != null ? opts.temperature : 0.2,
    max_tokens: opts.max_tokens != null ? opts.max_tokens : PERPLEXITY_MAX_OUTPUT_TOKENS_SEARCH,
    messages: opts.messages || [],
  };

  const useStream = opts.stream === true;
  const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;

  return withRateLimitRetry(function () {
    return executePerplexityRequest(apiKey, body, useStream, onDelta);
  }, 'search');
}

module.exports = {
  PERPLEXITY_URL,
  PERPLEXITY_MODEL,
  PERPLEXITY_SEARCH_MODEL,
  PERPLEXITY_MAX_OUTPUT_TOKENS_PRO,
  PERPLEXITY_MAX_OUTPUT_TOKENS_SEARCH,
  normalizeApiKey,
  resolveApiKey,
  callPerplexityChat,
  callPerplexityChatWithCitations,
  callPerplexitySearch,
  extractMessageContent,
  extractCitations,
};
