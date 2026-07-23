/**
 * auth-subscription.js — Client-side auth placeholders & subscription rate limiting.
 * Ready for future Supabase / Firebase integration.
 */
(function (global) {
  'use strict';

  var STORAGE_AUTH = 'waldorf_auth_v1';
  var STORAGE_USAGE = 'waldorf_search_usage_v2';
  var STORAGE_WORD_DOWNLOADS = 'waldorf_word_downloads_v1';
  var STORAGE_IDENTITY_EMAIL = 'waldorf_identity_email_v1';
  var SUPPORT_WHATSAPP = '9725440548078';
  var SUPPORT_EMAIL = 'Waldorfplanner@gmail.com';
  var SUPPORT_PHONE_DISPLAY = '054-40548078';

  /** Permanent PRO tier — must match api/subscription.js PRO_USERS. */
  var PRO_USERS = ['alon1971@gmail.com'];
  /** Local mock Google demo email (upgraded to PRO_USERS[0] on localhost). */
  var LOCAL_DEMO_EMAIL = 'demo.user@gmail.com';
  /** Pro monthly search cap — must stay in sync with api/tier-limits.js */
  var PRO_MONTHLY_SEARCH_LIMIT = 25;
  /** One-time support lifetime search cap — must stay in sync with api/tier-limits.js */
  var STANDARD_LIFETIME_SEARCH_LIMIT = 20;
  /** Free-tier Word download lifetime cap */
  var TRIAL_WORD_DOWNLOAD_LIMIT = 5;
  /** One-time support Word download lifetime cap — must stay in sync with api/tier-limits.js */
  var STANDARD_WORD_DOWNLOAD_LIMIT = 20;
  /** Google display names that map to a PRO account when email is absent from the session. */
  var PRO_DISPLAY_NAMES = ['alon yerushalmy', 'אלון ירושלמי', 'אלוני ירושלמי'];

  var LEGACY_TIER_MAP = {
    educator: 'standard',
    expert: 'pro',
  };

  /** Server override from GET /api/config (applied after page load). */
  var trialSearchLimitFromServer = null;

  /**
   * Free-tier lifetime search cap — must stay in sync with api/tier-limits.js
   * and window.__WALDROF_TRIAL_SEARCH_LIMIT__ in index.html.
   * Free tier default: 1 live search (lifetime).
   */
  function resolveTrialLifetimeSearchLimit() {
    if (trialSearchLimitFromServer != null) return trialSearchLimitFromServer;
    if (global.__WALDROF_TRIAL_SEARCH_LIMIT__ != null) {
      var fromHtml = Number(global.__WALDROF_TRIAL_SEARCH_LIMIT__);
      if (Number.isFinite(fromHtml) && fromHtml > 0) return Math.floor(fromHtml);
    }
    if (global.__WALDROF_RUNTIME_CONFIG__ && global.__WALDROF_RUNTIME_CONFIG__.trialSearchLimit != null) {
      var fromRuntime = Number(global.__WALDROF_RUNTIME_CONFIG__.trialSearchLimit);
      if (Number.isFinite(fromRuntime) && fromRuntime > 0) return Math.floor(fromRuntime);
    }
    return 1;
  }

  var TIERS = {
    trial: {
      id: 'trial',
      lifetimeLimit: resolveTrialLifetimeSearchLimit(),
      wordDownloadLimit: TRIAL_WORD_DOWNLOAD_LIMIT,
      wordDownloadPeriod: 'lifetime',
      monthlyLimit: null,
      displayUnlimited: false,
      prices: { monthly: 0, yearly: 0 },
    },
    /** One-time support (100 ₪) — 20 searches lifetime, 20 Word downloads. */
    standard: {
      id: 'standard',
      monthlyLimit: null,
      lifetimeLimit: STANDARD_LIFETIME_SEARCH_LIMIT,
      wordDownloadLimit: STANDARD_WORD_DOWNLOAD_LIMIT,
      displayUnlimited: false,
      prices: { monthly: null, yearly: 100 },
    },
    /** Annual subscription (220 ₪) — 25 searches/month, unlimited Word. */
    pro: {
      id: 'pro',
      monthlyLimit: PRO_MONTHLY_SEARCH_LIMIT,
      lifetimeLimit: null,
      wordDownloadLimit: null,
      displayUnlimited: false,
      prices: { monthly: null, yearly: 220 },
    },
    school: {
      id: 'school',
      contactOnly: true,
      monthlyLimit: null,
      lifetimeLimit: null,
      prices: { monthly: null, yearly: null },
    },
  };

  var authState = {
    isAuthenticated: false,
    user: null,
    tier: 'trial',
    planType: 'trial',
    isTrial: true,
    provider: 'mock',
    sessionReady: false,
    autoRenew: true,
    billingCycle: null,
    expiresAt: null,
    usagePeriod: 'lifetime',
    searchesUsed: null,
    searchLimit: resolveTrialLifetimeSearchLimit(),
    wordDownloadsUsed: 0,
    wordDownloadLimit: 5,
  };

  var stripeCheckoutEnabled = false;
  var billingCheckoutUrl = '/api/billing/checkout';
  var MAKE_UPGRADE_WEBHOOK_URL = 'https://hook.eu1.make.com/atopa4q5ewidxqlwwe0e3lkyr2mzcf2g';
  /**
   * Grow checkout links — one-time support (100 ₪) and annual (220 ₪).
   * Keep in sync with api/env.js and the upgrade modal buttons.
   */
  var GROW_ONE_TIME_URL = 'https://pay.grow.link/OTAwMDc~8e58f88e567929a25776603bb5f1ef7e-MzU5NTU4Ng';
  var GROW_ANNUAL_URL = 'https://pay.grow.link/OTAwMDc~af378d4d544c172796f6cc566245c781-MzU5OTYxMg';
  /** @deprecated alias — annual Grow URL (backward compatible). */
  var GROW_UPGRADE_URL = GROW_ANNUAL_URL;

  function applyRuntimeBillingConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (cfg.stripeCheckoutEnabled != null) stripeCheckoutEnabled = Boolean(cfg.stripeCheckoutEnabled);
    if (cfg.apiBillingCheckout) billingCheckoutUrl = String(cfg.apiBillingCheckout);
    // Honor the server-configured Make→Grow webhook (Render env MAKE_UPGRADE_WEBHOOK_URL).
    // Without this the client silently used the hardcoded default and ignored Render's value.
    if (cfg.makeUpgradeWebhookUrl) {
      var makeUrl = String(cfg.makeUpgradeWebhookUrl).trim();
      if (/^https?:\/\//i.test(makeUrl)) MAKE_UPGRADE_WEBHOOK_URL = makeUrl;
    }
    if (cfg.growOneTimeUrl) {
      var oneTime = String(cfg.growOneTimeUrl).trim();
      if (/^https?:\/\//i.test(oneTime)) GROW_ONE_TIME_URL = oneTime;
    }
    if (cfg.growAnnualUrl || cfg.growUpgradeUrl) {
      var annual = String(cfg.growAnnualUrl || cfg.growUpgradeUrl).trim();
      if (/^https?:\/\//i.test(annual)) {
        GROW_ANNUAL_URL = annual;
        GROW_UPGRADE_URL = annual;
      }
    }
    syncGrowCheckoutLinkElements();
    if (cfg.trialSearchLimit != null) {
      var n = Number(cfg.trialSearchLimit);
      if (Number.isFinite(n) && n > 0) {
        trialSearchLimitFromServer = Math.floor(n);
        TIERS.trial.lifetimeLimit = trialSearchLimitFromServer;
        if (normalizeTierId(authState.tier) === 'trial' && authState.searchLimit != null) {
          authState.searchLimit = trialSearchLimitFromServer;
        }
      }
    }
  }

  if (global.__WALDROF_RUNTIME_CONFIG__) {
    applyRuntimeBillingConfig(global.__WALDROF_RUNTIME_CONFIG__);
  }

  var listeners = [];
  var logoutCleanupHooks = [];
  var logoutRequested = false;
  var logoutFinalized = false;
  var supabaseClient = null;
  var SUPABASE_CLIENT_GLOBAL_KEY = '__waldorfSupabaseClient';

  function resetSupabaseClient() {
    supabaseClient = null;
    try { delete global[SUPABASE_CLIENT_GLOBAL_KEY]; } catch (e) { global[SUPABASE_CLIENT_GLOBAL_KEY] = null; }
  }

  function getSupabaseClient() {
    if (supabaseClient) return supabaseClient;
    if (global[SUPABASE_CLIENT_GLOBAL_KEY]) {
      supabaseClient = global[SUPABASE_CLIENT_GLOBAL_KEY];
      return supabaseClient;
    }
    if (!isSupabaseConfigured() || typeof global.supabase === 'undefined') return null;
    try {
      supabaseClient = global.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey, {
        auth: {
          flowType: 'pkce',
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
        },
      });
      global[SUPABASE_CLIENT_GLOBAL_KEY] = supabaseClient;
    } catch (e) {
      console.warn('[Auth] Supabase client creation failed', e);
      return null;
    }
    return supabaseClient;
  }

  var supabaseConfig = { url: '', anonKey: '' };
  var authUiLoading = false;
  var useMockGoogleAuth = false;
  var authRedirectUrl = '';

  /** Latin display names that map to Hebrew UI labels (e.g. Google OAuth returns English only). */
  var KNOWN_HEBREW_FROM_LATIN = {
    'alon': { full: 'אלון ירושלמי', first: 'אלון' },
    'alon yerushalmy': { full: 'אלון ירושלמי', first: 'אלון' },
  };

  /** Verified account emails with Hebrew display names when Google OAuth is Latin-only. */
  var KNOWN_HEBREW_BY_EMAIL = {
    'alon1971@gmail.com': { full: 'אלון ירושלמי', first: 'אלון' },
  };

  function prefersHebrewUi() {
    return typeof global.isEnglish !== 'function' || !global.isEnglish();
  }

  function resolveHebrewNameByEmail(user, emailFallback, mode) {
    var email = normalizeEmail((user && user.email) || emailFallback || '') || getIdentityEmail();
    if (!email) return '';
    var known = KNOWN_HEBREW_BY_EMAIL[email];
    if (!known) return '';
    return mode === 'full' ? String(known.full || '').trim() : String(known.first || '').trim();
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function isProUserEmail(email) {
    return PRO_USERS.indexOf(normalizeEmail(email)) >= 0;
  }

  function normalizeDisplayName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function isProDisplayName(displayName) {
    return PRO_DISPLAY_NAMES.indexOf(normalizeDisplayName(displayName)) >= 0;
  }

  function resolveProEmailFromUser(user) {
    if (!user) return '';
    if (isProUserEmail(user.email)) return normalizeEmail(user.email);
    if (isProDisplayName(user.displayName)) return PRO_USERS[0];
    return '';
  }

  function isProUserProfile(user) {
    return Boolean(resolveProEmailFromUser(user));
  }

  function readIdentityEmail() {
    try {
      return normalizeEmail(localStorage.getItem(STORAGE_IDENTITY_EMAIL));
    } catch (e) {
      return '';
    }
  }

  function writeIdentityEmail(email) {
    try {
      localStorage.setItem(STORAGE_IDENTITY_EMAIL, normalizeEmail(email));
    } catch (e) { /* quota */ }
  }

  function getIdentityEmail() {
    // Localhost: prefer pinned PRO admin identity so archive/admin API headers work
    // even when a stale mock/demo session email is still in memory.
    if (isLocalDevHost()) {
      var localPinned = readIdentityEmail();
      if (isProUserEmail(localPinned)) return localPinned;
    }
    if (authState.isAuthenticated && authState.user) {
      var sessionEmail = normalizeEmail(authState.user.email);
      if (sessionEmail) return sessionEmail;
      var mappedPro = resolveProEmailFromUser(authState.user);
      if (mappedPro) return mappedPro;
    }
    var stored = readIdentityEmail();
    if (stored) return stored;
    return '';
  }

  function setIdentityEmail(email) {
    writeIdentityEmail(email);
    applyProUserTierIfEligible();
    updateIdentityEmailUi();
    updateHeaderUi();
    updateSearchMeterUi();
    notifyListeners();
    if (isProUser()) hideAuthOverlay();
  }

  function isProUser() {
    if (isProUserEmail(getIdentityEmail())) return true;
    if (authState.isAuthenticated && authState.user && isProUserProfile(authState.user)) return true;
    return false;
  }

  function hasPaidSubscription() {
    if (authState.isTrial === false) {
      var paidPlan = normalizeTierId(authState.planType || authState.tier);
      return paidPlan === 'pro' || paidPlan === 'standard';
    }
    if (authState.isTrial === true) return false;
    var tier = normalizeTierId(authState.planType || authState.tier);
    return tier === 'pro' || tier === 'standard';
  }

  function hasPaidAccess() {
    return isProUser() || hasPaidSubscription();
  }

  function parseIsTrialFlag(value) {
    if (value === false || value === 0 || value === 'false' || value === '0') return false;
    if (value === true || value === 1 || value === 'true' || value === '1') return true;
    return Boolean(value);
  }

  /**
   * Display / product plan from server-backed authState.
   * Never invents 'pro' — unknown values fall back via normalizeTierId to 'trial'.
   */
  function resolvePlanType() {
    if (authState.planType) return normalizeTierId(authState.planType);
    if (authState.tier) return normalizeTierId(authState.tier);
    return 'trial';
  }

  function isAnnualProPlan() {
    return resolvePlanType() === 'pro';
  }

  function isStandardPlan() {
    return resolvePlanType() === 'standard';
  }

  function applySubscriptionFields(subscription, usage) {
    if (usage) {
      if (usage.planType != null) {
        authState.planType = normalizeTierId(usage.planType);
      } else if (usage.tier != null) {
        // Older payloads may omit planType — never leave a stale 'pro' from localStorage.
        authState.planType = normalizeTierId(usage.tier);
      }
      if (usage.isTrial != null) authState.isTrial = parseIsTrialFlag(usage.isTrial);
      if (usage.tier != null) authState.tier = normalizeTierId(usage.tier);
      if (usage.autoRenew != null) authState.autoRenew = usage.autoRenew !== false;
      if (usage.expiresAt != null) authState.expiresAt = usage.expiresAt;
      if (usage.searchLimit != null) authState.searchLimit = usage.searchLimit;
      if (usage.usagePeriod != null) authState.usagePeriod = usage.usagePeriod;
    }
    if (subscription) {
      if (subscription.planType != null) {
        authState.planType = normalizeTierId(subscription.planType);
      } else if (subscription.tier != null) {
        authState.planType = normalizeTierId(subscription.tier);
      }
      if (subscription.isTrial != null) authState.isTrial = parseIsTrialFlag(subscription.isTrial);
      if (subscription.tier != null) authState.tier = normalizeTierId(subscription.tier);
      if (subscription.autoRenew != null) authState.autoRenew = subscription.autoRenew !== false;
      if (subscription.expiresAt != null) authState.expiresAt = subscription.expiresAt;
    }
    if (authState.isTrial === false && authState.planType) {
      authState.tier = authState.planType;
    } else if (authState.isTrial === true) {
      authState.planType = 'trial';
      authState.tier = 'trial';
    }
  }

  function applyProUserTierIfEligible() {
    // Whitelist bypass is for quotas only — do not override a real DB plan_type
    // (e.g. standard) that was already applied from /api/subscription.
    if (!isProUser()) return;
    if (authState.isAuthenticated && (isStandardPlan() || isAnnualProPlan())) return;
    authState.tier = 'pro';
    authState.planType = 'pro';
    authState.isTrial = false;
    authState.searchLimit = null;
    authState.usagePeriod = 'monthly';
    authState.searchesUsed = authState.searchesUsed != null ? authState.searchesUsed : 0;
  }

  function applyProUserUsageFromServer(usage) {
    if (usage && (usage.proUser || usage.whitelisted)) {
      authState.planType = 'pro';
      authState.tier = 'pro';
      authState.isTrial = false;
      applyProUserTierIfEligible();
      authState.searchesUsed = 0;
      authState.searchLimit = null;
      notifyListeners();
      updateHeaderUi();
      updateSearchMeterUi();
      return true;
    }
    return false;
  }

  function isLocalDevHost() {
    try {
      var host = String(window.location.hostname || '').toLowerCase();
      if (window.location.protocol === 'file:') return true;
      return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
    } catch (e) {
      return false;
    }
  }

  function isLocalDemoEmail(email) {
    return normalizeEmail(email) === LOCAL_DEMO_EMAIL;
  }

  function getLocalDevAdminEmail() {
    return PRO_USERS[0];
  }

  function getLocalDevAdminDisplayName() {
    return prefersHebrewUi() ? 'אלון ירושלמי' : 'Alon Yerushalmy';
  }

  /**
   * Localhost-only: pin the active session / identity to the permanent PRO admin
   * so archive wipe, research tools, and related UI gates match production admin access.
   */
  function ensureLocalDevAdminPrivileges() {
    if (!isLocalDevHost()) return false;
    var adminEmail = getLocalDevAdminEmail();
    var adminName = getLocalDevAdminDisplayName();
    var currentIdentity = readIdentityEmail();
    var currentUserEmail = authState.user ? normalizeEmail(authState.user.email) : '';
    var alreadyAdmin = currentIdentity === adminEmail &&
      (!authState.isAuthenticated || currentUserEmail === adminEmail || isProUserEmail(currentUserEmail)) &&
      normalizeTierId(authState.tier) === 'pro';
    if (alreadyAdmin) return true;

    writeIdentityEmail(adminEmail);

    if (authState.isAuthenticated && authState.user) {
      var email = normalizeEmail(authState.user.email);
      var userId = String(authState.user.id || '');
      var isMockSession = isMockProvider(authState.provider) ||
        isLocalDemoEmail(email) ||
        userId.indexOf('google_demo_') === 0 ||
        userId.indexOf('mock_') === 0 ||
        userId === 'local_admin_dev';
      if (isMockSession || !email || isLocalDemoEmail(email)) {
        authState.user = Object.assign({}, authState.user, {
          email: adminEmail,
          displayName: adminName,
        });
      }
    }

    applyProUserTierIfEligible();
    if (authState.isAuthenticated) persistAuth();
    return true;
  }

  function resolveAuthRedirectUrl(explicit) {
    if (explicit) return String(explicit).trim();
    if (authRedirectUrl) return authRedirectUrl;
    try {
      return window.location.origin + window.location.pathname + window.location.search;
    } catch (e) {
      return 'https://waldrof.onrender.com/';
    }
  }

  function shouldAllowMockAuth() {
    return useMockGoogleAuth && isLocalDevHost();
  }

  function isMockProvider(provider) {
    return provider === 'mock' || provider === 'mock-google';
  }

  function normalizeSupabaseConfigUrl(url) {
    var value = String(url || '').trim().replace(/\/$/, '');
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) {
      value = 'https://' + value.replace(/^\/+/, '');
    }
    return value.replace(/\/$/, '');
  }

  function isSupabaseConfigured() {
    return Boolean(supabaseConfig.url && supabaseConfig.anonKey);
  }

  function isValidSupabaseProjectUrl(url) {
    var value = normalizeSupabaseConfigUrl(url);
    if (!value) return false;
    return /^https:\/\/[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i.test(value);
  }

  function assertSupabaseReadyForOAuth() {
    if (!isSupabaseConfigured()) {
      throw new Error(t('auth_err_supabase'));
    }
    if (!isValidSupabaseProjectUrl(supabaseConfig.url)) {
      throw new Error(t('auth_err_supabase_url'));
    }
  }

  function normalizeAuthError(err) {
    if (!err) return new Error(t('auth_err_supabase'));
    if (typeof err === 'string') return new Error(err);
    return new Error(err.message || t('auth_err_supabase'));
  }

  function normalizeTierId(tierId) {
    var t = String(tierId || 'trial').trim().toLowerCase();
    if (LEGACY_TIER_MAP[t]) return LEGACY_TIER_MAP[t];
    if (t === 'school') return 'school';
    return TIERS[t] ? t : 'trial';
  }

  function resolveTierFromUser(user) {
    /* Tier is loaded from user_subscriptions via /api/subscription — not Auth metadata. */
    return 'trial';
  }

  function formatNameFromEmail(email) {
    var normalized = normalizeEmail(email);
    if (!normalized || normalized.indexOf('@') < 0) return '';
    var local = normalized.split('@')[0] || '';
    if (!local) return '';
    var withoutDigits = local.replace(/\d+/g, '');
    var base = withoutDigits || local;
    if (base.indexOf('.') >= 0) base = base.split('.')[0];
    if (!base) base = local;
    return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
  }

  function containsHebrew(text) {
    return /[\u0590-\u05FF]/.test(String(text || ''));
  }

  function isValidAuthNameCandidate(name) {
    var value = String(name || '').trim();
    return value.length > 0 && value.indexOf('@') < 0;
  }

  function pickPreferredAuthName(candidates, mode) {
    var valid = [];
    for (var i = 0; i < candidates.length; i++) {
      var value = String(candidates[i] || '').trim();
      if (!isValidAuthNameCandidate(value)) continue;
      valid.push(value);
    }
    if (!valid.length) return '';
    var hebrew = valid.filter(containsHebrew);
    if (hebrew.length) {
      if (mode === 'full') {
        hebrew.sort(function (a, b) { return b.length - a.length; });
      }
      return hebrew[0];
    }
    if (mode === 'full' && valid.length > 1) {
      valid.sort(function (a, b) { return b.length - a.length; });
    }
    return valid[0];
  }

  function resolveKnownHebrewName(latinName, mode) {
    var key = normalizeDisplayName(latinName);
    var known = KNOWN_HEBREW_FROM_LATIN[key];
    if (!known && mode === 'full') {
      var firstKey = normalizeDisplayName(String(latinName || '').split(/\s+/)[0]);
      known = KNOWN_HEBREW_FROM_LATIN[firstKey];
    }
    if (!known) return '';
    return mode === 'full' ? String(known.full || '').trim() : String(known.first || '').trim();
  }

  function collectAuthMetadataNameCandidates(meta, mode) {
    var out = [];
    if (!meta) return out;
    if (mode === 'full') {
      if (meta.full_name_he) out.push(meta.full_name_he);
      if (meta.full_name) out.push(meta.full_name);
      if (meta.name) out.push(meta.name);
      var metaGiven = String(meta.given_name || '').trim();
      var metaFamily = String(meta.family_name || '').trim();
      if (metaGiven && metaFamily) out.push(metaGiven + ' ' + metaFamily);
    } else {
      if (meta.given_name_he) out.push(meta.given_name_he);
      if (meta.given_name) out.push(meta.given_name);
      if (meta.full_name_he) out.push(String(meta.full_name_he).split(/\s+/)[0]);
      if (meta.full_name) out.push(String(meta.full_name).split(/\s+/)[0]);
      if (meta.name) out.push(String(meta.name).split(/\s+/)[0]);
    }
    return out;
  }

  function collectAuthIdentityNameCandidates(identityData, mode) {
    var idData = identityData || {};
    var out = [];
    if (mode === 'full') {
      if (idData.full_name) out.push(idData.full_name);
      if (idData.name) out.push(idData.name);
      var given = String(idData.given_name || '').trim();
      var family = String(idData.family_name || '').trim();
      if (given && family) out.push(given + ' ' + family);
    } else {
      if (idData.given_name) out.push(idData.given_name);
      if (idData.full_name) out.push(String(idData.full_name).split(/\s+/)[0]);
      if (idData.name) out.push(String(idData.name).split(/\s+/)[0]);
    }
    return out;
  }

  function extractGoogleIdentityData(user) {
    if (!user) return null;
    if (user.identity_data && typeof user.identity_data === 'object') return user.identity_data;
    if (!Array.isArray(user.identities)) return null;
    for (var i = 0; i < user.identities.length; i++) {
      var identity = user.identities[i];
      if (!identity || !identity.identity_data) continue;
      if (identity.provider === 'google') return identity.identity_data;
    }
    for (var j = 0; j < user.identities.length; j++) {
      if (user.identities[j] && user.identities[j].identity_data) {
        return user.identities[j].identity_data;
      }
    }
    return null;
  }

  function resolveNameFromAuthUser(user, mode) {
    if (!user) return '';
    var candidates = [];
    var meta = user.user_metadata || user.raw_user_meta_data || {};
    candidates = candidates.concat(collectAuthMetadataNameCandidates(meta, mode));
    var identityData = extractGoogleIdentityData(user);
    if (identityData) {
      candidates = candidates.concat(collectAuthIdentityNameCandidates(identityData, mode));
    }
    if (user.displayName) {
      if (mode === 'full') candidates.push(user.displayName);
      else candidates.push(String(user.displayName).split(/\s+/)[0]);
    }
    return pickPreferredAuthName(candidates, mode);
  }

  function applyKnownHebrewNameFallback(name, mode, user, emailFallback) {
    if (name && containsHebrew(name)) return name;
    if (name) {
      var known = resolveKnownHebrewName(name, mode);
      if (known) return known;
    }
    var byEmail = resolveHebrewNameByEmail(user, emailFallback, mode);
    if (byEmail) return byEmail;
    return name || '';
  }

  function resolveUserDisplayName(user, emailFallback) {
    var email = (user && user.email) ? normalizeEmail(user.email) : normalizeEmail(emailFallback || '');
    if (!email) email = getIdentityEmail();
    var name = resolveNameFromAuthUser(user, 'full');
    if (name) return applyKnownHebrewNameFallback(name, 'full', user, email);
    var byEmail = resolveHebrewNameByEmail(user, email, 'full');
    if (byEmail) return byEmail;
    return formatNameFromEmail(email) || '';
  }

  function resolveUserFirstName(user, emailFallback) {
    var email = (user && user.email) ? normalizeEmail(user.email) : normalizeEmail(emailFallback || '');
    if (!email) email = getIdentityEmail();
    var first = resolveNameFromAuthUser(user, 'first');
    if (first) return applyKnownHebrewNameFallback(first, 'first', user, email);
    var byEmail = resolveHebrewNameByEmail(user, email, 'first');
    if (byEmail) return byEmail;
    return formatNameFromEmail(email) || '';
  }

  function fetchGoogleHebrewProfile(providerToken) {
    if (!providerToken) return Promise.resolve(null);
    var url = 'https://people.googleapis.com/v1/people/me?personFields=names';
    return fetch(url, {
      headers: { Authorization: 'Bearer ' + providerToken },
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.names) || !data.names.length) return null;
      var bestFull = '';
      var bestFirst = '';
      for (var i = 0; i < data.names.length; i++) {
        var entry = data.names[i] || {};
        var given = String(entry.givenName || '').trim();
        var family = String(entry.familyName || '').trim();
        var display = String(entry.displayName || '').trim();
        var combined = display || (given && family ? given + ' ' + family : given || family);
        if (!containsHebrew(combined) && !containsHebrew(given)) continue;
        if (combined.length > bestFull.length) bestFull = combined;
        if (given && (!bestFirst || (containsHebrew(given) && !containsHebrew(bestFirst)))) {
          bestFirst = given;
        }
      }
      if (!bestFull && !bestFirst) return null;
      if (!bestFirst && bestFull) bestFirst = bestFull.split(/\s+/)[0];
      return { full: bestFull, first: bestFirst };
    }).catch(function () {
      return null;
    });
  }

  function needsHebrewNameEnrichment(user) {
    if (!user) return false;
    var meta = user.user_metadata || user.raw_user_meta_data || {};
    if (meta.full_name_he && containsHebrew(meta.full_name_he)) return false;
    var current = resolveNameFromAuthUser(user, 'full');
    if (current && containsHebrew(current)) return false;
    if (current && resolveKnownHebrewName(current, 'full')) return false;
    return true;
  }

  function enrichGoogleHebrewNames(session) {
    if (!session || !session.provider_token || !authState.user) return Promise.resolve();
    if (!needsHebrewNameEnrichment(session.user)) return Promise.resolve();
    return fetchGoogleHebrewProfile(session.provider_token).then(function (hebrew) {
      if (!hebrew || (!hebrew.full && !hebrew.first)) return;
      var meta = authState.user.user_metadata || {};
      authState.user.user_metadata = Object.assign({}, meta, {
        full_name_he: hebrew.full || meta.full_name_he,
        given_name_he: hebrew.first || meta.given_name_he,
      });
      authState.user.displayName = resolveUserDisplayName(
        Object.assign({}, session.user, {
          user_metadata: authState.user.user_metadata,
          identity_data: authState.user.identity_data,
        }),
        authState.user.email || ''
      );
      persistAuth();
      var client = getSupabaseClient();
      if (client && client.auth && typeof client.auth.updateUser === 'function') {
        client.auth.updateUser({
          data: {
            full_name_he: hebrew.full,
            given_name_he: hebrew.first,
          },
        }).catch(function () { /* optional */ });
      }
    });
  }

  function getUserDisplayName(user) {
    var u = user || (authState.isAuthenticated ? authState.user : null);
    return resolveUserDisplayName(u, u && u.email ? u.email : getIdentityEmail());
  }

  function getUserFirstName(user) {
    var u = user || (authState.isAuthenticated ? authState.user : null);
    return resolveUserFirstName(u, u && u.email ? u.email : getIdentityEmail());
  }

  function mapSupabaseUser(user) {
    var meta = user.user_metadata || user.raw_user_meta_data || {};
    var identityData = extractGoogleIdentityData(user);
    return {
      id: user.id,
      email: user.email || '',
      displayName: resolveUserDisplayName(user, user.email || ''),
      user_metadata: meta,
      identity_data: identityData || undefined,
    };
  }

  function applySupabaseSession(session) {
    if (!session || !session.user) return Promise.resolve();
    var user = session.user;
    authState.isAuthenticated = true;
    authState.provider = 'supabase';
    authState.user = mapSupabaseUser(user);
    // Reset plan before server sync so a stale localStorage 'pro' cannot win.
    authState.tier = 'trial';
    authState.planType = 'trial';
    authState.isTrial = true;
    if (authState.user.email) writeIdentityEmail(authState.user.email);
    else {
      var mappedPro = resolveProEmailFromUser(authState.user);
      if (mappedPro) writeIdentityEmail(mappedPro);
    }
    hideAuthOverlay();
    return refreshSubscriptionFromServer().finally(function () {
      persistAuth();
      return enrichGoogleHebrewNames(session).finally(function () {
        notifyListeners();
      });
    });
  }

  function clearAuthErrors() {
    var loginErr = document.getElementById('auth-login-error');
    var signupErr = document.getElementById('auth-signup-error');
    if (loginErr) loginErr.textContent = '';
    if (signupErr) signupErr.textContent = '';
  }

  function setAuthLoading(loading, scope) {
    authUiLoading = loading;
    var card = document.getElementById('auth-card');
    var overlay = document.getElementById('auth-overlay');
    var isSession = scope === 'session';
    var isGoogle = scope === 'google';
    var isLogin = scope === 'login';
    var isSignup = scope === 'signup';

    if (card) card.classList.toggle('auth-card--loading', loading && (isSession || isGoogle));
    if (overlay) overlay.setAttribute('aria-busy', loading ? 'true' : 'false');

    document.querySelectorAll('#auth-overlay input, #auth-overlay .auth-tab').forEach(function (el) {
      el.disabled = loading;
    });

    document.querySelectorAll('[data-auth-google]').forEach(function (btn) {
      btn.disabled = loading && (isGoogle || isSession);
      btn.classList.toggle('auth-google-btn--loading', loading && isGoogle);
      btn.setAttribute('aria-label', t('auth_google_btn'));
    });

    var loginSubmit = document.getElementById('auth-submit-login');
    var signupSubmit = document.getElementById('auth-submit-signup');
    if (loginSubmit) {
      loginSubmit.disabled = loading;
      loginSubmit.classList.toggle('auth-submit--loading', loading && isLogin);
    }
    if (signupSubmit) {
      signupSubmit.disabled = loading;
      signupSubmit.classList.toggle('auth-submit--loading', loading && isSignup);
    }
  }

  function t(key, vars) {
    if (typeof global.t === 'function') return global.t(key, vars);
    return key;
  }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function monthKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function readWordDownloads() {
    try {
      var raw = localStorage.getItem(STORAGE_WORD_DOWNLOADS);
      if (!raw) return 0;
      var parsed = JSON.parse(raw);
      if (typeof parsed === 'number') return parsed;
      var tier = normalizeTierId(authState.tier);
      if (tier === 'trial') {
        if (!parsed || parsed.period !== monthKey()) return 0;
        return Number(parsed.count) || 0;
      }
      return Number(parsed.count) || 0;
    } catch (e) {
      return 0;
    }
  }

  function writeWordDownloads(count) {
    try {
      var tier = normalizeTierId(authState.tier);
      var payload = tier === 'trial'
        ? { period: monthKey(), count: Number(count) || 0 }
        : { period: monthKey(), count: Number(count) || 0 };
      localStorage.setItem(STORAGE_WORD_DOWNLOADS, JSON.stringify(payload));
    } catch (e) { /* */ }
  }

  function getWordDownloadsUsed() {
    if (authState.wordDownloadsUsed != null) return authState.wordDownloadsUsed;
    return readWordDownloads();
  }

  function getWordDownloadLimit() {
    var tier = normalizeTierId(authState.planType || authState.tier);
    var cfg = getTierConfig(tier);
    if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'wordDownloadLimit')) {
      if (cfg.wordDownloadLimit == null) return null;
      if (authState.wordDownloadLimit != null) return authState.wordDownloadLimit;
      return cfg.wordDownloadLimit;
    }
    if (authState.wordDownloadLimit != null) return authState.wordDownloadLimit;
    return null;
  }

  function readUsage() {
    try {
      var raw = localStorage.getItem(STORAGE_USAGE);
      if (!raw) return { period: monthKey(), count: 0, lifetime: 0 };
      var data = JSON.parse(raw);
      var tier = normalizeTierId(authState.tier);
      if (tier === 'trial') {
        return { period: 'lifetime', count: Number(data.lifetime) || 0, lifetime: Number(data.lifetime) || 0 };
      }
      if (!data || data.period !== monthKey()) return { period: monthKey(), count: 0, lifetime: Number(data.lifetime) || 0 };
      return { period: data.period, count: Number(data.count) || 0, lifetime: Number(data.lifetime) || 0 };
    } catch (e) {
      return { period: monthKey(), count: 0, lifetime: 0 };
    }
  }

  function writeUsage(usage) {
    try {
      var tier = normalizeTierId(authState.tier);
      var payload = {
        period: tier === 'trial' ? 'lifetime' : monthKey(),
        count: usage.count || 0,
        lifetime: usage.lifetime != null ? usage.lifetime : (usage.count || 0),
      };
      localStorage.setItem(STORAGE_USAGE, JSON.stringify(payload));
    } catch (e) { /* quota */ }
  }

  function applyServerUsage(usage) {
    if (!usage) return;
    if (applyProUserUsageFromServer(usage)) return;
    // Always apply backend plan/usage — never discard plan_type (e.g. standard) for whitelist emails.
    applySubscriptionFields(null, usage);
    authState.searchesUsed = Number(usage.searchesUsed) || 0;
    if (usage.wordDownloadsUsed != null) {
      authState.wordDownloadsUsed = Number(usage.wordDownloadsUsed) || 0;
      writeWordDownloads(authState.wordDownloadsUsed);
    }
    if (Object.prototype.hasOwnProperty.call(usage, 'wordDownloadLimit')) {
      authState.wordDownloadLimit = usage.wordDownloadLimit == null
        ? null
        : (Number(usage.wordDownloadLimit) || 0);
    }
    // Whitelist: unlimited search quota only when not on a capped standard plan.
    if (isProUser() && !isStandardPlan()) {
      authState.searchLimit = null;
      authState.usagePeriod = 'monthly';
    }
    var tier = normalizeTierId(authState.planType || authState.tier);
    if (tier === 'trial' && !hasPaidSubscription()) {
      writeUsage({ count: authState.searchesUsed, lifetime: authState.searchesUsed });
    } else {
      writeUsage({ count: authState.searchesUsed, lifetime: readUsage().lifetime });
    }
  }

  function subscriptionApiUrl() {
    try {
      if (typeof location !== 'undefined' && location.origin && location.protocol !== 'file:') {
        return location.origin + '/api/subscription';
      }
    } catch (e) { /* */ }
    return '/api/subscription';
  }

  function buildTeacherUserPayload() {
    if (!authState.user) return null;
    return {
      id: authState.user.id,
      email: authState.user.email || getIdentityEmail(),
      displayName: authState.user.displayName,
      name: getUpgradeUserFullName(),
      fullName: getUpgradeUserFullName(),
      phone: getUpgradeUserPhone(),
    };
  }

  function fetchSubscriptionAction(action) {
    var identityEmail = getIdentityEmail();
    if (!authState.isAuthenticated && !identityEmail) return Promise.resolve(null);
    return getAccessToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (identityEmail) headers['X-User-Email'] = identityEmail;
      var body = { action: action || 'status', userEmail: identityEmail || undefined };
      var teacherUser = buildTeacherUserPayload();
      if (teacherUser) {
        body.teacherUser = teacherUser;
      } else if (identityEmail) {
        body.teacherUser = {
          email: identityEmail,
        };
      }
      return fetch(subscriptionApiUrl(), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.text().then(function (bodyText) {
          var json;
          try {
            json = bodyText && bodyText.trim() ? JSON.parse(bodyText) : {};
          } catch (parseErr) {
            var parseMsg = parseErr && parseErr.message ? parseErr.message : 'subscription response invalid';
            throw new Error(parseMsg);
          }
          if (!res.ok) {
            var err = new Error((json && json.error) || 'subscription error');
            err.code = json && json.code;
            err.usage = json && json.usage;
            throw err;
          }
          return (json && json.data) || json;
        });
      });
    }).catch(function (err) {
      if (action === 'record_search' || action === 'record_word_download') {
        console.warn('[Auth] subscription', action, 'failed:', err.message || err);
        throw err;
      }
      console.warn('[Auth] subscription sync failed', err.message || err);
      return null;
    });
  }

  function applyUsageFromServer(usage) {
    applyServerUsage(usage);
    persistAuth();
    notifyListeners();
  }

  function refreshSubscriptionFromServer() {
    authState.searchesUsed = null;
    authState.wordDownloadsUsed = null;
    return fetchSubscriptionAction('status').then(function (data) {
      if (!data) return null;
      // Prefer real usage/subscription from DB. Only honor explicit proUser when there is
      // no usage payload (legacy whitelist-only responses).
      if (data.usage) {
        applyServerUsage(data.usage);
      } else if (data.subscription) {
        applySubscriptionFields(data.subscription, null);
      } else if (data.proUser || data.whitelisted) {
        applyProUserUsageFromServer(data.usage || { proUser: true });
      }
      persistAuth();
      notifyListeners();
      return data;
    });
  }

  function getTierConfig(tierId) {
    return TIERS[normalizeTierId(tierId)] || TIERS.trial;
  }

  function getEffectiveLimit(tierId) {
    if (isProUser() && !isStandardPlan()) return null;
    if (authState.searchLimit != null) {
      return authState.searchLimit;
    }
    if (hasPaidSubscription()) {
      var paidTier = getTierConfig(authState.planType || authState.tier);
      if (paidTier.lifetimeLimit != null) return paidTier.lifetimeLimit;
      if (paidTier.monthlyLimit != null) return paidTier.monthlyLimit;
      return null;
    }
    if (normalizeTierId(tierId || authState.tier) === 'trial') {
      return resolveTrialLifetimeSearchLimit();
    }
    var tier = getTierConfig(tierId || authState.tier);
    if (tier.lifetimeLimit != null) return tier.lifetimeLimit;
    return tier.monthlyLimit;
  }

  function getDisplayLimit(tierId) {
    return getEffectiveLimit(tierId);
  }

  function getSearchesUsed() {
    if (authState.searchesUsed != null) return authState.searchesUsed;
    return readUsage().count;
  }

  function persistAuth() {
    if (!authState.isAuthenticated || !authState.user) {
      try { localStorage.removeItem(STORAGE_AUTH); } catch (e) { /* */ }
      return;
    }
    try {
      localStorage.setItem(STORAGE_AUTH, JSON.stringify({
        user: authState.user,
        tier: authState.tier,
        planType: authState.planType,
        isTrial: authState.isTrial,
        provider: authState.provider,
      }));
    } catch (e) { /* */ }
  }

  function loadPersistedAuth() {
    try {
      var raw = localStorage.getItem(STORAGE_AUTH);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data || !data.user) return false;
      if (isSupabaseConfigured() && isMockProvider(data.provider)) {
        try { localStorage.removeItem(STORAGE_AUTH); } catch (e) { /* */ }
        return false;
      }
      if (!shouldAllowMockAuth() && isMockProvider(data.provider)) {
        try { localStorage.removeItem(STORAGE_AUTH); } catch (e) { /* */ }
        return false;
      }
      authState.isAuthenticated = true;
      authState.user = data.user;
      authState.tier = normalizeTierId(data.tier || 'trial');
      authState.planType = normalizeTierId(data.planType || data.tier || 'trial');
      authState.isTrial = data.isTrial != null ? parseIsTrialFlag(data.isTrial) : authState.planType === 'trial';
      authState.provider = data.provider || 'mock';
      return true;
    } catch (e) {
      return false;
    }
  }

  function notifyListeners() {
    ensureAuthChromeUnlocked();
    listeners.forEach(function (fn) {
      try { fn(getPublicState()); } catch (e) { console.warn(e); }
    });
    updateHeaderUi();
    updateIdentityEmailUi();
    updateSearchMeterUi();
  }

  function getPublicState() {
    var usage = readUsage();
    var displayLimit = getDisplayLimit();
    var used = getSearchesUsed();
    var effectiveLimit = getEffectiveLimit();
    var planType = resolvePlanType();
    return {
      isAuthenticated: authState.isAuthenticated,
      user: authState.user ? Object.assign({}, authState.user) : null,
      tier: planType,
      planType: planType,
      isTrial: authState.isTrial,
      hasPaidSubscription: hasPaidSubscription(),
      provider: authState.provider,
      sessionReady: authState.sessionReady,
      autoRenew: authState.autoRenew,
      billingCycle: authState.billingCycle,
      expiresAt: authState.expiresAt,
      usagePeriod: authState.usagePeriod || (planType === 'trial' ? 'lifetime' : 'monthly'),
      searchesToday: used,
      searchesUsed: used,
      dailyLimit: displayLimit,
      searchLimit: displayLimit,
      effectiveLimit: effectiveLimit,
      remaining: displayLimit === null ? null : Math.max(0, displayLimit - used),
      wordDownloadsUsed: getWordDownloadsUsed(),
      wordDownloadLimit: getWordDownloadLimit(),
      wordDownloadsRemaining: (function () {
        var limit = getWordDownloadLimit();
        if (limit == null) return null;
        return Math.max(0, limit - getWordDownloadsUsed());
      })(),
      tierConfig: getTierConfig(planType),
      isProUser: isProUser(),
      identityEmail: getIdentityEmail(),
    };
  }

  function subscribe(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) { return f !== fn; });
    };
  }

  /* ── Supabase Auth ─────────────────────────────────────────────────────── */

  function initSupabaseAuth(client) {
    if (!client || typeof client.auth === 'undefined') {
      console.warn('[Auth] initSupabaseAuth: invalid Supabase client');
      return Promise.resolve(null);
    }
    supabaseClient = client;
    return client.auth.getSession().then(function (result) {
      var session = result && result.data && result.data.session;
      var applySession = function (sess) {
        if (!sess || !sess.user) return Promise.resolve(sess);
        applySupabaseSession(sess);
        return sess;
      };
      if (session && session.user && typeof client.auth.getUser === 'function') {
        return client.auth.getUser().then(function (userResult) {
          if (userResult && userResult.data && userResult.data.user) {
            session = Object.assign({}, session, { user: userResult.data.user });
          }
          return applySession(session);
        }).catch(function () {
          return applySession(session);
        });
      }
      return applySession(session);
    }).then(function (session) {
      client.auth.onAuthStateChange(function (event, sess) {
        if (sess && sess.user) {
          applySupabaseSession(sess);
        } else if (event === 'SIGNED_OUT') {
          if (!logoutRequested) {
            logoutRequested = true;
            runLogoutCleanupHooks();
            completeLogoutRedirect();
          }
        }
      });
      authState.sessionReady = true;
      notifyListeners();
      return session;
    });
  }

  function signInWithEmail(email, password) {
    var trimmed = String(email || '').trim().toLowerCase();
    if (!trimmed || !String(password || '').length) {
      return Promise.reject(new Error(t('auth_err_required')));
    }
    clearAuthErrors();
    var client = getSupabaseClient();
    if (!client) {
      if (shouldAllowMockAuth()) return mockSignIn(trimmed, password);
      return Promise.reject(new Error(t('auth_err_supabase')));
    }

    setAuthLoading(true, 'login');
    return client.auth.signInWithPassword({ email: trimmed, password: password })
      .then(function (result) {
        if (result.error) throw result.error;
        if (result.data && result.data.session) applySupabaseSession(result.data.session);
        return getPublicState();
      })
      .catch(function (err) { throw normalizeAuthError(err); })
      .finally(function () { setAuthLoading(false, 'login'); });
  }

  function signUpWithEmail(email, password, displayName) {
    var trimmed = String(email || '').trim().toLowerCase();
    if (!trimmed || !String(password || '').length) {
      return Promise.reject(new Error(t('auth_err_required')));
    }
    clearAuthErrors();
    var client = getSupabaseClient();
    if (!client) {
      if (shouldAllowMockAuth()) return mockSignUp(trimmed, password, displayName);
      return Promise.reject(new Error(t('auth_err_supabase')));
    }

    setAuthLoading(true, 'signup');
    return client.auth.signUp({
      email: trimmed,
      password: password,
      options: {
        data: {
          full_name: String(displayName || '').trim() || trimmed.split('@')[0],
          tier: 'trial',
        },
      },
    })
      .then(function (result) {
        if (result.error) throw result.error;
        if (result.data && result.data.session) {
          applySupabaseSession(result.data.session);
        } else {
          var signupErr = document.getElementById('auth-signup-error');
          if (signupErr) signupErr.textContent = t('auth_confirm_email');
        }
        return getPublicState();
      })
      .catch(function (err) { throw normalizeAuthError(err); })
      .finally(function () { setAuthLoading(false, 'signup'); });
  }

  function mockGoogleSignIn() {
    console.log('[WaldorfAuth] Google sign-in clicked — local mock admin mode');
    setAuthLoading(true, 'google');
    return new Promise(function (resolve) {
      setTimeout(function () {
        authState.isAuthenticated = true;
        authState.provider = 'mock-google';
        authState.user = {
          id: 'local_admin_dev',
          email: getLocalDevAdminEmail(),
          displayName: getLocalDevAdminDisplayName(),
        };
        authState.tier = 'pro';
        authState.planType = 'pro';
        authState.isTrial = false;
        authState.searchLimit = null;
        ensureLocalDevAdminPrivileges();
        persistAuth();
        hideAuthOverlay();
        notifyListeners();
        setAuthLoading(false, 'google');
        console.log('[WaldorfAuth] Local mock admin login successful', getPublicState());
        resolve(getPublicState());
      }, 700);
    });
  }

  function signInWithGoogle() {
    clearAuthErrors();
    if (shouldAllowMockAuth()) {
      return mockGoogleSignIn();
    }
    assertSupabaseReadyForOAuth();
    var client = getSupabaseClient();
    if (!client) {
      return Promise.reject(new Error(t('auth_err_supabase')));
    }
    setAuthLoading(true, 'google');
    var oauthRedirectTo = resolveAuthRedirectUrl();
    return client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: oauthRedirectTo,
        skipBrowserRedirect: false,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    })
      .then(function (result) {
        if (result.error) throw result.error;
        var oauthUrl = result.data && result.data.url;
        if (oauthUrl) {
          global.location.assign(oauthUrl);
          return result;
        }
        throw new Error(t('auth_err_supabase_oauth'));
      })
      .catch(function (err) {
        setAuthLoading(false, 'google');
        throw normalizeAuthError(err);
      });
  }

  function onLogoutCleanup(fn) {
    if (typeof fn === 'function') logoutCleanupHooks.push(fn);
  }

  function getCleanAppUrl() {
    try {
      var loc = global.location;
      return loc.origin + loc.pathname;
    } catch (e) {
      return '/';
    }
  }

  function runLogoutCleanupHooks() {
    logoutCleanupHooks.forEach(function (fn) {
      try { fn(); } catch (e) { console.warn('[Auth] logout cleanup hook failed:', e); }
    });
  }

  function clearAuthBrowserStorage() {
    var keys = [
      STORAGE_AUTH,
      STORAGE_USAGE,
      STORAGE_WORD_DOWNLOADS,
      STORAGE_IDENTITY_EMAIL,
      'chat_history',
    ];
    keys.forEach(function (key) {
      try { localStorage.removeItem(key); } catch (e) { /* */ }
    });
    // Supabase session tokens — do not use localStorage.clear(); preserve UI prefs (e.g. hideWelcomePage).
    try {
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && /^sb-.*-auth-token$/.test(k)) toRemove.push(k);
      }
      toRemove.forEach(function (k) {
        try { localStorage.removeItem(k); } catch (e) { /* */ }
      });
    } catch (e) { /* */ }
  }

  function completeLogoutRedirect() {
    if (logoutFinalized) return;
    logoutFinalized = true;
    clearAuthBrowserStorage();
    resetSupabaseClient();
    authState.isAuthenticated = false;
    authState.user = null;
    authState.tier = 'trial';
    authState.provider = 'mock';
    authState.sessionReady = true;
    // Hard reload after logout: once the session is cleared we force a FULL page load
    // (window.location.reload(true)) so the browser drops every byte of in-memory app
    // state, caches and timers, and the user lands on a completely clean page.
    try {
      var cleanUrl = getCleanAppUrl();
      var current = String(global.location.href || '').split('#')[0];
      if (current === cleanUrl) {
        // Already on the clean URL — a plain hard reload is the cleanest reset.
        global.location.reload(true);
      } else {
        // Strip any OAuth tokens / query / hash by navigating to the clean URL,
        // which itself triggers a full document load.
        global.location.replace(cleanUrl);
      }
    } catch (e) {
      try { global.location.reload(true); }
      catch (e2) {
        try { global.location.href = getCleanAppUrl(); } catch (e3) { /* */ }
      }
    }
  }

  function signOut() {
    logoutRequested = true;
    runLogoutCleanupHooks();
    var client = getSupabaseClient();
    if (client && authState.provider === 'supabase') {
      return client.auth.signOut()
        .then(completeLogoutRedirect)
        .catch(completeLogoutRedirect);
    }
    completeLogoutRedirect();
    return Promise.resolve();
  }

  /* ── Legacy provider hooks ─────────────────────────────────────────────── */
  function initFirebaseAuth(firebaseAuth) {
    if (!firebaseAuth || typeof firebaseAuth.onAuthStateChanged !== 'function') {
      console.warn('[Auth] initFirebaseAuth: invalid Firebase auth');
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      firebaseAuth.onAuthStateChanged(function (user) {
        if (user) {
          applyExternalUser({
            id: user.uid,
            email: user.email,
            displayName: user.displayName,
          }, 'firebase', user.tier);
        } else if (authState.provider === 'firebase') {
          clearAuth(false);
        }
        authState.sessionReady = true;
        notifyListeners();
        resolve(user);
      });
    });
  }

  function applyExternalUser(externalUser, provider, tier) {
    authState.isAuthenticated = true;
    authState.provider = provider;
    authState.user = {
      id: externalUser.id || externalUser.uid || '',
      email: externalUser.email || '',
      displayName: resolveUserDisplayName(externalUser, externalUser.email || '') || String(externalUser.displayName || '').trim(),
    };
    authState.tier = tier && TIERS[normalizeTierId(tier)] ? normalizeTierId(tier) : authState.tier || 'trial';
    persistAuth();
    hideAuthOverlay();
    notifyListeners();
  }

  /* ── Mock auth (development) ───────────────────────────────────────────── */

  function mockSignUp(email, password, displayName) {
    var trimmed = String(email || '').trim().toLowerCase();
    if (!trimmed || !String(password || '').length) {
      return Promise.reject(new Error(t('auth_err_required')));
    }
    setAuthLoading(true, 'signup');
    authState.isAuthenticated = true;
    authState.provider = 'mock';
    authState.user = {
      id: 'mock_' + Date.now(),
      email: trimmed,
      displayName: String(displayName || '').trim() || trimmed.split('@')[0],
    };
    authState.tier = 'trial';
    persistAuth();
    hideAuthOverlay();
    notifyListeners();
    return Promise.resolve(getPublicState()).finally(function () {
      setAuthLoading(false, 'signup');
    });
  }

  function mockSignIn(email, password) {
    var trimmed = String(email || '').trim().toLowerCase();
    if (!trimmed || !String(password || '').length) {
      return Promise.reject(new Error(t('auth_err_required')));
    }
    setAuthLoading(true, 'login');
    var restored = loadPersistedAuth();
    if (restored && authState.user && authState.user.email === trimmed) {
      authState.isAuthenticated = true;
      hideAuthOverlay();
      notifyListeners();
      return Promise.resolve(getPublicState()).finally(function () {
        setAuthLoading(false, 'login');
      });
    }
    return mockSignUp(trimmed, password, trimmed.split('@')[0]);
  }

  function mockSignOut() {
    return signOut();
  }

  function clearAuth(removeStorage) {
    authState.isAuthenticated = false;
    authState.user = null;
    authState.tier = 'trial';
    authState.provider = 'mock';
    if (removeStorage) {
      try { localStorage.removeItem(STORAGE_AUTH); } catch (e) { /* */ }
    }
    notifyListeners();
  }

  function setTier(tierId) {
    var normalized = normalizeTierId(tierId);
    if (!TIERS[normalized]) return;
    authState.tier = normalized;
    persistAuth();
    notifyListeners();
  }

  function startStripeCheckout(tierId, billingCycle) {
    return getAccessToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      var identityEmail = getIdentityEmail();
      if (identityEmail) headers['X-User-Email'] = identityEmail;
      var body = {
        planType: tierId,
        billingCycle: billingCycle || pricingBillingCycle,
        userEmail: identityEmail || undefined,
      };
      if (authState.user) {
        body.teacherUser = Object.assign({}, buildTeacherUserPayload() || {}, {
          tier: authState.tier,
        });
      }
      return fetch(billingCheckoutUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.text().then(function (text) {
          var json;
          try { json = text && text.trim() ? JSON.parse(text) : {}; } catch (e) { json = {}; }
          // Stripe not usable on the server (e.g. price IDs removed) — fall back to Grow.
          if (json && json.code === 'CHECKOUT_UNAVAILABLE') {
            var fallbackEmail = getUpgradeUserEmail();
            if (fallbackEmail) return startMakeUpgradeCheckout(fallbackEmail, null);
          }
          if (!res.ok) throw new Error((json && json.error) || 'checkout error');
          var checkoutUrl = json.data && json.data.checkoutUrl;
          if (!checkoutUrl) throw new Error('checkout URL missing');
          global.location.assign(checkoutUrl);
          return json.data;
        });
      });
    });
  }

  function getUpgradeUserEmail() {
    if (authState.isAuthenticated && authState.user && authState.user.email) {
      return normalizeEmail(authState.user.email);
    }
    return getIdentityEmail() || '';
  }

  function getUpgradeUserFullName() {
    var name = String(getUserDisplayName() || '').trim();
    return name || 'מנוי מרוצה';
  }

  function getUpgradeUserPhone() {
    var user = authState.isAuthenticated ? authState.user : null;
    if (!user) return '';
    var meta = user.user_metadata || {};
    var candidates = [
      meta.phone,
      meta.phone_number,
      meta.mobile,
      user.phone,
    ];
    if (user.identity_data) {
      candidates.push(user.identity_data.phone);
      candidates.push(user.identity_data.phone_number);
    }
    for (var i = 0; i < candidates.length; i++) {
      var value = String(candidates[i] || '').trim();
      if (value) return value;
    }
    return '';
  }

  function closeCheckoutTab(newTab) {
    if (!newTab || typeof newTab.close !== 'function') return;
    try { newTab.close(); } catch (e) { /* ignore */ }
  }

  /** Extract a checkout URL from a Make/Grow response — tolerant of JSON, nested JSON, or a bare URL string. */
  function extractMakeCheckoutUrl(rawText) {
    var text = String(rawText || '').trim();
    if (!text) return '';
    var parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      var fromJson = String(
        parsed.url ||
        parsed.checkoutUrl ||
        parsed.payment_url ||
        parsed.paymentUrl ||
        parsed.paymentLink ||
        parsed.payment_link ||
        (parsed.data && (parsed.data.url || parsed.data.checkoutUrl || parsed.data.payment_url || parsed.data.paymentLink)) ||
        (parsed.data && parsed.data.data && parsed.data.data.url) ||
        ''
      ).trim();
      if (/^https?:\/\//i.test(fromJson)) return fromJson;
    }
    // Make scenarios without a JSON "Webhook response" module may return a bare URL (or text containing one).
    if (/^https?:\/\//i.test(text)) return text;
    var match = text.match(/https?:\/\/[^\s"'<>]+/i);
    return match ? match[0].trim() : '';
  }

  function fallbackGrowCheckoutUrl(planKey) {
    var plan = planKey === 'one_time' ? 'one_time' : 'annual';
    return String(plan === 'one_time' ? GROW_ONE_TIME_URL : GROW_ANNUAL_URL || GROW_UPGRADE_URL || '').trim();
  }

  /**
   * Ask Make for a dynamic Grow checkout URL (paymentLinkProcessId).
   * This request must NEVER activate a subscription — Supabase upgrades only via
   * POST /api/webhooks/payment-success after Grow confirms a real charge.
   */
  function requestMakeCheckoutUrl(email, planKey) {
    var webhookUrl = String(MAKE_UPGRADE_WEBHOOK_URL || '').trim();
    var plan = planKey === 'one_time' ? 'one_time_support' : 'annual_pro';
    var price = planKey === 'one_time' ? 100 : 220;
    var fallbackUrl = fallbackGrowCheckoutUrl(planKey);

    if (!email || !/^https?:\/\//i.test(webhookUrl)) {
      return Promise.resolve(fallbackUrl);
    }

    return fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        name: getUpgradeUserFullName(),
        phone: getUpgradeUserPhone() || '0500000000',
        plan: plan,
        price: price,
        // Explicit intent so Make must NOT call /api/webhooks/payment-success here.
        intent: 'checkout_link',
        event: 'checkout_link_request',
      }),
    }).then(function (res) {
      return res.text().then(function (text) {
        var fromMake = extractMakeCheckoutUrl(text);
        if (/^https?:\/\//i.test(fromMake)) return fromMake;
        if (!res.ok) {
          console.warn('[upgrade] Make checkout webhook returned', res.status, '— using static Grow URL');
        }
        return fallbackUrl;
      });
    }).catch(function (err) {
      console.warn('[upgrade] Make checkout webhook failed — using static Grow URL', err && err.message);
      return fallbackUrl;
    });
  }

  /** Open a checkout URL in a new tab — never navigate this site away, never touch Supabase. */
  function openCheckoutUrlInNewTab(checkoutUrl) {
    if (!/^https?:\/\//i.test(checkoutUrl)) return false;
    try {
      var anchor = document.createElement('a');
      anchor.href = checkoutUrl;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      return true;
    } catch (e) {
      var opened = global.open(checkoutUrl, '_blank');
      if (opened) {
        try { opened.opener = null; } catch (openerErr) { /* ignore */ }
        return true;
      }
      return false;
    }
  }

  /**
   * Checkout flow: Make webhook → open Grow link only.
   * Do NOT refreshSubscriptionFromServer / setTier / write Supabase here.
   */
  function startMakeUpgradeCheckout(userEmail, newTab, planKey) {
    var email = normalizeEmail(userEmail);
    var plan = planKey === 'one_time' ? 'one_time' : 'annual';

    return requestMakeCheckoutUrl(email, plan).then(function (checkoutUrl) {
      if (!/^https?:\/\//i.test(checkoutUrl)) {
        closeCheckoutTab(newTab);
        console.error('[upgrade] Grow checkout URL is not configured:', checkoutUrl, plan);
        return Promise.reject(new Error(t('paywall_upgrade_error')));
      }

      if (newTab) {
        try {
          newTab.location.href = checkoutUrl;
        } catch (assignErr) {
          closeCheckoutTab(newTab);
          if (!openCheckoutUrlInNewTab(checkoutUrl)) {
            showContactToast(t('paywall_upgrade_popup_blocked'), 'error');
            global.location.href = checkoutUrl;
          }
        }
      } else if (!openCheckoutUrlInNewTab(checkoutUrl)) {
        showContactToast(t('paywall_upgrade_popup_blocked'), 'error');
        global.location.href = checkoutUrl;
      }

      // Intentionally no subscription refresh — Pro activates only after Grow payment webhook.
      return { url: checkoutUrl, plan: plan };
    });
  }

  /** Open Grow checkout via Make dynamic link (fallback: static Grow URL). */
  function openGrowCheckout(planKey) {
    var email = getUpgradeUserEmail();
    if (!email) {
      showAuthOverlay();
      return false;
    }
    startMakeUpgradeCheckout(email, null, planKey === 'one_time' ? 'one_time' : 'annual').catch(function () {
      showContactToast(t('paywall_upgrade_error'), 'error');
    });
    return true;
  }

  function syncGrowCheckoutLinkElements() {
    var pairs = [
      { id: 'upgrade-plan-one-time', url: GROW_ONE_TIME_URL },
      { id: 'upgrade-plan-annual', url: GROW_ANNUAL_URL || GROW_UPGRADE_URL },
      { id: 'pricing-plan-one-time', url: GROW_ONE_TIME_URL },
      { id: 'pricing-plan-annual', url: GROW_ANNUAL_URL || GROW_UPGRADE_URL },
    ];
    pairs.forEach(function (pair) {
      var el = document.getElementById(pair.id);
      if (!el || !pair.url) return;
      if (el.tagName === 'A') {
        el.setAttribute('href', pair.url);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  function mockUpgrade(tierId, billingCycle) {
    if (!authState.isAuthenticated) return Promise.reject(new Error(t('auth_err_sign_in_first')));
    var normalized = normalizeTierId(tierId);
    if (!TIERS[normalized] || normalized === 'school') return Promise.reject(new Error('Invalid tier'));
    if (normalized === 'trial') {
      authState.tier = normalized;
      persistAuth();
      hidePricingModal();
      notifyListeners();
      return Promise.resolve({ tier: normalized, billingCycle: billingCycle || 'monthly' });
    }
    var cycle = billingCycle || pricingBillingCycle;
    if (stripeCheckoutEnabled) {
      hidePricingModal();
      return startStripeCheckout(normalized, cycle);
    }
    var userEmail = getUpgradeUserEmail();
    if (!userEmail) {
      showAuthOverlay();
      return;
    }
    hidePricingModal();
    return startMakeUpgradeCheckout(userEmail, null);
  }

  /* ── Rate limiter ────────────────────────────────────────────────────── */

  function canPerformSearch() {
    if (isProUser() && !isStandardPlan()) {
      return { allowed: true, unlimited: true, proUser: true, usage: 0, limit: null };
    }
    if (!authState.isAuthenticated) return { allowed: false, reason: 'auth' };
    var used = getSearchesUsed();
    var limit = getEffectiveLimit();
    if (limit == null) {
      return { allowed: true, unlimited: true, usage: used, limit: null };
    }
    if (used >= limit) {
      return { allowed: false, reason: 'limit', usage: used, limit: limit };
    }
    return { allowed: true, usage: used, limit: limit };
  }

  function canPerformWordDownload() {
    if (isProUser() && !isStandardPlan()) return { allowed: true, unlimited: true, proUser: true };
    if (!authState.isAuthenticated) return { allowed: false, reason: 'auth' };
    var limit = getWordDownloadLimit();
    if (limit == null) return { allowed: true, unlimited: true };
    var used = getWordDownloadsUsed();
    if (used >= limit) {
      return { allowed: false, reason: 'word_limit', usage: used, limit: limit };
    }
    return { allowed: true, usage: used, limit: limit };
  }

  function assertWordDownloadAllowed() {
    var check = canPerformWordDownload();
    if (!check.allowed) {
      if (check.reason === 'auth') showAuthOverlay();
      else showFreeTierLimitModal();
      var err = new Error(t('word_download_limit_exceeded'));
      err.code = 'WORD_DOWNLOAD_LIMIT';
      err.details = check;
      throw err;
    }
    return check;
  }

  function recordWordDownload() {
    if (isProUser() && !isStandardPlan()) {
      return Promise.resolve(getWordDownloadsUsed());
    }
    var limit = getWordDownloadLimit();
    // Unlimited (pro) — no counter increment.
    if (limit == null) {
      return Promise.resolve(getWordDownloadsUsed());
    }
    return fetchSubscriptionAction('record_word_download').then(function (data) {
      if (data && data.usage) {
        applyServerUsage(data.usage);
        notifyListeners();
        return data.usage.wordDownloadsUsed;
      }
      var used = getWordDownloadsUsed() + 1;
      authState.wordDownloadsUsed = used;
      writeWordDownloads(used);
      notifyListeners();
      return used;
    }).catch(function (err) {
      if (err && err.code === 'WORD_DOWNLOAD_LIMIT') {
        if (err.usage) applyServerUsage(err.usage);
        showFreeTierLimitModal();
      }
      throw err;
    });
  }

  function recordSearch() {
    if (isProUser() && !isStandardPlan()) {
      notifyListeners();
      updateHeaderUi();
      updateSearchMeterUi();
      return Promise.resolve(getSearchesUsed());
    }
    return fetchSubscriptionAction('record_search').then(function (data) {
      if (data && data.usage) {
        applyServerUsage(data.usage);
        notifyListeners();
        return data.usage.searchesUsed;
      }
      if (data && data.fallback) {
        var usage = readUsage();
        var tier = normalizeTierId(authState.tier);
        var lifetimeTier = tier === 'trial' || tier === 'standard';
        if (lifetimeTier) {
          usage.lifetime = (Number(usage.lifetime) || 0) + 1;
          usage.count = usage.lifetime;
        } else {
          if (usage.period !== monthKey()) {
            usage.period = monthKey();
            usage.count = 0;
          }
          usage.count += 1;
        }
        writeUsage(usage);
        authState.searchesUsed = usage.count;
        notifyListeners();
        return usage.count;
      }
      return getSearchesUsed();
    }).catch(function (err) {
      if (err && (err.code === 'RATE_LIMIT' || err.code === 'RATE_LIMIT_MONTHLY')) {
        if (err.usage) applyServerUsage(err.usage);
        showSearchLimitBlocked({
          usage: err.usage,
          tier: err.code === 'RATE_LIMIT' ? 'trial' : undefined,
          usagePeriod: err.code === 'RATE_LIMIT' ? 'lifetime' : 'monthly',
        });
        throw err;
      }
      return refreshSubscriptionFromServer().then(function (data) {
        if (data && data.usage) return data.usage.searchesUsed;
        return getSearchesUsed();
      });
    });
  }

  /** After a successful live search — sync usage from server; never double-bill when searchBilled. */
  function syncUsageAfterLiveSearch(meta) {
    var m = meta || {};
    var chain = Promise.resolve();
    // Free / community-archive summary paths must never consume live-search credits.
    if (
      m.skipLiveSearchBilling === true
      || m.freeCommunitySummary === true
      || m.free === true
      || m.phase === 'community_summarizer'
      || m.billable === false
    ) {
      if (m.usage) {
        applyServerUsage(m.usage);
        persistAuth();
        notifyListeners();
        return Promise.resolve(m.usage);
      }
      return Promise.resolve(null);
    }
    if (m.usage) {
      applyServerUsage(m.usage);
      persistAuth();
      notifyListeners();
      return Promise.resolve(m.usage);
    }
    if (!m.searchBilled && !m.fromCache) {
      chain = recordSearch().catch(function (usageErr) {
        console.warn('[usage] recordSearch failed after generate:', usageErr && usageErr.message ? usageErr.message : usageErr);
        return null;
      });
    }
    return chain.then(function (data) {
      if (data && data.usage) {
        applyServerUsage(data.usage);
        persistAuth();
        notifyListeners();
        return data.usage;
      }
      return refreshSubscriptionFromServer();
    });
  }

  function assertSearchAllowed() {
    var check = canPerformSearch();
    if (!check.allowed) {
      if (check.reason === 'auth') showAuthOverlay();
      else showSearchLimitBlocked({ tier: normalizeTierId(authState.tier), usagePeriod: authState.usagePeriod });
      var err = new Error(t('rate_limit_exceeded'));
      err.code = normalizeTierId(authState.tier) === 'trial' ? 'RATE_LIMIT' : 'RATE_LIMIT_MONTHLY';
      err.details = check;
      throw err;
    }
    return check;
  }

  function getSearchesRemainingDisplay() {
    var check = canPerformSearch();
    if (!check.allowed) return 0;
    if (check.unlimited || check.limit == null) return null;
    var used = Number(check.usage) || 0;
    var limit = Number(check.limit) || 0;
    return Math.max(0, limit - used);
  }

  /**
   * Show confirmation before a credit-consuming search/AI action.
   * Resolves true on confirm, false on cancel. Does not bill — server bills on success.
   */
  function confirmCreditUsage(options) {
    var opts = options || {};
    // Chat / system help / archive-cache hits must never show a payment/credit modal.
    // Callers must run checkArchiveHit first; these flags are a hard safety net.
    if (opts.skipConfirm || opts.phase === 'chat_followup' || opts.free === true ||
        opts.phase === 'community_summarizer' || opts.skipLiveSearchBilling === true ||
        opts.freeCommunitySummary === true ||
        opts.isArchiveHit || opts.fromCache || opts.hit === true) {
      return Promise.resolve(true);
    }
    var check;
    try {
      check = assertSearchAllowed();
    } catch (err) {
      return Promise.resolve(false);
    }
    var remaining = getSearchesRemainingDisplay();
    var modal = document.getElementById('credit-confirm-modal');
    var msgEl = document.getElementById('credit-confirm-message');
    var okBtn = document.getElementById('credit-confirm-ok');
    var cancelBtn = document.getElementById('credit-confirm-cancel');
    var backdrop = document.getElementById('credit-confirm-backdrop');
    if (!modal || !msgEl || !okBtn || !cancelBtn) {
      // Fallback when modal markup is missing — proceed after quota gate.
      return Promise.resolve(true);
    }
    var bodyKey = remaining == null ? 'credit_confirm_unlimited' : 'credit_confirm_body';
    var creditsLabel = remaining == null
      ? (isEnglishUi() ? 'unlimited' : 'ללא הגבלה')
      : String(remaining);
    msgEl.textContent = t(bodyKey, { credits: creditsLabel });
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    return new Promise(function (resolve) {
      function cleanup(result) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        if (backdrop) backdrop.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onOk(e) {
        if (e) e.preventDefault();
        cleanup(true);
      }
      function onCancel(e) {
        if (e) e.preventDefault();
        cleanup(false);
      }
      function onKey(e) {
        if (e.key === 'Escape') onCancel(e);
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (backdrop) backdrop.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      try { okBtn.focus(); } catch (focusErr) { /* ignore */ }
    });
  }

  function isEnglishUi() {
    try {
      if (typeof global.getUiLang === 'function') return global.getUiLang() === 'en';
      if (document && document.documentElement) {
        return String(document.documentElement.lang || '').toLowerCase().indexOf('en') === 0;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function wrapResearchCall(fn) {
    return function () {
      assertSearchAllowed();
      var args = arguments;
      var self = this;
      return Promise.resolve(fn.apply(self, args)).then(function (result) {
        return recordSearch().then(function () { return result; });
      });
    };
  }

  /* ── UI ─────────────────────────────────────────────────────────────── */

  var pricingBillingCycle = 'yearly';

  function escapeHtml(s) {
    if (typeof global.escapeHtml === 'function') return global.escapeHtml(s);
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showAuthOverlay() {
    setShowEmailForm(false);
    var el = document.getElementById('auth-overlay');
    if (el) {
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('auth-locked');
    }
  }

  function ensureAuthChromeUnlocked() {
    if (authState.isAuthenticated || isProUser()) {
      if (document.body) document.body.classList.remove('auth-locked');
    }
  }

  function formatHeaderDisplayName() {
    var name = getUserDisplayName();
    if (name) return name;
    var email = authState.user && authState.user.email
      ? normalizeEmail(authState.user.email)
      : getIdentityEmail();
    if (email) {
      var byEmail = resolveHebrewNameByEmail(authState.user, email, 'full');
      if (byEmail) return byEmail;
      return formatNameFromEmail(email) || '';
    }
    return '';
  }

  function setHeaderDisplayName(el) {
    if (!el) return;
    var displayName = formatHeaderDisplayName();
    el.textContent = displayName;
    el.setAttribute('title', displayName);
    el.classList.toggle('is-empty', !displayName);
  }

  function hideAuthOverlay() {
    ensureAuthChromeUnlocked();
    var el = document.getElementById('auth-overlay');
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('auth-locked');
    }
    var active = document.activeElement;
    if (active && el && el.contains(active) && typeof active.blur === 'function') {
      active.blur();
    }
    var gradeSel = document.getElementById('grade-select');
    if (gradeSel && document.activeElement === gradeSel && typeof gradeSel.blur === 'function') {
      gradeSel.blur();
    }
    var sentinel = document.getElementById('page-focus-sentinel');
    if (sentinel && typeof sentinel.focus === 'function') {
      try {
        sentinel.focus({ preventScroll: true });
      } catch (e) {
        sentinel.focus();
      }
    }
    if (typeof global.scheduleInitialPageScrollReset === 'function') {
      global.scheduleInitialPageScrollReset();
    } else if (typeof global.ensurePageAtTop === 'function') {
      global.ensurePageAtTop();
    } else {
      global.scrollTo(0, 0);
    }
  }

  function showFreeTierLimitModal() {
    var el = document.getElementById('free-tier-limit-modal');
    var title = document.getElementById('free-tier-limit-title');
    if (title) title.textContent = t('upgrade_modal_title');
    var msg = document.getElementById('free-tier-limit-message');
    if (msg) msg.textContent = t('upgrade_modal_body');
    var reassurance = document.getElementById('upgrade-modal-reassurance');
    if (reassurance) reassurance.textContent = t('upgrade_modal_reassurance');
    var oneTimeBtn = document.getElementById('upgrade-plan-one-time');
    if (oneTimeBtn) oneTimeBtn.textContent = t('pricing_buy_one_time');
    var annualBtn = document.getElementById('upgrade-plan-annual');
    if (annualBtn) annualBtn.textContent = t('pricing_buy_annual');
    var closeBtn = document.getElementById('free-tier-limit-close');
    if (closeBtn) closeBtn.textContent = t('free_tier_limit_close');
    syncGrowCheckoutLinkElements();
    if (el) {
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('free-tier-limit-open');
    }
  }

  function hideFreeTierLimitModal() {
    var el = document.getElementById('free-tier-limit-modal');
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('free-tier-limit-open');
    }
  }

  function showPricingModal(noticeKey) {
    var el = document.getElementById('pricing-modal');
    var notice = document.getElementById('pricing-modal-notice');
    if (notice) {
      if (noticeKey) {
        notice.textContent = t(noticeKey);
        notice.classList.remove('hidden');
      } else {
        notice.textContent = '';
        notice.classList.add('hidden');
      }
    }
    if (el) {
      renderPricingComparisonTable();
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('pricing-modal-open');
    }
  }

  function hidePricingModal() {
    var el = document.getElementById('pricing-modal');
    var notice = document.getElementById('pricing-modal-notice');
    if (notice) {
      notice.textContent = '';
      notice.classList.add('hidden');
    }
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('pricing-modal-open');
    }
  }

  function showSearchLimitBlocked(opts) {
    var o = opts || {};
    if (o.usage) applyServerUsage(o.usage);
    var tier = normalizeTierId(o.tier || (o.usage && o.usage.tier) || authState.tier);
    var period = o.usagePeriod || (o.usage && o.usage.usagePeriod) || authState.usagePeriod;
    if (tier === 'trial' || period === 'lifetime') {
      showFreeTierLimitModal();
    } else {
      showRateLimitModal({
        usage: o.usage && o.usage.searchesUsed != null ? o.usage.searchesUsed : getSearchesUsed(),
        limit: o.usage && o.usage.searchLimit != null ? o.usage.searchLimit : getEffectiveLimit(),
        monthly: true,
      });
    }
  }

  function showRateLimitModal(check) {
    var el = document.getElementById('rate-limit-modal');
    var msg = document.getElementById('rate-limit-message');
    var titleEl = document.getElementById('rate-limit-title');
    if (titleEl) {
      titleEl.textContent = check && check.monthly
        ? t('rate_limit_monthly_title')
        : t('rate_limit_title');
    }
    if (msg) {
      var displayLimit = check && check.limit != null ? check.limit : getDisplayLimit();
      var used = check && check.usage != null ? check.usage : getSearchesUsed();
      var text = check && check.monthly
        ? t('rate_limit_monthly_body', { used: used, limit: displayLimit != null ? displayLimit : getEffectiveLimit() })
        : t('rate_limit_body', { used: used, limit: displayLimit != null ? displayLimit : getEffectiveLimit() });
      msg.textContent = text;
    }
    if (el) {
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function hideRateLimitModal() {
    var el = document.getElementById('rate-limit-modal');
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  function tierLabel(tierId) {
    return t('tier_' + tierId + '_name');
  }

  function formatPrice(amount, cycle) {
    if (!amount) return t('pricing_free');
    var suffix = cycle === 'yearly' ? t('pricing_per_year') : t('pricing_per_month');
    return amount + ' ₪' + suffix;
  }

  function whatsAppSupportUrl(message) {
    var phone = String(SUPPORT_WHATSAPP || '').replace(/\D/g, '');
    if (!phone) return 'https://wa.me/?text=' + encodeURIComponent(message || '');
    return 'https://wa.me/' + phone + '?text=' + encodeURIComponent(message || '');
  }

  function showCheckoutSoonModal(tierId, billingCycle) {
    var el = document.getElementById('checkout-soon-modal');
    var msg = document.getElementById('checkout-soon-message');
    var link = document.getElementById('checkout-soon-whatsapp');
    if (msg) {
      msg.textContent = t('checkout_soon_body');
    }
    if (link) {
      var tierName = tierLabel(tierId);
      var cycleLabel = billingCycle === 'yearly' ? t('pricing_billing_yearly') : t('pricing_billing_monthly');
      link.href = whatsAppSupportUrl(t('checkout_whatsapp_prefill', { tier: tierName, cycle: cycleLabel }));
    }
    hidePricingModal();
    if (el) {
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function hideCheckoutSoonModal() {
    var el = document.getElementById('checkout-soon-modal');
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  function setUserSettingsMeterFill(fillEl, used, limit) {
    if (!fillEl) return;
    var pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    fillEl.style.width = pct + '%';
    fillEl.classList.toggle('user-settings-meter-fill--warning', limit > 0 && used >= limit * 0.85);
    fillEl.classList.toggle('user-settings-meter-fill--danger', limit > 0 && used >= limit);
  }

  function showUserSettingsModal() {
    if (!authState.isAuthenticated) {
      showAuthOverlay();
      return;
    }
    var el = document.getElementById('user-settings-modal');
    var tierEl = document.getElementById('user-settings-tier');
    var usageEl = document.getElementById('user-settings-usage');
    var wordRow = document.getElementById('user-settings-word-row');
    var wordUsageEl = document.getElementById('user-settings-word-usage');
    var searchMeter = document.getElementById('user-settings-search-meter');
    var searchFill = document.getElementById('user-settings-search-fill');
    var wordMeter = document.getElementById('user-settings-word-meter');
    var wordFill = document.getElementById('user-settings-word-fill');
    var renewEl = document.getElementById('user-settings-renew');
    var cancelBtn = document.getElementById('btn-cancel-subscription');
    var upgradeAnnualBtn = document.getElementById('btn-upgrade-to-annual');
    var state = getPublicState();
    var paid = state.hasPaidSubscription;
    var displayPlan = resolvePlanType();
    var planId = displayPlan;
    var isStandard = paid && planId === 'standard';
    if (tierEl) tierEl.textContent = tierLabel(displayPlan);
    if (usageEl) {
      if (state.searchLimit != null) {
        usageEl.textContent = isStandard
          ? t('user_settings_usage_of', { used: state.searchesUsed, limit: state.searchLimit })
          : (state.searchesUsed + ' / ' + state.searchLimit);
      } else {
        usageEl.textContent = String(state.searchesUsed);
      }
    }
    if (searchMeter) {
      searchMeter.classList.toggle('hidden', !isStandard || state.searchLimit == null);
      searchMeter.setAttribute('aria-hidden', (!isStandard || state.searchLimit == null) ? 'true' : 'false');
      if (isStandard && state.searchLimit != null) {
        setUserSettingsMeterFill(searchFill, Number(state.searchesUsed) || 0, Number(state.searchLimit) || 0);
      }
    }
    if (wordRow) {
      wordRow.classList.toggle('hidden', !isStandard);
    }
    if (isStandard && wordUsageEl) {
      var wordUsed = Number(state.wordDownloadsUsed) || 0;
      var wordLimit = state.wordDownloadLimit != null
        ? Number(state.wordDownloadLimit)
        : STANDARD_WORD_DOWNLOAD_LIMIT;
      wordUsageEl.textContent = t('user_settings_word_usage_of', {
        used: wordUsed,
        limit: wordLimit,
      });
      if (wordMeter) wordMeter.classList.remove('hidden');
      setUserSettingsMeterFill(wordFill, wordUsed, wordLimit);
    }
    if (renewEl) {
      renewEl.textContent = !paid
        ? t('user_settings_trial_renew')
        : (state.autoRenew ? t('user_settings_renew_on') : t('user_settings_renew_off'));
    }
    var expiresEl = document.getElementById('user-settings-expires');
    if (expiresEl) {
      if (paid && state.expiresAt) {
        try {
          var d = new Date(state.expiresAt);
          expiresEl.textContent = isNaN(d.getTime()) ? state.expiresAt : d.toLocaleDateString('he-IL');
        } catch (e) {
          expiresEl.textContent = state.expiresAt;
        }
      } else {
        expiresEl.textContent = '—';
      }
    }
    if (upgradeAnnualBtn) {
      upgradeAnnualBtn.classList.toggle('hidden', !isStandard);
      upgradeAnnualBtn.textContent = t('user_settings_upgrade_annual');
    }
    if (cancelBtn) {
      cancelBtn.classList.toggle('hidden', !paid || isStandard);
      cancelBtn.disabled = !paid || isStandard;
      if (paid && !isStandard && state.autoRenew === false) {
        cancelBtn.classList.add('hidden');
      }
    }
    if (el) {
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function hideUserSettingsModal() {
    var el = document.getElementById('user-settings-modal');
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  function showCancelSubscriptionModal() {
    var el = document.getElementById('cancel-subscription-modal');
    if (el) {
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function hideCancelSubscriptionModal() {
    var el = document.getElementById('cancel-subscription-modal');
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  var MAKE_CONTACT_WEBHOOK_URL = 'https://hook.eu1.make.com/6ttquerf5d1ethsvbrih0h5o3yex22zu';

  function splitDisplayName(displayName) {
    var parts = String(displayName || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { first: '', last: '' };
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  function showContactModal() {
    var el = document.getElementById('contact-modal');
    var firstEl = document.getElementById('contact-first-name');
    var lastEl = document.getElementById('contact-last-name');
    var emailEl = document.getElementById('contact-email');
    var phoneEl = document.getElementById('contact-phone');
    var messageEl = document.getElementById('contact-message');
    var displayName = getUserDisplayName();
    var nameParts = splitDisplayName(displayName);
    if (firstEl && !firstEl.value) firstEl.value = nameParts.first || getUserFirstName() || '';
    if (lastEl && !lastEl.value) lastEl.value = nameParts.last || '';
    if (emailEl && !emailEl.value) {
      var email = authState.isAuthenticated && authState.user && authState.user.email
        ? authState.user.email
        : getIdentityEmail();
      if (email) emailEl.value = email;
    }
    if (phoneEl && phoneEl.value) { /* keep user input */ }
    if (messageEl && messageEl.value) { /* keep user input */ }
    if (el) {
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
      if (firstEl) firstEl.focus();
    }
  }

  function hideContactModal() {
    var el = document.getElementById('contact-modal');
    var submitBtn = document.getElementById('contact-form-submit');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('contact_submit') || 'שליחה';
    }
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  function showContactToast(message, type) {
    if (typeof global.showAppToast === 'function') {
      global.showAppToast(message, type);
      return;
    }
    if (type === 'error') console.error('[Contact]', message);
    else console.log('[Contact]', message);
  }

  function bindContactOwnerLinks() {
    var phoneLink = document.getElementById('contact-owner-phone-link');
    if (phoneLink) {
      phoneLink.setAttribute('href', 'tel:0544548078');
      phoneLink.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }
  }

  function submitContactForm(e) {
    if (e && e.preventDefault) e.preventDefault();
    var firstEl = document.getElementById('contact-first-name');
    var lastEl = document.getElementById('contact-last-name');
    var emailEl = document.getElementById('contact-email');
    var phoneEl = document.getElementById('contact-phone');
    var messageEl = document.getElementById('contact-message');
    var submitBtn = document.getElementById('contact-form-submit');
    var firstName = firstEl ? String(firstEl.value || '').trim() : '';
    var lastName = lastEl ? String(lastEl.value || '').trim() : '';
    var email = emailEl ? String(emailEl.value || '').trim() : '';
    var phone = phoneEl ? String(phoneEl.value || '').trim() : '';
    var message = messageEl ? String(messageEl.value || '').trim() : '';
    if (!firstName || !lastName || !email || !phone || !message) {
      if (firstEl && !firstName) firstEl.focus();
      else if (lastEl && !lastName) lastEl.focus();
      else if (emailEl && !email) emailEl.focus();
      else if (phoneEl && !phone) phoneEl.focus();
      else if (messageEl && !message) messageEl.focus();
      return;
    }
    if (submitBtn && submitBtn.disabled) return;

    var defaultBtnText = submitBtn ? String(submitBtn.textContent || t('contact_submit') || 'שליחה').trim() : 'שליחה';

    function setSubmitting(loading) {
      if (!submitBtn) return;
      submitBtn.disabled = loading;
      submitBtn.textContent = loading ? 'שולח...' : defaultBtnText;
    }

    setSubmitting(true);

    fetch(MAKE_CONTACT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: firstName,
        lastName: lastName,
        email: email,
        phone: phone,
        message: message,
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Contact webhook failed: ' + res.status);
        return res.text().catch(function () { return ''; });
      })
      .then(function () {
        showContactToast('ההודעה נשלחה בהצלחה!');
        if (firstEl) firstEl.value = '';
        if (lastEl) lastEl.value = '';
        if (emailEl) emailEl.value = '';
        if (phoneEl) phoneEl.value = '';
        if (messageEl) messageEl.value = '';
        setTimeout(function () {
          hideContactModal();
        }, 1500);
      })
      .catch(function () {
        setSubmitting(false);
        showContactToast('שליחת ההודעה נכשלה. נסו שוב.', 'error');
      });
  }

  function confirmCancelSubscription() {
    return fetchSubscriptionAction('cancel_subscription').then(function (data) {
      authState.autoRenew = false;
      applySubscriptionFields(data.subscription, data.usage);
      persistAuth();
      hideCancelSubscriptionModal();
      hideUserSettingsModal();
      notifyListeners();
      alert(t('cancel_subscription_success'));
      return data;
    }).catch(function (err) {
      alert((err && err.message) || t('cancel_subscription_error'));
    });
  }

  function schoolTierEmailHref() {
    return 'mailto:' + SUPPORT_EMAIL + '?subject=' + encodeURIComponent(t('tier_school_email_subject'));
  }

  function setPricingUpgradeButtonLoading(loading) {
    // Legacy no-op — single CTA replaced by two Grow plan buttons.
    void loading;
  }

  function handlePricingUpgradeClick() {
    // Legacy fallback — route to annual Grow checkout.
    handlePricingPlanClick('annual');
  }

  function handlePricingPlanClick(planKey, event) {
    if (isProUser()) {
      if (event) event.preventDefault();
      return;
    }
    if (!authState.isAuthenticated) {
      if (event) event.preventDefault();
      hidePricingModal();
      hideFreeTierLimitModal();
      showAuthOverlay();
      return;
    }
    // Authenticated: stop the static <a href>, request dynamic Make→Grow link, open it.
    // Never upgrade Supabase here — that happens only via Grow payment-success webhook.
    if (event) event.preventDefault();
    var email = getUpgradeUserEmail();
    if (!email) {
      showAuthOverlay();
      return;
    }
    startMakeUpgradeCheckout(email, null, planKey === 'one_time' ? 'one_time' : 'annual').catch(function () {
      showContactToast(t('paywall_upgrade_error'), 'error');
    });
  }

  function handleUpgradeModalPlanClick(planKey, event) {
    if (!authState.isAuthenticated) {
      if (event) event.preventDefault();
      hideFreeTierLimitModal();
      showAuthOverlay();
      return;
    }
    if (event) event.preventDefault();
    var email = getUpgradeUserEmail();
    if (!email) {
      showAuthOverlay();
      return;
    }
    startMakeUpgradeCheckout(email, null, planKey === 'one_time' ? 'one_time' : 'annual').catch(function () {
      showContactToast(t('paywall_upgrade_error'), 'error');
    });
  }

  function renderPricingComparisonTable() {
    var wrap = document.getElementById('pricing-comparison-wrap');
    if (!wrap) return;
    var current = normalizeTierId(authState.tier);
    var displayTier = isProUser() ? 'pro' : current;
    var rows = [
      { feature: t('pricing_row_archive'), free: t('pricing_cell_unlimited_sparkle'), pro: t('pricing_cell_unlimited_sparkle') },
      { feature: t('pricing_row_community'), free: t('pricing_cell_unlimited'), pro: t('pricing_cell_unlimited') },
      { feature: t('pricing_row_chat'), free: t('pricing_cell_unlimited'), pro: t('pricing_cell_unlimited') },
      { feature: t('pricing_row_word'), free: t('pricing_cell_word_free'), pro: t('pricing_cell_word_pro') },
      { feature: t('pricing_row_live_search'), free: t('pricing_cell_search_free'), pro: t('pricing_cell_search_pro') },
      { feature: t('pricing_row_price'), free: t('pricing_cell_price_free'), pro: t('pricing_cell_price_pro') },
    ];

    var headerCells = [
      '<th scope="col" class="pricing-table-feature-col">' + escapeHtml(t('pricing_table_feature_col')) + '</th>',
      '<th scope="col" class="pricing-table-plan-col' + (displayTier === 'trial' ? ' pricing-table-plan-col--current' : '') + '">' + escapeHtml(t('pricing_table_free_header')) + '</th>',
      '<th scope="col" class="pricing-table-plan-col pricing-table-plan-col--featured' + (displayTier === 'pro' || displayTier === 'standard' ? ' pricing-table-plan-col--current' : '') + '">' + escapeHtml(t('pricing_table_pro_header')) + '</th>',
    ].join('');

    var bodyRows = rows.map(function (row) {
      return (
        '<tr>' +
          '<th scope="row" class="pricing-table-feature">' + escapeHtml(row.feature) + '</th>' +
          '<td>' + escapeHtml(row.free) + '</td>' +
          '<td class="pricing-table-pro-cell">' + escapeHtml(row.pro) + '</td>' +
        '</tr>'
      );
    }).join('');

    wrap.innerHTML =
      '<div class="pricing-table-scroll">' +
        '<table class="pricing-comparison-table" role="table">' +
          '<thead><tr>' + headerCells + '</tr></thead>' +
          '<tbody>' + bodyRows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<p class="pricing-auto-renew-disclaimer">' + escapeHtml(t('pricing_auto_renew_disclaimer')) + '</p>';

    var purchaseActions = document.getElementById('pricing-purchase-actions');
    if (purchaseActions) {
      purchaseActions.classList.toggle('hidden', isProUser() || hasPaidAccess());
    }
    var oneTimeBtn = document.getElementById('pricing-plan-one-time');
    if (oneTimeBtn) oneTimeBtn.textContent = t('pricing_buy_one_time');
    var annualBtn = document.getElementById('pricing-plan-annual');
    if (annualBtn) annualBtn.textContent = t('pricing_buy_annual');
    syncGrowCheckoutLinkElements();
  }

  function renderPricingCards() {
    renderPricingComparisonTable();
  }

  function setSearchUsageMeterHidden(hidden) {
    var meter = document.getElementById('search-usage-meter');
    if (!meter) return;
    meter.classList.toggle('hidden', hidden);
    meter.style.display = hidden ? 'none' : '';
    meter.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  }

  function syncAuthBodyClass() {
    if (!document.body) return;
    var plan = resolvePlanType();
    var paid = hasPaidSubscription() || isProUser();
    document.body.classList.toggle('is-authenticated', Boolean(authState.isAuthenticated));
    // Pro chrome only for annual pro (or whitelist without a capped standard plan).
    document.body.classList.toggle('is-pro-user', isAnnualProPlan() || (isProUser() && !isStandardPlan()));
    document.body.classList.toggle('is-standard-user', isStandardPlan());
    document.body.classList.toggle('has-paid-access', paid);
  }

  function syncProUserDomState() {
    syncAuthBodyClass();
    var plan = resolvePlanType();
    var accountBar = document.getElementById('user-account-bar');
    if (accountBar) {
      accountBar.classList.toggle('user-account-bar--pro', isAnnualProPlan());
      accountBar.classList.toggle('user-account-bar--standard', isStandardPlan());
    }
    // Hide header meter only for annual Pro (unlimited Word / monthly pool UX).
    if (isAnnualProPlan() || (isProUser() && !isStandardPlan())) {
      setSearchUsageMeterHidden(true);
    }
  }

  function updateHeaderTierBadge(tierEl) {
    if (!tierEl) return;
    var plan = resolvePlanType();
    tierEl.textContent = tierLabel(plan);
    tierEl.className = 'user-tier-badge user-tier-badge--' + plan;
    // Green "פרו" only for annual pro — never for standard.
    tierEl.classList.toggle('user-tier-badge--pro-user', plan === 'pro');
    if (plan === 'standard') {
      tierEl.classList.remove('user-tier-badge--pro', 'user-tier-badge--pro-user');
    }
  }

  function updateHeaderUi() {
    syncProUserDomState();
    var bar = document.getElementById('user-account-bar');
    var identityBar = document.getElementById('identity-email-bar');
    if (identityBar) {
      identityBar.classList.toggle('hidden', authState.isAuthenticated || isProUser());
    }
    if (!bar) return;
    if (authState.isAuthenticated && authState.user) {
      bar.classList.remove('hidden');
      var nameEl = document.getElementById('user-display-name');
      var tierEl = document.getElementById('user-tier-badge');
      var upgradeBtn = document.getElementById('btn-open-pricing');
      if (nameEl) setHeaderDisplayName(nameEl);
      updateHeaderTierBadge(tierEl);
      var plan = resolvePlanType();
      if (upgradeBtn) upgradeBtn.classList.toggle('hidden', hasPaidSubscription() || isProUser());
      // Standard keeps usage meters visible; Pro hides them.
      setSearchUsageMeterHidden(plan === 'pro' || (isProUser() && plan !== 'standard') || !authState.isAuthenticated);
      var signOutBtn = document.getElementById('btn-auth-signout');
      var settingsBtn = document.getElementById('btn-user-settings');
      if (signOutBtn) signOutBtn.classList.remove('hidden');
      if (settingsBtn) settingsBtn.classList.remove('hidden');
      return;
    }
    if (isProUser()) {
      bar.classList.remove('hidden');
      var proNameEl = document.getElementById('user-display-name');
      var proTierEl = document.getElementById('user-tier-badge');
      var proUpgradeBtn = document.getElementById('btn-open-pricing');
      var proSignOutBtn = document.getElementById('btn-auth-signout');
      var proSettingsBtn = document.getElementById('btn-user-settings');
      if (proNameEl) setHeaderDisplayName(proNameEl);
      if (proTierEl) {
        proTierEl.textContent = t('tier_pro_name');
        proTierEl.className = 'user-tier-badge user-tier-badge--pro user-tier-badge--pro-user';
      }
      if (proUpgradeBtn) proUpgradeBtn.classList.add('hidden');
      if (proSignOutBtn) proSignOutBtn.classList.add('hidden');
      if (proSettingsBtn) proSettingsBtn.classList.add('hidden');
      setSearchUsageMeterHidden(true);
      return;
    }
    bar.classList.add('hidden');
  }

  function updateIdentityEmailUi() {
    var input = document.getElementById('identity-email-input');
    var badge = document.getElementById('identity-pro-badge');
    var bar = document.getElementById('identity-email-bar');
    if (!bar) return;
    var email = getIdentityEmail();
    var showBar = !authState.isAuthenticated && !isProUser();
    bar.classList.toggle('hidden', !showBar);
    if (input && email && !input.matches(':focus')) input.value = email;
    if (badge) badge.classList.toggle('hidden', !isProUser());
  }

  function updateSearchMeterUi() {
    syncProUserDomState();
    var meter = document.getElementById('search-usage-meter');
    if (!meter) return;
    var plan = resolvePlanType();
    // Annual Pro (and whitelist without standard): hide. Trial + standard: show.
    if (!authState.isAuthenticated || plan === 'pro' || (isProUser() && plan !== 'standard')) {
      setSearchUsageMeterHidden(true);
      return;
    }
    setSearchUsageMeterHidden(false);
    var used = getSearchesUsed();
    var displayLimit = getDisplayLimit();
    var countEl = document.getElementById('search-usage-count');
    var labelEl = document.getElementById('search-usage-label');
    var fillEl = document.getElementById('search-usage-fill');
    if (countEl) {
      countEl.textContent = displayLimit != null
        ? used + ' / ' + displayLimit
        : String(used);
    }
    if (labelEl) {
      labelEl.textContent = plan === 'trial'
        ? t('search_usage_label_trial')
        : (plan === 'standard' ? t('search_usage_label_trial') : t('search_usage_label_monthly'));
    }
    if (fillEl) {
      var pct = displayLimit ? Math.min(100, (used / displayLimit) * 100) : 0;
      fillEl.style.width = pct + '%';
      fillEl.classList.toggle('search-usage-fill--warning', displayLimit && used >= displayLimit * 0.85);
      fillEl.classList.toggle('search-usage-fill--danger', displayLimit && used >= displayLimit);
    }
  }

  function setShowEmailForm(show) {
    var emailForm = document.getElementById('auth-email-form');
    var toggle = document.getElementById('auth-email-toggle');
    if (emailForm) emailForm.classList.toggle('hidden', !show);
    if (toggle) toggle.classList.toggle('hidden', show);
  }

  function setAuthTab(tab) {
    var loginPanel = document.getElementById('auth-panel-login');
    var signupPanel = document.getElementById('auth-panel-signup');
    var tabLogin = document.getElementById('auth-tab-login');
    var tabSignup = document.getElementById('auth-tab-signup');
    var isLogin = tab === 'login';
    if (loginPanel) loginPanel.classList.toggle('hidden', !isLogin);
    if (signupPanel) signupPanel.classList.toggle('hidden', isLogin);
    if (tabLogin) tabLogin.classList.toggle('auth-tab--active', isLogin);
    if (tabSignup) tabSignup.classList.toggle('auth-tab--active', !isLogin);
    if (isLogin) setShowEmailForm(false);
  }

  function bindAuthUi() {
    var tabLogin = document.getElementById('auth-tab-login');
    var tabSignup = document.getElementById('auth-tab-signup');
    if (tabLogin) tabLogin.addEventListener('click', function () {
      if (!authUiLoading) setAuthTab('login');
    });
    if (tabSignup) tabSignup.addEventListener('click', function () {
      if (!authUiLoading) setAuthTab('signup');
    });

    var emailToggle = document.getElementById('auth-email-toggle');
    if (emailToggle) {
      emailToggle.addEventListener('click', function () {
        if (authUiLoading) return;
        setShowEmailForm(true);
        var emailInput = document.getElementById('auth-login-email');
        if (emailInput && typeof emailInput.focus === 'function') emailInput.focus();
      });
    }

    document.querySelectorAll('[data-auth-google]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (authUiLoading) return;
        var errEl = document.getElementById('auth-login-error');
        var errSignup = document.getElementById('auth-signup-error');
        signInWithGoogle().catch(function (err) {
          var msg = err.message || String(err);
          if (errEl) errEl.textContent = msg;
          if (errSignup) errSignup.textContent = msg;
        });
      });
    });

    var loginForm = document.getElementById('auth-form-login');
    if (loginForm) {
      loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (authUiLoading) return;
        var email = document.getElementById('auth-login-email');
        var pass = document.getElementById('auth-login-password');
        var errEl = document.getElementById('auth-login-error');
        signInWithEmail(email && email.value, pass && pass.value).catch(function (err) {
          if (errEl) errEl.textContent = err.message || String(err);
        });
      });
    }

    var signupForm = document.getElementById('auth-form-signup');
    if (signupForm) {
      signupForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (authUiLoading) return;
        var name = document.getElementById('auth-signup-name');
        var email = document.getElementById('auth-signup-email');
        var pass = document.getElementById('auth-signup-password');
        var errEl = document.getElementById('auth-signup-error');
        signUpWithEmail(email && email.value, pass && pass.value, name && name.value).catch(function (err) {
          if (errEl) errEl.textContent = err.message || String(err);
        });
      });
    }

    var btnUpgrade = document.getElementById('btn-open-pricing');
    if (btnUpgrade) btnUpgrade.addEventListener('click', showPricingModal);
    var btnSettings = document.getElementById('btn-user-settings');
    if (btnSettings) btnSettings.addEventListener('click', showUserSettingsModal);
    var btnSignOut = document.getElementById('btn-auth-signout');
    if (btnSignOut) btnSignOut.addEventListener('click', function () { signOut(); });

    document.querySelectorAll('#btn-header-contact, #btn-header-contact-inline, #btn-header-contact-guest').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        showContactModal();
      });
    });
    var contactForm = document.getElementById('contact-form');
    if (contactForm) contactForm.addEventListener('submit', submitContactForm);
    bindContactOwnerLinks();
    var contactClose = document.getElementById('contact-modal-close');
    if (contactClose) contactClose.addEventListener('click', hideContactModal);
    var contactBackdrop = document.getElementById('contact-modal-backdrop');
    if (contactBackdrop) contactBackdrop.addEventListener('click', hideContactModal);
    var contactPanel = document.querySelector('#contact-modal .app-modal-panel');
    if (contactPanel) {
      contactPanel.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }

    var chromeActions = document.querySelector('.app-chrome-actions-row');
    if (chromeActions && !chromeActions.dataset.authChromeBound) {
      chromeActions.dataset.authChromeBound = '1';
      chromeActions.addEventListener('click', function (e) {
        if (e.target.closest('#btn-open-pricing')) {
          e.preventDefault();
          showPricingModal();
          return;
        }
        if (e.target.closest('#btn-user-settings')) {
          e.preventDefault();
          showUserSettingsModal();
          return;
        }
        if (e.target.closest('#btn-auth-signout')) {
          e.preventDefault();
          signOut();
          return;
        }
        if (e.target.closest('#btn-header-contact, #btn-header-contact-inline, #btn-header-contact-guest')) {
          e.preventDefault();
          showContactModal();
        }
      });
    }

    var pricingClose = document.getElementById('pricing-modal-close');
    if (pricingClose) pricingClose.addEventListener('click', hidePricingModal);
    var pricingDismiss = document.getElementById('pricing-modal-dismiss');
    if (pricingDismiss) pricingDismiss.addEventListener('click', hidePricingModal);
    var pricingBackdrop = document.getElementById('pricing-modal-backdrop');
    if (pricingBackdrop) pricingBackdrop.addEventListener('click', hidePricingModal);

    var pricingOneTime = document.getElementById('pricing-plan-one-time');
    if (pricingOneTime) {
      pricingOneTime.addEventListener('click', function (ev) {
        handlePricingPlanClick('one_time', ev);
      });
    }
    var pricingAnnual = document.getElementById('pricing-plan-annual');
    if (pricingAnnual) {
      pricingAnnual.addEventListener('click', function (ev) {
        handlePricingPlanClick('annual', ev);
      });
    }

    var checkoutClose = document.getElementById('checkout-soon-close');
    if (checkoutClose) checkoutClose.addEventListener('click', hideCheckoutSoonModal);
    var checkoutBackdrop = document.getElementById('checkout-soon-backdrop');
    if (checkoutBackdrop) checkoutBackdrop.addEventListener('click', hideCheckoutSoonModal);

    var settingsClose = document.getElementById('user-settings-close');
    if (settingsClose) settingsClose.addEventListener('click', hideUserSettingsModal);
    var settingsBackdrop = document.getElementById('user-settings-backdrop');
    if (settingsBackdrop) settingsBackdrop.addEventListener('click', hideUserSettingsModal);

    var cancelOpen = document.getElementById('btn-cancel-subscription');
    if (cancelOpen) cancelOpen.addEventListener('click', showCancelSubscriptionModal);
    var upgradeAnnualOpen = document.getElementById('btn-upgrade-to-annual');
    if (upgradeAnnualOpen) {
      upgradeAnnualOpen.addEventListener('click', function (ev) {
        hideUserSettingsModal();
        handleUpgradeModalPlanClick('annual', ev);
      });
    }
    var cancelDismiss = document.getElementById('cancel-subscription-dismiss');
    if (cancelDismiss) cancelDismiss.addEventListener('click', hideCancelSubscriptionModal);
    var cancelBackdrop = document.getElementById('cancel-subscription-backdrop');
    if (cancelBackdrop) cancelBackdrop.addEventListener('click', hideCancelSubscriptionModal);
    var cancelConfirm = document.getElementById('cancel-subscription-confirm');
    if (cancelConfirm) cancelConfirm.addEventListener('click', confirmCancelSubscription);

    var rateClose = document.getElementById('rate-limit-close');
    if (rateClose) rateClose.addEventListener('click', hideRateLimitModal);
    var rateUpgrade = document.getElementById('rate-limit-upgrade');
    if (rateUpgrade) rateUpgrade.addEventListener('click', function () {
      hideRateLimitModal();
      showPricingModal();
    });
    var rateBackdrop = document.getElementById('rate-limit-backdrop');
    if (rateBackdrop) rateBackdrop.addEventListener('click', hideRateLimitModal);

    var freeTierClose = document.getElementById('free-tier-limit-close');
    if (freeTierClose) freeTierClose.addEventListener('click', hideFreeTierLimitModal);
    var freeTierBackdrop = document.getElementById('free-tier-limit-backdrop');
    if (freeTierBackdrop) freeTierBackdrop.addEventListener('click', hideFreeTierLimitModal);
    var upgradeOneTime = document.getElementById('upgrade-plan-one-time');
    if (upgradeOneTime) {
      upgradeOneTime.addEventListener('click', function (ev) {
        handleUpgradeModalPlanClick('one_time', ev);
      });
    }
    var upgradeAnnual = document.getElementById('upgrade-plan-annual');
    if (upgradeAnnual) {
      upgradeAnnual.addEventListener('click', function (ev) {
        handleUpgradeModalPlanClick('annual', ev);
      });
    }
    syncGrowCheckoutLinkElements();
    // Legacy single upgrade button (if present in older markup).
    var freeTierUpgrade = document.getElementById('free-tier-limit-upgrade');
    if (freeTierUpgrade) freeTierUpgrade.addEventListener('click', handlePricingUpgradeClick);

    var identityInput = document.getElementById('identity-email-input');
    if (identityInput) {
      identityInput.addEventListener('change', function () {
        setIdentityEmail(identityInput.value);
      });
      identityInput.addEventListener('blur', function () {
        if (identityInput.value) setIdentityEmail(identityInput.value);
      });
      identityInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          setIdentityEmail(identityInput.value);
          identityInput.blur();
        }
      });
    }

  }

  function initAuthSubscription(options) {
    options = options || {};
    if (options.supportWhatsApp) SUPPORT_WHATSAPP = String(options.supportWhatsApp).trim();
    var nextUrl = normalizeSupabaseConfigUrl(options.supabaseUrl || '');
    var nextKey = options.supabaseAnonKey || '';
    if (nextUrl !== supabaseConfig.url || nextKey !== supabaseConfig.anonKey) {
      resetSupabaseClient();
    }
    supabaseConfig.url = nextUrl;
    supabaseConfig.anonKey = nextKey;
    authRedirectUrl = options.authRedirectUrl || '';
    useMockGoogleAuth = options.useMockGoogleAuth === true && isLocalDevHost();
    bindAuthUi();
    if (isLocalDevHost()) {
      ensureLocalDevAdminPrivileges();
    }
    applyProUserTierIfEligible();
    updateIdentityEmailUi();
    if (isProUser()) hideAuthOverlay();

    var useSupabase = isSupabaseConfigured() && typeof global.supabase !== 'undefined';

    if (useSupabase) {
      setAuthLoading(true, 'session');
      var client = options.supabaseClient || getSupabaseClient();
      initSupabaseAuth(client).then(function (session) {
        setAuthLoading(false, 'session');
        if (isLocalDevHost()) ensureLocalDevAdminPrivileges();
        if (session && session.user) {
          hideAuthOverlay();
          refreshSubscriptionFromServer();
        } else if (!isProUser()) {
          showAuthOverlay();
        } else {
          hideAuthOverlay();
        }
        notifyListeners();
      }).catch(function (e) {
        console.warn('[Auth] Supabase session check failed', e);
        setAuthLoading(false, 'session');
        if (isLocalDevHost()) ensureLocalDevAdminPrivileges();
        if (!isProUser()) showAuthOverlay();
        else hideAuthOverlay();
        authState.sessionReady = true;
        notifyListeners();
      });
      return getPublicState();
    }

    var restored = shouldAllowMockAuth() && loadPersistedAuth();
    if (restored && isLocalDevHost()) ensureLocalDevAdminPrivileges();
    authState.sessionReady = true;
    if (options.firebaseAuth) initFirebaseAuth(options.firebaseAuth);
    if (!restored && !authState.isAuthenticated && !isProUser()) showAuthOverlay();
    else if (authState.isAuthenticated || isProUser()) {
      hideAuthOverlay();
      if (authState.isAuthenticated) refreshSubscriptionFromServer();
    }
    else showAuthOverlay();
    notifyListeners();
    try {
      var params = new URLSearchParams(global.location && global.location.search || '');
      if (params.get('checkout') === 'success' && authState.isAuthenticated) {
        refreshSubscriptionFromServer().then(function () {
          if (global.history && global.history.replaceState) {
            global.history.replaceState({}, '', global.location.pathname);
          }
        });
      }
    } catch (checkoutErr) { /* ignore */ }
    return getPublicState();
  }

  function refreshAuthI18n() {
    renderPricingComparisonTable();
    updateHeaderUi();
    updateIdentityEmailUi();
    updateSearchMeterUi();
    var subtitle = document.getElementById('auth-subtitle');
    if (subtitle) subtitle.textContent = t('auth_subtitle');
    document.querySelectorAll('[data-auth-google]').forEach(function (btn) {
      btn.setAttribute('aria-label', t('auth_google_btn'));
    });
  }

  function getContributorProfile() {
    if (authState.isAuthenticated && authState.user) {
      var displayName = getUserDisplayName();
      return {
        id: authState.user.id || null,
        email: normalizeEmail(authState.user.email),
        name: displayName,
        displayName: displayName,
        tier: isProUser() ? 'pro' : normalizeTierId(authState.tier),
      };
    }
    var email = readIdentityEmail();
    if (email) {
      var identityDisplayName = getUserDisplayName();
      return {
        id: null,
        email: email,
        name: identityDisplayName,
        displayName: identityDisplayName,
        tier: isProUserEmail(email) ? 'pro' : 'trial',
      };
    }
    return null;
  }

  function getAccessToken() {
    var client = getSupabaseClient();
    if (!client || !client.auth || typeof client.auth.getSession !== 'function') {
      return Promise.resolve(null);
    }
    return client.auth.getSession().then(function (result) {
      var session = result && result.data && result.data.session;
      return session && session.access_token ? session.access_token : null;
    }).catch(function () {
      return null;
    });
  }

  global.WaldorfAuth = {
    TIERS: TIERS,
    init: initAuthSubscription,
    subscribe: subscribe,
    applyRuntimeBillingConfig: applyRuntimeBillingConfig,
    getState: getPublicState,
    canPerformSearch: canPerformSearch,
    assertSearchAllowed: assertSearchAllowed,
    confirmCreditUsage: confirmCreditUsage,
    getSearchesRemainingDisplay: getSearchesRemainingDisplay,
    canPerformWordDownload: canPerformWordDownload,
    assertWordDownloadAllowed: assertWordDownloadAllowed,
    recordSearch: recordSearch,
    recordWordDownload: recordWordDownload,
    wrapResearchCall: wrapResearchCall,
    setTier: setTier,
    signInWithEmail: signInWithEmail,
    signUpWithEmail: signUpWithEmail,
    signInWithGoogle: signInWithGoogle,
    mockGoogleSignIn: mockGoogleSignIn,
    signOut: signOut,
    onLogoutCleanup: onLogoutCleanup,
    mockSignIn: mockSignIn,
    mockSignUp: mockSignUp,
    mockSignOut: mockSignOut,
    mockUpgrade: mockUpgrade,
    initSupabaseAuth: initSupabaseAuth,
    initFirebaseAuth: initFirebaseAuth,
    getSupabaseClient: getSupabaseClient,
    isSupabaseConfigured: isSupabaseConfigured,
    showPricingModal: showPricingModal,
    hidePricingModal: hidePricingModal,
    showFreeTierLimitModal: showFreeTierLimitModal,
    hideFreeTierLimitModal: hideFreeTierLimitModal,
    showSearchLimitBlocked: showSearchLimitBlocked,
    showRateLimitModal: showRateLimitModal,
    showUserSettingsModal: showUserSettingsModal,
    hideUserSettingsModal: hideUserSettingsModal,
    showContactModal: showContactModal,
    hideContactModal: hideContactModal,
    refreshSubscriptionFromServer: refreshSubscriptionFromServer,
    applyUsageFromServer: applyUsageFromServer,
    syncUsageAfterLiveSearch: syncUsageAfterLiveSearch,
    showAuthOverlay: showAuthOverlay,
    refreshI18n: refreshAuthI18n,
    getContributorProfile: getContributorProfile,
    getUserDisplayName: getUserDisplayName,
    getUserFirstName: getUserFirstName,
    getAccessToken: getAccessToken,
    getIdentityEmail: getIdentityEmail,
    setIdentityEmail: setIdentityEmail,
    isProUser: isProUser,
    hasPaidSubscription: hasPaidSubscription,
    hasPaidAccess: hasPaidAccess,
    isProUserEmail: isProUserEmail,
    isLocalDevHost: isLocalDevHost,
    ensureLocalDevAdminPrivileges: ensureLocalDevAdminPrivileges,
    PRO_USERS: PRO_USERS,
    resolvePlanType: resolvePlanType,
    isStandardPlan: isStandardPlan,
    isAnnualProPlan: isAnnualProPlan,
    normalizeTierId: normalizeTierId,
  };
})(typeof window !== 'undefined' ? window : globalThis);
