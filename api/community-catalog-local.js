/**
 * GET /api/community-catalog-local
 *
 * Same response shape as the former on-disk index (data/community-catalog-index.json),
 * but rows + grade/topic overview are built live from Supabase community_materials.
 *
 * No local JSON, no Google Drive crawl. Catalog display only — not summarizer.
 */
const communityMaterials = require('./community-materials');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const GRADE_LABELS = {
  '1': 'כיתה א׳',
  '2': 'כיתה ב׳',
  '3': 'כיתה ג׳',
  '4': 'כיתה ד׳',
  '5': 'כיתה ה׳',
  '6': 'כיתה ו׳',
  '7': 'כיתה ז׳',
  '8': 'כיתה ח׳',
  general: 'כללי',
};

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

function normalizeTopicKey(topic) {
  return String(topic || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Build the same grades overview structure the 1:42 local index used. */
function buildGradesOverview(rows) {
  const grades = {};
  (rows || []).forEach(function (row) {
    if (!row || typeof row !== 'object') return;
    const gradeId = String(row.grade_level != null ? row.grade_level : (row.grade || '')).trim() || 'general';
    const topic = String(row.topic || '').trim();
    if (!grades[gradeId]) {
      grades[gradeId] = {
        gradeId: gradeId,
        gradeLabel: GRADE_LABELS[gradeId] || gradeId,
        topicCount: 0,
        fileCount: 0,
        topics: [],
        _topicMap: Object.create(null),
      };
    }
    const g = grades[gradeId];
    g.fileCount += 1;
    if (!topic) return;
    const key = normalizeTopicKey(topic);
    if (!g._topicMap[key]) {
      const entry = { id: topic, label: topic, count: 0 };
      g._topicMap[key] = entry;
      g.topics.push(entry);
    }
    g._topicMap[key].count += 1;
  });

  Object.keys(grades).forEach(function (gid) {
    const g = grades[gid];
    g.topicCount = g.topics.length;
    g.topics.sort(function (a, b) {
      return String(a.label).localeCompare(String(b.label), 'he');
    });
    delete g._topicMap;
  });
  return grades;
}

async function legacyHandler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const listed = await communityMaterials.listCommunityMaterials();
    const rows = Array.isArray(listed.rows) ? listed.rows : [];
    const payload = {
      version: 1,
      success: !listed.degraded,
      source: 'supabase',
      grades: buildGradesOverview(rows),
      data: rows,
    };
    if (listed.degraded) {
      payload.degraded = true;
      payload.reason = listed.reason || 'degraded';
    }
    return sendJson(res, 200, payload);
  } catch (err) {
    console.error('[community-catalog-local]', err.message || err);
    return sendJson(res, 500, {
      success: false,
      source: 'supabase',
      error: err.message || String(err),
      grades: {},
      data: [],
    });
  }
}

module.exports = {
  legacyHandler,
  handleRequest: legacyHandler,
  buildGradesOverview: buildGradesOverview,
};
