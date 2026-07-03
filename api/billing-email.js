/**
 * Transactional email for billing reports (SMTP via nodemailer).
 */
const env = require('./env');

const LOG_PREFIX = '[billing-email]';

function log(event, detail) {
  console.log(LOG_PREFIX, event, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function isEmailEnabled() {
  return Boolean(env.getSmtpUser() && env.getSmtpPass());
}

async function sendEmail(options) {
  const opts = options || {};
  if (!isEmailEnabled()) {
    log('skipped', 'SMTP not configured');
    return { ok: false, skipped: true, reason: 'SMTP not configured' };
  }

  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: env.getSmtpHost(),
    port: env.getSmtpPort(),
    secure: env.getSmtpPort() === 465,
    auth: {
      user: env.getSmtpUser(),
      pass: env.getSmtpPass(),
    },
  });

  const mail = {
    from: env.getSmtpFrom() || env.getSmtpUser(),
    to: opts.to || env.getBillingReportEmail(),
    subject: opts.subject || 'Waldrof billing report',
    text: opts.text || '',
    html: opts.html || undefined,
    attachments: opts.attachments || undefined,
  };

  const info = await transporter.sendMail(mail);
  log('sent', { messageId: info.messageId, to: mail.to });
  return { ok: true, messageId: info.messageId };
}

async function sendCancellationAlert(details) {
  const d = details || {};
  const email = String(d.email || '').trim() || '(unknown)';
  const fullName = String(d.fullName || '').trim() || '—';
  const phone = String(d.phone || '').trim() || '—';
  const planType = String(d.planType || 'pro').trim();
  const expiresAt = String(d.expiresAt || '').trim() || '—';
  const userId = String(d.userId || '').trim() || '—';
  const cancelledAt = String(d.cancelledAt || new Date().toISOString()).trim();

  const subject = '[Waldrof] בקשת ביטול חידוש מנוי — ' + email;
  const text = [
    'משתמש ביקש לבטל את חידוש המנוי (הגישה נשמרת עד תאריך התפוגה).',
    '',
    'שם: ' + fullName,
    'מייל: ' + email,
    'טלפון: ' + phone,
    'מזהה משתמש: ' + userId,
    'מסלול נוכחי: ' + planType,
    'תוקף עד: ' + expiresAt,
    'זמן הבקשה: ' + cancelledAt,
  ].join('\n');

  log('cancellation_alert', { email: email, userId: userId, expiresAt: expiresAt });
  return sendEmail({ subject: subject, text: text });
}

module.exports = {
  isEmailEnabled,
  sendEmail,
  sendCancellationAlert,
};
