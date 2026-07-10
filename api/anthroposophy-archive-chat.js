/**
 * POST /api/anthroposophy-archive-chat
 *
 * Fully isolated Perplexity chat for anthroposophy / Waldorf archive sources.
 * Does not touch /api/generate, general search, community, or Word export paths.
 */
const perplexityClient = require('./perplexity-client');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Email',
};

const SYSTEM_PROMPT =
  'אתה מנוע חיפוש פדגוגי מומחה לחינוך ולדורף. כשמשתמש שואל שאלה, בצע חיפוש חי באינטרנט ובמאגרים הבאים במקביל:\n' +
  '- תיקיית הגוגל דרייב הייעודית: `1N50V9Njt3E6IQDX0OfktLM7qkhzyJ0Cs`\n' +
  '- האתרים: `rsarchive.org` ו-`daniel-zahavi.co.il`\n' +
  "- תכנים, תיאורים ותמלולים של הפודקאסט של גלעד גולדשמידט והפודקאסט 'מסעות בחינוך'.\n" +
  '- בנוסף, מותר לך לסרוק ולזהות בעצמך כל מאגר מאמרים, ארכיון, ספרייה דיגיטלית או אתר רשמי ברשת העוסקים באנתרופוסופיה ובמשנתו של רודולף שטיינר.\n' +
  'אל תציג תוצאות מפורומים כלליים או אתרים שאינם קשורים ישירות לזרם הוולדורף. החזר תשובה ותקציר ממוקד בעברית, ובסוף התשובה ספק תמיד קישורים חיים וכחולים (URLs) לדפים ולמאמרים הספציפיים שמהם הבאת את המידע ברשת.';

const MAX_HISTORY = 8;
const MAX_MESSAGE_LEN = 4000;

function setCors(res) {
  Object.keys(corsHeaders).forEach(function (key) {
    res.setHeader(key, corsHeaders[key]);
  });
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(statusCode).json(payload);
}

function parseRequestBody(req) {
  const rawBody = req.body;
  if (rawBody === undefined || rawBody === null) return null;
  if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return rawBody.trim() ? JSON.parse(rawBody) : null;
  if (Buffer.isBuffer(rawBody)) {
    const text = rawBody.toString('utf8');
    return text.trim() ? JSON.parse(text) : null;
  }
  return rawBody;
}

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-MAX_HISTORY)
    .map(function (item) {
      if (!item || typeof item !== 'object') return null;
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      const content = String(item.content || item.text || '').trim();
      if (!content) return null;
      return { role: role, content: content.slice(0, MAX_MESSAGE_LEN) };
    })
    .filter(Boolean);
}

function appendCitationLinks(answer, citations) {
  const text = String(answer || '').trim();
  const urls = Array.isArray(citations)
    ? citations
        .map(function (c) {
          if (typeof c === 'string') return c.trim();
          if (c && typeof c === 'object') return String(c.url || c.link || '').trim();
          return '';
        })
        .filter(function (u) {
          return /^https?:\/\//i.test(u);
        })
    : [];

  if (!urls.length) return text;

  const missing = urls.filter(function (url) {
    return text.indexOf(url) === -1;
  });
  if (!missing.length) return text;

  return (
    text +
    '\n\nמקורות:\n' +
    missing
      .map(function (url, i) {
        return String(i + 1) + '. ' + url;
      })
      .join('\n')
  );
}

async function executeAnthroposophyArchiveChat(req) {
  const body = parseRequestBody(req) || {};
  const message = String(body.message || body.question || body.query || '').trim();
  if (!message) {
    const err = new Error('נא להזין שאלה');
    err.statusCode = 400;
    throw err;
  }
  if (message.length > MAX_MESSAGE_LEN) {
    const err = new Error('השאלה ארוכה מדי');
    err.statusCode = 400;
    throw err;
  }

  if (!perplexityClient.resolveApiKey()) {
    const err = new Error('שירות החיפוש אינו מוגדר כרגע');
    err.statusCode = 503;
    throw err;
  }

  const history = normalizeHistory(body.history || body.chatHistory);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
    .concat(history)
    .concat([{ role: 'user', content: message }]);

  console.log('[anthroposophy-archive-chat] request', {
    messageLen: message.length,
    historyLen: history.length,
  });

  const result = await perplexityClient.callPerplexityChatWithCitations({
    model: perplexityClient.PERPLEXITY_SEARCH_MODEL,
    temperature: 0.2,
    max_tokens: 4000,
    messages: messages,
  });

  const answer = appendCitationLinks(result.content, result.citations);
  if (!answer) {
    const err = new Error('לא התקבלה תשובה מהמנוע. נסו שוב.');
    err.statusCode = 502;
    throw err;
  }

  return {
    ok: true,
    answer: answer,
    citations: Array.isArray(result.citations) ? result.citations : [],
  };
}

async function legacyHandler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  try {
    const data = await executeAnthroposophyArchiveChat(req);
    return sendJson(res, 200, { ok: true, data: data });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn('[anthroposophy-archive-chat]', status, err.message || err);
    return sendJson(res, status, {
      ok: false,
      error: err.message || String(err),
    });
  }
}

module.exports = {
  legacyHandler,
  executeAnthroposophyArchiveChat,
  SYSTEM_PROMPT,
};
