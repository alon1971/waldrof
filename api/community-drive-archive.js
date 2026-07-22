/**
 * Community Drive archive — Gemini pedagogical summaries of Drive hits.
 * Used only by the standalone /api/community-summarizer flow (not live web search).
 * Public archive (no userId). Delta-refresh: re-scan Drive fingerprint → reuse or regenerate.
 */
const crypto = require('crypto');
const env = require('./env');
const driveCatalogSync = require('./drive-catalog-sync');
const jsonRepair = require('./json-repair');

const TABLE_NAME = 'community_drive_archive';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_FALLBACK_MODELS = ['gemini-2.5-pro', 'gemini-1.5-flash'];
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Exact UI copy from product spec (Hebrew). */
const COMMUNITY_SUMMARY_HEADING = 'סיכום נושא מתוך המאגר הקהילתי';
const COMMUNITY_SUMMARY_EMPTY = 'אין חומר מהארכיון עבור נושא וכיתה זו';

const MAX_FILES_FOR_SUMMARY = 24;
const MAX_CHARS_PER_FILE = 14000;
const MAX_TOTAL_CHARS = 90000;
/** Prefer inlineData under this size; larger PDFs/images use Gemini Files API. */
const MAX_GEMINI_INLINE_BYTES = 12 * 1024 * 1024;
/** Gemini document understanding PDF/image ceiling (~50MB). */
const MAX_GEMINI_MULTIMODAL_BYTES = 50 * 1024 * 1024;
const MAX_MULTIMODAL_FILES = 6;

/**
 * Strip Markdown fences (```json … ```) that Gemini sometimes wraps around JSON.
 */
function stripGeminiJsonFences(text) {
  if (typeof jsonRepair.stripMarkdownJsonFences === 'function') {
    return jsonRepair.stripMarkdownJsonFences(text);
  }
  let raw = String(text || '').replace(/^\uFEFF/, '').trim();
  const fenced = raw.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  else {
    raw = raw.replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/```\s*$/gi, '').trim();
  }
  return raw;
}

/**
 * Parse Gemini model text as JSON after fence cleanup.
 * Logs the raw response on failure so silent crashes are avoided.
 */
function parseGeminiSummaryJson(rawText) {
  const raw = String(rawText || '');
  const cleaned = stripGeminiJsonFences(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') {
      const summary = parsed.summary != null
        ? String(parsed.summary).trim()
        : (parsed.text != null ? String(parsed.text).trim() : '');
      if (summary) return summary;
    }
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
    throw new Error('JSON parsed but missing summary/text field');
  } catch (err) {
    console.error(
      '[community-drive-archive] Gemini summary JSON.parse failed:',
      err && err.message ? err.message : err
    );
    console.error(
      '[community-drive-archive] Gemini raw response (first 2000 chars):',
      raw.slice(0, 2000)
    );

    // Truncated / lightly-broken JSON: pull "summary" via balanced-ish extract.
    const summaryMatch = cleaned.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/s)
      || cleaned.match(/"summary"\s*:\s*"([\s\S]*?)(?:"\s*}?\s*$)/);
    if (summaryMatch && summaryMatch[1]) {
      try {
        const unescaped = JSON.parse('"' + summaryMatch[1].replace(/"\s*$/, '') + '"');
        if (String(unescaped || '').trim()) {
          console.warn('[community-drive-archive] recovered summary from partial JSON');
          return String(unescaped).trim();
        }
      } catch (e2) {
        const loose = summaryMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .trim();
        if (loose) {
          console.warn('[community-drive-archive] recovered summary via loose unescape');
          return loose;
        }
      }
    }

    // Fallback: plain Hebrew prose (no JSON object).
    const plain = cleaned.trim();
    if (plain && plain.charAt(0) !== '{' && plain.charAt(0) !== '[') {
      console.warn('[community-drive-archive] falling back to plain-text Gemini summary');
      return plain;
    }
    // Broken object that still contains long Hebrew prose after the opening brace.
    const proseAfterBrace = plain.replace(/^\{\s*"summary"\s*:\s*"?/, '').replace(/"\s*\}\s*$/, '').trim();
    if (proseAfterBrace.length > 80 && /[\u0590-\u05FF]/.test(proseAfterBrace)) {
      console.warn('[community-drive-archive] falling back to Hebrew prose sliced from broken JSON');
      return proseAfterBrace;
    }
    throw new Error('המודל החזיר תשובה שאינה JSON תקין');
  }
}

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServiceRoleKey() || env.getSupabaseServerKey(),
  };
}

function stableNormalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildArchiveKey(query, options) {
  const opts = options || {};
  const parts = [
    stableNormalize(query),
    String(opts.gradeId || opts.currentGrade || '').trim(),
    stableNormalize(opts.topic || opts.catalogTopic || ''),
    String(opts.phase || 'hybrid').trim(),
  ];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 40);
}

function buildSourceFingerprint(fileRefs) {
  const parts = (fileRefs || [])
    .map(function (ref) {
      return [
        String(ref.driveFileId || ref.id || '').trim(),
        String(ref.modifiedTime || '').trim(),
        String(ref.name || ref.fileName || '').trim(),
      ].join(':');
    })
    .filter(Boolean)
    .sort();
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

function normalizeFileRefsFromMatches(matches) {
  const seen = new Set();
  const refs = [];
  (matches || []).forEach(function (match) {
    if (!match) return;
    const driveFileId = String(match.driveFileId || '').trim()
      || (String(match.id || '').indexOf('drive:') === 0 ? String(match.id).slice(6) : '');
    if (!driveFileId || seen.has(driveFileId)) return;
    seen.add(driveFileId);
    refs.push({
      driveFileId: driveFileId,
      name: String(match.fileName || match.title || match.displayTitle || '').trim(),
      folderPath: String(
        match.locationPath
        || match.drivePath
        || match.pathLabels
        || match.filePath
        || ''
      ).trim().replace(/\s*\/\s*/g, ' > '),
      folder: String(match.catalogTopic || match.topic || '').trim(),
      fileUrl: String(match.webViewLink || match.fileUrl || '').trim(),
      webViewLink: String(match.webViewLink || match.fileUrl || '').trim(),
      mimeType: String(match.mimeType || '').trim(),
      resourceKey: String(match.resourceKey || '').trim(),
      modifiedTime: String(match.modifiedTime || '').trim(),
      gradeId: String(match.gradeId || match.grade_level || '').trim(),
    });
  });
  return refs.slice(0, MAX_FILES_FOR_SUMMARY);
}

async function fetchArchiveRow(archiveKey) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key || !archiveKey) return null;
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('archive_key', 'eq.' + archiveKey);
  params.set('limit', '1');
  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404 || /relation|does not exist/i.test(text)) {
      console.warn('[community-drive-archive] table missing — run supabase/community_drive_archive.sql');
      return null;
    }
    console.warn('[community-drive-archive] fetch failed:', res.status, text.slice(0, 200));
    return null;
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Convert literal escaped newlines ("\\n") into real line breaks so UI/DOCX
 * never render the characters "\n" as visible text.
 */
function normalizeEscapedNewlines(text) {
  let s = String(text == null ? '' : text);
  if (!s) return '';
  // Double-encoded JSON residue: "\\n" → real newline
  if (s.indexOf('\\n') !== -1 || s.indexOf('\\r') !== -1 || s.indexOf('\\t') !== -1) {
    s = s
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, '\t');
  }
  // Normalize real CRLF
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return s;
}

/** Leaf file/folder name only — strip "נתיב > תיקייה > …" hierarchies. */
function shortCitationDisplayName(value, fallback) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return String(fallback || 'קובץ Drive');
  s = s.replace(/^\d+[\.\)]\s*/, '').trim();
  // Prefer text before an em-dash path caption
  const dashSplit = s.split(/\s*[—–]\s+/);
  if (dashSplit.length > 1 && dashSplit[0].trim()) {
    s = dashSplit[0].trim();
  }
  if (/[>\/]/.test(s)) {
    const parts = s.split(/\s*>\s*|\s*\/\s*/).map(function (p) {
      return String(p || '').trim();
    }).filter(Boolean);
    if (parts.length) s = parts[parts.length - 1];
  }
  return s || String(fallback || 'קובץ Drive');
}

/**
 * Shorten markdown link labels and strip trailing path captions in «מראי מקום».
 */
function sanitizeCommunitySummaryMarkdown(summary) {
  let s = normalizeEscapedNewlines(summary);
  if (!s) return '';
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (_m, label, url) {
    return '[' + shortCitationDisplayName(label, label) + '](' + url + ')';
  });
  // Drop " — long folder path" after a markdown link on the same line
  s = s.replace(/(\]\(https?:\/\/[^)\s]+\))\s*[—–-]\s*[^\n]+/g, '$1');
  return s.trim();
}

/**
 * Instant archive hit by topic + grade — no Drive scan, no Gemini.
 * Used when the UI asks for a previously archived classroom/topic summary.
 */
async function tryInstantArchiveRetrieval(query, options) {
  const opts = options || {};
  if (opts.forceRefresh === true || opts.refresh === true) return null;
  const q = String(query || '').trim();
  if (!q) return null;
  const archiveKey = buildArchiveKey(q, opts);
  let existing = null;
  try {
    existing = await fetchArchiveRow(archiveKey);
  } catch (lookupErr) {
    console.warn('[community-drive-archive] instant lookup failed:', lookupErr.message || lookupErr);
    return null;
  }
  if (
    !existing
    || existing.community_status !== 'ok'
    || !String(existing.summary_md || '').trim()
  ) {
    return null;
  }
  const summary = sanitizeCommunitySummaryMarkdown(existing.summary_md);
  if (!summary) return null;
  console.log(
    '[community-drive-archive] INSTANT archive hit — skipping Drive + Gemini',
    '| key:',
    archiveKey.slice(0, 12),
    '| topic:',
    String(opts.topic || q).slice(0, 60),
    '| grade:',
    String(opts.gradeId || opts.currentGrade || '')
  );
  return {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: summary,
    communityStatus: 'ok',
    fromArchive: true,
    deltaUpdated: false,
    archiveKey: archiveKey,
    fileRefs: Array.isArray(existing.file_refs) ? existing.file_refs : [],
    sourceFingerprint: String(existing.source_fingerprint || ''),
    model: existing.model || null,
    instantHit: true,
  };
}

async function upsertArchiveRow(record) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    throw new Error('Supabase not configured for community_drive_archive');
  }
  const payload = Object.assign({}, record, {
    updated_at: new Date().toISOString(),
  });
  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?on_conflict=archive_key', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('community_drive_archive upsert failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const data = text ? JSON.parse(text) : [];
  return Array.isArray(data) ? data[0] : data;
}

function extractGeminiText(payload) {
  const candidates = payload && payload.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return '';
  const parts = candidates[0].content && candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(function (part) {
    return part && typeof part.text === 'string' ? part.text : '';
  }).join('').trim();
}

function resolveMultimodalMime(mimeType, fileName) {
  const mime = String(mimeType || '').toLowerCase().trim();
  const name = String(fileName || '').toLowerCase();
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'application/pdf';
  if (mime === 'image/jpeg' || mime === 'image/jpg' || /\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (mime === 'image/png' || /\.png$/i.test(name)) return 'image/png';
  if (mime === 'image/webp' || /\.webp$/i.test(name)) return 'image/webp';
  if (mime === 'image/gif' || /\.gif$/i.test(name)) return 'image/gif';
  if (mime.indexOf('image/') === 0) return mime;
  return '';
}

function isMultimodalCandidate(ref) {
  if (!ref) return false;
  const reason = String(ref.failReason || '');
  if (reason === 'not_found' || reason === 'broken_shortcut') return false;
  return Boolean(resolveMultimodalMime(ref.mimeType, ref.name));
}

/**
 * Resumable upload to Gemini Files API (for PDFs/images above inline size).
 */
async function uploadGeminiFile(buffer, mimeType, displayName) {
  const apiKey = env.getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const mime = String(mimeType || 'application/octet-stream');
  const startRes = await fetch(GEMINI_API_BASE.replace('/v1beta', '') + '/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file: { display_name: String(displayName || 'community-drive.pdf').slice(0, 120) },
    }),
  });
  if (!startRes.ok) {
    const text = await startRes.text();
    throw new Error('Gemini Files start failed (' + startRes.status + '): ' + text.slice(0, 300));
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url') || startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('Gemini Files start returned no upload URL');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Type': mime,
    },
    body: bytes,
  });
  const uploadRaw = await uploadRes.text();
  let uploadPayload;
  try {
    uploadPayload = JSON.parse(uploadRaw);
  } catch (e) {
    throw new Error('Gemini Files upload returned non-JSON: ' + String(uploadRaw || '').slice(0, 300));
  }
  if (!uploadRes.ok) {
    const msg = uploadPayload.error && uploadPayload.error.message
      ? uploadPayload.error.message
      : uploadRaw.slice(0, 300);
    throw new Error('Gemini Files upload failed (' + uploadRes.status + '): ' + msg);
  }
  const file = uploadPayload.file || uploadPayload;
  if (!file || !file.uri) {
    throw new Error('Gemini Files upload missing file.uri');
  }
  return file;
}

async function waitForGeminiFileActive(fileName, options) {
  const opts = options || {};
  const apiKey = env.getGeminiApiKey();
  const rawName = String(fileName || '').trim();
  if (!apiKey || !rawName) return null;
  const pathName = rawName.indexOf('files/') === 0 ? rawName : ('files/' + rawName);
  const maxAttempts = Number(opts.maxAttempts) > 0 ? Number(opts.maxAttempts) : 20;
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(GEMINI_API_BASE + '/' + pathName, {
      headers: { 'x-goog-api-key': apiKey },
    });
    const raw = await res.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      throw new Error('Gemini Files get returned non-JSON: ' + String(raw || '').slice(0, 200));
    }
    if (!res.ok) {
      const msg = payload.error && payload.error.message ? payload.error.message : raw.slice(0, 200);
      throw new Error('Gemini Files get failed (' + res.status + '): ' + msg);
    }
    const state = String(payload.state || '').toUpperCase();
    if (state === 'ACTIVE') return payload;
    if (state === 'FAILED') {
      throw new Error('Gemini Files processing failed for ' + pathName);
    }
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
  }
  throw new Error('Gemini Files still processing after wait: ' + pathName);
}

/**
 * Download a Drive PDF/image for multimodal Gemini when text extract yielded 0 chars.
 * Resolves shortcuts to their targets before media download.
 */
async function prepareMultimodalMediaParts(failedRefs, accessToken) {
  const partsMeta = [];
  const refs = (failedRefs || []).filter(isMultimodalCandidate).slice(0, MAX_MULTIMODAL_FILES);
  const maxDownload = typeof driveCatalogSync.MAX_MULTIMODAL_DOWNLOAD_BYTES === 'number'
    ? driveCatalogSync.MAX_MULTIMODAL_DOWNLOAD_BYTES
    : MAX_GEMINI_MULTIMODAL_BYTES;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    let mime = resolveMultimodalMime(ref.mimeType, ref.name);
    if (!mime) continue;
    try {
      console.log(
        '[community-drive-archive] multimodal fallback — downloading',
        ref.name || ref.driveFileId,
        '| mime:',
        mime,
        '| reason:',
        ref.failReason || 'thin_extract'
      );

      let downloadId = ref.driveFileId;
      let resourceKey = ref.resourceKey || '';
      // Resolve shortcut shells so we download the real PDF/image bytes.
      try {
        const meta = await driveCatalogSync.fetchDriveFileMeta(
          downloadId,
          accessToken,
          null,
          { resourceKey: resourceKey }
        );
        if (meta && String(meta.mimeType || '') === 'application/vnd.google-apps.shortcut') {
          const target = await driveCatalogSync.resolveShortcutTarget(meta, accessToken);
          if (!target || !target.id) {
            console.warn('[community-drive-archive] multimodal skip — broken shortcut:', ref.name);
            continue;
          }
          downloadId = target.id;
          resourceKey = target.resourceKey || '';
          mime = resolveMultimodalMime(target.mimeType, target.name || ref.name) || mime;
          console.log(
            '[community-drive-archive] multimodal via shortcut target:',
            ref.name,
            '→',
            downloadId,
            mime
          );
        } else if (meta && meta.mimeType) {
          mime = resolveMultimodalMime(meta.mimeType, meta.name || ref.name) || mime;
          if (meta.resourceKey) resourceKey = meta.resourceKey;
        }
      } catch (metaErr) {
        // Keep original id; download may still succeed with resourceKey.
        console.warn(
          '[community-drive-archive] multimodal meta resolve warning:',
          ref.name,
          metaErr && metaErr.message ? metaErr.message : metaErr
        );
      }

      if (!resolveMultimodalMime(mime, ref.name)) {
        console.warn('[community-drive-archive] multimodal skip — unsupported mime after resolve:', mime);
        continue;
      }

      const buffer = await driveCatalogSync.downloadDriveFileBuffer(
        downloadId,
        accessToken,
        {
          resourceKey: resourceKey,
          maxBytes: maxDownload,
        }
      );
      if (!buffer || !buffer.length) {
        console.warn('[community-drive-archive] multimodal download empty:', ref.name);
        continue;
      }
      if (buffer.length > MAX_GEMINI_MULTIMODAL_BYTES) {
        console.warn(
          '[community-drive-archive] multimodal skip — over Gemini PDF/image cap:',
          ref.name,
          buffer.length,
          'bytes'
        );
        continue;
      }

      let contentPart;
      if (buffer.length <= MAX_GEMINI_INLINE_BYTES) {
        contentPart = {
          inlineData: {
            mimeType: mime,
            data: buffer.toString('base64'),
          },
        };
        console.log(
          '[community-drive-archive] multimodal inlineData ready:',
          ref.name,
          '| bytes:',
          buffer.length
        );
      } else {
        const uploaded = await uploadGeminiFile(buffer, mime, ref.name || ref.driveFileId);
        const active = await waitForGeminiFileActive(uploaded.name || uploaded.uri);
        const fileUri = (active && active.uri) || uploaded.uri;
        contentPart = {
          fileData: {
            mimeType: mime,
            fileUri: fileUri,
          },
        };
        console.log(
          '[community-drive-archive] multimodal Files API ready:',
          ref.name,
          '| bytes:',
          buffer.length,
          '| uri:',
          fileUri
        );
      }

      partsMeta.push({
        ref: ref,
        contentPart: contentPart,
        byteLength: buffer.length,
        mimeType: mime,
      });
    } catch (mediaErr) {
      console.warn(
        '[community-drive-archive] multimodal prepare failed:',
        ref.name || ref.driveFileId,
        mediaErr && mediaErr.message ? mediaErr.message : mediaErr
      );
    }
  }
  return partsMeta;
}

async function callGeminiModel(model, systemPrompt, userParts) {
  const apiKey = env.getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  const parts = Array.isArray(userParts) ? userParts : [{ text: String(userParts || '') }];
  const url = GEMINI_API_BASE + '/models/' + encodeURIComponent(model) + ':generateContent';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: parts }],
      generationConfig: {
        temperature: 0.45,
        maxOutputTokens: 16384,
        responseMimeType: 'application/json',
      },
    }),
  });
  const raw = await res.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    console.error(
      '[community-drive-archive] Gemini HTTP envelope JSON.parse failed:',
      e && e.message ? e.message : e
    );
    console.error(
      '[community-drive-archive] Gemini HTTP raw response (first 2000 chars):',
      String(raw || '').slice(0, 2000)
    );
    throw new Error('Gemini returned non-JSON (' + res.status + '): ' + String(raw || '').slice(0, 300));
  }
  if (!res.ok) {
    const msg = payload.error && payload.error.message ? payload.error.message : raw.slice(0, 300);
    const err = new Error('Gemini ' + model + ' error ' + res.status + ': ' + msg);
    err.statusCode = res.status;
    throw err;
  }
  const text = extractGeminiText(payload);
  if (!text) throw new Error('Gemini ' + model + ' returned an empty summary');
  return sanitizeCommunitySummaryMarkdown(parseGeminiSummaryJson(text));
}

function buildCommunitySummarySystemPrompt() {
  return [
    'אתה עוזר פדגוגי בכיר במסורת החינוך הוולדורפי (שטיינר).',
    'תפקידך להפיק סיכום עמוק, מקיף ומנוסח ברמה מקצועית גבוהה מתוך חומרי המאגר הקהילתי ב-Google Drive בלבד.',
    'אסור להסתמך על ידע חיצוני או על חיפוש ברשת — רק על הטקסטים/המסמכים שסופקו.',
    'כתוב בעברית פדגוגית עשירה, רהוטה ומדויקת — לא רשימות דלות או תקציר שטחי.',
    'הסיכום חייב להיות מפורט: רקע רעיוני, רציונל פדגוגי וולדורפי, יישומים מעשיים בכיתה, קצב/מבנה שיעור או תקופה כשמופיע במקורות, והמלצות למורה.',
    'מבנה Markdown חובה בתוך שדה summary: כותרת ראשית (#), כותרות משנה (## / ###), נקודות־תבליט, והדגשת מושגי מפתח ב־**מודגש**.',
    'בסוף הסיכום הוסף סעיף «### מראי מקום».',
    'במראי מקום הצג רק את שם הקובץ או שם התיקייה הישיר (למשל «עבודת רנסנס.pdf») — אסור לציין נתיבי תיקיות ארוכים עם «>».',
    'כל מראה מקום בשורה נפרדת כקישור Markdown: [שם הקובץ](url).',
    'החזר JSON נקי בלבד — אובייקט אחד במבנה {"summary":"..."} ללא טקסט לפני או אחרי, ללא עטיפת ```json.',
    'בתוך ערך summary השתמש בתווי שורה אמיתיים (JSON escaped \\n) — לא במחרוזת גלויה של התווים backslash-n.',
  ].join(' ');
}

function resolveGradeLabelForPrompt(gradeId) {
  const gid = String(gradeId || '').trim();
  if (!gid) return '';
  if (gid === 'general') return 'כללי (פדגוגיה כללית / חוצה־כיתות)';
  const map = {
    '1': "כיתה א׳", '2': "כיתה ב׳", '3': "כיתה ג׳", '4': "כיתה ד׳",
    '5': "כיתה ה׳", '6': "כיתה ו׳", '7': "כיתה ז׳", '8': "כיתה ח׳",
  };
  return map[gid] || ('כיתה ' + gid);
}

function buildCommunitySummaryTextPreamble(query, options, fileBundles, mediaMeta) {
  const opts = options || {};
  const gradeLabel = resolveGradeLabelForPrompt(opts.gradeId || opts.currentGrade);
  const sourcesBlock = (fileBundles || []).map(function (bundle, idx) {
    const leafName = shortCitationDisplayName(bundle.name, 'קובץ Drive');
    return [
      '=== מקור טקסט ' + (idx + 1) + ' ===',
      'שם קובץ להצגה במראי מקום: ' + leafName,
      bundle.webViewLink ? ('קישור Drive: ' + bundle.webViewLink) : '',
      'תוכן:',
      String(bundle.text || '').slice(0, MAX_CHARS_PER_FILE),
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const mediaBlock = (mediaMeta || []).map(function (item, idx) {
    const ref = item.ref || {};
    const leafName = shortCitationDisplayName(ref.name, 'קובץ Drive');
    return [
      '=== מסמך/תמונה מצורפת ' + (idx + 1) + ' ===',
      'שם קובץ להצגה במראי מקום: ' + leafName,
      ref.webViewLink || ref.fileUrl ? ('קישור Drive: ' + (ref.webViewLink || ref.fileUrl)) : '',
      'סוג: ' + (item.mimeType || ref.mimeType || ''),
      'הוראה: קרא/י את המסמך או התמונה המצורפים (PDF סרוק / תמונה) וחלץ מהם את התוכן הפדגוגי לסיכום המעמיק.',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return [
    'נושא החיפוש: ' + String(query || '').trim(),
    gradeLabel ? ('שכבת גיל / כיתה: ' + gradeLabel) : '',
    opts.topic ? ('נושא קטלוג: ' + opts.topic) : '',
    '',
    'הפק סיכום פדגוגי עמוק, מקיף ומאוחד של החומרים הבאים — לא תקציר קצר.',
    'שלב בין המקורות לכתיבה קוהרנטית אחת: רציונל פדגוגי, מושגי מפתח מודגשים, ויישומים מעשיים.',
    'הכותרת הראשית של הסיכום חייבת להיות:',
    COMMUNITY_SUMMARY_HEADING,
    '',
    'פורמט פלט חובה: החזר רק JSON תקין במבנה {"summary":"<טקסט הסיכום בעברית עם Markdown>"}.',
    'אין לעטוף ב-```json או בכל Markdown אחר מחוץ לשדה summary.',
    '',
    sourcesBlock,
    mediaBlock,
  ].filter(function (line) { return line !== ''; }).join('\n');
}

async function summarizeWithGemini15Pro(query, fileBundles, options) {
  return summarizeCommunitySourcesWithGemini(query, fileBundles, [], options);
}

/**
 * Text bundles and/or multimodal PDF/image parts → one pedagogical summary.
 */
async function summarizeCommunitySourcesWithGemini(query, fileBundles, mediaMeta, options) {
  const opts = options || {};
  const systemPrompt = buildCommunitySummarySystemPrompt();
  const preamble = buildCommunitySummaryTextPreamble(query, opts, fileBundles, mediaMeta);
  const userParts = [{ text: preamble }];
  (mediaMeta || []).forEach(function (item) {
    if (item && item.contentPart) userParts.push(item.contentPart);
  });

  const models = [GEMINI_MODEL].concat(GEMINI_FALLBACK_MODELS);
  let lastErr = null;
  for (let i = 0; i < models.length; i++) {
    try {
      const summary = await callGeminiModel(models[i], systemPrompt, userParts);
      return {
        summary: summary,
        model: models[i],
        multimodalFileCount: (mediaMeta || []).length,
      };
    } catch (err) {
      lastErr = err;
      const status = err && err.statusCode;
      if (status === 404 || status === 400) {
        console.warn('[community-drive-archive] model unavailable:', models[i], err.message || err);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Gemini summarization failed');
}

async function extractTextsForRefs(fileRefs, accessToken) {
  const bundles = [];
  const failedRefs = [];
  let totalChars = 0;
  console.log(
    '[community-drive-archive] extracting text from',
    (fileRefs || []).length,
    'Drive file(s) for multi-file merge…'
  );
  for (let i = 0; i < (fileRefs || []).length; i++) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      console.warn(
        '[community-drive-archive] total char budget reached — remaining files skipped'
      );
      break;
    }
    const ref = fileRefs[i];
    try {
      const extracted = await driveCatalogSync.extractDriveFileText(ref.driveFileId, {
        accessToken: accessToken,
        fileName: ref.name,
        mimeType: ref.mimeType,
        resourceKey: ref.resourceKey || '',
      });
      if (extracted && extracted.skipped) {
        failedRefs.push(Object.assign({}, ref, {
          failReason: extracted.skipReason || 'skipped',
          mimeType: extracted.mimeType || ref.mimeType,
        }));
        console.warn(
          '[community-drive-archive] skip extract:',
          ref.name || ref.driveFileId,
          extracted.skipReason || 'skipped'
        );
        continue;
      }
      const text = String(extracted && extracted.text || '').trim();
      if (!text || text.length < 40) {
        failedRefs.push(Object.assign({}, ref, {
          failReason: text ? 'thin_extract' : 'empty_extract',
          mimeType: (extracted && extracted.mimeType) || ref.mimeType,
          resourceKey: (extracted && extracted.resourceKey) || ref.resourceKey || '',
          driveFileId: (extracted && extracted.driveFileId) || ref.driveFileId,
        }));
        console.warn(
          '[community-drive-archive] skip thin/empty extract:',
          ref.name || ref.driveFileId,
          '| chars:',
          text.length
        );
        continue;
      }
      const clipped = text.slice(0, Math.min(MAX_CHARS_PER_FILE, MAX_TOTAL_CHARS - totalChars));
      totalChars += clipped.length;
      bundles.push({
        name: ref.name || (extracted && extracted.name) || ref.driveFileId,
        folderPath: ref.folderPath || ref.folder || '',
        folder: ref.folder || '',
        driveFileId: (extracted && extracted.driveFileId) || ref.driveFileId,
        webViewLink: ref.fileUrl || ref.webViewLink || '',
        mimeType: (extracted && extracted.mimeType) || ref.mimeType || '',
        text: clipped,
        charCount: clipped.length,
      });
      console.log(
        '[community-drive-archive] extracted OK:',
        bundles[bundles.length - 1].name,
        '| chars:',
        clipped.length,
        '| mime:',
        bundles[bundles.length - 1].mimeType || '(unknown)'
      );
    } catch (extractErr) {
      failedRefs.push(Object.assign({}, ref, {
        failReason: String(extractErr && extractErr.message ? extractErr.message : extractErr),
      }));
      console.warn(
        '[community-drive-archive] extract failed:',
        ref.name || ref.driveFileId,
        extractErr.message || extractErr
      );
    }
  }
  console.log(
    '[community-drive-archive] merge ready for Gemini — files:',
    bundles.length,
    '| names:',
    bundles.map(function (b) { return b.name; }).join(' | '),
    '| totalChars:',
    totalChars,
    failedRefs.length ? ('| failed/empty: ' + failedRefs.length) : ''
  );
  return { bundles: bundles, failedRefs: failedRefs };
}

function emptySummaryResult(query, options) {
  return {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: COMMUNITY_SUMMARY_EMPTY,
    communityStatus: 'empty',
    fromArchive: false,
    deltaUpdated: false,
    archiveKey: buildArchiveKey(query, options),
    fileRefs: [],
    sourceFingerprint: '',
    model: null,
  };
}

function degradedNoExtractResult(fileRefs, archiveKey, fingerprint, communityError) {
  const fileList = (fileRefs || []).map(function (ref) {
    return '• ' + (ref.name || ref.driveFileId) + (ref.folderPath ? ' (' + ref.folderPath + ')' : '');
  }).join('\n');
  return {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: [
      'נמצאו חומרים במאגר הקהילתי לנושא זה, אך לא ניתן היה לחלץ מהם טקסט לסיכום (קבצים סרוקים/גדולים מדי או קיצורים שאינם נגישים).',
      '',
      'קבצים שנמצאו:',
      fileList,
    ].join('\n'),
    communityStatus: 'degraded',
    fromArchive: false,
    deltaUpdated: false,
    archiveKey: archiveKey,
    fileRefs: fileRefs,
    sourceFingerprint: fingerprint,
    model: null,
    communityError: communityError || 'Drive text extraction failed for all matched files',
  };
}

/**
 * Delta community summary for the standalone summarizer.
 * Always re-checks Drive fingerprint; regenerates with Gemini only when sources changed.
 * Archive lookup is global (no userId filter).
 */
async function resolveCommunityDriveSummary(query, matches, options) {
  const opts = options || {};
  const q = String(query || '').trim();
  const fileRefs = normalizeFileRefsFromMatches(matches);

  if (!fileRefs.length) {
    return emptySummaryResult(q, opts);
  }

  const archiveKey = buildArchiveKey(q, opts);
  const fingerprint = buildSourceFingerprint(fileRefs);

  try {
    const existing = await fetchArchiveRow(archiveKey);
    if (
      existing &&
      existing.source_fingerprint === fingerprint &&
      String(existing.summary_md || '').trim() &&
      existing.community_status === 'ok'
      && opts.forceRefresh !== true
      && opts.refresh !== true
    ) {
      return {
        heading: COMMUNITY_SUMMARY_HEADING,
        summary: sanitizeCommunitySummaryMarkdown(existing.summary_md),
        communityStatus: 'ok',
        fromArchive: true,
        deltaUpdated: false,
        archiveKey: archiveKey,
        fileRefs: Array.isArray(existing.file_refs) ? existing.file_refs : fileRefs,
        sourceFingerprint: fingerprint,
        model: existing.model || null,
      };
    }
  } catch (lookupErr) {
    console.warn('[community-drive-archive] lookup failed:', lookupErr.message || lookupErr);
  }

  if (!env.getGeminiApiKey()) {
    const fileList = fileRefs.map(function (ref) {
      return '• ' + (ref.name || ref.driveFileId) + (ref.folderPath ? ' (' + ref.folderPath + ')' : '');
    }).join('\n');
    return {
      heading: COMMUNITY_SUMMARY_HEADING,
      summary: [
        'נמצאו חומרים במאגר הקהילתי, אך לא ניתן לייצר סיכום כרגע (חסר מפתח Gemini).',
        '',
        'קבצים שנמצאו:',
        fileList,
      ].join('\n'),
      communityStatus: 'degraded',
      fromArchive: false,
      deltaUpdated: false,
      archiveKey: archiveKey,
      fileRefs: fileRefs,
      sourceFingerprint: fingerprint,
      model: null,
      communityError: 'GEMINI_API_KEY missing — community summary skipped',
    };
  }

  let accessToken;
  try {
    accessToken = await driveCatalogSync.resolveDriveAccessToken(opts);
  } catch (tokenErr) {
    return {
      heading: COMMUNITY_SUMMARY_HEADING,
      summary: COMMUNITY_SUMMARY_EMPTY,
      communityStatus: 'unavailable',
      fromArchive: false,
      deltaUpdated: false,
      archiveKey: archiveKey,
      fileRefs: fileRefs,
      sourceFingerprint: fingerprint,
      model: null,
      communityError: String(tokenErr.message || tokenErr),
    };
  }

  const extracted = await extractTextsForRefs(fileRefs, accessToken);
  const bundles = extracted.bundles || [];
  const failedRefs = extracted.failedRefs || [];

  // When pdf-parse / standard extract yields 0 chars (scanned PDF / image), send the
  // binary to Gemini multimodal instead of jumping straight to degraded.
  let mediaMeta = [];
  if (failedRefs.some(isMultimodalCandidate)) {
    try {
      mediaMeta = await prepareMultimodalMediaParts(failedRefs, accessToken);
    } catch (multiErr) {
      console.warn(
        '[community-drive-archive] multimodal fallback setup failed:',
        multiErr && multiErr.message ? multiErr.message : multiErr
      );
    }
  }

  if (!bundles.length && !mediaMeta.length) {
    return degradedNoExtractResult(
      fileRefs,
      archiveKey,
      fingerprint,
      failedRefs.length
        ? 'Drive text extraction failed; multimodal fallback unavailable or over size limit'
        : 'Drive text extraction failed for all matched files'
    );
  }

  console.log(
    '[community-drive-archive] sending corpus to Gemini —',
    'textFiles:',
    bundles.length,
    '| multimodalFiles:',
    mediaMeta.length,
    bundles.map(function (b) {
      return (b.name || b.driveFileId) + ' (' + (b.charCount || 0) + ' chars)';
    }).concat(mediaMeta.map(function (m) {
      return (m.ref && m.ref.name ? m.ref.name : 'media') + ' (' + (m.byteLength || 0) + ' bytes multimodal)';
    })).join('; ')
  );

  const generated = await summarizeCommunitySourcesWithGemini(q, bundles, mediaMeta, {
    gradeId: opts.gradeId || opts.currentGrade || '',
    topic: opts.topic || opts.catalogTopic || '',
  });

  const cleanedSummary = sanitizeCommunitySummaryMarkdown(generated.summary);
  const record = {
    archive_key: archiveKey,
    search_query: q,
    query_text: q,
    grade_id: String(opts.gradeId || opts.currentGrade || '').trim(),
    topic: String(opts.topic || opts.catalogTopic || '').trim(),
    summary_md: cleanedSummary,
    community_status: 'ok',
    source_fingerprint: fingerprint,
    source_file_ids: fileRefs.map(function (ref) { return ref.driveFileId; }),
    file_refs: fileRefs,
    model: generated.model,
  };

  try {
    await upsertArchiveRow(record);
  } catch (persistErr) {
    console.warn('[community-drive-archive] persist failed:', persistErr.message || persistErr);
  }

  return {
    heading: COMMUNITY_SUMMARY_HEADING,
    summary: cleanedSummary,
    communityStatus: 'ok',
    fromArchive: false,
    deltaUpdated: true,
    archiveKey: archiveKey,
    fileRefs: fileRefs,
    sourceFingerprint: fingerprint,
    model: generated.model,
    multimodalFileCount: generated.multimodalFileCount || mediaMeta.length,
  };
}

module.exports = {
  TABLE_NAME,
  COMMUNITY_SUMMARY_HEADING,
  COMMUNITY_SUMMARY_EMPTY,
  GEMINI_MODEL,
  MAX_GEMINI_INLINE_BYTES,
  MAX_GEMINI_MULTIMODAL_BYTES,
  buildArchiveKey,
  buildSourceFingerprint,
  normalizeFileRefsFromMatches,
  normalizeEscapedNewlines,
  sanitizeCommunitySummaryMarkdown,
  shortCitationDisplayName,
  tryInstantArchiveRetrieval,
  resolveCommunityDriveSummary,
  emptySummaryResult,
  resolveMultimodalMime,
  isMultimodalCandidate,
};
