/**
 * Monthly billing report — active subscribers, MRR, cancellations.
 * Triggered by Render cron on the 1st of each month.
 */
const billingDb = require('./billing-db');
const billingStripe = require('./billing-stripe');
const billingEmail = require('./billing-email');
const env = require('./env');

const LOG_PREFIX = '[billing-report]';

function log(event, detail) {
  console.log(LOG_PREFIX, event, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch (e) {
    return String(iso);
  }
}

function isActivePaidRow(row) {
  const tier = String(row.plan_type || 'trial').toLowerCase();
  if (tier === 'trial') return false;
  if (!row.expires_at) return true;
  return new Date(row.expires_at).getTime() > Date.now();
}

function isCancelledPendingExpiry(row) {
  return row.auto_renew === false && isActivePaidRow(row);
}

async function buildReportData() {
  const now = new Date();
  const reportMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const allRows = await billingDb.fetchAllSubscriptions();
  const userIds = allRows.map(function (r) { return r.user_id; }).filter(Boolean);
  const profiles = await billingDb.fetchProfilesByIds(userIds);
  const profileById = {};
  profiles.forEach(function (p) { profileById[p.id] = p; });

  const active = [];
  const cancellations = [];
  let mrr = 0;

  allRows.forEach(function (row) {
    const profile = profileById[row.user_id] || {};
    const enriched = {
      user_id: row.user_id,
      email: profile.email || '',
      display_name: profile.display_name || '',
      plan_type: row.plan_type,
      billing_cycle: row.billing_cycle || 'monthly',
      auto_renew: row.auto_renew !== false,
      expires_at: row.expires_at,
      subscription_status: profile.subscription_status || billingDb.subscriptionStatusLabel(row.plan_type),
    };

    if (isActivePaidRow(row)) {
      active.push(enriched);
      mrr += billingStripe.mrrForRow(row);
    }
    if (isCancelledPendingExpiry(row)) {
      cancellations.push(enriched);
    }
  });

  mrr = Math.round(mrr * 100) / 100;

  return {
    reportMonth: reportMonth,
    generatedAt: now.toISOString(),
    totalActiveSubscribers: active.length,
    mrrNis: mrr,
    cancellationsCount: cancellations.length,
    active: active,
    cancellations: cancellations,
  };
}

function escapeCsv(value) {
  const s = String(value == null ? '' : value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(report) {
  const lines = [];
  lines.push('section,user_id,email,display_name,plan_type,billing_cycle,auto_renew,expires_at,subscription_status');
  report.active.forEach(function (row) {
    lines.push([
      'active',
      escapeCsv(row.user_id),
      escapeCsv(row.email),
      escapeCsv(row.display_name),
      escapeCsv(row.plan_type),
      escapeCsv(row.billing_cycle),
      escapeCsv(row.auto_renew),
      escapeCsv(row.expires_at),
      escapeCsv(row.subscription_status),
    ].join(','));
  });
  report.cancellations.forEach(function (row) {
    lines.push([
      'cancellation_pending',
      escapeCsv(row.user_id),
      escapeCsv(row.email),
      escapeCsv(row.display_name),
      escapeCsv(row.plan_type),
      escapeCsv(row.billing_cycle),
      escapeCsv(row.auto_renew),
      escapeCsv(row.expires_at),
      escapeCsv(row.subscription_status),
    ].join(','));
  });
  return lines.join('\n');
}

function buildHtmlSummary(report) {
  return (
    '<div dir="rtl" style="font-family:Arial,sans-serif;color:#5C4A3A;">' +
      '<h2 style="color:#8B3A3A;">דוח מנויים חודשי — Waldrof</h2>' +
      '<p><strong>חודש:</strong> ' + report.reportMonth + '</p>' +
      '<p><strong>מנויים פעילים:</strong> ' + report.totalActiveSubscribers + '</p>' +
      '<p><strong>MRR (₪):</strong> ' + report.mrrNis.toFixed(2) + '</p>' +
      '<p><strong>ביטולים ממתינים לסיום תקופה:</strong> ' + report.cancellationsCount + '</p>' +
      '<p style="font-size:12px;color:#888;">נוצר: ' + formatDate(report.generatedAt) + '</p>' +
      '<hr>' +
      '<p style="font-size:12px;">Monthly summary — Active: ' + report.totalActiveSubscribers +
      ' | MRR: ₪' + report.mrrNis.toFixed(2) +
      ' | Pending cancellations: ' + report.cancellationsCount + '</p>' +
      '<p>CSV attachment includes full subscriber detail.</p>' +
    '</div>'
  );
}

function buildTextSummary(report) {
  return [
    'Waldrof Monthly Billing Report',
    'Month: ' + report.reportMonth,
    'Active subscribers: ' + report.totalActiveSubscribers,
    'MRR (NIS): ' + report.mrrNis.toFixed(2),
    'Cancellations (pending expiry): ' + report.cancellationsCount,
    'Generated: ' + report.generatedAt,
  ].join('\n');
}

function assertCronAuthorized(req) {
  const secret = env.getCronSecret();
  if (!secret) return;
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const headerSecret = req.headers['x-cron-secret'] || req.headers['X-Cron-Secret'];
  const querySecret = req.query && req.query.secret;
  if (auth === secret || headerSecret === secret || querySecret === secret) return;
  const err = new Error('Unauthorized cron request');
  err.statusCode = 401;
  throw err;
}

async function runMonthlyReport(req) {
  assertCronAuthorized(req || { headers: {} });

  if (!billingDb.isEnabled()) {
    const err = new Error('Supabase not configured for billing report');
    err.statusCode = 503;
    throw err;
  }

  const expiryResult = await billingDb.processExpiredSubscriptions();
  log('expiry_sweep', expiryResult);

  const report = await buildReportData();
  const csv = buildCsv(report);
  const filename = 'waldrof-billing-' + report.reportMonth + '.csv';

  const emailResult = await billingEmail.sendEmail({
    to: env.getBillingReportEmail(),
    subject: 'Waldrof — דוח מנויים ' + report.reportMonth + ' | MRR ₪' + report.mrrNis.toFixed(2),
    text: buildTextSummary(report),
    html: buildHtmlSummary(report),
    attachments: [{
      filename: filename,
      content: csv,
      contentType: 'text/csv; charset=utf-8',
    }],
  });

  log('complete', {
    active: report.totalActiveSubscribers,
    mrr: report.mrrNis,
    email: emailResult,
  });

  return {
    ok: true,
    report: {
      reportMonth: report.reportMonth,
      totalActiveSubscribers: report.totalActiveSubscribers,
      mrrNis: report.mrrNis,
      cancellationsCount: report.cancellationsCount,
      downgraded: expiryResult.downgraded,
    },
    email: emailResult,
  };
}

module.exports = {
  buildReportData,
  runMonthlyReport,
};
