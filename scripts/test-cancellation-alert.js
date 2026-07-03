#!/usr/bin/env node
'use strict';
/**
 * Local manual trigger for cancellation admin alert.
 * Usage: node scripts/test-cancellation-alert.js shorashimclass7@gmail.com
 */
const testAlert = require('../api/test-cancellation-alert');
const billingEmail = require('../api/billing-email');
const env = require('../api/env');

async function main() {
  const email = process.argv[2] || 'shorashimclass7@gmail.com';
  console.log('SMTP configured:', billingEmail.isEmailEnabled());
  console.log('Alert recipient:', env.getBillingReportEmail());
  const result = await testAlert.runTestCancellationAlert({ email: email });
  console.log(JSON.stringify(result, null, 2));
  if (result.emailResult && result.emailResult.skipped) {
    process.exit(2);
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
