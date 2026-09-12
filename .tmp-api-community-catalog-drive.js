/**
 * GET /api/community-catalog-drive
 *
 * Live Google Drive overview for the Community Archive tab (מאגר קהילתי):
 * grade → topic folders → file counts.
 *
 * Intentionally separate from /api/community-summarizer and community_drive_archive
 * (Gemini summary polling must not affect this listing).
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

  try {
    const overview = await driveCatalogSync.summarizeDriveCatalogForUi({
      forceRefresh: forceRefresh,
    });
    return res.status(200).json(overview);
  } catch (err) {
    console.error(
      '[community-catalog-drive] failed:',
      err && err.message ? err.message : err
    );
    return res.status(err && err.statusCode ? err.statusCode : 500).json({
      success: false,
      source: 'drive',
      grades: {},
      error: String(err && err.message ? err.message : err),
    });
  }
}

module.exports = {
  legacyHandler,
  handleRequest: legacyHandler,
};
