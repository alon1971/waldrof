/**
 * POST /api/regenerate-legacy-table — blocking migration for legacy / empty phase_c curriculum.
 * Awaits the full 3-chunk Perplexity pipeline before responding so the client can show a spinner.
 */
const cacheDb = require('./cache');
const curriculumMigration = require('./curriculum-migration');
const authContext = require('./auth-context');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function setCors(res) {
  Object.entries(corsHeaders).forEach(function (entry) {
    res.setHeader(entry[0], entry[1]);
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

async function resolveTeacher(req, body) {
  const verified = await authContext.resolveVerifiedUser(req, body);
  if (verified) return verified;

  const fromBody = body && body.teacherUser;
  if (fromBody && fromBody.email && !authContext.isMockUserId(fromBody.id)) {
    const id = fromBody.id && authContext.isValidAuthUuid(fromBody.id) ? String(fromBody.id).trim() : null;
    return {
      id: id,
      email: String(fromBody.email || '').trim(),
      name: fromBody.name || fromBody.displayName || fromBody.email || '',
    };
  }
  return null;
}

function buildTopicBody(body, row) {
  const topic = String(
    (body && body.topic) ||
    (row && row.topic) ||
    ''
  ).trim();
  const gradeId = String(
    (body && (body.gradeId || body.currentGrade)) ||
    (row && row.grade_id) ||
    ''
  ).trim();
  return {
    phase: 'topic',
    topic: topic,
    currentGrade: gradeId,
    gradeId: gradeId,
    gradeLabel: (body && body.gradeLabel) || (row && row.grade_label) || null,
    userEmail: (row && row.user_email) || (body && body.teacherUser && body.teacherUser.email) || null,
    userId: (row && row.user_id) || (body && body.teacherUser && body.teacherUser.id) || null,
  };
}

async function loadTopicPayload(body, teacher) {
  const cacheKey = String((body && body.cacheKey) || '').trim();
  const topic = String((body && body.topic) || '').trim();
  const gradeId = String((body && (body.gradeId || body.currentGrade)) || '').trim();

  if (cacheKey) {
    let item = await cacheDb.getCommunityLessonByCacheKey(cacheKey);
    if (teacher) {
      const owned = await cacheDb.getTeacherLessonByCacheKey(teacher, cacheKey);
      if (owned) item = owned;
    }
    if (item && item.resultData && item.resultData.blockPlan) {
      return {
        topicData: item.resultData,
        topicBody: buildTopicBody(body, item),
        cacheKey: cacheKey,
      };
    }
  }

  if (!topic || !gradeId) {
    const err = new Error('חסרים נושא, כיתה או מזהה ארכיון לשדרוג תכנון התקופה');
    err.statusCode = 400;
    throw err;
  }

  const cached = await cacheDb.getCachedResult({
    phase: 'topic',
    topic: topic,
    gradeId: gradeId,
    currentGrade: gradeId,
    gradeLabel: (body && body.gradeLabel) || null,
  }, { requireEnhanced: false });

  if (!cached || !cached.data || !cached.data.blockPlan) {
    const err = new Error('לא נמצאה תכנית ארכיון לשדרוג תכנון התקופה');
    err.statusCode = 404;
    throw err;
  }

  return {
    topicData: cached.data,
    topicBody: buildTopicBody(body, null),
    cacheKey: (cached.meta && cached.meta.cacheKey) || cacheKey || '',
  };
}

function stripCurriculumFromTopicPayload(data) {
  if (!data || typeof data !== 'object') return data;
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(data));
  } catch (cloneErr) {
    return data;
  }
  const bp = cloned.blockPlan;
  if (bp && typeof bp === 'object') {
    delete bp.curriculum;
    delete bp.days;
    delete bp.rawCurriculum;
    delete bp.curriculumRaw;
    delete bp.table_data;
  }
  delete cloned.curriculum;
  delete cloned.table_data;
  return cloned;
}

async function executeRegenerateLegacyTable(req) {
  if (req.method !== 'POST') {
    const err = new Error('Method not allowed');
    err.statusCode = 405;
    throw err;
  }

  const body = parseRequestBody(req) || {};
  const teacher = await resolveTeacher(req, body);
  const loaded = await loadTopicPayload(body, teacher);
  const topicBody = loaded.topicBody;
  const needsMigration = curriculumMigration.topicNeedsCurriculumRegeneration(loaded.topicData);
  const topicData = stripCurriculumFromTopicPayload(loaded.topicData);

  if (!needsMigration) {
    return {
      ok: true,
      migrated: cacheDb.isPhaseCCurriculumServeReady(loaded.topicData),
      data: loaded.topicData,
      meta: { cacheKey: loaded.cacheKey || null },
    };
  }

  console.log('[regenerate-legacy-table] awaiting live curriculum regen:', topicBody.topic, '@', topicBody.gradeId);
  const healed = await curriculumMigration.regenerateTopicCurriculumChunked(topicBody, topicData, {
    forceFresh: true,
    skipCache: true,
  });
  const upgradedDays = cacheDb.countValidPhaseCCurriculumDays(healed || topicData);

  if (upgradedDays < cacheDb.PHASE_C_CURRICULUM_MIN_VALID_DAYS) {
    const err = new Error('לא ניתן היה ליצור תכנון תקופה מלא — נסו שוב בעוד רגע');
    err.statusCode = 502;
    throw err;
  }

  return {
    ok: true,
    migrated: true,
    data: healed || topicData,
    meta: {
      cacheKey: loaded.cacheKey || null,
      upgradedDays: upgradedDays,
      curriculumRegenerated: true,
    },
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
    const data = await executeRegenerateLegacyTable(req);
    return sendJson(res, 200, { data: data });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn('[regenerate-legacy-table]', status, err.message || err);
    return sendJson(res, status, { error: err.message || String(err) });
  }
}

module.exports = {
  legacyHandler,
  executeRegenerateLegacyTable,
};

/** Web Standard fetch handler — Vercel serverless. */
async function fetchHandler(request) {
  const headers = new Headers(corsHeaders);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  }

  let body = null;
  try {
    const text = await request.text();
    body = text && text.trim() ? JSON.parse(text) : null;
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return Response.json({ error: message || 'Invalid JSON body' }, { status: 400, headers });
  }

  try {
    const data = await executeRegenerateLegacyTable({
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body,
    });
    return Response.json({ data: data }, { status: 200, headers });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn('[regenerate-legacy-table]', status, err.message || err);
    return Response.json({ error: err.message || String(err) }, { status, headers });
  }
}

module.exports.fetch = fetchHandler;
