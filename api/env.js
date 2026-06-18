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

function getPublicClientConfig() {
  return {
    supabaseUrl: getSupabaseUrl(),
    supabaseAnonKey: getSupabaseAnonKey(),
    communityTable: 'community_materials',
    communityMetaField: 'notes',
    storageBucket: 'community-uploads',
    apiGenerate: '/api/generate',
    apiSearchHistory: '/api/search-history',
    apiShareMaterial: '/api/share-material',
    authRedirectUrl: process.env.AUTH_REDIRECT_URL || 'https://waldrof.onrender.com',
    supportWhatsApp: cleanKey(process.env.SUPPORT_WHATSAPP || process.env.SUPPORT_WHATSAPP_NUMBER || ''),
    apiSubscription: '/api/subscription',
  };
}

module.exports = {
  getSupabaseUrl,
  getSupabaseAnonKey,
  getSupabaseServiceRoleKey,
  getSupabaseServerKey,
  getPerplexityApiKey,
  getOpenAiApiKey,
  getPublicClientConfig,
  normalizeSupabaseUrl,
  isSupabaseUrlReachable,
};
