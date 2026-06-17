/**
 * chat-sidebar.js — Pedagogy assistant: bubble | side panel | fullscreen.
 */
(function (global) {
  'use strict';

  var state = {
    messages: [],
    displayMode: 'bubble',
    historyOpen: false,
    historyItems: [],
    historyLoading: false,
    historyExpandedKey: '',
    loading: false,
    sessionKey: '',
    ragContext: '',
    ragChunkIds: [],
  };

  var CHAT_GREETING_FALLBACK_HE = 'שלום! ברוכים הבאים למתכנן הפדגוגי.';
  var chatInitialized = false;
  var BODY_MODE_CLASSES = ['lesson-chat-mode-bubble', 'lesson-chat-mode-panel', 'lesson-chat-mode-fullscreen'];

  var deps = {
    t: function (k, vars) {
      if (typeof global.t === 'function') {
        var translated = global.t(k, vars);
        if (translated != null && translated !== '' && translated !== k) return translated;
      }
      if (k === 'chat_greeting') return CHAT_GREETING_FALLBACK_HE;
      return k;
    },
    isEnglish: function () { return false; },
    getAppState: function () { return {}; },
    getGradeAge: function () { return ''; },
    getUserFirstName: function () { return ''; },
    getAccessToken: null,
    getTeacherProfile: null,
    isAuthenticated: function () { return false; },
    sendResearch: null,
    onSessionPersist: null,
    onChatStateSync: null,
    onGradeCacheUpdated: null,
    canExportPedagogyDoc: null,
    downloadPedagogyDocx: null,
    getLessonCacheKey: function () { return ''; },
    escapeHtml: function (s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  };

  function normalizeMessages(messages) {
    return (messages || []).map(function (m) {
      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        text: m.text || m.content || '',
        html: m.html || null,
        fromCache: Boolean(m.fromCache),
        isGreeting: Boolean(m.isGreeting),
      };
    });
  }

  function getUserFirstName() {
    if (typeof deps.getUserFirstName === 'function') {
      var name = String(deps.getUserFirstName() || '').trim();
      if (name) return name;
    }
    return deps.isEnglish() ? 'Alon' : 'אלון';
  }

  function isUnresolvedTranslation(key, value) {
    var text = String(value || '').trim();
    return !text || text === key || text === '{' + key + '}';
  }

  function resolveChatGreetingText() {
    var translated = deps.t('chat_greeting', { name: getUserFirstName() });
    if (isUnresolvedTranslation('chat_greeting', translated)) {
      return CHAT_GREETING_FALLBACK_HE;
    }
    return translated;
  }

  function buildGreetingMessage() {
    return {
      role: 'assistant',
      text: resolveChatGreetingText(),
      isGreeting: true,
    };
  }

  function hasOnlyGreeting() {
    return state.messages.length === 1 && state.messages[0] && state.messages[0].isGreeting;
  }

  function ensureWelcomeMessage() {
    if (!state.messages.length) {
      state.messages = [buildGreetingMessage()];
    } else if (hasOnlyGreeting()) {
      state.messages[0] = buildGreetingMessage();
    }
  }

  function getPersistableMessages() {
    return state.messages.filter(function (m) {
      return m && !m.isGreeting;
    });
  }

  function getLastExchange() {
    var msgs = getPersistableMessages();
    var lastUser = null;
    var lastAssistant = null;
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (!lastAssistant && msgs[i].role === 'assistant') lastAssistant = msgs[i];
      if (!lastUser && msgs[i].role === 'user') lastUser = msgs[i];
      if (lastUser && lastAssistant) break;
    }
    return { user: lastUser, assistant: lastAssistant };
  }

  function persistSession() {
    if (typeof deps.onSessionPersist !== 'function') return;
    var persistable = getPersistableMessages();
    if (!persistable.length) return;
    deps.onSessionPersist({
      messages: persistable,
      ragContext: state.ragContext || '',
      ragChunkIds: state.ragChunkIds || [],
      sessionKey: state.sessionKey || '',
      cacheKey: typeof deps.getLessonCacheKey === 'function' ? deps.getLessonCacheKey() : '',
    });
  }

  function stripHtml(html) {
    var el = document.createElement('div');
    el.innerHTML = html || '';
    return (el.textContent || el.innerText || '').trim();
  }

  function buildResearchContext(app) {
    if (!app) return '';
    var chunks = [];
    if (app.gradeLabel) chunks.push('כיתה: ' + app.gradeLabel);
    if (app.topic) chunks.push('נושא: ' + app.topic);
    if (app.webResearch) {
      if (app.webResearch.summary) chunks.push('סיכום מחקר רשת:\n' + stripHtml(app.webResearch.summary));
      if (app.webResearch.connections && app.webResearch.connections.length) {
        chunks.push('חיבורים לגיל:\n- ' + app.webResearch.connections.join('\n- '));
      }
    }
    if (app.gradeResearch && app.gradeResearch.gradeInsights) {
      var gi = app.gradeResearch.gradeInsights;
      if (gi.part1AgePictureHtml) chunks.push('תמונת גיל:\n' + stripHtml(gi.part1AgePictureHtml));
      if (gi.part2ClassroomIdeasHtml) chunks.push('רעיונות כיתה:\n' + stripHtml(gi.part2ClassroomIdeasHtml));
    }
    var plan = app.aiGeneratedPlan || app.activePlan;
    if (plan) {
      if (plan.theory && plan.theory.sections) {
        plan.theory.sections.forEach(function (sec) {
          if (!sec || sec._chatAmendments) return;
          chunks.push((sec.heading || 'תיאוריה') + ':\n' + stripHtml(sec.content || ''));
        });
      }
      if (plan.inspiration && plan.inspiration.global) {
        plan.inspiration.global.forEach(function (block) {
          chunks.push((block.title || 'השראה') + ': ' + (block.items || []).join(' '));
        });
      }
      if (plan.curriculum && plan.curriculum.length) {
        var days = plan.curriculum.slice(0, 15).map(function (d) {
          return 'יום ' + d.day + ' — ' + (d.topic || '') + ': ' + stripHtml(d.content || '');
        });
        chunks.push('תכנון 15 ימים:\n' + days.join('\n'));
      }
    }
    return chunks.join('\n\n').slice(0, 12000);
  }

  function sessionKeyFromApp(app) {
    return String(app.grade || '') + '|' + String(app.topic || '').trim().toLowerCase();
  }

  function renderMessageBubble(msg) {
    var roleClass = msg.role === 'user' ? 'lesson-chat-bubble--user' : 'lesson-chat-bubble--assistant';
    var cacheTag = msg.fromCache
      ? '<span class="lesson-chat-cache-tag" title="' + deps.escapeHtml(deps.t('chat_cache_hit')) + '"><i class="fa-solid fa-bolt"></i></span>'
      : '';
    var body = msg.role === 'assistant' && msg.html
      ? '<div class="lesson-chat-bubble-body prose-ai">' + msg.html + '</div>'
      : '<div class="lesson-chat-bubble-body">' + deps.escapeHtml(msg.text) + '</div>';
    return '<div class="lesson-chat-bubble ' + roleClass + '">' + cacheTag + body + '</div>';
  }

  function renderMessages() {
    ensureWelcomeMessage();
    var list = document.getElementById('lesson-chat-messages');
    if (!list) return;

    list.innerHTML = state.messages.map(renderMessageBubble).join('');
    list.scrollTop = list.scrollHeight;
    syncExportBarVisibility();
    if (state.displayMode === 'fullscreen') renderFullscreenContent();
  }

  function renderFullscreenContent() {
    var body = document.getElementById('lesson-chat-fullscreen-body');
    if (!body) return;
    ensureWelcomeMessage();
    if (!state.messages.length) {
      body.innerHTML = '<p class="lesson-chat-fullscreen-empty">' + deps.escapeHtml(deps.t('chat_empty_hint')) + '</p>';
      return;
    }
    body.innerHTML = '<div class="lesson-chat-fullscreen-thread">' +
      state.messages.map(renderMessageBubble).join('') +
      '</div>';
    body.scrollTop = body.scrollHeight;
  }

  function formatHistoryDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(deps.isEnglish() ? 'en-GB' : 'he-IL', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch (e) {
      return String(iso).slice(0, 16);
    }
  }

  function renderHistoryList() {
    var list = document.getElementById('lesson-chat-history-list');
    if (!list) return;

    if (state.historyLoading) {
      list.innerHTML = '<p class="lesson-chat-history-status">' + deps.escapeHtml(deps.t('chat_history_loading')) + '</p>';
      return;
    }

    if (!deps.isAuthenticated()) {
      list.innerHTML = '<p class="lesson-chat-history-status">' + deps.escapeHtml(deps.t('chat_history_signin')) + '</p>';
      return;
    }

    if (!state.historyItems.length) {
      list.innerHTML = '<p class="lesson-chat-history-status">' + deps.escapeHtml(deps.t('chat_history_empty')) + '</p>';
      return;
    }

    list.innerHTML = state.historyItems.map(function (item) {
      var expanded = state.historyExpandedKey === item.cacheKey;
      var meta = [];
      if (item.gradeLabel) meta.push(item.gradeLabel);
      if (item.topic) meta.push(item.topic);
      if (item.hitCount > 1) meta.push('×' + item.hitCount);
      var answerBlock = '';
      if (expanded) {
        if (item.answerHtml) {
          answerBlock = '<div class="lesson-chat-history-answer prose-ai">' + item.answerHtml + '</div>';
        } else if (item.answerPreview) {
          answerBlock = '<p class="lesson-chat-history-answer">' + deps.escapeHtml(item.answerPreview) + '</p>';
        }
      }
      return (
        '<button type="button" class="lesson-chat-history-item' + (expanded ? ' lesson-chat-history-item--open' : '') + '" data-cache-key="' + deps.escapeHtml(item.cacheKey) + '">' +
        '<span class="lesson-chat-history-item-q">' + deps.escapeHtml(item.question || '') + '</span>' +
        '<span class="lesson-chat-history-item-meta">' + deps.escapeHtml(formatHistoryDate(item.createdAt)) +
        (meta.length ? ' · ' + deps.escapeHtml(meta.join(' · ')) : '') + '</span>' +
        answerBlock +
        '</button>'
      );
    }).join('');
  }

  function loadChatHistory() {
    state.historyLoading = true;
    renderHistoryList();

    var headers = { 'Content-Type': 'application/json' };
    var tokenPromise = typeof deps.getAccessToken === 'function'
      ? Promise.resolve(deps.getAccessToken())
      : Promise.resolve(null);

    tokenPromise.then(function (token) {
      if (token) headers.Authorization = 'Bearer ' + token;
      var app = deps.getAppState() || {};
      var body = {
        action: 'list_chat',
        gradeId: app.grade || '',
        topic: app.topic || '',
        limit: 30,
      };
      if (typeof deps.getTeacherProfile === 'function') {
        var teacher = deps.getTeacherProfile();
        if (teacher) body.teacherUser = teacher;
      }
      var apiUrl = (typeof location !== 'undefined' && location.origin && location.protocol !== 'file:')
        ? location.origin + '/api/search-history'
        : '/api/search-history';
      return fetch(apiUrl, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok || json.error) throw new Error(json.error || deps.t('chat_history_error'));
        var data = json.data || json;
        state.historyItems = Array.isArray(data.items) ? data.items : [];
      });
    }).catch(function () {
      state.historyItems = [];
      var list = document.getElementById('lesson-chat-history-list');
      if (list) {
        list.innerHTML = '<p class="lesson-chat-history-status lesson-chat-history-status--err">' +
          deps.escapeHtml(deps.t('chat_history_error')) + '</p>';
      }
    }).finally(function () {
      state.historyLoading = false;
      renderHistoryList();
    });
  }

  function openHistory() {
    state.historyOpen = true;
    state.historyExpandedKey = '';
    syncDisplayUi();
    loadChatHistory();
  }

  function closeHistory() {
    state.historyOpen = false;
    state.historyExpandedKey = '';
    syncDisplayUi();
  }

  function ensureChatExportBar() {
    var bar = document.getElementById('lesson-chat-export-bar');
    if (!bar) return null;

    var label = bar.querySelector('.lesson-chat-export-label');
    if (label) {
      label.textContent = deps.t('chat_download_word');
      if (label.textContent === 'chat_download_word') label.textContent = 'הורד למסמך וורד';
    }

    var btn = document.getElementById('lesson-chat-export-word');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        if (typeof deps.downloadPedagogyDocx === 'function') deps.downloadPedagogyDocx();
      });
    }
    return bar;
  }

  function syncExportBarVisibility() {
    var bar = ensureChatExportBar();
    if (!bar) return;
    var canExport = typeof deps.canExportPedagogyDoc === 'function'
      ? Boolean(deps.canExportPedagogyDoc())
      : Boolean((deps.getAppState() || {}).grade);
    bar.classList.toggle('hidden', !canExport || state.displayMode === 'fullscreen');
  }

  function setLoading(loading) {
    state.loading = loading;
    var btn = document.getElementById('lesson-chat-send');
    var input = document.getElementById('lesson-chat-input');
    if (btn) btn.disabled = loading;
    if (input) input.disabled = loading;
    var status = document.getElementById('lesson-chat-status');
    if (status) {
      status.classList.toggle('hidden', !loading);
      status.textContent = loading ? deps.t('chat_thinking') : '';
    }
  }

  function sendMessage() {
    var input = document.getElementById('lesson-chat-input');
    var fsInput = document.getElementById('lesson-chat-fullscreen-input');
    var activeInput = (state.displayMode === 'fullscreen' && fsInput) ? fsInput : input;
    if (!activeInput || state.loading) return;
    var text = activeInput.value.trim();
    if (!text) return;
    if (typeof deps.sendResearch !== 'function') return;

    var app = deps.getAppState() || {};
    if (hasOnlyGreeting()) state.messages = [];

    state.messages.push({ role: 'user', text: text });
    if (input) input.value = '';
    if (fsInput) fsInput.value = '';
    renderMessages();
    setLoading(true);

    var payload = {
      phase: 'chat_followup',
      userMessage: text,
      researchContext: buildResearchContext(app),
      ragContext: state.ragContext || '',
      ragChunkIds: state.ragChunkIds || [],
      currentGrade: app.grade,
      gradeId: app.grade,
      gradeLabel: app.gradeLabel,
      topic: app.topic,
      age: app.gradeAge || deps.getGradeAge() || '',
      chatHistory: getPersistableMessages().slice(-8).map(function (m) {
        return { role: m.role, content: m.text || stripHtml(m.html) };
      }),
    };

    deps.sendResearch(payload).then(function (result) {
      var data = (result && result.chatReply) ? result : (result && result.data) || result || {};
      var reply = data.chatReply || {};
      var answer = reply.answer || stripHtml(reply.answerHtml) || reply.answerHtml || '';
      var fromCache = Boolean(result && result._fromCache);
      var meta = (result && result._meta) || {};
      var enriched = Boolean(meta.priorCacheEnriched || (reply && reply.enrichedFromPrior));
      if (meta.ragContext) state.ragContext = meta.ragContext;
      if (Array.isArray(meta.ragChunkIds)) state.ragChunkIds = meta.ragChunkIds;
      if (!answer) throw new Error(deps.t('chat_error_empty'));
      state.messages.push({
        role: 'assistant',
        text: stripHtml(answer) || answer,
        html: reply.answerHtml || null,
        fromCache: fromCache && !enriched,
        enriched: enriched,
      });
      renderMessages();
      if (typeof deps.onChatStateSync === 'function') {
        deps.onChatStateSync({
          messages: getPersistableMessages(),
          lastReply: state.messages[state.messages.length - 1] || null,
        });
      }
      if (meta.gradeCacheUpdated && typeof deps.onGradeCacheUpdated === 'function') {
        deps.onGradeCacheUpdated({
          gradeInsights: meta.updatedGradeInsights || null,
          cacheKey: meta.gradeCacheKey || '',
        });
      }
      persistSession();
    }).catch(function (err) {
      if (err && err.code === 'RATE_LIMIT') return;
      state.messages.push({
        role: 'assistant',
        text: (err && err.message) || deps.t('chat_error_generic'),
      });
      renderMessages();
    }).finally(function () {
      setLoading(false);
    });
  }

  function setDisplayMode(mode) {
    if (mode !== 'bubble' && mode !== 'panel' && mode !== 'fullscreen') mode = 'bubble';
    state.displayMode = mode;
    if (mode !== 'panel') state.historyOpen = false;
    var body = document.body;
    if (body) {
      BODY_MODE_CLASSES.forEach(function (cls) { body.classList.remove(cls); });
      body.classList.add('lesson-chat-mode-' + mode);
    }
    syncDisplayUi();
  }

  function syncDisplayUi() {
    var sidebar = document.getElementById('lesson-chat-sidebar');
    var fabWrap = document.getElementById('lesson-chat-fab-wrap');
    var fullscreen = document.getElementById('lesson-chat-fullscreen');
    var drawer = document.getElementById('lesson-chat-history-drawer');
    var mainView = document.getElementById('lesson-chat-main-view');

    if (fabWrap) {
      fabWrap.classList.toggle('hidden', state.displayMode !== 'bubble');
      fabWrap.setAttribute('aria-hidden', state.displayMode === 'bubble' ? 'false' : 'true');
    }
    if (sidebar) {
      sidebar.classList.toggle('hidden', state.displayMode !== 'panel');
      sidebar.setAttribute('aria-hidden', state.displayMode === 'panel' ? 'false' : 'true');
    }
    if (fullscreen) {
      fullscreen.classList.toggle('hidden', state.displayMode !== 'fullscreen');
      fullscreen.setAttribute('aria-hidden', state.displayMode === 'fullscreen' ? 'false' : 'true');
    }
    if (drawer) drawer.classList.toggle('hidden', !state.historyOpen);
    if (mainView) mainView.classList.toggle('hidden', state.historyOpen);

    if (state.displayMode === 'fullscreen') renderFullscreenContent();
    syncExportBarVisibility();
  }

  function syncSessionFromApp(app) {
    if (!app) return;
    var key = sessionKeyFromApp(app);
    if (!key || key === '|') return;
    if (key === state.sessionKey) return;
    state.sessionKey = key;
    state.messages = [buildGreetingMessage()];
    state.ragContext = '';
    state.ragChunkIds = [];
    renderMessages();
  }

  function updateVisibility() {
    syncDisplayUi();
    var app = deps.getAppState();
    syncSessionFromApp(app);
    syncExportBarVisibility();
  }

  function bindUi() {
    ensureChatExportBar();

    var fab = document.getElementById('lesson-chat-fab');
    var closeBtn = document.getElementById('lesson-chat-close');
    var expandBtn = document.getElementById('lesson-chat-expand');
    var collapseBtn = document.getElementById('lesson-chat-collapse');
    var historyBtn = document.getElementById('lesson-chat-history-btn');
    var historyClose = document.getElementById('lesson-chat-history-close');
    var historyList = document.getElementById('lesson-chat-history-list');
    var sendBtn = document.getElementById('lesson-chat-send');
    var input = document.getElementById('lesson-chat-input');
    var fsSendBtn = document.getElementById('lesson-chat-fullscreen-send');
    var fsInput = document.getElementById('lesson-chat-fullscreen-input');

    if (fab) fab.addEventListener('click', function () { setDisplayMode('panel'); });
    if (closeBtn) closeBtn.addEventListener('click', function () { closeHistory(); setDisplayMode('bubble'); });
    if (expandBtn) expandBtn.addEventListener('click', function () { closeHistory(); setDisplayMode('fullscreen'); });
    if (collapseBtn) collapseBtn.addEventListener('click', function () { setDisplayMode('panel'); });
    if (historyBtn) historyBtn.addEventListener('click', function () {
      if (state.historyOpen) closeHistory();
      else openHistory();
    });
    if (historyClose) historyClose.addEventListener('click', closeHistory);

    if (historyList && !historyList.dataset.bound) {
      historyList.dataset.bound = '1';
      historyList.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.lesson-chat-history-item') : null;
        if (!btn) return;
        var key = btn.getAttribute('data-cache-key') || '';
        state.historyExpandedKey = state.historyExpandedKey === key ? '' : key;
        renderHistoryList();
      });
    }

    if (sendBtn) sendBtn.addEventListener('click', sendMessage);
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    if (fsSendBtn) fsSendBtn.addEventListener('click', sendMessage);
    if (fsInput) {
      fsInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    setDisplayMode('bubble');
  }

  function restoreSession(options) {
    options = options || {};
    var restored = normalizeMessages(options.messages || []);
    state.messages = restored.length ? restored : [buildGreetingMessage()];
    state.sessionKey = options.sessionKey || '';
    state.ragContext = options.ragContext || '';
    state.ragChunkIds = Array.isArray(options.ragChunkIds) ? options.ragChunkIds.slice() : [];
    setDisplayMode('panel');
    renderMessages();
  }

  function refreshWelcome() {
    if (!state.messages.length || hasOnlyGreeting()) {
      state.messages = [buildGreetingMessage()];
      renderMessages();
    }
  }

  function init(options) {
    options = options || {};
    if (typeof options.t === 'function') deps.t = options.t;
    if (typeof options.isEnglish === 'function') deps.isEnglish = options.isEnglish;
    if (typeof options.getAppState === 'function') deps.getAppState = options.getAppState;
    if (typeof options.getGradeAge === 'function') deps.getGradeAge = options.getGradeAge;
    if (typeof options.getUserFirstName === 'function') deps.getUserFirstName = options.getUserFirstName;
    if (typeof options.getAccessToken === 'function') deps.getAccessToken = options.getAccessToken;
    if (typeof options.getTeacherProfile === 'function') deps.getTeacherProfile = options.getTeacherProfile;
    if (typeof options.isAuthenticated === 'function') deps.isAuthenticated = options.isAuthenticated;
    if (typeof options.sendResearch === 'function') deps.sendResearch = options.sendResearch;
    if (typeof options.onSessionPersist === 'function') deps.onSessionPersist = options.onSessionPersist;
    if (typeof options.onChatStateSync === 'function') deps.onChatStateSync = options.onChatStateSync;
    if (typeof options.onGradeCacheUpdated === 'function') deps.onGradeCacheUpdated = options.onGradeCacheUpdated;
    if (typeof options.canExportPedagogyDoc === 'function') deps.canExportPedagogyDoc = options.canExportPedagogyDoc;
    if (typeof options.downloadPedagogyDocx === 'function') deps.downloadPedagogyDocx = options.downloadPedagogyDocx;
    if (typeof options.getLessonCacheKey === 'function') deps.getLessonCacheKey = options.getLessonCacheKey;
    if (typeof options.escapeHtml === 'function') deps.escapeHtml = options.escapeHtml;
    try {
      bindUi();
      state.messages = [buildGreetingMessage()];
      renderMessages();
      updateVisibility();
      chatInitialized = true;
    } catch (err) {
      console.warn('[LessonChatSidebar] init failed:', err);
      chatInitialized = false;
    }
  }

  global.LessonChatSidebar = {
    init: init,
    isReady: function () { return chatInitialized; },
    updateVisibility: updateVisibility,
    buildResearchContext: buildResearchContext,
    restoreSession: restoreSession,
    persistSession: persistSession,
    getPersistableMessages: getPersistableMessages,
    refreshWelcome: refreshWelcome,
    syncExportBar: syncExportBarVisibility,
    setDisplayMode: setDisplayMode,
    openForLesson: function (resetChat) {
      setDisplayMode('panel');
      if (resetChat) {
        var app = deps.getAppState() || {};
        state.sessionKey = sessionKeyFromApp(app);
        state.messages = [buildGreetingMessage()];
        state.ragContext = '';
        state.ragChunkIds = [];
        renderMessages();
      }
      updateVisibility();
    },
    reset: function () {
      state.messages = [buildGreetingMessage()];
      state.sessionKey = '';
      state.ragContext = '';
      state.ragChunkIds = [];
      closeHistory();
      setDisplayMode('bubble');
      renderMessages();
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
