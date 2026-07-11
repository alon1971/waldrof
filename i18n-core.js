/**
 * i18n-core.js — Hebrew / English UI layer (load after languages.js)
 */
(function (global) {
  const LOCALE_STORAGE_KEY = 'masaot-ui-locale';
  const SUPPORTED = ['he', 'en'];
  /** Used when languages.js failed to load or a key is missing from LANGUAGES. */
  const I18N_FALLBACKS = {
    chat_greeting: 'שלום! ברוכים הבאים למתכנן הפדגוגי.',
    chat_sidebar_title: 'עוזר פדגוגי',
    chat_input_placeholder: 'שאל שאלה פדגוגית...',
    chat_send_btn: 'שלח שאלה',
    meta_title: 'מרכז המידע למורי הוולדורף בישראל, בתי ספר יסודיים א\'-ח\'',
  };
  let currentLang = 'he';
  let onLanguageChange = null;

  function getLang() {
    return currentLang;
  }

  function isEnglish() {
    return currentLang === 'en';
  }

  function isRtl() {
    return currentLang === 'he';
  }

  function interpolate(str, vars) {
    if (!vars) return str;
    return String(str).replace(/\{(\w+)\}/g, function (_, key) {
      return vars[key] != null ? String(vars[key]) : '{' + key + '}';
    });
  }

  function t(key, vars) {
    const dict = (typeof LANGUAGES !== 'undefined' && LANGUAGES[currentLang]) || {};
    const fallbackDict = (typeof LANGUAGES !== 'undefined' && LANGUAGES.he) || {};
    let raw = dict[key] != null ? dict[key] : (fallbackDict[key] != null ? fallbackDict[key] : key);
    if (raw === key && I18N_FALLBACKS[key] != null) {
      raw = I18N_FALLBACKS[key];
    }
    return interpolate(raw, vars);
  }

  function applyStaticI18n(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      el.textContent = t(key);
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    const titleEl = document.querySelector('title[data-i18n]');
    if (titleEl) document.title = t(titleEl.getAttribute('data-i18n'));
    const metaDesc = document.querySelector('meta[name="description"][data-i18n-content]');
    if (metaDesc) metaDesc.setAttribute('content', t(metaDesc.getAttribute('data-i18n-content')));
  }

  function applyDocumentDirection() {
    const html = document.documentElement;
    html.lang = currentLang;
    html.dir = isRtl() ? 'rtl' : 'ltr';
    document.body.classList.toggle('is-ltr-ui', !isRtl());
    document.body.classList.toggle('is-rtl-ui', isRtl());
  }

  function updateLangToggleUi() {
    const btn = document.getElementById('lang-toggle');
    if (!btn) return;
    const next = isEnglish() ? 'he' : 'en';
    btn.setAttribute('data-next-lang', next);
    btn.setAttribute('aria-label', t('lang_toggle_aria', { lang: isEnglish() ? t('lang_name_he') : t('lang_name_en') }));
    const label = btn.querySelector('.lang-toggle-label');
    if (label) label.textContent = isEnglish() ? 'עב' : 'EN';
    btn.classList.toggle('lang-toggle--en-active', isEnglish());
    btn.classList.toggle('lang-toggle--he-active', !isEnglish());
  }

  function setOnLanguageChange(fn) {
    onLanguageChange = typeof fn === 'function' ? fn : null;
  }

  function setLanguage(lang, options) {
    const opts = options || {};
    const next = SUPPORTED.indexOf(lang) >= 0 ? lang : 'he';
    if (!opts.force && next === currentLang) return;
    currentLang = next;
    try { localStorage.setItem(LOCALE_STORAGE_KEY, currentLang); } catch (e) { /* ignore */ }
    applyDocumentDirection();
    applyStaticI18n();
    updateLangToggleUi();
    if (onLanguageChange) onLanguageChange(opts);
  }

  function initI18n() {
    let stored = 'he';
    try {
      const s = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (SUPPORTED.indexOf(s) >= 0) stored = s;
    } catch (e) { /* ignore */ }
    setLanguage(stored, { force: true });
    const btn = document.getElementById('lang-toggle');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        setLanguage(isEnglish() ? 'he' : 'en');
      });
    }
  }

  function getAiOutputLanguageInstruction() {
    if (isEnglish()) {
      return (
        'CRITICAL OUTPUT LANGUAGE: Produce ALL generated pedagogical content exclusively in English. ' +
        'This includes theory sections, inspiration blocks, podcast episode text, block planning rows, ' +
        'lesson plans, day topics, narrative tags, summaries, archive intros, and all UI-facing titles. ' +
        'Do not output Hebrew in generated content. Bibliography may list English-language sources only (see bibliography rules).'
      );
    }
    return (
      'שפת פלט חובה: הפק את כל התוכן הפדגוגי שנוצר בעברית בלבד — רקע תיאורטי, השראה, תכנון תקופה, מערכי שיעור וכותרות. ' +
      'מקורות בביבליוגרפיה יכולים לכלול עברית (ללא הגבלה) ואנגלית (עד 10).'
    );
  }

  function getGradeLabelById(gradeId) {
    return t('grade_' + gradeId);
  }

  global.getLang = getLang;
  global.isEnglish = isEnglish;
  global.isRtl = isRtl;
  global.t = t;
  global.applyStaticI18n = applyStaticI18n;
  global.setLanguage = setLanguage;
  global.setOnLanguageChange = setOnLanguageChange;
  global.initI18n = initI18n;
  global.getAiOutputLanguageInstruction = getAiOutputLanguageInstruction;
  global.getGradeLabelById = getGradeLabelById;
})(typeof window !== 'undefined' ? window : globalThis);
