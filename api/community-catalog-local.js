/**
 * GET /api/community-catalog-local
 *
 * Instant Community Archive (מאגר קהילתי) from the on-disk index:
 *   data/community-catalog-index.json
 *
 * No Google Drive crawl, no Supabase community_materials query.
 */
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'data', 'community-catalog-index.json');
const FALLBACK_REPORT_PATH = path.join(__dirname, '..', 'scripts', 'upload-community-to-drive-report.json');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

let memoryCache = { loadedAt: 0, mtimeMs: 0, payload: null };

function setCors(res) {
  Object.keys(corsHeaders).forEach(function (key) {
    res.setHeader(key, corsHeaders[key]);
  });
}

function buildPayloadFromUploadReport(report) {
  const grades = {};
  const data = [];
  const tree = (report && report.tree) || {};
  Object.keys(tree).forEach(function (gradeLabel) {
    const g = tree[gradeLabel] || {};
    const gradeId = String(g.gradeId || '').trim();
    if (!gradeId) return;
    const topicsMap = g.topics || {};
    const topics = [];
    let fileCount = 0;
    Object.keys(topicsMap).forEach(function (topicLabel) {
      const files = topicsMap[topicLabel] || [];
      const count = files.length;
      fileCount += count;
      topics.push({ id: topicLabel, label: topicLabel, count: count });
      files.forEach(function (f, i) {
        const id = String(f.materialId || ('local:' + gradeId + ':' + topicLabel + ':' + i));
        const fileName = String(f.fileName || topicLabel);
        const openUrl = String(f.url || f.link || f.fileUrl || f.webViewLink || f.file_path || '').trim();
        const fileId = String(f.file_id || f.fileId || f.driveFileId || '').trim();
        data.push({
          id: id,
          grade_level: gradeId,
          topic: topicLabel,
          file_name: fileName,
          file_path: openUrl,
          url: openUrl,
          link: openUrl,
          file_id: fileId,
          kind: String(f.kind || ''),
          notes: '[title:' + fileName + ']',
          created_at: (report && report.generatedAt) || null,
          user_id: null,
        });
      });
    });
    topics.sort(function (a, b) {
      return String(a.label).localeCompare(String(b.label), 'he');
    });
    grades[gradeId] = {
      gradeId: gradeId,
      gradeLabel: gradeLabel,
      topicCount: topics.length,
      fileCount: fileCount,
      topics: topics,
    };
  });
  return {
    version: 1,
    success: true,
    source: 'local',
    driveConfigured: false,
    generatedAt: new Date().toISOString(),
    basedOn: (report && report.generatedAt) || null,
    grades: grades,
    data: data,
  };
}

function readIndexPayload() {
  if (fs.existsSync(INDEX_PATH)) {
    const stat = fs.statSync(INDEX_PATH);
    if (
      memoryCache.payload
      && memoryCache.mtimeMs === stat.mtimeMs
    ) {
      return memoryCache.payload;
    }
    const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const payload = {
      success: true,
      source: 'local',
      driveConfigured: false,
      version: parsed.version || 1,
      generatedAt: parsed.generatedAt || null,
      basedOn: parsed.basedOn || null,
      grades: parsed.grades || {},
      data: Array.isArray(parsed.data) ? parsed.data : [],
    };
    memoryCache = { loadedAt: Date.now(), mtimeMs: stat.mtimeMs, payload: payload };
    return payload;
  }

  if (fs.existsSync(FALLBACK_REPORT_PATH)) {
    const report = JSON.parse(fs.readFileSync(FALLBACK_REPORT_PATH, 'utf8'));
    const payload = buildPayloadFromUploadReport(report);
    memoryCache = { loadedAt: Date.now(), mtimeMs: 0, payload: payload };
    return payload;
  }

  return {
    success: false,
    source: 'local',
    driveConfigured: false,
    grades: {},
    data: [],
    error: 'Local community catalog index not found',
  };
}

async function legacyHandler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const payload = readIndexPayload();
    const status = payload.success === false ? 404 : 200;
    return res.status(status).json(payload);
  } catch (err) {
    console.error('[community-catalog-local] failed:', err && err.message ? err.message : err);
    return res.status(500).json({
      success: false,
      source: 'local',
      grades: {},
      data: [],
      error: String(err && err.message ? err.message : err),
    });
  }
}

module.exports = {
  legacyHandler,
  handleRequest: legacyHandler,
  readIndexPayload,
  INDEX_PATH,
};
