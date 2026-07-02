/**
 * search-history.js — "החיפושים האחרונים שלי" button + dedicated table view.
 */
(function (global) {
  'use strict';

  var state = {
    items: [],
    loading: false,
    loaded: false,
    viewOpen: false,
    openingKey: '',
    eventsBound: false,
  };

  var deps = {
    t: function (k) { return k; },
    escapeHtml: function (s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    isAuthenticated: function () { return false; },
    isSessionReady: function () { return false; },
    getContributor: function () { return null; },
    getAccessToken: function () { return Promise.resolve(null); },
    showAuth: function () {},
    onReload: null,
    apiBase: '',
  };

  function historyApiUrl() {
    var base = String(deps.apiBase || '').replace(/\/$/, '');
    if (base) return base + '/api/search-history';
    if (typeof location !== 'undefined' && location.origin && location.protocol !== 'file:') {
      return location.origin + '/api/search-history';
    }
    return '/api/search-history';
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('he-IL', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (e) {
      return '—';
    }
  }

  function gradeLabelForItem(item) {
    if (item.gradeLabel) return item.gradeLabel;
    if (item.gradeId && deps.getGradeLabel) return deps.getGradeLabel(item.gradeId);
    return item.gradeId ? ('כיתה ' + item.gradeId) : '—';
  }

  function sortedItems() {
    return state.items.slice().sort(function (a, b) {
      var ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      var tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }

  function findItemByKey(cacheKey) {
    return state.items.find(function (x) { return x.cacheKey === cacheKey; }) || null;
  }

  function isTopicMasterHistoryShape(resultData, item) {
    if (item && item.phase === 'topic_master') return true;
    if (!resultData || typeof resultData !== 'object') return false;
    if (resultData.purePhaseC && typeof resultData.purePhaseC === 'object') return true;
    if (resultData.theory && typeof resultData.theory === 'object') {
      if (String(resultData.core_emphases || '').trim().length > 20) return true;
      if (Array.isArray(resultData.key_points) && resultData.key_points.length) return true;
    }
    return false;
  }

  function hasMeaningfulBlockPlanShell(resultData) {
    if (!resultData || !resultData.blockPlan || typeof resultData.blockPlan !== 'object') return false;
    var bp = resultData.blockPlan;
    if (String(bp.rawContent || '').trim()) return true;
    var theory = bp.theory;
    if (theory && Array.isArray(theory.sections) && theory.sections.length) return true;
    if (Array.isArray(bp.curriculum) && bp.curriculum.length) return true;
    var wr = resultData.webResearch;
    if (wr && String(wr.summary || wr.overview || '').trim()) return true;
    return false;
  }

  function isOpenableHistoryPayload(resultData, item) {
    if (!resultData || typeof resultData !== 'object') return false;
    if (isTopicMasterHistoryShape(resultData, item)) return true;
    if (hasMeaningfulBlockPlanShell(resultData)) return true;
    return false;
  }

  function fetchLessonByCacheKey(cacheKey) {
    return deps.getAccessToken().then(function (token) {
      var contributor = deps.getContributor();
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;

      return fetch(historyApiUrl(), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          action: 'reload',
          cacheKey: cacheKey,
          teacherUser: contributor,
        }),
      });
    }).then(function (res) {
      return res.text().then(function (body) {
        var json;
        try { json = body ? JSON.parse(body) : {}; } catch (e) { json = {}; }
        if (!res.ok) {
          var err = new Error((json && json.error) || body || String(res.status));
          err.statusCode = res.status;
          err.responseBody = body;
          console.error('[search-history] reload HTTP error', {
            cacheKey: cacheKey,
            status: res.status,
            error: json && json.error,
            bodyPreview: body ? String(body).slice(0, 500) : '',
          });
          throw err;
        }
        var data = json.data || json;
        var item = (data && data.item) || null;
        if (!item || !item.resultData) {
          console.error('[search-history] reload empty payload', {
            cacheKey: cacheKey,
            item: item,
            action: data && data.action,
          });
          throw new Error(deps.t('search_history_error'));
        }
        return item;
      });
    });
  }

  function closeView() {
    state.viewOpen = false;
    var overlay = document.getElementById('search-history-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.setAttribute('hidden', '');
      overlay.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('search-history-view-open');
    var openBtn = document.getElementById('search-history-open-btn');
    if (openBtn) openBtn.focus();
  }

  function canLoadHistory() {
    return deps.isSessionReady() && deps.isAuthenticated();
  }

  function openView() {
    if (!deps.isAuthenticated()) {
      if (typeof deps.showAuth === 'function') deps.showAuth();
      return;
    }
    if (!deps.isSessionReady()) {
      ensureOverlay();
      state.viewOpen = true;
      var pendingOverlay = document.getElementById('search-history-overlay');
      if (pendingOverlay) {
        pendingOverlay.classList.remove('hidden');
        pendingOverlay.removeAttribute('hidden');
        pendingOverlay.setAttribute('aria-hidden', 'false');
      }
      document.body.classList.add('search-history-view-open');
      renderTable();
      return;
    }
    ensureOverlay();
    state.viewOpen = true;
    var overlay = document.getElementById('search-history-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      overlay.removeAttribute('hidden');
      overlay.setAttribute('aria-hidden', 'false');
    }
    document.body.classList.add('search-history-view-open');
    renderTable();
    loadHistory(true).then(function () {
      if (state.viewOpen) renderTable();
    });
    var closeBtn = document.getElementById('search-history-close');
    if (closeBtn) closeBtn.focus();
  }

  function openHistoryItem(cacheKey) {
    if (!cacheKey || state.openingKey) return Promise.resolve();
    if (typeof deps.onReload !== 'function') {
      console.warn('[search-history] onReload handler is not configured');
      return Promise.resolve();
    }

    state.openingKey = cacheKey;
    renderTable();

    return fetchLessonByCacheKey(cacheKey).then(function (item) {
      if (!isOpenableHistoryPayload(item.resultData, item)) {
        console.error('[search-history] reload unusable lesson shape', {
          cacheKey: cacheKey,
          phase: item.phase,
          hasBlockPlan: Boolean(item.resultData && item.resultData.blockPlan),
          hasPurePhaseC: Boolean(item.resultData && item.resultData.purePhaseC),
          hasTheory: Boolean(item.resultData && item.resultData.theory),
        });
        throw new Error(deps.t('search_history_error'));
      }
      return Promise.resolve(deps.onReload(item)).then(function () {
        closeView();
      });
    }).catch(function (err) {
      console.error('[search-history] open history item failed', {
        cacheKey: cacheKey,
        statusCode: err && err.statusCode,
        message: err && err.message,
        responseBody: err && err.responseBody ? String(err.responseBody).slice(0, 500) : undefined,
      });
      alert((err && err.message) || deps.t('search_history_error'));
    }).finally(function () {
      state.openingKey = '';
      if (state.viewOpen) renderTable();
    });
  }

  function renderTableBody() {
    if (!deps.isAuthenticated()) {
      return '<tr><td colspan="4" class="search-history-table-empty">' +
        deps.escapeHtml(deps.t('search_history_need_auth')) + '</td></tr>';
    }

    if (!deps.isSessionReady()) {
      return '<tr><td colspan="4" class="search-history-table-empty">' +
        '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ' +
        deps.escapeHtml(deps.t('search_history_loading')) + '</td></tr>';
    }

    if (state.loading) {
      return '<tr><td colspan="4" class="search-history-table-empty">' +
        '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ' +
        deps.escapeHtml(deps.t('search_history_loading')) + '</td></tr>';
    }

    var items = sortedItems();
    if (!items.length) {
      return '<tr><td colspan="4" class="search-history-table-empty">' +
        deps.escapeHtml(deps.t('search_history_empty')) + '</td></tr>';
    }

    return items.map(function (item) {
      var topic = deps.escapeHtml(item.topic || deps.t('search_history_untitled'));
      var grade = deps.escapeHtml(gradeLabelForItem(item));
      var date = deps.escapeHtml(formatDate(item.createdAt));
      var gradeId = deps.escapeHtml(item.gradeId || '');
      var topicKey = deps.escapeHtml(String(item.topic || '').trim().toLowerCase());
      var opening = state.openingKey === item.cacheKey;
      var actionLabel = opening
        ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ' + deps.escapeHtml(deps.t('search_history_loading'))
        : '<i class="fa-solid fa-folder-open" aria-hidden="true"></i> ' + deps.escapeHtml(deps.t('search_history_open'));
      return (
        '<tr class="search-history-table-row" data-cache-key="' + deps.escapeHtml(item.cacheKey) + '" data-grade-id="' + gradeId + '" data-topic="' + topicKey + '">' +
          '<td class="search-history-table-topic" data-label="' + deps.escapeHtml(deps.t('search_history_col_topic')) + '">' + topic + '</td>' +
          '<td class="search-history-table-grade" data-label="' + deps.escapeHtml(deps.t('search_history_col_grade')) + '">' + grade + '</td>' +
          '<td class="search-history-table-date" data-label="' + deps.escapeHtml(deps.t('search_history_col_date')) + '"><time datetime="' + deps.escapeHtml(item.createdAt || '') + '">' + date + '</time></td>' +
          '<td class="search-history-table-action" data-label="' + deps.escapeHtml(deps.t('search_history_col_action')) + '">' +
            '<button type="button" class="search-history-load-btn touch-btn" data-cache-key="' + deps.escapeHtml(item.cacheKey) + '"' + (opening ? ' disabled' : '') + '>' + actionLabel + '</button>' +
          '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function renderTable() {
    var tbody = document.getElementById('search-history-table-body');
    if (!tbody) return;
    tbody.innerHTML = renderTableBody();
  }

  function ensureOverlay() {
    var main = document.getElementById('app-main');
    if (!main) return null;

    var overlay = document.getElementById('search-history-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'search-history-overlay';
    overlay.className = 'search-history-overlay hidden';
    overlay.setAttribute('hidden', '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'search-history-view-title');
    overlay.setAttribute('aria-hidden', 'true');

    overlay.innerHTML =
      '<div class="search-history-view">' +
        '<header class="search-history-view-header">' +
          '<div class="search-history-view-heading">' +
            '<i class="fa-solid fa-clock-rotate-left search-history-view-icon" aria-hidden="true"></i>' +
            '<div>' +
              '<h2 id="search-history-view-title" class="search-history-view-title">' + deps.escapeHtml(deps.t('search_history_title')) + '</h2>' +
              '<p class="search-history-view-lead">' + deps.escapeHtml(deps.t('search_history_lead')) + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="search-history-view-actions">' +
            '<button type="button" id="search-history-refresh" class="search-history-refresh touch-btn" title="' + deps.escapeHtml(deps.t('search_history_refresh')) + '">' +
              '<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>' +
              '<span class="sr-only">' + deps.escapeHtml(deps.t('search_history_refresh')) + '</span>' +
            '</button>' +
            '<button type="button" id="search-history-close" class="search-history-close touch-btn">' +
              '<i class="fa-solid fa-xmark" aria-hidden="true"></i>' +
              '<span>' + deps.escapeHtml(deps.t('search_history_close')) + '</span>' +
            '</button>' +
          '</div>' +
        '</header>' +
        '<div class="search-history-table-wrap">' +
          '<table class="search-history-table" aria-describedby="search-history-view-title">' +
            '<thead>' +
              '<tr>' +
                '<th scope="col">' + deps.escapeHtml(deps.t('search_history_col_topic')) + '</th>' +
                '<th scope="col">' + deps.escapeHtml(deps.t('search_history_col_grade')) + '</th>' +
                '<th scope="col">' + deps.escapeHtml(deps.t('search_history_col_date')) + '</th>' +
                '<th scope="col">' + deps.escapeHtml(deps.t('search_history_col_action')) + '</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody id="search-history-table-body"></tbody>' +
          '</table>' +
        '</div>' +
      '</div>';

    main.appendChild(overlay);

    var closeBtn = document.getElementById('search-history-close');
    if (closeBtn) closeBtn.addEventListener('click', closeView);

    var refreshBtn = document.getElementById('search-history-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadHistory(true);
      });
    }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeView();
    });

    return overlay;
  }

  function renderEntryButton() {
    var mount = document.getElementById('search-history-mount');
    if (!mount) return;

    var labelKey = 'nav_search_history';
    var label = deps.t(labelKey);
    if (!label || label === labelKey) label = deps.t('search_history_title');

    mount.innerHTML =
      '<button type="button" id="search-history-open-btn" class="step-pill step-pill-history search-history-open-btn touch-btn inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:px-5 sm:py-2.5 rounded-full border text-sm sm:text-xs cursor-pointer"' +
        ' aria-label="' + deps.escapeHtml(deps.t('nav_search_history_aria') || label) + '">' +
        '<i class="fa-solid fa-clock-rotate-left text-base sm:text-sm" aria-hidden="true"></i>' +
        '<span data-i18n="nav_search_history">' + deps.escapeHtml(label) + '</span>' +
      '</button>';

    var openBtn = document.getElementById('search-history-open-btn');
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        openView();
      });
    }
  }

  function bindGlobalEvents() {
    if (state.eventsBound) return;
    state.eventsBound = true;

    document.addEventListener('keydown', function (e) {
      if (!state.viewOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeView();
      }
    });

    document.addEventListener('click', function (e) {
      var loadBtn = e.target && e.target.closest ? e.target.closest('.search-history-load-btn') : null;
      if (!loadBtn || loadBtn.disabled) return;
      e.preventDefault();
      var key = loadBtn.getAttribute('data-cache-key');
      if (key) openHistoryItem(key);
    });
  }

  function loadHistory(force) {
    if (!canLoadHistory()) {
      // Auth session not resolved yet — keep loaded=false so a later refresh actually fetches.
      state.items = [];
      state.loaded = false;
      renderTable();
      return Promise.resolve();
    }
    if (state.loading) return Promise.resolve();
    if (state.loaded && !force) return Promise.resolve();

    state.loading = true;
    renderTable();

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeoutId = controller
      ? setTimeout(function () {
        try { controller.abort(); } catch (e) { /* ignore */ }
      }, 20000)
      : null;

    return deps.getAccessToken().then(function (token) {
      if (!token) {
        var authErr = new Error(deps.t('search_history_need_auth'));
        authErr.statusCode = 401;
        throw authErr;
      }
      var contributor = deps.getContributor();
      if (!contributor || (!contributor.id && !contributor.email)) {
        var profileErr = new Error(deps.t('search_history_loading'));
        profileErr.statusCode = 401;
        throw profileErr;
      }
      var headers = { 'Content-Type': 'application/json' };
      headers.Authorization = 'Bearer ' + token;

      return fetch(historyApiUrl(), {
        method: 'POST',
        headers: headers,
        signal: controller ? controller.signal : undefined,
        body: JSON.stringify({ action: 'list', teacherUser: contributor, limit: 40 }),
      });
    }).then(function (res) {
      return res.text().then(function (body) {
        var json;
        try { json = body ? JSON.parse(body) : {}; } catch (e) { json = {}; }
        if (!res.ok) {
          var err = new Error((json && json.error) || body || res.status);
          err.statusCode = res.status;
          throw err;
        }
        return json;
      });
    }).then(function (json) {
      var data = json.data || json;
      state.items = (data && data.items) || [];
      state.loaded = true;
      console.log('[search-history][debug] client loaded', {
        count: state.items.length,
        degraded: Boolean(data && data.degraded),
        teacherEmail: data && data.teacher && data.teacher.email,
        teacherId: data && data.teacher && data.teacher.id,
      });
    }).catch(function (err) {
      var authFailure = err && (err.statusCode === 401 || err.statusCode === 403);
      var aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
      if (authFailure) {
        state.items = [];
        state.loaded = false;
      } else {
        state.items = [];
        state.loaded = true;
        console.warn('[search-history] load failed:', err && err.message ? err.message : err);
        var tbody = document.getElementById('search-history-table-body');
        if (tbody && state.viewOpen) {
          tbody.innerHTML = '<tr><td colspan="4" class="search-history-table-empty search-history-table-empty--err">' +
            deps.escapeHtml((err && err.message) || deps.t('search_history_error')) + '</td></tr>';
        }
      }
      if (aborted) {
        console.warn('[search-history] load timed out');
      }
    }).finally(function () {
      if (timeoutId) clearTimeout(timeoutId);
      state.loading = false;
      if (state.viewOpen) renderTable();
    });
  }

  function refresh() {
    var wasOpen = state.viewOpen;
    var overlay = document.getElementById('search-history-overlay');
    if (overlay) overlay.remove();
    state.viewOpen = false;
    renderEntryButton();
    bindGlobalEvents();
    if (canLoadHistory()) loadHistory(true);
    if (wasOpen) openView();
  }

  function invalidate() {
    state.loaded = false;
    if (!canLoadHistory()) {
      state.items = [];
      if (state.viewOpen) renderTable();
      return;
    }
    loadHistory(true);
  }

  function init(options) {
    Object.assign(deps, options || {});
    renderEntryButton();
    bindGlobalEvents();
    if (canLoadHistory()) loadHistory(false);
  }

  global.WaldorfSearchHistory = {
    init: init,
    refresh: refresh,
    invalidate: invalidate,
    loadHistory: loadHistory,
    getItems: function () { return state.items.slice(); },
    openItem: openHistoryItem,
    openView: openView,
    closeView: closeView,
  };
})(typeof window !== 'undefined' ? window : globalThis);
