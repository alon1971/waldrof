/**
 * Enrichment / inspiration link helpers — Pinterest-only archive cleanup + shared URL guards.
 */
'use strict';

const waldorfQueryGen = require('../waldorf-query-generation');
const waldorfWebSeed = require('../waldorf-web-seed');

const ENRICHMENT_LINKS_MAX = waldorfQueryGen.ENRICHMENT_LINKS_MAX;
const isPinterestUrl = waldorfQueryGen.isPinterestUrl;
const isValidPinterestSearchUrl = waldorfQueryGen.isValidPinterestSearchUrl;

const PEDAGOGICAL_RESOURCE_LABELS = [
  'מאמר פדגוגי',
  'מערך שיעור מאתר בית ספר',
  'מקור וולדורף רשמי',
  'כתב עת פדגוגי',
  'מדריך תקופה וולדורפית',
];

function inferResourceMetaFromUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.replace(/^www\./i, '');
    return { source: host || 'מקור רשת', label: 'מאמר פדגוגי' };
  } catch (e) {
    return { source: 'מקור רשת', label: 'מאמר פדגוגי' };
  }
}

/** Verified HTTPS article URL — no hardcoded domain whitelist. */
function isVerifiedArticleUrl(url) {
  if (!waldorfWebSeed.isAllowedPedagogicalUrl(url)) return false;
  if (isPinterestUrl(url)) return false;
  return true;
}

function filterPinterestGalleryItem(item) {
  if (!item || typeof item !== 'object') return null;
  const copy = Object.assign({}, item);
  const url = String(copy.url || '').trim();
  const src = String(copy.src || '').trim();
  const pin = String(copy.pin || '').trim();

  if (src && !isPinterestUrl(src)) copy.src = '';

  if (url && !isPinterestUrl(url)) {
    if (pin && waldorfQueryGen.buildPinterestSearchUrl) {
      copy.url = waldorfQueryGen.buildPinterestSearchUrl(pin);
    } else {
      delete copy.url;
    }
  }

  if (copy.url && isPinterestUrl(copy.url)) return copy;
  if (pin) {
    if (!copy.url && waldorfQueryGen.buildPinterestSearchUrl) {
      copy.url = waldorfQueryGen.buildPinterestSearchUrl(pin);
    }
    return copy.url && isPinterestUrl(copy.url) ? copy : null;
  }
  return null;
}

function filterPinterestLinkItem(item) {
  if (!item || typeof item !== 'object') return null;
  const url = String(item.url || item.link || item.href || '').trim();
  if (!isPinterestUrl(url)) return null;
  return Object.assign({}, item, { url: url });
}

/**
 * Strip all non-Pinterest enrichment/inspiration links from cached lesson payloads.
 */
function stripNonPinterestLinksFromArchiveData(data) {
  if (!data || typeof data !== 'object') return { changed: false, data: data };

  let changed = false;
  const out = data;

  function wipeArray(key) {
    if (Array.isArray(out[key]) && out[key].length) {
      out[key] = [];
      changed = true;
    }
  }

  wipeArray('pedagogicalResources');
  wipeArray('waldorfWebResources');

  if (out.blockPlan && typeof out.blockPlan === 'object') {
    if (Array.isArray(out.blockPlan.pedagogicalResources) && out.blockPlan.pedagogicalResources.length) {
      out.blockPlan.pedagogicalResources = [];
      changed = true;
    }
    if (out.blockPlan.inspiration && typeof out.blockPlan.inspiration === 'object' &&
        Array.isArray(out.blockPlan.inspiration.pedagogicalResources) &&
        out.blockPlan.inspiration.pedagogicalResources.length) {
      out.blockPlan.inspiration.pedagogicalResources = [];
      changed = true;
    }
  }

  if (out.enrichment_links && typeof out.enrichment_links === 'object') {
    if (Array.isArray(out.enrichment_links.article_links) && out.enrichment_links.article_links.length) {
      out.enrichment_links.article_links = [];
      changed = true;
    }
    if (Array.isArray(out.enrichment_links.pinterest_links)) {
      const filtered = out.enrichment_links.pinterest_links
        .map(filterPinterestLinkItem)
        .filter(Boolean);
      if (filtered.length !== out.enrichment_links.pinterest_links.length) changed = true;
      out.enrichment_links.pinterest_links = filtered;
    }
  } else if (out.enrichment_links != null) {
    out.enrichment_links = { pinterest_links: [], article_links: [] };
    changed = true;
  }

  ['gallery', 'visualGallery'].forEach(function (key) {
    if (!Array.isArray(out[key])) return;
    const filtered = out[key].map(filterPinterestGalleryItem).filter(Boolean);
    if (filtered.length !== out[key].length) changed = true;
    out[key] = filtered;
  });

  if (out.webResearch && typeof out.webResearch === 'object' && Array.isArray(out.webResearch.citations)) {
    const filtered = out.webResearch.citations.filter(function (u) { return isPinterestUrl(u); });
    if (filtered.length !== out.webResearch.citations.length) changed = true;
    out.webResearch.citations = filtered;
  }

  if (out.blockPlan && Array.isArray(out.blockPlan.citations)) {
    const filtered = out.blockPlan.citations.filter(function (u) { return isPinterestUrl(u); });
    if (filtered.length !== out.blockPlan.citations.length) changed = true;
    out.blockPlan.citations = filtered;
  }

  return { changed: changed, data: out };
}

module.exports = {
  ENRICHMENT_LINKS_MAX,
  PEDAGOGICAL_RESOURCE_LABELS,
  isPinterestUrl,
  isValidPinterestSearchUrl,
  isVerifiedArticleUrl,
  inferResourceMetaFromUrl,
  filterPinterestGalleryItem,
  filterPinterestLinkItem,
  stripNonPinterestLinksFromArchiveData,
};
