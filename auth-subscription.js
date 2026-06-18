/**
 * auth-subscription.js — Client-side auth placeholders & subscription rate limiting.
 * Ready for future Supabase / Firebase integration.
 */
(function (global) {
  'use strict';

  var STORAGE_AUTH = 'waldorf_auth_v1';
  var STORAGE_USAGE = 'waldorf_search_usage_v2';
  var STORAGE_WORD_DOWNLOADS = 'waldorf_word_downloads_v1';
  var SUPPORT_WHATSAPP = '';

  var LEGACY_TIER_MAP = {
    educator: 'standard',
    expert: 'pro',
  };

  var TIERS = {
    trial: {
      id: 'trial',
      lifetimeLimit: 10,
      wordDownloadLimit: 10,
      monthlyLimit: null,
      displayUnlimited: false,
      prices: { monthly: 0, yearly: 0 },
    },
    standard: {
      id: 'standard',
      monthlyLimit: 200,
      lifetimeLimit: null,
      displayUnlimited: false,
      prices: { monthly: 50, yearly: 500 },
      yearlySavingsKey: 'pricing_standard_yearly_deal',
    },
    pro: {
      id: 'pro',
      monthlyLimit: 1000,
      lifetimeLimit: null,
      displayUnlimited: false,
      prices: { monthly: 200, yearly: 2000 },
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
    usagePeriod: 'lifetime',
    searchesUsed: 0,
    searchLimit: 10,
    wordDownloadsUsed: 0,
    wordDownloadLimit: 10,
  };

  var listeners = [];
  var supabaseClient = null;
  var supabaseConfig = { url: '', anonKey: '' };
  var authUiLoading = false;
  var useMockGoogleAuth = false;
  var authRedirectUrl = '';

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

  function resetSupabaseClient() {
    supabaseClient = null;
  }

  function getSupabaseClient() {
    if (supabaseClient) return supabaseClient;
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
    } catch (e) {
      console.warn('[Auth] Supabase client creation failed', e);
      return null;
    }
    return supabaseClient;
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

  function mapSupabaseUser(user) {
    var meta = (user && user.user_metadata) || {};
    return {
      id: user.id,
      email: user.email || '',
      displayName: meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : ''),
    };
  }

  function applySupabaseSession(session) {
    if (!session || !session.user) return;
    var user = session.user;
    authState.isAuthenticated = true;
    authState.provider = 'supabase';
    authState.user = mapSupabaseUser(user);
    authState.tier = resolveTierFromUser(user);
    persistAuth();
    hideAuthOverlay();
    refreshSubscriptionFromServer().finally(function () {
      notifyListeners();
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
      return Number(raw) || 0;
    } catch (e) {
      return 0;
    }
  }

  function writeWordDownloads(count) {
    try {
      localStorage.setItem(STORAGE_WORD_DOWNLOADS, String(Number(count) || 0));
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
    return getTierConfig('trial').wordDownloadLimit || 10;
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
    authState.tier = normalizeTierId(usage.tier || authState.tier);
    authState.searchesUsed = Number(usage.searchesUsed) || 0;
    authState.searchLimit = usage.searchLimit != null ? usage.searchLimit : authState.searchLimit;
    authState.usagePeriod = usage.usagePeriod || authState.usagePeriod;
    if (usage.autoRenew != null) authState.autoRenew = usage.autoRenew !== false;
    if (usage.billingCycle != null) authState.billingCycle = usage.billingCycle;
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
    if (!authState.isAuthenticated) return Promise.resolve(null);
    return getAccessToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      var body = { action: action || 'status' };
      if (authState.user) {
        body.teacherUser = {
          id: authState.user.id,
          email: authState.user.email,
          displayName: authState.user.displayName,
          tier: authState.tier,
        };
      }
      return fetch(subscriptionApiUrl(), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.json().then(function (json) {
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
      console.warn('[Auth] subscription sync failed', err.message || err);
      return null;
    });
  }

  function refreshSubscriptionFromServer() {
    return fetchSubscriptionAction('status').then(function (data) {
      if (!data) return null;
      if (data.subscription && data.subscription.tier) {
        authState.tier = normalizeTierId(data.subscription.tier);
        authState.autoRenew = data.subscription.autoRenew !== false;
        authState.billingCycle = data.subscription.billingCycle || null;
      }
      if (data.usage) applyServerUsage(data.usage);
      persistAuth();
      notifyListeners();
      return data;
    });
  }

  function getTierConfig(tierId) {
    return TIERS[normalizeTierId(tierId)] || TIERS.trial;
  }

  function getEffectiveLimit(tierId) {
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
    listeners.forEach(function (fn) {
      try { fn(getPublicState()); } catch (e) { console.warn(e); }
    });
    updateHeaderUi();
    updateSearchMeterUi();
  }

  function getPublicState() {
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
      if (session && session.user) {
        applySupabaseSession(session);
      }
      client.auth.onAuthStateChange(function (event, sess) {
        if (sess && sess.user) {
          applySupabaseSession(sess);
        } else if (event === 'SIGNED_OUT') {
          clearAuth(false);
          showAuthOverlay();
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

  function signOut() {
    var client = getSupabaseClient();
    if (client && authState.provider === 'supabase') {
      return client.auth.signOut().then(function () {
        clearAuth(true);
        showAuthOverlay();
      }).catch(function () {
        clearAuth(true);
        showAuthOverlay();
      });
    }
    return mockSignOut();
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
      displayName: externalUser.displayName || externalUser.user_metadata && externalUser.user_metadata.full_name || '',
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
    clearAuth(true);
    showAuthOverlay();
    return Promise.resolve();
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
    showCheckoutSoonModal(normalized, billingCycle || pricingBillingCycle);
    return Promise.resolve({ tier: normalized, billingCycle: billingCycle || pricingBillingCycle, pendingCheckout: true });
  }

  /* ── Rate limiter ────────────────────────────────────────────────────── */

  function canPerformSearch() {
    if (!authState.isAuthenticated) return { allowed: false, reason: 'auth' };
    var used = getSearchesUsed();
    var limit = getEffectiveLimit();
    if (used >= limit) {
      return { allowed: false, reason: 'limit', usage: used, limit: limit };
    }
    return { allowed: true, usage: used, limit: limit };
  }

  function canPerformWordDownload() {
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
      else {
        showPricingModal('word_download_limit_notice');
      }
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
    return fetchSubscriptionAction('record_search').then(function (data) {
      if (data && data.usage) {
        applyServerUsage(data.usage);
        notifyListeners();
        return data.usage.searchesUsed;
      }
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
    });
  }

  function assertSearchAllowed() {
    var check = canPerformSearch();
    if (!check.allowed) {
      if (check.reason === 'auth') showAuthOverlay();
      else {
        showRateLimitModal(check);
        showPricingModal();
      }
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

  function hideAuthOverlay() {
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
    if (typeof global.ensurePageAtTop === 'function') {
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
      renderPricingCards();
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
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
    if (cancelBtn) {
      cancelBtn.classList.toggle('hidden', state.tier === 'trial');
      cancelBtn.disabled = state.tier === 'trial';
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

  function confirmCancelSubscription() {
    return fetchSubscriptionAction('cancel_renewal').then(function (data) {
      authState.autoRenew = false;
      if (data && data.subscription) {
        authState.tier = normalizeTierId(data.subscription.tier || authState.tier);
      }
      persistAuth();
      hideCancelSubscriptionModal();
      hideUserSettingsModal();
      notifyListeners();
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
    return 'mailto:waldorf.planner.ai@gmail.com?subject=' + encodeURIComponent(t('tier_school_email_subject'));
  }

  function renderPricingCardActions(tierId, isCurrent, featured) {
    if (tierId === 'school') {
      return '<a href="' + escapeHtml(schoolTierEmailHref()) + '" class="pricing-tier-btn pricing-tier-btn--outline pricing-tier-btn--mail">' +
        '<i class="fa-solid fa-envelope" aria-hidden="true"></i> ' +
        escapeHtml(t('tier_school_contact_btn')) +
      '</a>';
    }
    if (tierId === 'trial') {
      return '<button type="button" class="pricing-tier-btn pricing-tier-btn--outline" data-pricing-select="trial"' + (isCurrent ? ' disabled' : '') + '>' +
        escapeHtml(isCurrent ? t('pricing_current_plan') : t('pricing_start_trial')) +
      '</button>';
    }
    return '<button type="button" class="pricing-tier-btn' + (featured ? '' : ' pricing-tier-btn--outline') + '" data-pricing-select="' + tierId + '"' + (isCurrent ? ' disabled' : '') + '>' +
      escapeHtml(isCurrent ? t('pricing_current_plan') : t('pricing_upgrade_btn')) +
    '</button>';
  }

  function renderPricingTierFeatures(tierId) {
    if (tierId === 'trial') {
      return '<li>' + escapeHtml(t('tier_trial_feature_searches')) + '</li>' +
        '<li>' + escapeHtml(t('tier_trial_feature_downloads')) + '</li>' +
        '<li>' + escapeHtml(t('tier_trial_feature_archive')) + '</li>';
    }
    if (tierId === 'standard') {
      return '<li>' + escapeHtml(t('tier_standard_feature_1')) + '</li>' +
        '<li>' + escapeHtml(t('tier_standard_feature_2')) + '</li>' +
        '<li>' + escapeHtml(t('tier_standard_feature_3')) + '</li>';
    }
    if (tierId === 'pro') {
      return '<li>' + escapeHtml(t('tier_pro_feature_1')) + '</li>' +
        '<li>' + escapeHtml(t('tier_pro_feature_2')) + '</li>' +
        '<li>' + escapeHtml(t('tier_pro_feature_3')) + '</li>';
    }
    if (tierId === 'school') {
      return '<li>' + escapeHtml(t('tier_school_feature_1')) + '</li>' +
        '<li>' + escapeHtml(t('tier_school_feature_2')) + '</li>' +
        '<li>' + escapeHtml(t('tier_school_feature_3')) + '</li>';
    }
    return '';
  }

  function renderPricingCards() {
    var grid = document.getElementById('pricing-tier-grid');
    if (!grid) return;
    var current = normalizeTierId(authState.tier);
    var cycle = pricingBillingCycle;
    var order = ['trial', 'standard', 'pro', 'school'];

    grid.innerHTML = order.map(function (tierId) {
      var tier = TIERS[tierId];
      if (!tier) return '';
      var isCurrent = tierId === current;
      var featured = tierId === 'pro';
      var isSchool = tierId === 'school';
      var price = tierId === 'trial'
        ? t('pricing_free')
        : (isSchool
          ? t('tier_school_price_label')
          : formatPrice(tier.prices[cycle], cycle));
      var altPrice = !isSchool && tierId !== 'trial' && cycle === 'monthly'
        ? t('pricing_or_yearly', { amount: tier.prices.yearly })
        : (!isSchool && tierId !== 'trial' && cycle === 'yearly'
          ? t('pricing_or_monthly', { amount: tier.prices.monthly })
          : '');
      var savings = !isSchool && (tierId === 'standard' || tierId === 'pro') && tier.yearlySavingsKey
        ? '<p class="pricing-tier-savings">' + escapeHtml(t(tier.yearlySavingsKey)) + '</p>'
        : '';
      var limitLine = '';

      return (
        '<article class="pricing-tier-card' + (featured ? ' pricing-tier-card--featured' : '') + (isCurrent ? ' pricing-tier-card--current' : '') + (isSchool ? ' pricing-tier-card--school' : '') + '" data-tier="' + tierId + '">' +
          (featured ? '<span class="pricing-tier-badge">' + escapeHtml(t('pricing_most_popular')) + '</span>' : '') +
          (isCurrent ? '<span class="pricing-tier-current">' + escapeHtml(t('pricing_current_plan')) + '</span>' : '') +
          '<h3 class="pricing-tier-name font-display">' + escapeHtml(tierLabel(tierId)) + '</h3>' +
          '<p class="pricing-tier-price font-display">' + escapeHtml(price) + '</p>' +
          (altPrice ? '<p class="pricing-tier-alt">' + escapeHtml(altPrice) + '</p>' : '') +
          savings +
          limitLine +
          '<ul class="pricing-tier-features">' + renderPricingTierFeatures(tierId) + '</ul>' +
          (tierId !== 'trial' && !isSchool
            ? '<p class="pricing-tier-disclaimer">' + escapeHtml(t('pricing_auto_renew_disclaimer')) + '</p>'
            : '') +
          renderPricingCardActions(tierId, isCurrent, featured) +
        '</article>'
      );
    }).join('');

    grid.querySelectorAll('[data-pricing-select]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tierId = btn.getAttribute('data-pricing-select');
        mockUpgrade(tierId, pricingBillingCycle).catch(function (e) {
          alert(e.message || String(e));
        });
      });
    });
  }

  function updateHeaderUi() {
    var bar = document.getElementById('user-account-bar');
    if (!bar) return;
    if (!authState.isAuthenticated || !authState.user) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    var nameEl = document.getElementById('user-display-name');
    var tierEl = document.getElementById('user-tier-badge');
    if (nameEl) nameEl.textContent = authState.user.displayName || authState.user.email || '';
    if (tierEl) {
      tierEl.textContent = tierLabel(authState.tier);
      tierEl.className = 'user-tier-badge user-tier-badge--' + (typeof WaldorfAuth.normalizeTierId === 'function'
        ? WaldorfAuth.normalizeTierId(authState.tier)
        : authState.tier);
    }
  }

  function updateSearchMeterUi() {
    var meter = document.getElementById('search-usage-meter');
    if (!meter) return;
    if (!authState.isAuthenticated) {
      meter.classList.add('hidden');
      return;
    }
    meter.classList.remove('hidden');
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

    var pricingClose = document.getElementById('pricing-modal-close');
    if (pricingClose) pricingClose.addEventListener('click', hidePricingModal);
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

    document.querySelectorAll('[data-billing-cycle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pricingBillingCycle = btn.getAttribute('data-billing-cycle') || 'monthly';
        document.querySelectorAll('[data-billing-cycle]').forEach(function (b) {
          b.classList.toggle('billing-toggle-btn--active', b === btn);
        });
        renderPricingCards();
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

    var useSupabase = isSupabaseConfigured() && typeof global.supabase !== 'undefined';

    if (useSupabase) {
      clearAuth(false);
      showAuthOverlay();
      setAuthLoading(true, 'session');
      var client = options.supabaseClient || getSupabaseClient();
      initSupabaseAuth(client).then(function (session) {
        setAuthLoading(false, 'session');
        if (session && session.user) {
          hideAuthOverlay();
          refreshSubscriptionFromServer();
        } else showAuthOverlay();
      }).catch(function (e) {
        console.warn('[Auth] Supabase session check failed', e);
        setAuthLoading(false, 'session');
        showAuthOverlay();
        authState.sessionReady = true;
        notifyListeners();
      });
      return getPublicState();
    }

    var restored = shouldAllowMockAuth() && loadPersistedAuth();
    authState.sessionReady = true;
    if (options.firebaseAuth) initFirebaseAuth(options.firebaseAuth);
    if (!restored && !authState.isAuthenticated) showAuthOverlay();
    else if (authState.isAuthenticated) {
      hideAuthOverlay();
      refreshSubscriptionFromServer();
    }
    else showAuthOverlay();
    notifyListeners();
    return getPublicState();
  }

  function refreshAuthI18n() {
    renderPricingCards();
    updateHeaderUi();
    updateSearchMeterUi();
    var subtitle = document.getElementById('auth-subtitle');
    if (subtitle) subtitle.textContent = t('auth_subtitle');
    document.querySelectorAll('[data-auth-google]').forEach(function (btn) {
      btn.setAttribute('aria-label', t('auth_google_btn'));
    });
  }

  function getContributorProfile() {
    if (!authState.isAuthenticated || !authState.user) return null;
    return {
      id: authState.user.id || null,
      email: authState.user.email || '',
      name: authState.user.displayName || authState.user.email || '',
      displayName: authState.user.displayName || authState.user.email || '',
    };
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
    refreshSubscriptionFromServer: refreshSubscriptionFromServer,
    showAuthOverlay: showAuthOverlay,
    refreshI18n: refreshAuthI18n,
    getContributorProfile: getContributorProfile,
    getAccessToken: getAccessToken,
    normalizeTierId: normalizeTierId,
  };
})(typeof window !== 'undefined' ? window : globalThis);
