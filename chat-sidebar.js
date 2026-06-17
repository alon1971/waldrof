/**
 * chat-sidebar.js — Permanent left pedagogy chat assistant.
 */
(function (global) {
  'use strict';

  var state = {
    messages: [],
    isOpen: false,
    loading: false,
    sessionKey: '',
    ragContext: '',
    ragChunkIds: [],
  };

  var CHAT_GREETING_FALLBACK_HE = 'שלום! ברוכים הבאים למתכנן הפדגוגי.';
  var chatInitialized = false;

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
          if (sec && sec._chatAmendments) return;
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

  function renderMessages() {
    ensureWelcomeMessage();
    var list = document.getElementById('lesson-chat-messages');
    if (!list) return;

    list.innerHTML = state.messages.map(function (msg) {
      var roleClass = msg.role === 'user' ? 'lesson-chat-bubble--user' : 'lesson-chat-bubble--assistant';
      var cacheTag = msg.fromCache
        ? '<span class="lesson-chat-cache-tag" title="' + deps.escapeHtml(deps.t('chat_cache_hit')) + '"><i class="fa-solid fa-bolt"></i></span>'
        : '';
      var body = msg.role === 'assistant' && msg.html
        ? '<div class="lesson-chat-bubble-body prose-ai">' + msg.html + '</div>'
        : '<div class="lesson-chat-bubble-body">' + deps.escapeHtml(msg.text) + '</div>';
      return (
        '<div class="lesson-chat-bubble ' + roleClass + '">' + cacheTag + body + '</div>'
      );
    }).join('');
    list.scrollTop = list.scrollHeight;
    syncExportBarVisibility();
  }

  function ensureChatExportBar() {
    var panel = document.querySelector('.lesson-chat-panel');
    var messages = document.getElementById('lesson-chat-messages');
    if (!panel || !messages) return null;

    var bar = document.getElementById('lesson-chat-export-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'lesson-chat-export-bar';
      bar.className = 'lesson-chat-export-bar hidden';
      bar.setAttribute('dir', 'rtl');
      bar.innerHTML =
        '<button type="button" id="lesson-chat-export-word" class="lesson-chat-export-btn" dir="rtl">' +
        '<i class="fa-solid fa-file-word" aria-hidden="true"></i>' +
        '<span class="lesson-chat-export-label"></span>' +
        '</button>';
      var status = document.getElementById('lesson-chat-status');
      if (status && status.parentNode === panel) {
        panel.insertBefore(bar, status);
      } else {
        panel.insertBefore(bar, messages.nextSibling);
      }
    }

    var label = bar.querySelector('.lesson-chat-export-label');
    if (label) {
      label.textContent = deps.t('chat_download_word');
      if (label.textContent === 'chat_download_word') label.textContent = 'הורד למסמך וורד';
    }

    var btn = document.getElementById('lesson-chat-export-word');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        if (typeof deps.downloadPedagogyDocx === 'function') {
          deps.downloadPedagogyDocx();
        }
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
    bar.classList.toggle('hidden', !canExport);
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
    if (!input || state.loading) return;
    var text = input.value.trim();
    if (!text) return;
    if (typeof deps.sendResearch !== 'function') return;

    var app = deps.getAppState() || {};

    if (hasOnlyGreeting()) {
      state.messages = [];
    }

    state.messages.push({ role: 'user', text: text });
    input.value = '';
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

  function syncOpenUi() {
    var sidebar = document.getElementById('lesson-chat-sidebar');
    var fabWrap = document.getElementById('lesson-chat-fab-wrap');
    var toggle = document.getElementById('lesson-chat-toggle');
    if (sidebar) {
      sidebar.classList.toggle('lesson-chat-sidebar--collapsed', !state.isOpen);
      sidebar.classList.toggle('hidden', !state.isOpen);
    }
    if (fabWrap) {
      fabWrap.classList.toggle('hidden', state.isOpen);
      fabWrap.setAttribute('aria-hidden', state.isOpen ? 'true' : 'false');
    }
    if (toggle) toggle.setAttribute('aria-expanded', state.isOpen ? 'true' : 'false');
    syncExportBarVisibility();
  }

  function toggleOpen() {
    state.isOpen = !state.isOpen;
    syncOpenUi();
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
    syncOpenUi();
    var app = deps.getAppState();
    syncSessionFromApp(app);
    syncExportBarVisibility();
  }

  function bindUi() {
    ensureChatExportBar();
    var toggle = document.getElementById('lesson-chat-toggle');
    var closeBtn = document.getElementById('lesson-chat-close');
    var sendBtn = document.getElementById('lesson-chat-send');
    var input = document.getElementById('lesson-chat-input');
    var fab = document.getElementById('lesson-chat-fab');

    if (toggle) toggle.addEventListener('click', toggleOpen);
    if (closeBtn) closeBtn.addEventListener('click', toggleOpen);
    if (fab) fab.addEventListener('click', function () {
      if (!state.isOpen) {
        state.isOpen = true;
        syncOpenUi();
      }
    });
    if (sendBtn) sendBtn.addEventListener('click', sendMessage);
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }
  }

  function restoreSession(options) {
    options = options || {};
    var restored = normalizeMessages(options.messages || []);
    state.messages = restored.length ? restored : [buildGreetingMessage()];
    state.sessionKey = options.sessionKey || '';
    state.ragContext = options.ragContext || '';
    state.ragChunkIds = Array.isArray(options.ragChunkIds) ? options.ragChunkIds.slice() : [];
    state.isOpen = true;
    syncOpenUi();
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
    openForLesson: function (resetChat) {
      state.isOpen = true;
      syncOpenUi();
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
      renderMessages();
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
