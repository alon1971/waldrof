/**
 * auth-subscription.js — Client-side auth placeholders & subscription rate limiting.
 * Ready for future Supabase / Firebase integration.
 */
(function (global) {
  'use strict';

  var STORAGE_AUTH = 'waldorf_auth_v1';
  var STORAGE_USAGE = 'waldorf_search_usage_v1';

  /** Hidden fair-use cap for Expert tier (not shown in UI). */
  var EXPERT_FAIR_USE_CAP = 400;

  var TIERS = {
    trial: {
      id: 'trial',
      dailyLimit: 20,
      displayUnlimited: false,
      prices: { monthly: 0, yearly: 0 },
    },
    educator: {
      id: 'educator',
      dailyLimit: 50,
      displayUnlimited: false,
      prices: { monthly: 50, yearly: 400 },
    },
    expert: {
      id: 'expert',
      dailyLimit: null,
      fairUseCap: EXPERT_FAIR_USE_CAP,
      displayUnlimited: true,
      prices: { monthly: 100, yearly: 900 },
    },
  };

  var authState = {
    isAuthenticated: false,
    user: null,
    tier: 'trial',
    provider: 'mock',
    sessionReady: false,
  };

  var listeners = [];

  function t(key, vars) {
    if (typeof global.t === 'function') return global.t(key, vars);
    return key;
  }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function readUsage() {
    try {
      var raw = localStorage.getItem(STORAGE_USAGE);
      if (!raw) return { date: todayKey(), count: 0 };
      var data = JSON.parse(raw);
      if (!data || data.date !== todayKey()) return { date: todayKey(), count: 0 };
      return { date: data.date, count: Number(data.count) || 0 };
    } catch (e) {
      return { date: todayKey(), count: 0 };
    }
  }

  function writeUsage(count) {
    try {
      localStorage.setItem(STORAGE_USAGE, JSON.stringify({ date: todayKey(), count: count }));
    } catch (e) { /* quota */ }
  }

  function getTierConfig(tierId) {
    return TIERS[tierId] || TIERS.trial;
  }

  function getDailyLimit(tierId) {
    var tier = getTierConfig(tierId || authState.tier);
    if (tier.displayUnlimited) return tier.fairUseCap || EXPERT_FAIR_USE_CAP;
    return tier.dailyLimit;
  }

  function getDisplayLimit(tierId) {
    var tier = getTierConfig(tierId || authState.tier);
    if (tier.displayUnlimited) return null;
    return tier.dailyLimit;
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
      authState.isAuthenticated = true;
      authState.user = data.user;
      authState.tier = data.tier || 'trial';
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
    var effectiveLimit = getDailyLimit();
    return {
      isAuthenticated: authState.isAuthenticated,
      user: authState.user ? Object.assign({}, authState.user) : null,
      tier: authState.tier,
      provider: authState.provider,
      sessionReady: authState.sessionReady,
      searchesToday: usage.count,
      dailyLimit: displayLimit,
      effectiveLimit: effectiveLimit,
      remaining: displayLimit === null ? null : Math.max(0, displayLimit - usage.count),
      tierConfig: getTierConfig(authState.tier),
    };
  }

  function subscribe(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) { return f !== fn; });
    };
  }

  /* ── Future provider hooks ─────────────────────────────────────────────── */

  function initSupabaseAuth(supabaseClient) {
    if (!supabaseClient || typeof supabaseClient.auth === 'undefined') {
      console.warn('[Auth] initSupabaseAuth: invalid Supabase client');
      return Promise.resolve(null);
    }
    return supabaseClient.auth.getSession().then(function (result) {
      var session = result && result.data && result.data.session;
      if (session && session.user) {
        applyExternalUser(session.user, 'supabase', session.user.user_metadata && session.user.user_metadata.tier);
      }
      supabaseClient.auth.onAuthStateChange(function (_event, sess) {
        if (sess && sess.user) {
          applyExternalUser(sess.user, 'supabase', sess.user.user_metadata && sess.user.user_metadata.tier);
        } else {
          clearAuth(false);
        }
      });
      authState.sessionReady = true;
      notifyListeners();
      return session;
    });
  }

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
    authState.tier = tier && TIERS[tier] ? tier : authState.tier || 'trial';
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
    return Promise.resolve(getPublicState());
  }

  function mockSignIn(email, password) {
    var trimmed = String(email || '').trim().toLowerCase();
    if (!trimmed || !String(password || '').length) {
      return Promise.reject(new Error(t('auth_err_required')));
    }
    var restored = loadPersistedAuth();
    if (restored && authState.user && authState.user.email === trimmed) {
      authState.isAuthenticated = true;
      hideAuthOverlay();
      notifyListeners();
      return Promise.resolve(getPublicState());
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
    if (!TIERS[tierId]) return;
    authState.tier = tierId;
    persistAuth();
    notifyListeners();
  }

  function mockUpgrade(tierId, billingCycle) {
    if (!authState.isAuthenticated) return Promise.reject(new Error(t('auth_err_sign_in_first')));
    if (!TIERS[tierId]) return Promise.reject(new Error('Invalid tier'));
    authState.tier = tierId;
    persistAuth();
    hidePricingModal();
    notifyListeners();
    return Promise.resolve({ tier: tierId, billingCycle: billingCycle || 'monthly' });
  }

  /* ── Rate limiter ────────────────────────────────────────────────────── */

  function canPerformSearch() {
    if (!authState.isAuthenticated) return { allowed: false, reason: 'auth' };
    var usage = readUsage();
    var limit = getDailyLimit();
    if (usage.count >= limit) {
      return { allowed: false, reason: 'limit', usage: usage.count, limit: limit };
    }
    return { allowed: true, usage: usage.count, limit: limit };
  }

  function recordSearch() {
    var usage = readUsage();
    usage.count += 1;
    writeUsage(usage.count);
    notifyListeners();
    return usage.count;
  }

  function assertSearchAllowed() {
    var check = canPerformSearch();
    if (!check.allowed) {
      if (check.reason === 'auth') showAuthOverlay();
      else showRateLimitModal(check);
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
        recordSearch();
        return result;
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
  }

  function showPricingModal() {
    var el = document.getElementById('pricing-modal');
    if (el) {
      renderPricingCards();
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function hidePricingModal() {
    var el = document.getElementById('pricing-modal');
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
      var text = t('rate_limit_body', {
        used: check && check.usage != null ? check.usage : readUsage().count,
        limit: displayLimit != null ? displayLimit : getDailyLimit(),
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

  function renderPricingCards() {
    var grid = document.getElementById('pricing-tier-grid');
    if (!grid) return;
    var current = authState.tier;
    var cycle = pricingBillingCycle;
    var order = ['trial', 'educator', 'expert'];

    grid.innerHTML = order.map(function (tierId) {
      var tier = TIERS[tierId];
      var isCurrent = tierId === current;
      var featured = tierId === 'educator';
      var price = tierId === 'trial' ? t('pricing_free') : formatPrice(tier.prices[cycle], cycle);
      var altPrice = tierId !== 'trial' && cycle === 'monthly'
        ? t('pricing_or_yearly', { amount: tier.prices.yearly })
        : (tierId !== 'trial' && cycle === 'yearly'
          ? t('pricing_or_monthly', { amount: tier.prices.monthly })
          : '');
      var limitText = tier.displayUnlimited
        ? t('tier_expert_searches')
        : t('tier_searches_per_day', { count: tier.dailyLimit });

      return (
        '<article class="pricing-tier-card' + (featured ? ' pricing-tier-card--featured' : '') + (isCurrent ? ' pricing-tier-card--current' : '') + '" data-tier="' + tierId + '">' +
          (featured ? '<span class="pricing-tier-badge">' + escapeHtml(t('pricing_most_popular')) + '</span>' : '') +
          (isCurrent ? '<span class="pricing-tier-current">' + escapeHtml(t('pricing_current_plan')) + '</span>' : '') +
          '<h3 class="pricing-tier-name font-display">' + escapeHtml(tierLabel(tierId)) + '</h3>' +
          '<p class="pricing-tier-price font-display">' + escapeHtml(price) + '</p>' +
          (altPrice ? '<p class="pricing-tier-alt">' + escapeHtml(altPrice) + '</p>' : '') +
          '<p class="pricing-tier-limit"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> ' + escapeHtml(limitText) + '</p>' +
          '<ul class="pricing-tier-features">' +
            (tierId === 'trial' ? '<li>' + escapeHtml(t('tier_trial_feature')) + '</li>' : '') +
            (tierId === 'educator' ? '<li>' + escapeHtml(t('tier_educator_feature_1')) + '</li><li>' + escapeHtml(t('tier_educator_feature_2')) + '</li>' : '') +
            (tierId === 'expert' ? '<li>' + escapeHtml(t('tier_expert_feature_1')) + '</li><li>' + escapeHtml(t('tier_expert_feature_2')) + '</li>' : '') +
          '</ul>' +
          (tierId === 'trial'
            ? '<button type="button" class="pricing-tier-btn pricing-tier-btn--outline" data-pricing-select="trial"' + (isCurrent ? ' disabled' : '') + '>' +
                escapeHtml(isCurrent ? t('pricing_current_plan') : t('pricing_start_trial')) +
              '</button>'
            : '<button type="button" class="pricing-tier-btn' + (featured ? '' : ' pricing-tier-btn--outline') + '" data-pricing-select="' + tierId + '"' + (isCurrent ? ' disabled' : '') + '>' +
                escapeHtml(isCurrent ? t('pricing_current_plan') : t('pricing_upgrade_btn')) +
              '</button>') +
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
      tierEl.className = 'user-tier-badge user-tier-badge--' + authState.tier;
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
    var usage = readUsage();
    var displayLimit = getDisplayLimit();
    var countEl = document.getElementById('search-usage-count');
    var labelEl = document.getElementById('search-usage-label');
    var fillEl = document.getElementById('search-usage-fill');
    if (countEl) {
      countEl.textContent = displayLimit === null
        ? usage.count + ' ' + t('search_usage_today_unlimited')
        : usage.count + ' / ' + displayLimit;
    }
    if (labelEl) labelEl.textContent = t('search_usage_label');
    if (fillEl) {
      var pct = displayLimit ? Math.min(100, (usage.count / displayLimit) * 100) : Math.min(100, (usage.count / 80) * 100);
      fillEl.style.width = pct + '%';
      fillEl.classList.toggle('search-usage-fill--warning', displayLimit && usage.count >= displayLimit * 0.85);
      fillEl.classList.toggle('search-usage-fill--danger', displayLimit && usage.count >= displayLimit);
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
    if (tabLogin) tabLogin.addEventListener('click', function () { setAuthTab('login'); });
    if (tabSignup) tabSignup.addEventListener('click', function () { setAuthTab('signup'); });

    var loginForm = document.getElementById('auth-form-login');
    if (loginForm) {
      loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = document.getElementById('auth-login-email');
        var pass = document.getElementById('auth-login-password');
        var errEl = document.getElementById('auth-login-error');
        mockSignIn(email && email.value, pass && pass.value).catch(function (err) {
          if (errEl) errEl.textContent = err.message || String(err);
        });
      });
    }

    var signupForm = document.getElementById('auth-form-signup');
    if (signupForm) {
      signupForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = document.getElementById('auth-signup-name');
        var email = document.getElementById('auth-signup-email');
        var pass = document.getElementById('auth-signup-password');
        var errEl = document.getElementById('auth-signup-error');
        mockSignUp(email && email.value, pass && pass.value, name && name.value).catch(function (err) {
          if (errEl) errEl.textContent = err.message || String(err);
        });
      });
    }

    var btnUpgrade = document.getElementById('btn-open-pricing');
    if (btnUpgrade) btnUpgrade.addEventListener('click', showPricingModal);
    var btnSignOut = document.getElementById('btn-auth-signout');
    if (btnSignOut) btnSignOut.addEventListener('click', function () { mockSignOut(); });

    var pricingClose = document.getElementById('pricing-modal-close');
    if (pricingClose) pricingClose.addEventListener('click', hidePricingModal);
    var pricingBackdrop = document.getElementById('pricing-modal-backdrop');
    if (pricingBackdrop) pricingBackdrop.addEventListener('click', hidePricingModal);

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
    bindAuthUi();
    var restored = loadPersistedAuth();
    authState.sessionReady = true;

    if (options.supabaseClient) {
      initSupabaseAuth(options.supabaseClient);
    } else if (typeof global.supabase !== 'undefined' && options.supabaseUrl && options.supabaseAnonKey) {
      try {
        var client = global.supabase.createClient(options.supabaseUrl, options.supabaseAnonKey);
        initSupabaseAuth(client);
      } catch (e) {
        console.warn('[Auth] Supabase init failed', e);
      }
    }

    if (options.firebaseAuth) initFirebaseAuth(options.firebaseAuth);

    if (!restored && !authState.isAuthenticated) {
      showAuthOverlay();
    } else {
      hideAuthOverlay();
    }

    notifyListeners();
    return getPublicState();
  }

  function refreshAuthI18n() {
    renderPricingCards();
    updateHeaderUi();
    updateSearchMeterUi();
    var subtitle = document.getElementById('auth-subtitle');
    if (subtitle) subtitle.textContent = t('auth_subtitle');
  }

  global.WaldorfAuth = {
    TIERS: TIERS,
    EXPERT_FAIR_USE_CAP: EXPERT_FAIR_USE_CAP,
    init: initAuthSubscription,
    subscribe: subscribe,
    getState: getPublicState,
    canPerformSearch: canPerformSearch,
    assertSearchAllowed: assertSearchAllowed,
    recordSearch: recordSearch,
    wrapResearchCall: wrapResearchCall,
    setTier: setTier,
    mockSignIn: mockSignIn,
    mockSignUp: mockSignUp,
    mockSignOut: mockSignOut,
    mockUpgrade: mockUpgrade,
    initSupabaseAuth: initSupabaseAuth,
    initFirebaseAuth: initFirebaseAuth,
    showPricingModal: showPricingModal,
    hidePricingModal: hidePricingModal,
    showAuthOverlay: showAuthOverlay,
    refreshI18n: refreshAuthI18n,
  };
})(typeof window !== 'undefined' ? window : globalThis);
