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
const REQUEST_TIMEOUT_MS = 180000;

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
  if (status === 401 || status === 403) {
    return new Error(
      'Perplexity API key invalid or unauthorized (HTTP ' + status + '). ' +
      'Verify PERPLEXITY_API_KEY in Render Environment Variables.'
    );
  }
  return new Error('Perplexity API ' + status + ': ' + detail);
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

async function fetchPerplexityResponse(apiKey, body, useStream, onDelta) {
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

async function fetchPerplexity(apiKey, body, useStream) {
  const result = await fetchPerplexityResponse(apiKey, body, useStream);
  return result.content;
}

async function httpsPerplexity(apiKey, body) {
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

  try {
    const result = await fetchPerplexityResponse(apiKey, body, false);
    return {
      content: result.content,
      citations: result.citations || [],
      rawResponseText: result.rawResponseText || '',
    };
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const isNetwork = /fetch failed|network|timeout|abort|ECONN|ENOTFOUND|UND_ERR/i.test(msg);
    if (!isNetwork) throw fetchErr;

    console.warn('[perplexity] fetch failed, retrying via https:', msg);
    try {
      const result = await httpsPerplexity(apiKey, body);
      return {
        content: result.content,
        citations: result.citations || [],
        rawResponseText: result.rawResponseText || '',
      };
    } catch (httpsErr) {
      const httpsMsg = httpsErr instanceof Error ? httpsErr.message : String(httpsErr);
      throw new Error('שגיאת רשת בחיבור ל-Perplexity: ' + httpsMsg);
    }
  }
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

  try {
    const result = await fetchPerplexityResponse(apiKey, body, useStream, onDelta);
    return result.content;
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const isNetwork = /fetch failed|network|timeout|abort|ECONN|ENOTFOUND|UND_ERR/i.test(msg);
    if (!isNetwork) throw fetchErr;

    console.warn('[perplexity] fetch failed, retrying via https:', msg);
    try {
      const result = await httpsPerplexity(apiKey, body);
      return result.content;
    } catch (httpsErr) {
      const httpsMsg = httpsErr instanceof Error ? httpsErr.message : String(httpsErr);
      throw new Error('שגיאת רשת בחיבור ל-Perplexity: ' + httpsMsg);
    }
  }
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

  try {
    return await fetchPerplexityResponse(apiKey, body, useStream, onDelta);
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const isNetwork = /fetch failed|network|timeout|abort|ECONN|ENOTFOUND|UND_ERR/i.test(msg);
    if (!isNetwork) throw fetchErr;

    console.warn('[perplexity] search fetch failed, retrying via https:', msg);
    try {
      return await httpsPerplexity(apiKey, body);
    } catch (httpsErr) {
      const httpsMsg = httpsErr instanceof Error ? httpsErr.message : String(httpsErr);
      throw new Error('שגיאת רשת בחיבור ל-Perplexity: ' + httpsMsg);
    }
  }
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
