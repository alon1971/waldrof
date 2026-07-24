/**
 * GET /api/community-catalog-drive
 *
 * Live Google Drive Grade → Topic → Files for the Community Archive tab
 * (מאגר קהילתי). Bypasses corrupted community_materials grade_level rows.
 *
 * Query:
 *   format=materials (default) — community_materials-shaped rows + grades overview
 *   format=overview — grade/topic/file counts only
 *   refresh=1 — bypass in-memory Drive caches
 *
 * Intentionally separate from /api/community-summarizer (Gemini polling).
 */
const driveCatalogSync = require('./drive-catalog-sync');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function setCors(res) {
  Object.keys(corsHeaders).forEach(function (key) {
    res.setHeader(key, corsHeaders[key]);
  });
}

async function legacyHandler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const query = req.query || {};
  const forceRefresh = String(query.refresh || query.forceRefresh || '').trim() === '1'
    || String(query.refresh || query.forceRefresh || '').toLowerCase() === 'true';
  const format = String(query.format || 'materials').trim().toLowerCase();

  const OVERVIEW_TIMEOUT_MS = format === 'overview' ? 20000 : 45000;
  let settled = false;
  try {
    const work = format === 'overview'
      ? driveCatalogSync.summarizeDriveCatalogForUi({ forceRefresh: forceRefresh })
      : driveCatalogSync.listDriveCatalogMaterialsRows({ forceRefresh: forceRefresh });

    const payload = await Promise.race([
      work,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(Object.assign(new Error('Drive catalog timed out'), { statusCode: 504 }));
        }, OVERVIEW_TIMEOUT_MS);
      }),
    ]);
    settled = true;
    return res.status(200).json(payload);
  } catch (err) {
    console.error(
      '[community-catalog-drive] failed:',
      err && err.message ? err.message : err
    );
    if (settled) return undefined;
    return res.status(err && err.statusCode ? err.statusCode : 500).json({
      success: false,
      source: 'drive',
      grades: {},
      data: [],
      error: String(err && err.message ? err.message : err),
    });
  }
}

module.exports = {
  legacyHandler,
  handleRequest: legacyHandler,
};
