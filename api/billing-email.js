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

module.exports = {
  isEmailEnabled,
  sendEmail,
};
