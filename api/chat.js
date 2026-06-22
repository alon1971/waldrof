/**
 * Pedagogical side-assistant chat — GEMINI ONLY, READ-ONLY.
 * Reads cached phase data via user prompt context; never generates, persists, or overwrites core phase payloads.
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

const CHAT_ONCE_PER_CONVERSATION_RULE =
  '\n=== CHAT — ONCE-PER-CONVERSATION ARCHIVE NOTICE (FIRST REPLY ONLY) ===\n' +
  'This is the FIRST assistant reply in this chat session.\n' +
  'You MAY mention once that content was retrieved from the community archive, use a brief community/catalog greeting, ' +
  'or open with the no-match sentence when applicable — ONLY in this first reply.\n' +
  '=== END CHAT — ONCE-PER-CONVERSATION ARCHIVE NOTICE ===\n';

const CHAT_CONTINUATION_NO_ARCHIVE_INSTRUCTION =
  '\n=== CHAT CONTINUATION — NO ARCHIVE NOTICES (ABSOLUTE — MANDATORY) ===\n' +
  'This is NOT the first reply in this chat session. The teacher already received any archive or community greetings.\n' +
  'STRICTLY FORBIDDEN in this reply:\n' +
  '- Repeating that the topic is in the archive, community database, מאגר, or cache\n' +
  '- Programmatic celebration openings («הרווחת!», «מצאנו במאגר», catalog redirects, «' +
  CHAT_NO_COMMUNITY_MATCH_OPENING_HE + '»)\n' +
  '- Referencing database states, match counts, vector search, Supabase, or retrieval pipeline status\n' +
  '- Administrative intros or meta-commentary about where data came from\n' +
  'Jump DIRECTLY into the requested pedagogical content. Maintain clean, professional, practical Hebrew prose.\n' +
  'You may still ground answers in matched materials silently — never announce them again.\n' +
  '=== END CHAT CONTINUATION — NO ARCHIVE NOTICES ===\n';

const CHAT_JSON_OUTPUT_INSTRUCTION =
  '\n=== CHAT OUTPUT: RAW JSON ONLY (MANDATORY) ===\n' +
  'Required shape: { "text": "<your full Hebrew pedagogical reply>" }\n' +
  '=== END CHAT OUTPUT ===\n';

const CHAT_NO_INVENTED_CITATIONS_INSTRUCTION =
  '\n=== CHAT — STRICT GROUNDING (ABSOLUTE) ===\n' +
  'Never invent fake bold citations or [1][2] markers when no community match exists.\n' +
  '=== END CHAT — STRICT GROUNDING ===\n';

const CHAT_STRICT_PROMPT_ISOLATION_INSTRUCTION =
  '\n=== CHAT — STRICT PROMPT ISOLATION (ABSOLUTE — MANDATORY) ===\n' +
  'Answer EXCLUSIVELY and ONLY the teacher\'s typed question in this turn.\n' +
  'FORBIDDEN: injecting, assuming, or mixing any hidden UI state — selected grade, active lesson topic, ' +
  'cached grade/topic overviews, biographies from other grades, curriculum summaries, or site background ' +
  'unless the teacher explicitly names them in the question text.\n' +
  'Infer Waldorf grade ONLY from entities named in the question (e.g. אודיסאוס → Grade 5) — never from the screen.\n' +
  'Community-archive excerpts matched to the question may enrich silently; never pivot to unrelated grades/topics.\n' +
  '=== END CHAT — STRICT PROMPT ISOLATION ===\n';

function normalizeChatHistoryRole(role) {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'model' || r === 'assistant' || r === 'ai') return 'assistant';
  if (r === 'user' || r === 'human') return 'user';
  return r;
}

/** True when no prior assistant reply exists in chatHistory (first turn of the session). */
function isFirstChatTurnInSession(body) {
  if (!body || typeof body !== 'object') return true;
  const history = Array.isArray(body.chatHistory) ? body.chatHistory : [];
  if (!history.length) return true;
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry || typeof entry !== 'object') continue;
    if (normalizeChatHistoryRole(entry.role) === 'assistant') return false;
  }
  return true;
}

function isChatContinuationTurn(body) {
  return !isFirstChatTurnInSession(body);
}

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
  return 'gemini_kb';
}

function isChatGradeDecoupled(body, promptMode) {
  return pedagogicalScope.shouldBypassPedagogicalScopeForChat(body, promptMode || resolveChatPromptMode(body));
}

function pedagogicalChatSystemPrompt(extra, mode, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const inferredGradeBlock = opts.inferredGradeBlock || '';
  const isFirstTurn = opts.isFirstTurn !== false;
  const isContinuation = !isFirstTurn;
  const baseRole =
    'You are the Pedagogical Chat Assistant for Waldorf / Steiner-Waldorf teachers — an expert educational consultant. ' +
    'Help teachers with follow-up questions as a supportive, highly accurate pedagogical peer. ' +
    'STRICT: This chat is Gemini-only — never use, simulate, or reference Perplexity, Sonar, or live web search. ' +
    'STRICT PROMPT ISOLATION: Answer only what the teacher typed — never bleed in UI lesson state or other grades\' curriculum. ';

  const conversationRule = isContinuation
    ? CHAT_CONTINUATION_NO_ARCHIVE_INSTRUCTION
    : CHAT_ONCE_PER_CONVERSATION_RULE;

  const sharedTail =
    conversationRule +
    CHAT_STRICT_PROMPT_ISOLATION_INSTRUCTION +
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

  if (mode === 'expansion' || isContinuation) {
    return (
      baseRole +
      (mode === 'expansion'
        ? 'The teacher wants MORE pedagogical materials or DEEPER ideas — deliver fresh, practical Hebrew content from your Waldorf knowledge base. '
        : 'Continue the pedagogical conversation — answer the teacher\'s follow-up directly with practical Hebrew content. ') +
      'Ignore any community archive blocks in the user message; they are background only and must NOT drive openings or admin intros. ' +
      STEINER_ANTHROPOSOPHIC_FIDELITY_INSTRUCTION +
      (mode === 'expansion' ? CHAT_EXPANSION_MODE_INSTRUCTION : '') +
      sharedTail
    );
  }

  return (
    baseRole +
    'Answer from your native Waldorf pedagogical knowledge base with practical insights and book/article recommendations. ' +
    'Give clear, professional guidance — never mention community archive, מאגר, folder counts, or catalog redirects. ' +
    'Never fake bold citations or structured placeholders. ' +
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

  const stripGreeting = Boolean(
    opts.expansionRequest || opts.stripCommunityGreeting || opts.chatContinuation
  );

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

  if (opts.expansionRequest || opts.chatContinuation) {
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
  const isFirstTurn = isFirstChatTurnInSession(body);
  const chatContinuation = isChatContinuationTurn(body);
  const promptMode = resolveChatPromptMode(body);
  const effectivePromptMode = chatContinuation && promptMode !== 'expansion' ? 'continuation' : promptMode;
  const gradeDecoupled = isChatGradeDecoupled(body, promptMode);
  const userMessage = String((body && body.userMessage) || '').trim();
  const inferredGradeBlock = gradeDecoupled && userMessage
    ? pedagogicalScope.buildChatInferredGradeBlock(userMessage)
    : '';
  const sanitizeOpts = {
    expansionRequest: expansionRequest,
    chatContinuation: chatContinuation,
  };

  if (gradeDecoupled) {
    body.chatGradeDecoupled = true;
    body.skipPedagogicalScopeValidation = true;
    console.log('[chat] grade-decoupled side-chat mode:', promptMode, '— UI grade scope lock bypassed');
  }

  if (chatContinuation) {
    console.log('[chat] continuation turn — once-per-conversation archive notices suppressed');
  }

  const chatExtra = extraSystem + (
    expansionRequest || chatContinuation
      ? ' PEDAGOGICAL CHAT — CONTINUATION: Jump directly into pedagogical content. ' +
        'Do NOT repeat archive greetings, community-match openings, catalog redirects, or database status.'
      : ' PEDAGOGICAL CHAT — GEMINI KNOWLEDGE BASE: Answer from your Waldorf pedagogical expertise. ' +
        'Do NOT mention community archive, מאגר, folder counts, or catalog redirects. No live web search.'
  );
  let lastRaw = '';

  for (let attempt = 1; attempt <= MODEL_PARSE_MAX_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    const retrySuffix = isRetry
      ? ' CRITICAL RETRY: Your previous reply was rejected — return ONLY valid JSON {"text":"..."} with no markdown fences or extra text.'
      : '';
    const systemContent = pedagogicalChatSystemPrompt(chatExtra + retrySuffix, effectivePromptMode, {
      inferredGradeBlock: inferredGradeBlock,
      isFirstTurn: isFirstTurn,
    });
    let raw;
    try {
      if (isRetry) {
        console.warn('[chat] Silent Gemini retry (attempt', attempt + '/' + MODEL_PARSE_MAX_ATTEMPTS + ')');
      }
      console.log(
        '[chat] Gemini-only pipeline',
        expansionRequest ? '(expansion — fresh pedagogical generation)' :
        chatContinuation ? '(continuation — no archive notices)' :
        '(Gemini pedagogical knowledge base)'
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

    const data = sanitizeChatReplyPayload(normalizeChatFollowupFromModel(raw), sanitizeOpts);
    if (data && data._parseFallback) {
      return sanitizeChatReplyPayload(data, sanitizeOpts);
    }
    if (cacheDb.extractChatAnswerText(data)) {
      return sanitizeChatReplyPayload(data, sanitizeOpts);
    }
    if (attempt >= MODEL_PARSE_MAX_ATTEMPTS) {
      return sanitizeChatReplyPayload(normalizeChatFollowupFromModel(lastRaw || ''), sanitizeOpts);
    }
  }

  return sanitizeChatReplyPayload(normalizeChatFollowupFromModel(lastRaw || ''), sanitizeOpts);
}

function resolveChatApiKey() {
  return env.getGeminiApiKey() || null;
}

function missingChatApiKeyError() {
  return 'מפתח Gemini לא מוגדר. הוסיפו GEMINI_API_KEY ב-Render → Environment ופרסמו מחדש.';
}

module.exports = {
  CHAT_STRICT_PROMPT_ISOLATION_INSTRUCTION,
  callGeminiV1,
  clearCommunityArchiveContextForExpansion,
  fetchPedagogicalChat,
  isChatContinuationTurn,
  isChatGradeDecoupled,
  isChatPedagogicalExpansionRequest,
  isFirstChatTurnInSession,
  normalizeChatHistoryRole,
  missingChatApiKeyError,
  pedagogicalChatSystemPrompt,
  resolveChatApiKey,
  resolveChatPromptMode,
  shouldTreatChatAsPedagogicalExpansion,
  stripCommunityGreetingFromChatText,
  stripRawUrlsFromChatText,
};
