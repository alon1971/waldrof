/**
 * Grade essence ("מהות הגיל") — isolated Conditional Branch.
 *
 * Completely separate from the regular topic summarizer / Archive HIT path in
 * community-drive-archive.js. Does not call tryInstantArchiveRetrieval or
 * resolveCommunityDriveSummary. Uses community_materials (grade-scoped) only;
 * on archive HIT skips Gemini and Drive entirely.
 */
const crypto = require('crypto');
const env = require('./env');
const communityDriveArchive = require('./community-drive-archive');

const TABLE_NAME = 'community_drive_archive';
const MATERIALS_TABLE = 'community_materials';
const GRADE_ESSENCE_SUBJECT = 'grade_essence';
const GRADE_ESSENCE_PHASE = 'grade_essence';
const GRADE_ESSENCE_PROMPT_VERSION = 'v3-grade-essence-clean-cites';
const GRADE_ESSENCE_HEADING = 'מהות הגיל מתוך חומרי הקהילה';
const GRADE_ESSENCE_INSUFFICIENT = 'אין מספיק חומרים ליצירת הסיכום הכללי.';
const MIN_MATERIALS_THRESHOLD = 3;
const GEMINI_MODEL = 'gemini-2.5-pro';
const GEMINI_FALLBACK_MODELS = ['gemini-2.5-flash'];
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MAX_OUTPUT_TOKENS = 12288;
const MAX_MATERIAL_CHARS = 4000;
const MAX_TOTAL_CHARS = 120000;

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServiceRoleKey() || env.getSupabaseServerKey(),
  };
}

function normalizeGradeId(raw) {
  if (typeof communityDriveArchive.toCommunityMaterialsGradeLevel === 'function') {
    const mapped = communityDriveArchive.toCommunityMaterialsGradeLevel(raw);
    if (mapped) return mapped;
  }
  if (typeof communityDriveArchive.normalizeArchiveGradeId === 'function') {
    return communityDriveArchive.normalizeArchiveGradeId(raw);
  }
  return String(raw || '').trim();
}

function buildGradeEssenceArchiveKey(gradeId) {
  const gid = normalizeGradeId(gradeId);
  return crypto
    .createHash('sha256')
    .update(
      [GRADE_ESSENCE_SUBJECT, gid, GRADE_ESSENCE_PHASE, GRADE_ESSENCE_PROMPT_VERSION].join('|'),
      'utf8'
    )
    .digest('hex')
    .slice(0, 40);
}

function buildMaterialsFingerprint(rows) {
  if (typeof communityDriveArchive.buildMaterialsFingerprint === 'function') {
    return communityDriveArchive.buildMaterialsFingerprint(rows);
  }
  const parts = (rows || []).map(function (row) {
    return [
      String(row && row.id || '').trim(),
      String(row && row.topic || '').trim(),
      String(row && (row.file_name || row.fileName) || '').trim(),
      String(row && (row.created_at || row.createdAt) || '').trim(),
    ].join(':');
  }).filter(Boolean).sort();
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

function archiveTimestampMs(row) {
  const t = Date.parse(String((row && (row.updated_at || row.created_at)) || ''));
  return Number.isFinite(t) ? t : 0;
}

function materialRowTimestampMs(row) {
  const t = Date.parse(String((row && (row.created_at || row.createdAt)) || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Invalidate archive when any community_materials row for the grade was created
 * after the archived summary was last written (created_at > updated_at).
 */
function hasNewerMaterialsSinceArchive(archiveRow, materialsRows) {
  if (typeof communityDriveArchive.hasNewerCommunityMaterials === 'function') {
    return communityDriveArchive.hasNewerCommunityMaterials(archiveRow, materialsRows);
  }
  const archiveMs = archiveTimestampMs(archiveRow);
  if (!archiveMs) return false;
  const rows = Array.isArray(materialsRows) ? materialsRows : [];
  for (let i = 0; i < rows.length; i++) {
    if (materialRowTimestampMs(rows[i]) > archiveMs) return true;
  }
  return false;
}

function countDistinctTopics(rows) {
  const seen = new Set();
  (rows || []).forEach(function (row) {
    const topic = String(row && row.topic || '').trim();
    if (topic) seen.add(topic.toLowerCase());
  });
  return seen.size;
}

/** Threshold: fewer than 3 community_materials rows for the grade → insufficient. */
function hasEnoughMaterials(rows) {
  return (Array.isArray(rows) ? rows.length : 0) >= MIN_MATERIALS_THRESHOLD;
}

function resolveGradeLabel(gradeId) {
  const gid = String(gradeId || '').trim();
  if (!gid) return '';
  if (gid === 'general') return 'כללי';
  const map = {
    '1': "כיתה א׳", '2': "כיתה ב׳", '3': "כיתה ג׳", '4': "כיתה ד׳",
    '5': "כיתה ה׳", '6': "כיתה ו׳", '7': "כיתה ז׳", '8': "כיתה ח׳",
  };
  return map[gid] || ('כיתה ' + gid);
}

function cleanMaterialNotes(notes) {
  let text = String(notes || '').trim();
  if (!text) return '';
  // Strip machine tags commonly embedded by Drive catalog sync.
  text = text
    .replace(/\[driveFileId:[^\]]*\]/gi, ' ')
    .replace(/\[drivePath:[^\]]*\]/gi, ' ')
    .replace(/\[mimeType:[^\]]*\]/gi, ' ')
    .replace(/\[resourceKey:[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

async function fetchCommunityMaterialsForGrade(gradeId) {
  const cfg = getSupabaseConfig();
  // community_materials.grade_level is digit-only ('7'), never Hebrew labels.
  const gid = normalizeGradeId(gradeId);
  if (!cfg.url || !cfg.key || !gid) return [];

  const params = new URLSearchParams();
  params.set(
    'select',
    'id,grade_level,topic,file_path,file_name,notes,created_at'
  );
  params.set('grade_level', 'eq.' + gid);
  params.set('order', 'created_at.desc');
  params.set('limit', '500');

  console.log(
    '[community-grade-essence] querying community_materials.grade_level=eq.' + gid,
    '| rawGrade:',
    String(gradeId || '').trim().slice(0, 40)
  );

  const res = await fetch(
    cfg.url + '/rest/v1/' + MATERIALS_TABLE + '?' + params.toString(),
    {
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        Accept: 'application/json',
      },
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(function () { return ''; });
    console.warn(
      '[community-grade-essence] community_materials fetch failed:',
      res.status,
      String(text || '').slice(0, 200)
    );
    return [];
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function fetchGradeEssenceArchiveRow(archiveKey, gradeId) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key || !archiveKey) return null;

  // Only serve rows matching the current archive_key (includes prompt version).
  // Do not fall back to topic+grade — that would resurrect stale prompt outputs.
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
  if (!res.ok) return null;
  const rows = await res.json();
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (row && String(row.summary_md || row.summary_text || '').trim()) return row;
  return null;
}

/**
 * Delete stale grade_essence archive rows for this grade (old prompt versions).
 * Ensures כיתה ז׳ / any grade regenerates under the current prompt.
 */
async function purgeStaleGradeEssenceArchives(gradeId) {
  const cfg = getSupabaseConfig();
  const gid = normalizeGradeId(gradeId);
  if (!cfg.url || !cfg.key || !gid) return 0;

  const currentKey = buildGradeEssenceArchiveKey(gid);
  const params = new URLSearchParams();
  params.set('topic', 'eq.' + GRADE_ESSENCE_SUBJECT);
  params.set('or', '(grade_id.eq.' + gid + ',grade_level.eq.' + gid + ')');
  params.set('archive_key', 'neq.' + currentKey);

  const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?' + params.toString(), {
    method: 'DELETE',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=representation',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(function () { return ''; });
    console.warn(
      '[community-grade-essence] stale archive purge failed:',
      res.status,
      String(text || '').slice(0, 200)
    );
    return 0;
  }
  const deleted = await res.json().catch(function () { return []; });
  const count = Array.isArray(deleted) ? deleted.length : 0;
  if (count) {
    console.log(
      '[community-grade-essence] purged stale grade_essence archives | grade:',
      gid,
      '| deleted:',
      count,
      '| keepKey:',
      currentKey.slice(0, 12)
    );
  }
  return count;
}

async function upsertGradeEssenceArchiveRow(record) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    throw new Error('Supabase not configured for community_drive_archive');
  }
  const payload = Object.assign({}, record, {
    updated_at: new Date().toISOString(),
  });

  async function postPayload(body) {
    const res = await fetch(cfg.url + '/rest/v1/' + TABLE_NAME + '?on_conflict=archive_key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { res: res, text: text };
  }

  let attempt = await postPayload(payload);
  if (!attempt.res.ok) {
    const errText = String(attempt.text || '');
    const optionalCols = ['citations', 'summary_text', 'drive_fingerprint', 'grade_level'];
    const stripped = Object.assign({}, payload);
    let removed = false;
    optionalCols.forEach(function (col) {
      if (Object.prototype.hasOwnProperty.call(stripped, col) && new RegExp(col, 'i').test(errText)) {
        delete stripped[col];
        removed = true;
      }
    });
    if (removed) attempt = await postPayload(stripped);
  }
  if (!attempt.res.ok) {
    throw new Error(
      'grade_essence archive upsert failed (' + attempt.res.status + '): '
      + String(attempt.text || '').slice(0, 300)
    );
  }
  const data = attempt.text ? JSON.parse(attempt.text) : [];
  return Array.isArray(data) ? data[0] : data;
}

function sanitizeSummary(summary) {
  if (typeof communityDriveArchive.sanitizeCommunitySummaryMarkdown === 'function') {
    return communityDriveArchive.sanitizeCommunitySummaryMarkdown(summary);
  }
  return String(summary || '').trim();
}

function materialLinkFromRow(row) {
  // community_materials stores links/paths in file_path (no google_docs_url column).
  const path = String(row && (row.file_path || row.filePath) || '').trim();
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  const base = env.getSupabaseUrl();
  if (!base) return '';
  const encoded = path.split('/').map(function (seg) {
    return encodeURIComponent(seg);
  }).join('/');
  return base.replace(/\/$/, '') + '/storage/v1/object/public/community-uploads/' + encoded;
}

function normalizeMaterialFileKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u05F3\u05F4׳״`'"]/g, '')
    .replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Unique materials by file_path (fallback: file_name) for citations / מראי מקום.
 */
function dedupeMaterialsByFilePath(rows) {
  const seen = new Set();
  const out = [];
  (rows || []).forEach(function (row) {
    if (!row) return;
    const filePath = String(row.file_path || row.filePath || '').trim();
    const fileName = String(row.file_name || row.fileName || '').trim();
    const key = filePath
      ? ('path:' + normalizeMaterialFileKey(filePath))
      : (fileName ? ('name:' + normalizeMaterialFileKey(fileName)) : '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(row);
  });
  return out;
}

/**
 * Strip Gemini-produced raw URLs and Markdown link syntax so only bare file
 * names remain for the server/frontend linkifier.
 */
function scrubGeminiUrlAndMarkdownLinkArtifacts(summary) {
  let text = String(summary || '');
  if (!text) return '';

  // [https://...](https://...) or [label](https://...) → keep readable label only
  // when label is not itself a URL; otherwise drop the whole markdown link.
  text = text.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, function (_m, label) {
    const clean = String(label || '').trim();
    if (!clean || /^https?:\/\//i.test(clean) || /docs\.google\.com|drive\.google\.com/i.test(clean)) {
      return '';
    }
    return clean;
  });

  // Bare URLs on their own or inline
  text = text.replace(/https?:\/\/[^\s)\]>]+/gi, '');

  // Cleanup leftover empty parentheses / double spaces from removals
  text = text
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Drop disclaimer / apology openers — start at the first ## heading.
 */
function stripLeadingDisclaimers(summary) {
  let text = String(summary || '').trim();
  if (!text) return '';

  const headingMatch = text.match(/^#{1,4}\s+\S/m);
  if (headingMatch && headingMatch.index != null && headingMatch.index > 0) {
    text = text.slice(headingMatch.index).trim();
  }

  // Also drop leading disclaimer paragraphs even without a later heading match.
  const disclaimerRe = /^(?:.{0,40})?(?:החומרים אינם|מתוך החומרים|לא ניתן לדעת|חשוב לציין|יש לציין|דיסקליימר|הבהרה|אין בידי|המסמכים שסופקו אינם)[\s\S]*?(?=\n#{1,4}\s+|$)/u;
  text = text.replace(disclaimerRe, '').trim();

  const again = text.match(/^#{1,4}\s+\S/m);
  if (again && again.index != null && again.index > 0) {
    text = text.slice(again.index).trim();
  }
  return text;
}

/**
 * Replace bare community file names in the summary with Markdown links to file_path.
 * Link label is the readable file name only (never a raw URL).
 */
function linkifyFileNamesInGradeEssenceSummary(summary, materialsRows) {
  let text = String(summary || '');
  if (!text) return '';

  const uniqueRows = dedupeMaterialsByFilePath(materialsRows);
  const entries = [];
  uniqueRows.forEach(function (row) {
    const name = String(row.file_name || row.fileName || '').trim();
    const url = materialLinkFromRow(row);
    if (!name || !url) return;
    entries.push({ name: name, url: url, len: name.length });
  });
  entries.sort(function (a, b) { return b.len - a.len; });
  if (!entries.length) return text;

  const protectedSpans = [];
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (match) {
    const idx = protectedSpans.length;
    protectedSpans.push(match);
    return '\u0000GELINK' + idx + '\u0000';
  });

  entries.forEach(function (entry) {
    const re = new RegExp(escapeRegExp(entry.name), 'g');
    text = text.replace(re, '[' + entry.name + '](' + entry.url + ')');
  });

  protectedSpans.forEach(function (span, idx) {
    // Re-normalize protected spans: keep readable label, never URL-as-label.
    const rebuilt = span.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/, function (_m, label, url) {
      const clean = String(label || '').trim();
      if (!clean || /^https?:\/\//i.test(clean)) {
        return '';
      }
      return '[' + clean + '](' + url + ')';
    });
    text = text.split('\u0000GELINK' + idx + '\u0000').join(rebuilt);
  });
  return text;
}

/**
 * Materials whose file names appear in the summary body (inline citations).
 * Used to build מראי מקום from files actually referenced — not the whole catalog.
 */
function materialsCitedInSummary(summary, materialsRows) {
  const body = String(summary || '');
  const marker = body.search(/#{1,4}\s*מראי\s*מקום/i);
  const prose = marker >= 0 ? body.slice(0, marker) : body;
  const uniqueRows = dedupeMaterialsByFilePath(materialsRows);
  const cited = [];
  uniqueRows.forEach(function (row) {
    const name = String(row.file_name || row.fileName || '').trim();
    if (!name) return;
    if (prose.indexOf(name) !== -1) cited.push(row);
  });
  return cited;
}

/**
 * Rebuild ## מראי מקום as a unique clickable list of files actually used in the body.
 * Format: numbered Markdown links with readable file-name labels only (no raw URL text).
 */
function rebuildGradeEssenceSourcesSection(summary, materialsRows) {
  const citedRows = materialsCitedInSummary(summary, materialsRows);
  const lines = citedRows.map(function (row, idx) {
    const name = String(row.file_name || row.fileName || '').trim();
    const url = materialLinkFromRow(row);
    if (url) return (idx + 1) + '. [' + name + '](' + url + ')';
    return (idx + 1) + '. ' + name;
  });

  const body = String(summary || '');
  const marker = body.search(/#{1,4}\s*מראי\s*מקום/i);
  const head = marker >= 0 ? body.slice(0, marker).trimEnd() : body.trimEnd();
  if (!lines.length) {
    return head;
  }
  return head + '\n\n## מראי מקום\n\n' + lines.join('\n');
}

/**
 * Pass grade-essence summary through scrubber + linkifier + unique sources formatter.
 */
function finalizeGradeEssenceSummary(summary, materialsRows) {
  let text = scrubGeminiUrlAndMarkdownLinkArtifacts(summary);
  text = stripLeadingDisclaimers(text);
  text = linkifyFileNamesInGradeEssenceSummary(text, materialsRows);
  text = rebuildGradeEssenceSourcesSection(text, materialsRows);
  return sanitizeSummary(text);
}

function buildCorpusFromMaterials(rows) {
  let total = 0;
  const blocks = [];
  (rows || []).forEach(function (row, idx) {
    if (total >= MAX_TOTAL_CHARS) return;
    const topic = String(row.topic || '').trim();
    const fileName = String(row.file_name || row.fileName || '').trim();
    const notes = cleanMaterialNotes(row.notes);
    // Do NOT include raw URLs / public links in the corpus — Gemini must cite
    // bare file names only; the linkifier attaches hrefs later.
    const body = [
      '=== חומר ' + (idx + 1) + ' ===',
      topic ? ('נושא/תקופה: ' + topic) : '',
      fileName ? ('שם קובץ מדויק לציטוט: ' + fileName) : '',
      notes ? ('הערות/תיאור: ' + notes.slice(0, MAX_MATERIAL_CHARS)) : '',
    ].filter(Boolean).join('\n');
    total += body.length;
    blocks.push(body);
  });
  return blocks.join('\n\n');
}

function buildFileRefsFromMaterials(rows) {
  return dedupeMaterialsByFilePath(rows).map(function (row) {
    const name = String(row.file_name || row.fileName || row.topic || 'חומר קהילתי').trim();
    const filePath = String(row.file_path || row.filePath || '').trim();
    const url = materialLinkFromRow(row);
    return {
      name: name,
      fileName: name,
      folder: String(row.topic || '').trim(),
      folderPath: filePath,
      filePath: filePath,
      fileUrl: url || filePath,
      webViewLink: url,
      gradeId: String(row.grade_level || '').trim(),
      materialId: String(row.id || '').trim(),
    };
  });
}

function buildCitationsFromMaterials(rows) {
  const cites = dedupeMaterialsByFilePath(rows).map(function (row) {
    const name = String(row.file_name || row.fileName || row.topic || 'חומר קהילתי').trim();
    const filePath = String(row.file_path || row.filePath || '').trim();
    const url = materialLinkFromRow(row);
    return {
      title: name,
      fileName: name,
      filePath: filePath,
      url: url,
      webViewLink: url,
      fileUrl: url,
    };
  }).filter(function (c) { return c.fileName; });
  if (typeof communityDriveArchive.dedupeCommunityCitations === 'function') {
    return communityDriveArchive.dedupeCommunityCitations(cites);
  }
  return cites;
}

function buildGradeEssenceSystemPrompt() {
  return [
    'אתה יועץ פדגוגי בכיר ומנוסה בחינוך ולדורף.',
    'תפקידך לנסח סיכום מקיף, מובנה ועמוק בשם "מהות הגיל מתוך חומרי הקהילה" עבור שכבת כיתה אחת.',
    'הגבלת מקור קשיחה: התבסס אך ורק על חומרי המאגר הקהילתי שצורפו בהודעת המשתמש. אסור ידע חיצוני, זיכרון מודל, חיפוש ברשת, או השלמות שאינן מופיעות בחומרים.',
    'אם פרט חסר בחומרים — דלג עליו בשקט והתמקד במה שכן מופיע. אל תכתוב התנצלות או דיסקליימר על החוסר.',
    'כתוב בעברית פדגוגית רהוטה, עשירה ומפורטת. פסקאות מלאות. פלט Markdown בלבד (ללא JSON וללא גדרות קוד).',
    '',
    'סגנון ישיר — חובה:',
    'אל תכלול פתיחים, דיסקליימרים או התנצלויות כגון «החומרים אינם מפרטים באופן מפורש...», «מתוך החומרים שסופקו לא ניתן לדעת...», «חשוב לציין ש...» וכדומה.',
    'התחל מיד בגוף התשובה תחת הכותרת הראשונה, בטון מקצועי, בטוח וישיר.',
    'השורה הראשונה בפלט חייבת להיות כותרת ## מהות הגיל והתפתחות הילד/ה.',
    '',
    'איסור מוחלט על קישורי Markdown וכתובות URL:',
    'אסור לכתוב כתובות URL גולמיות (http/https, docs.google.com, drive.google.com וכו׳).',
    'אסור להשתמש בתחביר Markdown של קישורים מהסוג [שם](URL) או [https://...](https://...).',
    'כדי להפנות למקור — ציין אך ורק את שם הקובץ המדויק כטקסט חופשי או במרכאות,',
    'לדוגמה: כפי שמתואר בקובץ עבודת שורשים-מעודכן1.docx',
    'המערכת החיצונית תמיר את שמות הקבצים לקישורים לחיצים. אל תנסה ליצור קישורים בעצמך.',
    '',
    'מבנה חובה בדיוק עם כותרות ## כדלקמן:',
    '## מהות הגיל והתפתחות הילד/ה',
    'סקירה פדגוגית עמוקה על המאפיינים ההתפתחותיים בגיל/בשכבה זו כפי שעולים מהחומרים המצורפים.',
    '## תקופות הלימוד בשכבה',
    'פירוט מורחב והסבר על כל תקופת לימוד (מיינלסון / Main Lesson) המופיעה בחומרים.',
    '## פרויקטים כיתתיים ועבודות',
    'סקירת עבודות החקר, הפרויקטים והמשימות המופיעות בחומרים (למשל עבודת שורשים וכדומה).',
    '## המלצות לפעילויות יצירתיות ואמנותיות',
    'המלצות קונקרטיות הנשענות על מערכי השיעור והקבצים שסופקו.',
    '## מראי מקום',
    'רשימה קצרה של שמות הקבצים שנעשה בהם שימוש בפועל בגוף הסיכום בלבד — לא רשימת כל התיקייה/הדרייב.',
    'כל קובץ פעם אחת, בשורה נפרדת, כשם קובץ קריא בלבד (בלי URL ובלי Markdown של קישור), למשל:',
    '1. עבודת שורשים-מעודכן1.docx',
  ].join(' ');
}

function buildGradeEssenceUserPrompt(gradeId, rows) {
  const gradeLabel = resolveGradeLabel(gradeId);
  const topics = [];
  const seen = new Set();
  (rows || []).forEach(function (row) {
    const topic = String(row.topic || '').trim();
    const key = topic.toLowerCase();
    if (topic && !seen.has(key)) {
      seen.add(key);
      topics.push(topic);
    }
  });
  return [
    'בקשה: הפק סיכום מקיף "מהות הגיל מתוך חומרי הקהילה" עבור ' + (gradeLabel || 'הכיתה שנבחרה') + '.',
    'השתמש אך ורק בחומרים המצורפים להלן מתוך המאגר הקהילתי. אסור ידע חיצוני.',
    'התחל מיד בכותרת ## מהות הגיל והתפתחות הילד/ה — בלי פתיח ובלי התנצלות.',
    'אסור URL ואסור [טקסט](קישור). ציין שמות קבצים מדויקים כטקסט בלבד.',
    'חובה לכלול: מהות הגיל והתפתחות הילד/ה; תקופות הלימוד בשכבה; פרויקטים כיתתיים ועבודות; המלצות לפעילויות יצירתיות ואמנותיות; מראי מקום.',
    'בסיום — מראי מקום רק לשמות קבצים ששימשו בפועל בגוף הסיכום (לא כל הקטלוג), בלי כתובות.',
    'נושאים/תקופות שזוהו בקטלוג: ' + (topics.length ? topics.join(' · ') : '(לא זוהו)'),
    'מספר פריטים בקטלוג: ' + (rows || []).length,
    '',
    'חומרי המאגר הקהילתי:',
    buildCorpusFromMaterials(rows),
  ].join('\n');
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

async function callGeminiGradeEssence(systemPrompt, userText) {
  const apiKey = env.getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const models = [GEMINI_MODEL].concat(GEMINI_FALLBACK_MODELS);
  let lastErr = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const url = GEMINI_API_BASE + '/models/' + encodeURIComponent(model) + ':generateContent';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          },
        }),
      });
      const raw = await res.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
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
      return { summary: sanitizeSummary(text), model: model };
    } catch (err) {
      lastErr = err;
      console.warn(
        '[community-grade-essence] model unavailable:',
        model,
        err && err.message ? err.message : err
      );
    }
  }
  throw lastErr || new Error('Gemini grade essence summarization failed');
}

/**
 * Instant archive HIT for grade_essence — no Gemini, no Drive.
 * Serve when archive exists and no newer community_materials rows for the grade.
 */
async function tryInstantGradeEssenceArchive(gradeId, materialsRows, options) {
  const opts = options || {};
  if (opts.forceRefresh === true || opts.refresh === true) {
    console.log('[Archive MISS] Reason: forceRefresh requested | mode=grade_essence');
    return null;
  }
  const gid = normalizeGradeId(gradeId);
  if (!gid) return null;

  const archiveKey = buildGradeEssenceArchiveKey(gid);
  const existing = await fetchGradeEssenceArchiveRow(archiveKey, gid);
  if (!existing) {
    console.log('[Archive MISS] Reason: no grade_essence entry | grade=' + gid);
    return null;
  }
  if (existing.community_status && existing.community_status !== 'ok') {
    console.log('[Archive MISS] Reason: grade_essence status not ok | grade=' + gid);
    return null;
  }
  const archivedBody = String(existing.summary_md || existing.summary_text || '').trim();
  if (!archivedBody) {
    console.log('[Archive MISS] Reason: grade_essence summary empty | grade=' + gid);
    return null;
  }

  if (hasNewerMaterialsSinceArchive(existing, materialsRows)) {
    console.log(
      '[Archive MISS] Reason: newer community_materials since grade_essence archive | grade=' + gid
    );
    return null;
  }

  const summary = sanitizeSummary(archivedBody);
  console.log(
    '[Archive HIT] Successfully loaded grade_essence from community_drive_archive | grade='
    + gid
    + ' | key='
    + archiveKey.slice(0, 12)
  );

  return {
    heading: GRADE_ESSENCE_HEADING,
    summary: summary,
    communityStatus: 'ok',
    fromArchive: true,
    deltaUpdated: false,
    archiveKey: String(existing.archive_key || archiveKey),
    fileRefs: Array.isArray(existing.file_refs) ? existing.file_refs : [],
    citations: Array.isArray(existing.citations) ? existing.citations : [],
    sourceFingerprint: String(existing.source_fingerprint || existing.drive_fingerprint || ''),
    model: existing.model || null,
    instantHit: true,
    gradeEssence: true,
    subject: GRADE_ESSENCE_SUBJECT,
  };
}

/**
 * Full grade-essence flow (isolated branch).
 */
async function runGradeEssenceSummary(options) {
  const opts = options || {};
  const rawGradeId = String(opts.gradeId || opts.currentGrade || '').trim();
  const forceRefresh = opts.forceRefresh === true || opts.refresh === true;

  if (!rawGradeId) {
    const err = new Error('gradeId is required');
    err.statusCode = 400;
    throw err;
  }

  const gradeId = normalizeGradeId(rawGradeId);
  const archiveKey = buildGradeEssenceArchiveKey(gradeId);

  // Invalidate old prompt-version caches (e.g. כיתה ז׳ grade_essence under v1).
  try {
    await purgeStaleGradeEssenceArchives(gradeId);
  } catch (purgeErr) {
    console.warn(
      '[community-grade-essence] purge stale archives threw:',
      purgeErr && purgeErr.message ? purgeErr.message : purgeErr
    );
  }

  const materialsRows = await fetchCommunityMaterialsForGrade(gradeId);
  console.log(
    '[community-grade-essence] materials for grade',
    gradeId,
    '| rows:',
    materialsRows.length,
    '| topics:',
    countDistinctTopics(materialsRows),
    '| prompt:',
    GRADE_ESSENCE_PROMPT_VERSION,
    '| archiveKey:',
    archiveKey.slice(0, 12)
  );

  if (!forceRefresh) {
    const instant = await tryInstantGradeEssenceArchive(gradeId, materialsRows, {
      forceRefresh: false,
    });
    if (instant && instant.summary) {
      const linkedSummary = finalizeGradeEssenceSummary(instant.summary, materialsRows);
      const citedRows = materialsCitedInSummary(linkedSummary, materialsRows);
      const fileRefs = buildFileRefsFromMaterials(citedRows.length ? citedRows : materialsRows);
      const citations = buildCitationsFromMaterials(citedRows.length ? citedRows : materialsRows);
      return {
        success: true,
        topic: GRADE_ESSENCE_SUBJECT,
        subject: GRADE_ESSENCE_SUBJECT,
        gradeEssence: true,
        gradeId: gradeId,
        communityStatus: 'ok',
        communitySummaryHeading: instant.heading || GRADE_ESSENCE_HEADING,
        communitySummary: linkedSummary,
        communityMatchCount: materialsRows.length,
        communityMatches: fileRefs.length ? fileRefs : (instant.fileRefs || []),
        communityCitations: citations.length ? citations : (instant.citations || []),
        communitySummaryFromArchive: true,
        communitySummaryDeltaUpdated: false,
        communityArchiveKey: instant.archiveKey || archiveKey,
        communitySummaryModel: instant.model || null,
        communityError: null,
        fromArchive: true,
        deltaUpdated: false,
        instantArchiveHit: true,
        sourceFingerprint: instant.sourceFingerprint || buildMaterialsFingerprint(materialsRows),
        persisted: true,
      };
    }
  }

  if (!hasEnoughMaterials(materialsRows)) {
    console.log(
      '[community-grade-essence] below threshold — skipping Gemini | grade:',
      gradeId,
      '| rows:',
      materialsRows.length
    );
    return {
      success: true,
      topic: GRADE_ESSENCE_SUBJECT,
      subject: GRADE_ESSENCE_SUBJECT,
      gradeEssence: true,
      gradeId: gradeId,
      communityStatus: 'insufficient',
      communitySummaryHeading: GRADE_ESSENCE_HEADING,
      communitySummary: GRADE_ESSENCE_INSUFFICIENT,
      communityMatchCount: materialsRows.length,
      communityMatches: [],
      communityCitations: [],
      communitySummaryFromArchive: false,
      communitySummaryDeltaUpdated: false,
      communityArchiveKey: archiveKey,
      communitySummaryModel: null,
      communityError: null,
      fromArchive: false,
      deltaUpdated: false,
      instantArchiveHit: false,
      sourceFingerprint: materialsRows.length ? buildMaterialsFingerprint(materialsRows) : '',
      persisted: false,
      insufficientMaterials: true,
    };
  }

  if (!env.getGeminiApiKey()) {
    const err = new Error('GEMINI_API_KEY is not configured');
    err.statusCode = 503;
    throw err;
  }

  const generated = await callGeminiGradeEssence(
    buildGradeEssenceSystemPrompt(),
    buildGradeEssenceUserPrompt(gradeId, materialsRows)
  );

  const fingerprint = buildMaterialsFingerprint(materialsRows);
  const cleanedSummary = finalizeGradeEssenceSummary(generated.summary, materialsRows);
  const citedRows = materialsCitedInSummary(cleanedSummary, materialsRows);
  const fileRefs = buildFileRefsFromMaterials(citedRows.length ? citedRows : materialsRows);
  const citations = buildCitationsFromMaterials(citedRows.length ? citedRows : materialsRows);

  const record = {
    archive_key: archiveKey,
    search_query: GRADE_ESSENCE_SUBJECT,
    query_text: GRADE_ESSENCE_SUBJECT,
    grade_id: gradeId,
    grade_level: gradeId,
    topic: GRADE_ESSENCE_SUBJECT,
    summary_md: cleanedSummary,
    summary_text: cleanedSummary,
    community_status: 'ok',
    source_fingerprint: fingerprint,
    drive_fingerprint: fingerprint,
    source_file_ids: materialsRows.map(function (row) { return String(row.id || ''); }).filter(Boolean),
    file_refs: fileRefs,
    citations: citations,
    model: generated.model,
  };

  let persistError = null;
  try {
    await upsertGradeEssenceArchiveRow(record);
    console.log(
      '[community-grade-essence] upserted | grade:',
      gradeId,
      '| key:',
      archiveKey.slice(0, 12),
      '| materials:',
      materialsRows.length
    );
  } catch (persistErr) {
    persistError = String(persistErr && persistErr.message ? persistErr.message : persistErr);
    console.error('[community-grade-essence] persist failed:', persistError);
  }

  return {
    success: true,
    topic: GRADE_ESSENCE_SUBJECT,
    subject: GRADE_ESSENCE_SUBJECT,
    gradeEssence: true,
    gradeId: gradeId,
    communityStatus: 'ok',
    communitySummaryHeading: GRADE_ESSENCE_HEADING,
    communitySummary: cleanedSummary,
    communityMatchCount: materialsRows.length,
    communityMatches: fileRefs,
    communityCitations: citations,
    communitySummaryFromArchive: false,
    communitySummaryDeltaUpdated: true,
    communityArchiveKey: archiveKey,
    communitySummaryModel: generated.model,
    communityError: persistError
      ? ('Summary generated but archive persist failed: ' + persistError)
      : null,
    fromArchive: false,
    deltaUpdated: true,
    instantArchiveHit: false,
    sourceFingerprint: fingerprint,
    persisted: !persistError,
  };
}

function isGradeEssenceRequest(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.gradeEssence === true || body.grade_essence === true) return true;
  const subject = String(body.subject || body.mode || body.topic || '').trim().toLowerCase();
  return subject === GRADE_ESSENCE_SUBJECT || subject === 'מהות הגיל';
}

module.exports = {
  GRADE_ESSENCE_SUBJECT,
  GRADE_ESSENCE_HEADING,
  GRADE_ESSENCE_INSUFFICIENT,
  MIN_MATERIALS_THRESHOLD,
  isGradeEssenceRequest,
  runGradeEssenceSummary,
  buildGradeEssenceArchiveKey,
  fetchCommunityMaterialsForGrade,
  tryInstantGradeEssenceArchive,
};
