/**
 * Central environment variable access for Waldrof server APIs.
 * Supports standard Render/Vercel names and NEXT_PUBLIC_* aliases for portability.
 */

function cleanUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function cleanKey(value) {
  return String(value || '').trim();
}

function getSupabaseUrl() {
  return cleanUrl(
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
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
    process.env.AI_API_KEY,
    process.env.PERPLEXITY_API_KEY,
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
};
