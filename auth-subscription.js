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
  /** Google display names that map to a PRO account when email is absent from the session. */
  var PRO_DISPLAY_NAMES = ['alon yerushalmy'];

  var LEGACY_TIER_MAP = {
    educator: 'standard',
    expert: 'pro',
  };

  var TIERS = {
    trial: {
      id: 'trial',
      lifetimeLimit: 3,
      wordDownloadLimit: 5,
      wordDownloadPeriod: 'monthly',
      monthlyLimit: null,
      displayUnlimited: false,
      prices: { monthly: 0, yearly: 0 },
    },
    standard: {
      id: 'standard',
      monthlyLimit: 300,
      lifetimeLimit: null,
      displayUnlimited: false,
      prices: { monthly: 49, yearly: 468 },
      yearlySavingsKey: 'pricing_pro_yearly_deal',
    },
    pro: {
      id: 'pro',
      monthlyLimit: 300,
      lifetimeLimit: null,
      displayUnlimited: false,
      prices: { monthly: 49, yearly: 468 },
      yearlySavingsKey: 'pricing_pro_yearly_deal',
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
    provider: 'mock',
    sessionReady: false,
    autoRenew: true,
    billingCycle: null,
    expiresAt: null,
    usagePeriod: 'lifetime',
    searchesUsed: null,
    searchLimit: 3,
    wordDownloadsUsed: 0,
    wordDownloadLimit: 5,
  };

  var stripeCheckoutEnabled = false;
  var billingCheckoutUrl = '/api/billing/checkout';

  function applyRuntimeBillingConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (cfg.stripeCheckoutEnabled != null) stripeCheckoutEnabled = Boolean(cfg.stripeCheckoutEnabled);
    if (cfg.apiBillingCheckout) billingCheckoutUrl = String(cfg.apiBillingCheckout);
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

  function applyProUserTierIfEligible() {
    if (!isProUser()) return;
    authState.tier = 'pro';
    authState.searchLimit = null;
    authState.usagePeriod = 'monthly';
    authState.searchesUsed = authState.searchesUsed != null ? authState.searchesUsed : 0;
  }

  function applyProUserUsageFromServer(usage) {
    if (usage && (usage.proUser || usage.whitelisted)) {
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
    var meta = (user && user.user_metadata) || {};
    var tier = meta.tier || meta.subscription_tier;
    return normalizeTierId(tier);
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
    if (!session || !session.user) return;
    var user = session.user;
    authState.isAuthenticated = true;
    authState.provider = 'supabase';
    authState.user = mapSupabaseUser(user);
    authState.tier = resolveTierFromUser(user);
    if (authState.user.email) writeIdentityEmail(authState.user.email);
    else {
      var mappedPro = resolveProEmailFromUser(authState.user);
      if (mappedPro) writeIdentityEmail(mappedPro);
    }
    applyProUserTierIfEligible();
    persistAuth();
    hideAuthOverlay();
    refreshSubscriptionFromServer().finally(function () {
      enrichGoogleHebrewNames(session).finally(function () {
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
    var tier = normalizeTierId(authState.tier);
    if (tier !== 'trial') return null;
    if (authState.wordDownloadLimit != null) return authState.wordDownloadLimit;
    return getTierConfig('trial').wordDownloadLimit || 5;
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
    if (isProUser()) {
      applyProUserTierIfEligible();
      return;
    }
    authState.tier = normalizeTierId(usage.tier || authState.tier);
    authState.searchesUsed = Number(usage.searchesUsed) || 0;
    authState.searchLimit = usage.searchLimit != null ? usage.searchLimit : authState.searchLimit;
    authState.usagePeriod = usage.usagePeriod || authState.usagePeriod;
    if (usage.autoRenew != null) authState.autoRenew = usage.autoRenew !== false;
    if (usage.billingCycle != null) authState.billingCycle = usage.billingCycle;
    if (usage.expiresAt != null) authState.expiresAt = usage.expiresAt;
    if (usage.wordDownloadsUsed != null) {
      authState.wordDownloadsUsed = Number(usage.wordDownloadsUsed) || 0;
      writeWordDownloads(authState.wordDownloadsUsed);
    }
    if (usage.wordDownloadLimit != null) authState.wordDownloadLimit = usage.wordDownloadLimit;
    var tier = normalizeTierId(authState.tier);
    if (tier === 'trial') {
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

  function fetchSubscriptionAction(action) {
    var identityEmail = getIdentityEmail();
    if (!authState.isAuthenticated && !identityEmail) return Promise.resolve(null);
    return getAccessToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (identityEmail) headers['X-User-Email'] = identityEmail;
      var body = { action: action || 'status', userEmail: identityEmail || undefined };
      if (authState.user) {
        body.teacherUser = {
          id: authState.user.id,
          email: authState.user.email || identityEmail,
          displayName: authState.user.displayName,
          tier: isProUser() ? 'pro' : authState.tier,
        };
      } else if (identityEmail) {
        body.teacherUser = {
          email: identityEmail,
          tier: isProUserEmail(identityEmail) ? 'pro' : 'trial',
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
      applyProUserTierIfEligible();
      if (data.proUser || data.whitelisted) {
        applyProUserUsageFromServer(data.usage || { proUser: true });
      } else {
        if (data.subscription && data.subscription.tier && !isProUser()) {
          authState.tier = normalizeTierId(data.subscription.tier);
          authState.autoRenew = data.subscription.autoRenew !== false;
          authState.billingCycle = data.subscription.billingCycle || null;
          authState.expiresAt = data.subscription.expiresAt || (data.usage && data.usage.expiresAt) || null;
        }
        if (data.usage) applyServerUsage(data.usage);
      }
      applyProUserTierIfEligible();
      persistAuth();
      notifyListeners();
      return data;
    });
  }

  function getTierConfig(tierId) {
    return TIERS[normalizeTierId(tierId)] || TIERS.trial;
  }

  function getEffectiveLimit(tierId) {
    if (isProUser()) return null;
    var tier = getTierConfig(tierId || authState.tier);
    if (authState.searchLimit != null && normalizeTierId(tierId || authState.tier) === normalizeTierId(authState.tier)) {
      return authState.searchLimit;
    }
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
    applyProUserTierIfEligible();
    var usage = readUsage();
    var displayLimit = getDisplayLimit();
    var used = getSearchesUsed();
  var effectiveLimit = getEffectiveLimit();
    return {
      isAuthenticated: authState.isAuthenticated,
      user: authState.user ? Object.assign({}, authState.user) : null,
      tier: normalizeTierId(authState.tier),
      provider: authState.provider,
      sessionReady: authState.sessionReady,
      autoRenew: authState.autoRenew,
      billingCycle: authState.billingCycle,
      expiresAt: authState.expiresAt,
      usagePeriod: authState.usagePeriod || (normalizeTierId(authState.tier) === 'trial' ? 'lifetime' : 'monthly'),
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
      tierConfig: getTierConfig(authState.tier),
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
    console.log('[WaldorfAuth] Google sign-in clicked — mock/demo mode (Supabase Google not enabled yet)');
    setAuthLoading(true, 'google');
    return new Promise(function (resolve) {
      setTimeout(function () {
        authState.isAuthenticated = true;
        authState.provider = 'mock-google';
        authState.user = {
          id: 'google_demo_' + Date.now(),
          email: 'demo.user@gmail.com',
          displayName: (typeof global.isEnglish === 'function' && global.isEnglish())
            ? 'Google Demo User'
            : 'משתמש גוגל (הדגמה)',
        };
        authState.tier = 'trial';
        persistAuth();
        hideAuthOverlay();
        notifyListeners();
        setAuthLoading(false, 'google');
        console.log('[WaldorfAuth] Mock Google login successful', getPublicState());
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

  function clearAllBrowserStorage() {
    try { localStorage.clear(); } catch (e) { /* */ }
    try { sessionStorage.clear(); } catch (e) { /* */ }
  }

  function completeLogoutRedirect() {
    if (logoutFinalized) return;
    logoutFinalized = true;
    clearAllBrowserStorage();
    resetSupabaseClient();
    authState.isAuthenticated = false;
    authState.user = null;
    authState.tier = 'trial';
    authState.provider = 'mock';
    authState.sessionReady = true;
    try {
      global.location.replace(getCleanAppUrl());
    } catch (e) {
      global.location.href = getCleanAppUrl();
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
        body.teacherUser = {
          id: authState.user.id,
          email: authState.user.email || identityEmail,
          displayName: authState.user.displayName,
          tier: authState.tier,
        };
      }
      return fetch(billingCheckoutUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.text().then(function (text) {
          var json;
          try { json = text && text.trim() ? JSON.parse(text) : {}; } catch (e) { json = {}; }
          if (!res.ok) throw new Error((json && json.error) || 'checkout error');
          var checkoutUrl = json.data && json.data.checkoutUrl;
          if (!checkoutUrl) throw new Error('checkout URL missing');
          global.location.assign(checkoutUrl);
          return json.data;
        });
      });
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
    showCheckoutSoonModal(normalized, cycle);
    return Promise.resolve({ tier: normalized, billingCycle: cycle, pendingCheckout: true });
  }

  /* ── Rate limiter ────────────────────────────────────────────────────── */

  function canPerformSearch() {
    if (isProUser()) {
      return { allowed: true, unlimited: true, proUser: true, usage: 0, limit: null };
    }
    if (!authState.isAuthenticated) return { allowed: false, reason: 'auth' };
    var used = getSearchesUsed();
    var limit = getEffectiveLimit();
    if (used >= limit) {
      return { allowed: false, reason: 'limit', usage: used, limit: limit };
    }
    return { allowed: true, usage: used, limit: limit };
  }

  function canPerformWordDownload() {
    if (isProUser()) return { allowed: true, unlimited: true, proUser: true };
    if (!authState.isAuthenticated) return { allowed: false, reason: 'auth' };
    var tier = normalizeTierId(authState.tier);
    if (tier !== 'trial') return { allowed: true, unlimited: true };
    var used = getWordDownloadsUsed();
    var limit = getWordDownloadLimit();
    if (used >= limit) {
      return { allowed: false, reason: 'word_limit', usage: used, limit: limit };
    }
    return { allowed: true, usage: used, limit: limit };
  }

  function assertWordDownloadAllowed() {
    var check = canPerformWordDownload();
    if (!check.allowed) {
      if (check.reason === 'auth') showAuthOverlay();
      else showPricingModal('paywall_word_message');
      var err = new Error(t('word_download_limit_exceeded'));
      err.code = 'WORD_DOWNLOAD_LIMIT';
      err.details = check;
      throw err;
    }
    return check;
  }

  function recordWordDownload() {
    var tier = normalizeTierId(authState.tier);
    if (tier !== 'trial') {
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
    });
  }

  function recordSearch() {
    if (isProUser()) {
      applyProUserTierIfEligible();
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
        if (tier === 'trial') {
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
    }).catch(function () {
      return refreshSubscriptionFromServer().then(function (data) {
        if (data && data.usage) return data.usage.searchesUsed;
        return getSearchesUsed();
      });
    });
  }

  /** After a successful live /api/generate response — sync usage from server, never trust stale client cache. */
  function syncUsageAfterLiveSearch(meta) {
    var m = meta || {};
    var chain = Promise.resolve();
    if (m.usage) {
      applyServerUsage(m.usage);
    } else if (!m.searchBilled) {
      chain = recordSearch().catch(function (usageErr) {
        console.warn('[usage] recordSearch failed after generate:', usageErr && usageErr.message ? usageErr.message : usageErr);
        return null;
      });
    }
    return chain.then(function () {
      return refreshSubscriptionFromServer();
    });
  }

  function assertSearchAllowed() {
    var check = canPerformSearch();
    if (!check.allowed) {
      if (check.reason === 'auth') showAuthOverlay();
      else showPricingModal('paywall_search_message');
      var err = new Error(t('rate_limit_exceeded'));
      err.code = 'RATE_LIMIT';
      err.details = check;
      throw err;
    }
    return check;
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

  var pricingBillingCycle = 'monthly';

  function escapeHtml(s) {
    if (typeof global.escapeHtml === 'function') return global.escapeHtml(s);
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showAuthOverlay() {
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

  function showRateLimitModal(check) {
    var el = document.getElementById('rate-limit-modal');
    var msg = document.getElementById('rate-limit-message');
    if (msg) {
      var displayLimit = getDisplayLimit();
      var used = check && check.usage != null ? check.usage : getSearchesUsed();
      var text = t('rate_limit_body', {
        used: used,
        limit: displayLimit != null ? displayLimit : getEffectiveLimit(),
      });
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

  function showUserSettingsModal() {
    if (!authState.isAuthenticated) {
      showAuthOverlay();
      return;
    }
    var el = document.getElementById('user-settings-modal');
    var tierEl = document.getElementById('user-settings-tier');
    var usageEl = document.getElementById('user-settings-usage');
    var renewEl = document.getElementById('user-settings-renew');
    var cancelBtn = document.getElementById('btn-cancel-subscription');
    var state = getPublicState();
    if (tierEl) tierEl.textContent = tierLabel(state.tier);
    if (usageEl) {
      usageEl.textContent = state.searchLimit != null
        ? (state.searchesUsed + ' / ' + state.searchLimit)
        : String(state.searchesUsed);
    }
    if (renewEl) {
      renewEl.textContent = state.tier === 'trial'
        ? t('user_settings_trial_renew')
        : (state.autoRenew ? t('user_settings_renew_on') : t('user_settings_renew_off'));
    }
    var expiresEl = document.getElementById('user-settings-expires');
    if (expiresEl) {
      if (state.tier !== 'trial' && state.expiresAt) {
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
    if (cancelBtn) {
      cancelBtn.classList.toggle('hidden', state.tier === 'trial');
      cancelBtn.disabled = state.tier === 'trial';
      if (state.tier !== 'trial' && state.autoRenew === false) {
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

  var CONTACT_EMAIL = 'waldrofplanner@gmail.com';

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
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  function submitContactForm(e) {
    if (e && e.preventDefault) e.preventDefault();
    var firstEl = document.getElementById('contact-first-name');
    var lastEl = document.getElementById('contact-last-name');
    var emailEl = document.getElementById('contact-email');
    var phoneEl = document.getElementById('contact-phone');
    var messageEl = document.getElementById('contact-message');
    var firstName = firstEl ? String(firstEl.value || '').trim() : '';
    var lastName = lastEl ? String(lastEl.value || '').trim() : '';
    var email = emailEl ? String(emailEl.value || '').trim() : '';
    var phone = phoneEl ? String(phoneEl.value || '').trim() : '';
    var message = messageEl ? String(messageEl.value || '').trim() : '';
    if (!firstName || !email) {
      if (firstEl && !firstName) firstEl.focus();
      else if (emailEl) emailEl.focus();
      return;
    }
    var fullName = [firstName, lastName].filter(Boolean).join(' ');
    var subject = t('contact_email_subject', { name: fullName });
    var bodyLines = [
      t('contact_email_line_name', { name: fullName }),
      t('contact_email_line_email', { email: email }),
    ];
    if (phone) bodyLines.push(t('contact_email_line_phone', { phone: phone }));
    if (message) {
      bodyLines.push('');
      bodyLines.push(t('contact_email_line_message'));
      bodyLines.push(message);
    }
    var mailto = 'mailto:' + CONTACT_EMAIL
      + '?subject=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(bodyLines.join('\n'));
    hideContactModal();
    window.location.href = mailto;
  }

  function confirmCancelSubscription() {
    return fetchSubscriptionAction('cancel_subscription').then(function (data) {
      authState.autoRenew = false;
      if (data && data.subscription) {
        authState.tier = normalizeTierId(data.subscription.tier || authState.tier);
        authState.expiresAt = data.subscription.expiresAt || authState.expiresAt;
      }
      if (data && data.usage && data.usage.expiresAt) {
        authState.expiresAt = data.usage.expiresAt;
      }
      persistAuth();
      hideCancelSubscriptionModal();
      hideUserSettingsModal();
      notifyListeners();
      if (stripeCheckoutEnabled) {
        alert(t('cancel_subscription_success'));
        return data;
      }
      var followup = document.getElementById('cancel-subscription-followup');
      var link = document.getElementById('cancel-subscription-whatsapp');
      if (link) link.href = whatsAppSupportUrl(t('cancel_subscription_whatsapp_prefill'));
      if (followup) {
        followup.classList.remove('hidden');
        followup.setAttribute('aria-hidden', 'false');
      }
      return data;
    }).catch(function (err) {
      alert((err && err.message) || t('cancel_subscription_error'));
    });
  }

  function schoolTierEmailHref() {
    return 'mailto:' + SUPPORT_EMAIL + '?subject=' + encodeURIComponent(t('tier_school_email_subject'));
  }

  function upgradeWhatsAppUrl(prefillKey) {
    var msg = t(prefillKey || 'paywall_whatsapp_prefill');
    return whatsAppSupportUrl(msg);
  }

  function renderProPriceCell(cycle) {
    if (cycle === 'yearly') {
      return (
        '<div class="pricing-price-stack">' +
          '<span class="pricing-price-highlight">🔥 ' + escapeHtml(t('pricing_pro_yearly_line')) + '</span>' +
          '<span class="pricing-price-note">' + escapeHtml(t('pricing_pro_yearly_savings')) + '</span>' +
        '</div>'
      );
    }
    return (
      '<div class="pricing-price-stack">' +
        '<span>• ' + escapeHtml(t('pricing_pro_monthly_line')) + '</span>' +
        '<span class="pricing-price-muted">' + escapeHtml(t('pricing_pro_monthly_yearly_equiv')) + '</span>' +
      '</div>'
    );
  }

  function renderPricingComparisonTable() {
    var wrap = document.getElementById('pricing-comparison-wrap');
    if (!wrap) return;
    var cycle = pricingBillingCycle;
    var current = normalizeTierId(authState.tier);
    var displayTier = isProUser() ? 'pro' : current;
    var rows = [
      { feature: t('pricing_row_archive'), free: t('pricing_cell_unlimited_sparkle'), pro: t('pricing_cell_unlimited_sparkle'), school: t('pricing_cell_unlimited_sparkle') },
      { feature: t('pricing_row_community'), free: t('pricing_cell_unlimited'), pro: t('pricing_cell_unlimited'), school: t('pricing_cell_unlimited') },
      { feature: t('pricing_row_chat'), free: t('pricing_cell_unlimited'), pro: t('pricing_cell_unlimited'), school: t('pricing_cell_unlimited') },
      { feature: t('pricing_row_word'), free: t('pricing_cell_word_free'), pro: t('pricing_cell_word_pro'), school: t('pricing_cell_word_pro') },
      { feature: t('pricing_row_live_search'), free: t('pricing_cell_search_free'), pro: t('pricing_cell_search_pro'), school: t('pricing_cell_search_school') },
      { feature: t('pricing_row_price'), free: t('pricing_cell_price_free'), pro: renderProPriceCell(cycle), school:
          '<span>' + escapeHtml(t('pricing_cell_price_school_line1')) + '</span><br>' +
          '<span class="pricing-contact-name">' + escapeHtml(t('pricing_cell_price_school_contact')) + '</span>' },
    ];

    var headerCells = [
      '<th scope="col" class="pricing-table-feature-col">' + escapeHtml(t('pricing_table_feature_col')) + '</th>',
      '<th scope="col" class="pricing-table-plan-col' + (displayTier === 'trial' ? ' pricing-table-plan-col--current' : '') + '">' + escapeHtml(t('pricing_table_free_header')) + '</th>',
      '<th scope="col" class="pricing-table-plan-col pricing-table-plan-col--featured' + (displayTier === 'pro' || displayTier === 'standard' ? ' pricing-table-plan-col--current' : '') + '">' + escapeHtml(t('pricing_table_pro_header')) + '</th>',
      '<th scope="col" class="pricing-table-plan-col' + (displayTier === 'school' ? ' pricing-table-plan-col--current' : '') + '">' + escapeHtml(t('pricing_table_school_header')) + '</th>',
    ].join('');

    var bodyRows = rows.map(function (row) {
      return (
        '<tr>' +
          '<th scope="row" class="pricing-table-feature">' + escapeHtml(row.feature) + '</th>' +
          '<td>' + (row.free.indexOf('<') >= 0 ? row.free : escapeHtml(row.free)) + '</td>' +
          '<td class="pricing-table-pro-cell">' + (row.pro.indexOf('<') >= 0 ? row.pro : escapeHtml(row.pro)) + '</td>' +
          '<td>' + (row.school.indexOf('<') >= 0 ? row.school : escapeHtml(row.school)) + '</td>' +
        '</tr>'
      );
    }).join('');

    wrap.innerHTML =
      '<div class="pricing-table-scroll">' +
        '<table class="pricing-comparison-table" role="table">' +
          '<thead><tr>' + headerCells + '</tr></thead>' +
          '<tbody>' + bodyRows + '</tbody>' +
        '</table>' +
      '</div>';

    var waLink = document.getElementById('pricing-upgrade-whatsapp');
    var mailLink = document.getElementById('pricing-upgrade-email');
    if (waLink) {
      waLink.href = upgradeWhatsAppUrl('paywall_whatsapp_prefill');
      waLink.setAttribute('aria-label', t('paywall_cta'));
    }
    if (mailLink) {
      mailLink.href = schoolTierEmailHref();
      mailLink.textContent = SUPPORT_EMAIL;
    }
    var phoneEl = document.getElementById('pricing-upgrade-phone');
    if (phoneEl) phoneEl.textContent = SUPPORT_PHONE_DISPLAY;
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
    document.body.classList.toggle('is-authenticated', Boolean(authState.isAuthenticated));
    document.body.classList.toggle('is-pro-user', isProUser());
  }

  function syncProUserDomState() {
    syncAuthBodyClass();
    var pro = isProUser();
    var accountBar = document.getElementById('user-account-bar');
    if (accountBar) accountBar.classList.toggle('user-account-bar--pro', pro);
    if (pro) setSearchUsageMeterHidden(true);
  }

  function updateHeaderUi() {
    applyProUserTierIfEligible();
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
      if (tierEl) {
        var displayTier = isProUser() ? 'pro' : authState.tier;
        tierEl.textContent = isProUser() ? t('pro_user_badge') : tierLabel(displayTier);
        tierEl.className = 'user-tier-badge user-tier-badge--' + (typeof WaldorfAuth.normalizeTierId === 'function'
          ? WaldorfAuth.normalizeTierId(displayTier)
          : displayTier);
        tierEl.classList.toggle('user-tier-badge--pro-user', isProUser());
      }
      if (upgradeBtn) upgradeBtn.classList.toggle('hidden', isProUser());
      setSearchUsageMeterHidden(isProUser());
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
        proTierEl.textContent = t('pro_user_badge');
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
    if (isProUser() || !authState.isAuthenticated) {
      setSearchUsageMeterHidden(true);
      return;
    }
    setSearchUsageMeterHidden(false);
    var used = getSearchesUsed();
    var displayLimit = getDisplayLimit();
    var countEl = document.getElementById('search-usage-count');
    var labelEl = document.getElementById('search-usage-label');
    var fillEl = document.getElementById('search-usage-fill');
    var tier = normalizeTierId(authState.tier);
    if (countEl) {
      countEl.textContent = displayLimit != null
        ? used + ' / ' + displayLimit
        : String(used);
    }
    if (labelEl) {
      labelEl.textContent = tier === 'trial'
        ? t('search_usage_label_trial')
        : t('search_usage_label_monthly');
    }
    if (fillEl) {
      var pct = displayLimit ? Math.min(100, (used / displayLimit) * 100) : 0;
      fillEl.style.width = pct + '%';
      fillEl.classList.toggle('search-usage-fill--warning', displayLimit && used >= displayLimit * 0.85);
      fillEl.classList.toggle('search-usage-fill--danger', displayLimit && used >= displayLimit);
    }
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
    var contactClose = document.getElementById('contact-modal-close');
    if (contactClose) contactClose.addEventListener('click', hideContactModal);
    var contactBackdrop = document.getElementById('contact-modal-backdrop');
    if (contactBackdrop) contactBackdrop.addEventListener('click', hideContactModal);

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
    var cancelDismiss = document.getElementById('cancel-subscription-dismiss');
    if (cancelDismiss) cancelDismiss.addEventListener('click', hideCancelSubscriptionModal);
    var cancelBackdrop = document.getElementById('cancel-subscription-backdrop');
    if (cancelBackdrop) cancelBackdrop.addEventListener('click', hideCancelSubscriptionModal);
    var cancelConfirm = document.getElementById('cancel-subscription-confirm');
    if (cancelConfirm) cancelConfirm.addEventListener('click', confirmCancelSubscription);
    var followupClose = document.getElementById('cancel-subscription-followup-close');
    if (followupClose) followupClose.addEventListener('click', function () {
      var followup = document.getElementById('cancel-subscription-followup');
      if (followup) {
        followup.classList.add('hidden');
        followup.setAttribute('aria-hidden', 'true');
      }
    });

    var rateClose = document.getElementById('rate-limit-close');
    if (rateClose) rateClose.addEventListener('click', hideRateLimitModal);
    var rateUpgrade = document.getElementById('rate-limit-upgrade');
    if (rateUpgrade) rateUpgrade.addEventListener('click', function () {
      hideRateLimitModal();
      showPricingModal();
    });
    var rateBackdrop = document.getElementById('rate-limit-backdrop');
    if (rateBackdrop) rateBackdrop.addEventListener('click', hideRateLimitModal);

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

    document.querySelectorAll('[data-billing-cycle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pricingBillingCycle = btn.getAttribute('data-billing-cycle') || 'monthly';
        document.querySelectorAll('[data-billing-cycle]').forEach(function (b) {
          b.classList.toggle('billing-toggle-btn--active', b === btn);
        });
        renderPricingComparisonTable();
      });
    });
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
    applyProUserTierIfEligible();
    updateIdentityEmailUi();
    if (isProUser()) hideAuthOverlay();

    var useSupabase = isSupabaseConfigured() && typeof global.supabase !== 'undefined';

    if (useSupabase) {
      setAuthLoading(true, 'session');
      var client = options.supabaseClient || getSupabaseClient();
      initSupabaseAuth(client).then(function (session) {
        setAuthLoading(false, 'session');
        if (session && session.user) {
          hideAuthOverlay();
          refreshSubscriptionFromServer();
        } else if (!isProUser()) {
          showAuthOverlay();
        } else {
          hideAuthOverlay();
        }
      }).catch(function (e) {
        console.warn('[Auth] Supabase session check failed', e);
        setAuthLoading(false, 'session');
        if (!isProUser()) showAuthOverlay();
        else hideAuthOverlay();
        authState.sessionReady = true;
        notifyListeners();
      });
      return getPublicState();
    }

    var restored = shouldAllowMockAuth() && loadPersistedAuth();
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
    isProUserEmail: isProUserEmail,
    PRO_USERS: PRO_USERS,
    normalizeTierId: normalizeTierId,
  };
})(typeof window !== 'undefined' ? window : globalThis);
