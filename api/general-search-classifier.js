/**
 * Gemini classifier for the GENERAL SEARCH archive (phase=general_search).
 *
 * Mirrors the flexible semantic check already used for topic/lesson disambiguation:
 * before spending a live Perplexity crawl we ask Gemini whether the new query is the
 * SAME pedagogical concept as one of the already-archived general searches.
 *
 * Word order is irrelevant and grade designations ("כיתה ז", "תקופה ז", "שכבה ז", "ז׳")
 * all refer to the same grade — so "רנסנס תקופה ז" and "כיתה ז רנסנס" are the same concept.
 *
 * Verdicts:
 *   - "exact"   → same concept AND same grade/scope → safe to reuse the archive silently.
 *   - "partial" → very likely the same concept but enough doubt to ask "האם התכוונת ל…".
 *   - "none"    → not the same concept → fall through to a live Perplexity run.
 */
const env = require('./env');
const jsonRepair = require('./json-repair');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = 'gemini-2.5-flash';

/** Minimum confidence to silently reuse an archived result without asking the teacher. */
const GENERAL_SEARCH_EXACT_MIN_CONFIDENCE = 0.9;
/** Minimum confidence to surface a "did you mean…" partial suggestion. */
const GENERAL_SEARCH_PARTIAL_MIN_CONFIDENCE = 0.7;

const SYSTEM_PROMPT = [
  'You are a Hebrew Waldorf-pedagogy search classifier.',
  'You receive a NEW teacher search query and a numbered catalog of queries already stored in the archive.',
  'Decide whether the NEW query refers to the SAME pedagogical concept as one of the archived queries.',
  'Rules for "same concept":',
  '- Word order is irrelevant ("רנסנס תקופה ז" == "תקופה ז רנסנס").',
  '- Grade designations are interchangeable and do NOT change the concept: "כיתה ז", "תקופה ז", "שכבה ז", "כיתה ז׳", "ז׳", "גיל 13" all mean the same grade.',
  '- The literal word "כיתה"/"תקופה"/"שכבה"/"לימוד"/"נושא" is filler and never changes the essence of the concept.',
  '- Hebrew morphology, definite article (ה), and synonyms/pedagogical aliases count as the same concept (e.g. "מיתולוגיה נורדית" == "סיפורי הצפון").',
  'NEVER treat a different subject, epoch, or grade as the same concept.',
  'Choose the single best archived candidate, if any.',
  'verdict = "exact" when it is the same concept AND the same grade/scope (confidence >= ' + GENERAL_SEARCH_EXACT_MIN_CONFIDENCE + ').',
  'verdict = "partial" when it is very likely the same concept but you are not fully certain (confidence >= ' + GENERAL_SEARCH_PARTIAL_MIN_CONFIDENCE + ').',
  'verdict = "none" when no archived query is the same concept.',
  'Respond ONLY with valid JSON (no markdown, no commentary): {"match":{"key":"<catalog key or empty>","verdict":"exact|partial|none","confidence":0.0-1.0,"reason":"brief Hebrew"}}.',
].join(' ');

function buildCandidateText(candidates) {
  return candidates
    .slice(0, 60)
    .map(function (candidate, index) {
      return (index + 1) + '. [' + candidate.key + '] «' + String(candidate.query || '').trim() + '»';
    })
    .join('\n');
}

function buildUserPrompt(query, candidates) {
  return [
    'שאילתה חדשה: «' + String(query || '').trim() + '»',
    '',
    'ארכיב חיפושים קיימים:',
    buildCandidateText(candidates),
  ].join('\n');
}

function normalizeVerdict(raw, confidence) {
  const verdict = String(raw || '').trim().toLowerCase();
  if (verdict === 'exact' && confidence >= GENERAL_SEARCH_EXACT_MIN_CONFIDENCE) return 'exact';
  if ((verdict === 'exact' || verdict === 'partial') && confidence >= GENERAL_SEARCH_PARTIAL_MIN_CONFIDENCE) {
    return 'partial';
  }
  return 'none';
}

/**
 * @param {string} query             The new teacher query.
 * @param {Array<{key:string, query:string}>} candidates  Archived general_search queries.
 * @returns {Promise<{key:string, verdict:string, confidence:number, reason:string}|null>}
 */
async function classifyGeneralSearchArchiveMatch(query, candidates) {
  const apiKey = env.getGeminiApiKey();
  const list = Array.isArray(candidates) ? candidates.filter(function (c) { return c && c.key && c.query; }) : [];
  if (!apiKey || !String(query || '').trim() || !list.length) return null;

  const url = GEMINI_API_BASE + '/models/' + encodeURIComponent(GEMINI_MODEL) + ':generateContent';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(query, list) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (fetchErr) {
    console.warn('[general-search-classifier] Gemini call failed:', fetchErr.message || fetchErr);
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(function () { return ''; });
    console.warn('[general-search-classifier] Gemini HTTP', res.status, errText.slice(0, 200));
    return null;
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    console.warn('[general-search-classifier] non-JSON Gemini response');
    return null;
  }

  const candidatesOut = data && data.candidates;
  const parts = candidatesOut && candidatesOut[0] && candidatesOut[0].content && candidatesOut[0].content.parts;
  const content = Array.isArray(parts)
    ? parts.map(function (part) { return part && part.text ? part.text : ''; }).join('').trim()
    : '';
  if (!content) return null;

  let parsed;
  try {
    parsed = jsonRepair.cleanAndParseJSON(content, { fallbackOnError: false, unwrap: true });
  } catch (jsonErr) {
    parsed = jsonRepair.safeParseJson(content);
  }
  const match = parsed && typeof parsed === 'object' ? parsed.match : null;
  if (!match || typeof match !== 'object') return null;

  const key = String(match.key || '').trim();
  const confidence = Number(match.confidence);
  if (!key || !Number.isFinite(confidence)) return null;

  const allowed = list.some(function (c) { return c.key === key; });
  if (!allowed) return null;

  const verdict = normalizeVerdict(match.verdict, confidence);
  if (verdict === 'none') return null;

  return {
    key: key,
    verdict: verdict,
    confidence: confidence,
    reason: String(match.reason || '').trim(),
  };
}

module.exports = {
  classifyGeneralSearchArchiveMatch,
  GENERAL_SEARCH_EXACT_MIN_CONFIDENCE,
  GENERAL_SEARCH_PARTIAL_MIN_CONFIDENCE,
};
