/**
 * Central environment variable access for Waldrof server APIs.
 * Supports standard Render/Vercel names and NEXT_PUBLIC_* aliases for portability.
 */
const fs = require('fs');
const path = require('path');

(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
})();

function cleanUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function cleanKey(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

/** Ensure a valid https Supabase project URL (no host typo rewrites). */
function normalizeSupabaseUrl(url) {
  let value = cleanUrl(url);
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) {
    value = 'https://' + value.replace(/^\/+/, '');
  }
  return value.replace(/\/$/, '');
}

function getSupabaseUrl() {
  return normalizeSupabaseUrl(
    process.env.SUPABASE_URI ||
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
}

async function isSupabaseUrlReachable(url) {
  const base = normalizeSupabaseUrl(url);
  if (!base) return false;
  try {
    const res = await fetch(base + '/auth/v1/health', {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

function getSupabaseAnonKey() {
  return cleanKey(
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

function getSupabaseServiceRoleKey() {
  return cleanKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function decodeJwtPayload(key) {
  try {
    const parts = String(key || '').split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function getSupabaseKeyRole(key) {
  const payload = decodeJwtPayload(key);
  return payload && payload.role ? String(payload.role) : '';
}

/** True only when the env key is a distinct service_role JWT (not anon / mis-copy). */
function hasRealServiceRoleKey() {
  const serviceKey = getSupabaseServiceRoleKey();
  if (!serviceKey) return false;
  const anonKey = getSupabaseAnonKey();
  if (anonKey && serviceKey === anonKey) return false;
  const role = getSupabaseKeyRole(serviceKey);
  if (role === 'anon') return false;
  return role === 'service_role' || role === '';
}

/** Preferred server-side Supabase key (service role, then anon). */
function getSupabaseServerKey() {
  return getSupabaseServiceRoleKey() || getSupabaseAnonKey();
}

function getPerplexityApiKey() {
  const candidates = [
    process.env.PERPLEXITY_API_KEY,
    process.env.AI_API_KEY,
    process.env.PPLX_API_KEY,
  ];
  for (let i = 0; i < candidates.length; i++) {
    const key = cleanKey(candidates[i]);
    if (key) return key;
  }
  return '';
}

function getOpenAiApiKey() {
  return cleanKey(process.env.OPENAI_API_KEY);
}

function getGeminiApiKey() {
  return cleanKey(process.env.GEMINI_API_KEY);
}

function getAppBaseUrl() {
  return cleanUrl(process.env.APP_BASE_URL || process.env.AUTH_REDIRECT_URL || 'https://waldrof.onrender.com');
}

function getBillingSuccessUrl() {
  return cleanUrl(process.env.BILLING_SUCCESS_URL || getAppBaseUrl() + '/?checkout=success');
}

function getBillingCancelUrl() {
  return cleanUrl(process.env.BILLING_CANCEL_URL || getAppBaseUrl() + '/?checkout=cancelled');
}

function getBillingReportEmail() {
  return cleanKey(process.env.BILLING_REPORT_EMAIL || 'Waldorfplanner@gmail.com');
}

function getMakeUpgradeWebhookUrl() {
  return cleanUrl(process.env.MAKE_UPGRADE_WEBHOOK_URL || '');
}

function getCronSecret() {
  return cleanKey(process.env.CRON_SECRET || process.env.BILLING_CRON_SECRET);
}

function getSmtpHost() {
  return cleanKey(process.env.SMTP_HOST || 'smtp.gmail.com');
}

function getSmtpPort() {
  return Number(process.env.SMTP_PORT || 587);
}

function getSmtpUser() {
  return cleanKey(process.env.SMTP_USER || process.env.GMAIL_USER);
}

function getSmtpPass() {
  return cleanKey(process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD);
}

function getSmtpFrom() {
  return cleanKey(process.env.SMTP_FROM || process.env.SMTP_USER || process.env.GMAIL_USER);
}

function isStripeCheckoutEnabled() {
  return Boolean(cleanKey(process.env.STRIPE_SECRET_KEY));
}

const { TRIAL_LIFETIME_SEARCH_LIMIT } = require('./tier-limits');

function getPublicClientConfig() {
  return {
    supabaseUrl: getSupabaseUrl(),
    supabaseAnonKey: getSupabaseAnonKey(),
    communityTable: 'community_materials',
    communityKnowledgeTable: 'community_knowledge_base',
    communityMetaField: 'notes',
    storageBucket: 'community-uploads',
    apiGenerate: '/api/generate',
    apiSearchHistory: '/api/search-history',
    apiShareMaterial: '/api/share-material',
    apiCommunityIngest: '/api/community-ingest',
    authRedirectUrl: process.env.AUTH_REDIRECT_URL || 'https://waldrof.onrender.com',
    supportWhatsApp: cleanKey(process.env.SUPPORT_WHATSAPP || process.env.SUPPORT_WHATSAPP_NUMBER || ''),
    apiSubscription: '/api/subscription',
    apiBillingCheckout: '/api/billing/checkout',
    stripeCheckoutEnabled: isStripeCheckoutEnabled(),
    makeUpgradeWebhookUrl: getMakeUpgradeWebhookUrl(),
    /** Mirrors api/tier-limits.js — revert to 3 after beta testing. */
    trialSearchLimit: TRIAL_LIFETIME_SEARCH_LIMIT,
  };
}

module.exports = {
  getSupabaseUrl,
  getSupabaseAnonKey,
  getSupabaseServiceRoleKey,
  hasRealServiceRoleKey,
  getSupabaseKeyRole,
  getSupabaseServerKey,
  getPerplexityApiKey,
  getOpenAiApiKey,
  getGeminiApiKey,
  getPublicClientConfig,
  normalizeSupabaseUrl,
  isSupabaseUrlReachable,
  getAppBaseUrl,
  getBillingSuccessUrl,
  getBillingCancelUrl,
  getBillingReportEmail,
  getMakeUpgradeWebhookUrl,
  getCronSecret,
  getSmtpHost,
  getSmtpPort,
  getSmtpUser,
  getSmtpPass,
  getSmtpFrom,
  isStripeCheckoutEnabled,
};
