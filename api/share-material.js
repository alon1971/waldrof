/**
 * POST /api/share-material — teacher community contribution to knowledge_base.
 * Body: { title, materialType, gradeId, gradeLabel, topic, text, contributor? }
 * Auth: Authorization: Bearer <supabase_access_token> (preferred)
 */
const knowledgeIngest = require('./knowledge-ingest');
const env = require('./env');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MATERIAL_TYPES = {
  lesson_plan: { sourceType: 'community_teacher', label: 'תכנית שיעור' },
  main_lesson: { sourceType: 'community_teacher', label: 'תקופת לימוד' },
  pedagogy_note: { sourceType: 'community_teacher', label: 'הערה פדגוגית' },
};

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    serviceKey: env.getSupabaseServiceRoleKey(),
    anonKey: env.getSupabaseAnonKey(),
  };
}

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

async function verifySupabaseToken(token) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !token) return null;
  const apiKey = cfg.anonKey || cfg.serviceKey;
  if (!apiKey) return null;

  const res = await fetch(cfg.url + '/auth/v1/user', {
    headers: {
      Authorization: 'Bearer ' + token,
      apikey: apiKey,
    },
  });

  if (!res.ok) return null;
  const user = await res.json();
  if (!user || !user.id) return null;

  const meta = user.user_metadata || {};
  return {
    id: user.id,
    email: user.email || '',
    name: meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : ''),
  };
}

function resolveContributor(req, body) {
  const authHeader = String(req.headers.authorization || req.headers.Authorization || '');
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  return verifySupabaseToken(token).then(function (verified) {
    if (verified && verified.email) return verified;

    const fromBody = body && body.contributor;
    if (fromBody && fromBody.email) {
      return {
        id: fromBody.id || null,
        email: String(fromBody.email).trim(),
        name: String(fromBody.name || fromBody.displayName || fromBody.email).trim(),
      };
    }

    const err = new Error('יש להתחבר כדי לשתף חומרים עם הקהילה');
    err.statusCode = 401;
    throw err;
  });
}

function validateShareBody(body) {
  if (!body || typeof body !== 'object') {
    const err = new Error('גוף הבקשה חסר');
    err.statusCode = 400;
    throw err;
  }

  const text = String(body.text || '').trim();
  const title = String(body.title || '').trim();
  const gradeId = String(body.gradeId || body.currentGrade || '').trim();
  const topic = String(body.topic || '').trim();
  const materialType = String(body.materialType || 'lesson_plan').trim();

  if (!text || text.length < 80) {
    const err = new Error('הטקסט קצר מדי — כתבו לפחות פסקה אחת מלאה (80 תווים ומעלה)');
    err.statusCode = 400;
    throw err;
  }
  if (!title) {
    const err = new Error('נא למלא כותרת לחומר');
    err.statusCode = 400;
    throw err;
  }
  if (!gradeId) {
    const err = new Error('נא לבחור כיתה');
    err.statusCode = 400;
    throw err;
  }
  if (!topic) {
    const err = new Error('נא למלא נושא / תקופת לימוד');
    err.statusCode = 400;
    throw err;
  }
  if (!MATERIAL_TYPES[materialType]) {
    const err = new Error('סוג חומר לא תקין');
    err.statusCode = 400;
    throw err;
  }

  return { text: text, title: title, gradeId: gradeId, topic: topic, materialType: materialType };
}

async function executeShareMaterial(req) {
  if (!knowledgeIngest.isIngestEnabled()) {
    const err = new Error('מאגר הידע אינו מוגדר בשרת (Supabase חסר)');
    err.statusCode = 503;
    throw err;
  }

  const body = parseRequestBody(req);
  const validated = validateShareBody(body);
  const contributor = await resolveContributor(req, body);
  const typeInfo = MATERIAL_TYPES[validated.materialType];

  const documentTitle = validated.title + ' — ' + typeInfo.label;
  const topicSuffix = validated.topic ? ' («' + validated.topic + '»)' : '';
  const result = await knowledgeIngest.insertKnowledgeText(validated.text, {
    title: documentTitle + topicSuffix,
    author: contributor.name || contributor.email,
    contributorEmail: contributor.email,
    origin: 'community_share',
    chunkOptions: { minChars: 100, maxChars: 1400 },
  });

  return {
    ok: true,
    inserted: result.inserted,
    chunks: result.chunks,
    contributor: {
      email: contributor.email,
      name: contributor.name,
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
    const data = await executeShareMaterial(req);
    return sendJson(res, 200, { data: data });
  } catch (err) {
    const status = err.statusCode || 500;
    console.warn('[share-material]', status, err.message || err);
    return sendJson(res, status, { error: err.message || String(err) });
  }
}

module.exports = {
  legacyHandler,
  executeShareMaterial,
  MATERIAL_TYPES,
};
