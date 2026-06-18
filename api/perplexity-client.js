/**
 * Server-side Perplexity Sonar client — streaming by default to avoid ~60s proxy timeouts.
 */
const https = require('https');
const env = require('./env');

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar-pro';
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

function appendStreamDelta(content, json) {
  if (!json || typeof json !== 'object') return content;
  const choice = json.choices && json.choices[0];
  if (!choice) return content;
  const delta = choice.delta && choice.delta.content;
  if (typeof delta === 'string' && delta) return content + delta;
  const message = choice.message && choice.message.content;
  if (typeof message === 'string' && message) return content + message;
  return content;
}

async function readStreamResponse(res) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return parseSseText(text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i].trim();
      if (!line || line.indexOf('data:') !== 0) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        content = appendStreamDelta(content, JSON.parse(payload));
      } catch (e) { /* skip malformed SSE chunk */ }
    }
  }

  if (buffer.trim()) {
    const tail = buffer.trim();
    if (tail.indexOf('data:') === 0) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          content = appendStreamDelta(content, JSON.parse(payload));
        } catch (e) { /* ignore */ }
      }
    }
  }

  return content.trim();
}

function parseSseText(text) {
  let content = '';
  String(text || '').split('\n').forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('data:') !== 0) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      content = appendStreamDelta(content, JSON.parse(payload));
    } catch (e) { /* ignore */ }
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

async function fetchPerplexity(apiKey, body, useStream) {
  const streaming = useStream !== false;
  const requestBody = Object.assign({}, body, { stream: streaming });
  const headers = buildHeaders(apiKey, streaming);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;

  if (controller) {
    timer = setTimeout(function () {
      try { controller.abort(); } catch (e) { /* ignore */ }
    }, REQUEST_TIMEOUT_MS);
  }

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
      const streamed = await readStreamResponse(res);
      if (streamed) return streamed;
      throw new Error('Perplexity החזיר תשובה ריקה — נסו שוב בעוד רגע.');
    }

    const responseText = await res.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch (parseErr) {
      throw new Error('Perplexity API returned non-JSON: ' + responseText.slice(0, 200));
    }
    const content = extractMessageContent(data);
    if (!content) throw new Error('Perplexity החזיר תשובה ריקה — נסו שוב בעוד רגע.');
    return content;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function httpsPerplexity(apiKey, body) {
  const requestBody = Object.assign({}, body, { stream: false });
  const headers = buildHeaders(apiKey, false);
  const result = await httpsPostJson(PERPLEXITY_URL, headers, requestBody, REQUEST_TIMEOUT_MS);
  if (result.status < 200 || result.status >= 300) {
    throw mapHttpError(result.status, result.text);
  }
  let data;
  try {
    data = result.text ? JSON.parse(result.text) : null;
  } catch (parseErr) {
    throw new Error('Perplexity API returned non-JSON: ' + String(result.text || '').slice(0, 200));
  }
  const content = extractMessageContent(data);
  if (!content) throw new Error('Perplexity החזיר תשובה ריקה — נסו שוב בעוד רגע.');
  return content;
}

/**
 * Call Perplexity chat completions — streaming first, https fallback on fetch failure.
 */
async function callPerplexityChat(options) {
  const opts = options || {};
  const apiKey = normalizeApiKey(opts.apiKey || resolveApiKey());
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY is not configured');
  }

  const body = {
    model: opts.model || PERPLEXITY_MODEL,
    temperature: opts.temperature != null ? opts.temperature : 0.35,
    messages: opts.messages || [],
  };

  const useStream = opts.stream !== false;

  try {
    return await fetchPerplexity(apiKey, body, useStream);
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const isNetwork = /fetch failed|network|timeout|abort|ECONN|ENOTFOUND|UND_ERR/i.test(msg);
    if (!isNetwork) throw fetchErr;

    console.warn('[perplexity] fetch failed, retrying via https:', msg);
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
  normalizeApiKey,
  resolveApiKey,
  callPerplexityChat,
  extractMessageContent,
};
