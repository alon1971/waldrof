/**
 * Pedagogical side-assistant chat — GEMINI ONLY.
 * Reads cached phase data via user prompt context; never generates or overwrites core phase payloads.
 */
const env = require('./env');
const cacheDb = require('./cache');
const jsonRepair = require('./json-repair');
const pedagogicalScope = require('./pedagogical-scope');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1';
const GEMINI_API_BASE_STRUCTURED = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_GENERATION_MODEL = 'gemini-2.5-flash';
const MODEL_PARSE_MAX_ATTEMPTS = 2;

const {
  cleanAndParseJSON,
  buildModelParseFallback,
  stripMarkdownJsonFences,
} = jsonRepair;

const CHAT_NO_COMMUNITY_MATCH_OPENING_HE =
  'לא מצאתי תוכן תואם במאגר הקהילתי, אך הנה הצעה פדגוגית כללית עבורך:';

const JSON_ONLY_INSTRUCTION =
  'Return ONLY the raw, valid JSON object matching the requested schema. ' +
  'Do not include any markdown formatting, do not wrap the response in ```json ... ``` blocks, ' +
  'and do not append any text, explanations, or extra characters before or after the JSON structure.';

const JSON_RESPONSE_ENFORCEMENT =
  '\n=== OUTPUT: RAW JSON ONLY (ABSOLUTE — MANDATORY) ===\n' +
  'Your ENTIRE reply MUST be exactly ONE valid JSON object — nothing before it, nothing after it.\n' +
  '=== END OUTPUT: RAW JSON ONLY ===\n';

const JSON_VALID_SYNTAX_INSTRUCTION =
  '\n=== JSON STRING ESCAPING (MANDATORY) ===\n' +
  'The entire response MUST pass JSON.parse() with zero syntax errors.\n' +
  '=== END JSON STRING ESCAPING ===\n';

const NO_LATEX_BLOCK =
  '\n=== NO LATEX (MANDATORY) ===\n' +
  'Do NOT use LaTeX, $...$, \\frac, or math markup. Use plain Hebrew text.\n' +
  '=== END NO LATEX ===\n';

const STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION =
  '\n=== STEINER / ANTHROPOSOPHIC SOURCE FIDELITY (CRITICAL) ===\n' +
  'Base pedagogical content on verified Rudolf Steiner and Waldorf sources. Never hallucinate doctrines or practices.\n' +
  '=== END STEINER / ANTHROPOSOPHIC SOURCE FIDELITY ===\n';

const CHAT_NO_RAW_URLS_INSTRUCTION =
  '\n=== CHAT — NO RAW URLS (ABSOLUTE) ===\n' +
  'NEVER include raw http:// or https:// links, file_path strings, storage paths, or Supabase URLs in the "text" field.\n' +
  'Guide teachers to catalog locations using grade and subject folder names only — the UI handles navigation separately.\n' +
  '=== END CHAT — NO RAW URLS ===\n';

const PEDAGOGICAL_CHAT_GROUNDING_INSTRUCTION =
  '\n=== PEDAGOGICAL CHAT — COMMUNITY ARCHIVE FIRST → GEMINI KNOWLEDGE BASE (MANDATORY) ===\n' +
  'This chat pipeline is DECOUPLED from live web search. Do NOT perform or simulate Perplexity, Sonar, or any internet search.\n' +
  '0. COMMUNITY ARCHIVE FIRST: Review COMMUNITY MATERIALS DATABASE in the user message.\n' +
  '1. GEMINI PEDAGOGICAL KNOWLEDGE BASE (fallback): Expert Waldorf educational consultant.\n' +
  'NO COMMUNITY MATCH: Open with «' + CHAT_NO_COMMUNITY_MATCH_OPENING_HE + '»\n' +
  '=== END PEDAGOGICAL CHAT ===\n';

const CHAT_EXPANSION_MODE_INSTRUCTION =
  '\n=== EXPANSION FOLLOW-UP — GEMINI GENERATION ONLY (MANDATORY) ===\n' +
  'The teacher explicitly asked for MORE materials, DEEPER ideas, or additional pedagogical content.\n' +
  'STRICT: This is a fresh-generation request — do NOT repeat community-match celebration openings, ' +
  'archive announcements, catalog redirects, or prior file references.\n' +
  'Do NOT open with «' + CHAT_NO_COMMUNITY_MATCH_OPENING_HE + '» or any archive alert phrasing.\n' +
  'Generate rich, original Waldorf pedagogical content: practical activities, classroom flow, developmental context, ' +
  'and book/article recommendations (title + author only — never URLs).\n' +
  '=== END EXPANSION FOLLOW-UP ===\n';

const CHAT_JSON_OUTPUT_INSTRUCTION =
  '\n=== CHAT OUTPUT: RAW JSON ONLY (MANDATORY) ===\n' +
  'Required shape: { "text": "<your full Hebrew pedagogical reply>" }\n' +
  '=== END CHAT OUTPUT ===\n';

const CHAT_NO_INVENTED_CITATIONS_INSTRUCTION =
  '\n=== CHAT — STRICT GROUNDING (ABSOLUTE) ===\n' +
  'Never invent fake bold citations or [1][2] markers when no community match exists.\n' +
  '=== END CHAT — STRICT GROUNDING ===\n';

function shouldTreatChatAsPedagogicalExpansion(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.chatExpansionRequest === true || body.skipCommunityArchive === true) return true;
  return isChatPedagogicalExpansionRequest(body);
}

function clearCommunityArchiveContextForExpansion(body) {
  if (!body || !shouldTreatChatAsPedagogicalExpansion(body)) return false;
  const query = String(body.userMessage || '').trim();
  body.chatExpansionRequest = true;
  body.skipCommunityArchive = true;
  body.skipRag = true;
  body.chatForceGeminiOnly = true;
  body.communityMaterialsProbe = {
    matches: [],
    count: 0,
    query: query,
    matchMethod: 'skipped_expansion',
    scope: 'global',
  };
  body.ragContext = '';
  body.ragCommunityContext = '';
  body.ragDriveContext = '';
  body.ragChunkIds = [];
  return true;
}

function resolveChatPromptMode(body) {
  if (shouldTreatChatAsPedagogicalExpansion(body)) return 'expansion';
  if (
    body &&
    body.communityMaterialsProbe &&
    body.communityMaterialsProbe.count > 0 &&
    body.communityMaterialsProbe.matchMethod !== 'skipped_expansion'
  ) {
    return 'community_match';
  }
  return 'gemini_kb';
}

function isChatGradeDecoupled(body, promptMode) {
  return pedagogicalScope.shouldBypassPedagogicalScopeForChat(body, promptMode || resolveChatPromptMode(body));
}

function pedagogicalChatSystemPrompt(extra, mode, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const inferredGradeBlock = opts.inferredGradeBlock || '';
  const baseRole =
    'You are the Pedagogical Chat Assistant for Waldorf / Steiner-Waldorf teachers — an expert educational consultant. ' +
    'Help teachers with follow-up questions as a supportive, highly accurate pedagogical peer. ' +
    'STRICT: This chat is Gemini-only — never use, simulate, or reference Perplexity, Sonar, or live web search. ' +
    'You may READ lesson context from cached grade/topic data in the user message but must NEVER regenerate or overwrite Phase A/B/C core content. ';

  const sharedTail =
    pedagogicalScope.CHAT_GRADE_DECOUPLED_INSTRUCTION +
    inferredGradeBlock +
    CHAT_NO_RAW_URLS_INSTRUCTION +
    CHAT_NO_INVENTED_CITATIONS_INSTRUCTION +
    CHAT_JSON_OUTPUT_INSTRUCTION +
    JSON_ONLY_INSTRUCTION +
    JSON_RESPONSE_ENFORCEMENT +
    JSON_VALID_SYNTAX_INSTRUCTION +
    ' Write all chat replies in Hebrew inside the JSON "text" field. ' +
    NO_LATEX_BLOCK +
    (extra || '');

  if (mode === 'expansion') {
    return (
      baseRole +
      'The teacher wants MORE pedagogical materials or DEEPER ideas — deliver fresh, practical Hebrew content from your Waldorf knowledge base. ' +
      'Ignore any community archive blocks in the user message; they are background only and must NOT drive your reply. ' +
      STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
      CHAT_EXPANSION_MODE_INSTRUCTION +
      sharedTail
    );
  }

  if (mode === 'community_match') {
    return (
      baseRole +
      'COMMUNITY ARCHIVE MATCH: A verified community file matched this question. ' +
      'Mention the matched title and grade naturally in professional prose — do NOT use formulaic celebration greetings ' +
      '(no «הרווחת!», no «מצאנו במאגר», no catalog redirect boilerplate). ' +
      'Enrich from matched title/subject/description metadata — never paste raw URLs. ' +
      STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
      PEDAGOGICAL_CHAT_GROUNDING_INSTRUCTION +
      sharedTail
    );
  }

  return (
    baseRole +
    'No direct community archive match for this question. Answer from your native pedagogical knowledge base with practical insights and book/article recommendations. ' +
    'Open with «' + CHAT_NO_COMMUNITY_MATCH_OPENING_HE + '» and give practical Waldorf guidance — never fake bold citations or structured placeholders. ' +
    STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
    PEDAGOGICAL_CHAT_GROUNDING_INSTRUCTION +
    sharedTail
  );
}

function getChatFollowupResponseSchema() {
  return {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Full Hebrew pedagogical chat reply — warm prose, plain text or light Markdown.',
      },
    },
    required: ['text'],
  };
}

function extractGeminiV1Text(payload) {
  const candidates = payload && payload.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return '';
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
    throw new Error('שגיאה: מפתח GEMINI_API_KEY לא מוגדר בשרת');
  }

  const model = opts.model || GEMINI_GENERATION_MODEL;
  const useStructuredApi = opts.jsonMode === true;
  const apiBase = useStructuredApi ? GEMINI_API_BASE_STRUCTURED : GEMINI_API_BASE;
  const url = apiBase + '/models/' + encodeURIComponent(model) + ':generateContent';

  const generationConfig = {
    temperature: opts.temperature != null ? opts.temperature : 0.35,
  };
  if (opts.jsonMode === true) {
    generationConfig.responseMimeType = 'application/json';
    if (opts.responseSchema && typeof opts.responseSchema === 'object') {
      generationConfig.responseSchema = opts.responseSchema;
    }
  }

  const body = { generationConfig: generationConfig };
  if (useStructuredApi) {
    body.contents = [{ role: 'user', parts: [{ text: userPrompt }] }];
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  } else {
    const contents = [];
    const systemText = systemPrompt != null ? String(systemPrompt).trim() : '';
    if (systemText) {
      contents.push({ role: 'user', parts: [{ text: systemText }] });
    }
    contents.push({ role: 'user', parts: [{ text: userPrompt }] });
    body.contents = contents;
  }

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
    throw new Error('Gemini returned non-JSON response (' + res.status + '): ' + raw.slice(0, 300));
  }

  if (!res.ok) {
    const msg = payload.error && payload.error.message ? payload.error.message : raw.slice(0, 300);
    const err = new Error('Gemini error ' + res.status + ': ' + msg);
    if (res.status === 429 || res.status === 400 || res.status === 403) {
      err.statusCode = res.status;
    }
    throw err;
  }

  const text = extractGeminiV1Text(payload);
  if (!text) {
    throw new Error('Gemini החזיר תשובה ריקה — נסו שוב בעוד רגע.');
  }
  return text;
}

function normalizeChatFollowupFromModel(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return buildModelParseFallback('chat_followup', '', {});
  }

  try {
    const stripped = stripMarkdownJsonFences(text);
    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch (directErr) {
      parsed = cleanAndParseJSON(stripped, {
        phase: 'chat_followup',
        fallbackOnError: false,
        unwrap: true,
      });
    }

    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        return { chatReply: { answer: String(parsed.text).trim() } };
      }
      if (parsed.chatReply && typeof parsed.chatReply === 'object') {
        return parsed;
      }
      if (parsed.reply) {
        return { chatReply: { answer: String(parsed.reply).trim() } };
      }
      if (parsed.answer || parsed.answerHtml) {
        return { chatReply: parsed };
      }
    }
  } catch (parseErr) {
    console.warn(
      '[chat] chat_followup JSON parse failed, packaging raw text:',
      parseErr instanceof Error ? parseErr.message : parseErr
    );
  }

  const fallbackText = stripMarkdownJsonFences(text).trim() || text;
  return {
    chatReply: { answer: fallbackText },
    _parseFallback: true,
  };
}

function isNonRetriableApiClientError(err) {
  const msg = err instanceof Error ? err.message : String(err || '');
  const statusCode = err && err.statusCode;
  if (statusCode === 429 || statusCode === 400 || statusCode === 403) return true;
  return /Gemini error (429|400|403)\b/i.test(msg)
    || /\berror 429\b/i.test(msg)
    || /\berror 400\b/i.test(msg)
    || /rate limit|quota exceeded|resource exhausted|too many requests|high demand|retry in [0-9.]+s/i.test(msg)
    || /invalid argument|INVALID_ARGUMENT|bad request/i.test(msg);
}

function isRetriableChatError(err) {
  if (isNonRetriableApiClientError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err || '');
  return !/API key|unauthorized|GEMINI_API_KEY|not configured|Method not allowed/i.test(msg);
}

function rethrowChatError(err, fallbackMessage) {
  const msg = err instanceof Error ? err.message : String(err || '');
  if (err instanceof Error && err.statusCode) throw err;
  const next = new Error(msg || fallbackMessage);
  if (isNonRetriableApiClientError(err)) {
    if (/Gemini error 429|\berror 429\b|rate limit|quota exceeded|too many requests|high demand/i.test(msg)) {
      next.statusCode = 429;
    } else if (/Gemini error 400|\berror 400\b|invalid argument|INVALID_ARGUMENT|bad request/i.test(msg)) {
      next.statusCode = 400;
    }
  }
  throw next;
}

function isChatPedagogicalExpansionRequest(body) {
  const msg = String((body && body.userMessage) || '').trim();
  if (!msg) return false;
  const compact = msg.replace(/\s+/g, ' ');
  if (/חומר\s+נוסף/u.test(compact)) return true;
  if (/עוד\s+חומרים?/u.test(compact)) return true;
  if (/\b(תן|תני|תנו)\s+לי\s+עוד\b/u.test(compact)) return true;
  if (/\bעוד\s+(רעיונות|פעילויות|דוגמאות|הצעות|חומרים?|הצעות\s+פדגוגיות)\b/u.test(compact)) return true;
  if (/\b(מידע|תוכן|חומר|רעיונות|פעילויות|דוגמאות|הצעות)\s+נוספ(?:ים|ות|ה)?\b/u.test(compact)) return true;
  if (/\b(רעיונות|תוכן|הרחבה)\s+(פדגוגי|פדגוגיים|עמוק|נוסף|נוספים)\b/u.test(compact)) return true;
  if (/\b(יש|יש\s+לך|יש\s+לכם)\s+עוד\b/u.test(compact)) return true;
  if (/\b(אפשר|בוא(?:ו)?|בואי)\s+עוד\b/u.test(compact)) return true;
  if (/\bהעמק\b/u.test(compact) || /\bהרחב(?:ה|ו|י)?\b/u.test(compact)) return true;
  if (/\b(deeper|more)\s+(pedagogical|materials?|ideas?|content)\b/i.test(compact)) return true;
  if (/\bmore\s+materials?\b/i.test(compact)) return true;
  return false;
}

function stripRawUrlsFromChatText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return raw;
  return raw
    .replace(/קישור\s+ישיר[^\n.]*/giu, '')
    .replace(/https?:\/\/[^\s)\]>"']+/gi, '')
    .replace(/(?:^|\n)\s*(?:file_path|url)\s*[:=]\s*\S+/gim, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.\s*\./g, '.')
    .trim();
}

function stripCommunityGreetingFromChatText(text) {
  let result = String(text || '');
  if (!result.trim()) return result;

  result = result.replace(
    /^([^,\n]{0,48},?\s*)?הרווחת!\s*(?:מצאנו|מישהו\s+מהקהילה)[^.!\n]*[.!]\s*/iu,
    ''
  );
  result = result.replace(
    /^[^.\n]{0,48},?\s*מצאנו\s+ב(?:מאגר|ארכיון)[^.!\n]*[.!]\s*/iu,
    ''
  );
  result = result.replace(/אתה\s+יכול\s+להיכנס\s+למאגר\s+הקהילתי[^.!\n]*[.!]\s*/giu, '');
  result = result.replace(/מיקום\s+במערכת:\s*מאגר\s+קהילתי[^.!\n]*[.!]\s*/giu, '');
  result = result.replace(
    new RegExp('^\\s*' + CHAT_NO_COMMUNITY_MATCH_OPENING_HE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'u'),
    ''
  );

  return result.replace(/^\s+/, '').trim();
}

function sanitizeChatReplyPayload(data, options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (!data || !data.chatReply || typeof data.chatReply !== 'object') return data;

  const stripGreeting = Boolean(opts.expansionRequest || opts.stripCommunityGreeting);

  if (typeof data.chatReply.answer === 'string') {
    let answer = stripRawUrlsFromChatText(data.chatReply.answer);
    if (stripGreeting) answer = stripCommunityGreetingFromChatText(answer);
    data.chatReply.answer = answer;
  }
  if (typeof data.chatReply.answerHtml === 'string') {
    let answerHtml = stripRawUrlsFromChatText(data.chatReply.answerHtml);
    if (stripGreeting) answerHtml = stripCommunityGreetingFromChatText(answerHtml);
    data.chatReply.answerHtml = answerHtml;
  }

  if (opts.expansionRequest) {
    data.chatReply.routedToCommunity = false;
    delete data.chatReply.communityMatchCount;
    delete data.chatReply.matchMethod;
  }

  return data;
}

/**
 * Gemini-only pedagogical side chat (chat_followup phase).
 */
async function fetchPedagogicalChat(body, userPrompt, extraSystem) {
  clearCommunityArchiveContextForExpansion(body);
  const expansionRequest = shouldTreatChatAsPedagogicalExpansion(body);
  const promptMode = resolveChatPromptMode(body);
  const gradeDecoupled = isChatGradeDecoupled(body, promptMode);
  const hasCommunityMatch = promptMode === 'community_match';
  const userMessage = String((body && body.userMessage) || '').trim();
  const inferredGradeBlock = gradeDecoupled && userMessage
    ? pedagogicalScope.buildChatInferredGradeBlock(userMessage)
    : '';

  if (gradeDecoupled) {
    body.chatGradeDecoupled = true;
    body.skipPedagogicalScopeValidation = true;
    console.log('[chat] grade-decoupled side-chat mode:', promptMode, '— UI grade scope lock bypassed');
  }

  const chatExtra = extraSystem + (
    expansionRequest
      ? ' PEDAGOGICAL CHAT — EXPANSION FOLLOW-UP: Fresh Gemini generation only. Skip all community archive redirects and celebration openings.'
      : hasCommunityMatch
      ? ' PEDAGOGICAL CHAT — COMMUNITY ARCHIVE MATCH: Start with the mandatory opening; guide the teacher to the exact catalog location (grade → subject). Never paste raw URLs.'
      : ' PEDAGOGICAL CHAT — GEMINI KNOWLEDGE BASE: No community archive match. Act as expert educational consultant; recommend relevant books, essays, and articles. No live web search.'
  );
  let lastRaw = '';

  for (let attempt = 1; attempt <= MODEL_PARSE_MAX_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    const retrySuffix = isRetry
      ? ' CRITICAL RETRY: Your previous reply was rejected — return ONLY valid JSON {"text":"..."} with no markdown fences or extra text.'
      : '';
    const systemContent = pedagogicalChatSystemPrompt(chatExtra + retrySuffix, promptMode, {
      inferredGradeBlock: inferredGradeBlock,
    });
    let raw;
    try {
      if (isRetry) {
        console.warn('[chat] Silent Gemini retry (attempt', attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + ')');
      }
      console.log(
        '[chat] Gemini-only pipeline',
        expansionRequest ? '(expansion — fresh pedagogical generation)' :
        hasCommunityMatch ? '(community archive + Gemini)' : '(Gemini knowledge base fallback)'
      );
      raw = await callGeminiV1(systemContent, userPrompt, {
        model: GEMINI_GENERATION_MODEL,
        temperature: isRetry ? 0.2 : (expansionRequest ? 0.45 : 0.35),
        jsonMode: true,
        responseSchema: getChatFollowupResponseSchema(),
      });
      lastRaw = raw;
    } catch (geminiErr) {
      const msg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
      console.error('[chat] Gemini call failed (attempt', attempt + '):', msg);
      if (attempt < MODEL_PARSE_MAX_ATTEMPTS && isRetriableChatError(geminiErr)) {
        continue;
      }
      rethrowChatError(geminiErr, 'שגיאה בעוזר הפדגוגי — נסו שוב בעוד רגע.');
    }

    const data = sanitizeChatReplyPayload(normalizeChatFollowupFromModel(raw), { expansionRequest: expansionRequest });
    if (data && data._parseFallback) {
      return sanitizeChatReplyPayload(data, { expansionRequest: expansionRequest });
    }
    if (cacheDb.extractChatAnswerText(data)) {
      if (hasCommunityMatch) {
        data.chatReply = data.chatReply || {};
        data.chatReply.routedToCommunity = true;
        data.chatReply.communityMatchCount = body.communityMaterialsProbe.count;
        data.chatReply.matchMethod = body.communityMaterialsProbe.matchMethod || 'none';
      }
      return sanitizeChatReplyPayload(data, { expansionRequest: expansionRequest });
    }
    if (attempt >= MODEL_PARSE_MAX_ATTEMPTS) {
      return sanitizeChatReplyPayload(normalizeChatFollowupFromModel(lastRaw || ''), { expansionRequest: expansionRequest });
    }
  }

  return sanitizeChatReplyPayload(normalizeChatFollowupFromModel(lastRaw || ''), { expansionRequest: expansionRequest });
}

module.exports = {
  clearCommunityArchiveContextForExpansion,
  fetchPedagogicalChat,
  isChatGradeDecoupled,
  isChatPedagogicalExpansionRequest,
  pedagogicalChatSystemPrompt,
  resolveChatPromptMode,
  shouldTreatChatAsPedagogicalExpansion,
  stripCommunityGreetingFromChatText,
  stripRawUrlsFromChatText,
};
