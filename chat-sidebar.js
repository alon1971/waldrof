/**
 * chat-sidebar.js — Collapsible lesson-plan chat assistant with research context.
 */
(function (global) {
  'use strict';

  var state = {
    messages: [],
    open: true,
    loading: false,
    sessionKey: '',
  };

  var deps = {
    t: function (k) { return k; },
    isEnglish: function () { return false; },
    getAppState: function () { return {}; },
    sendResearch: null,
    escapeHtml: function (s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  };

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
    var list = document.getElementById('lesson-chat-messages');
    if (!list) return;
    if (!state.messages.length) {
      list.innerHTML = '<p class="lesson-chat-empty">' + deps.escapeHtml(deps.t('chat_empty_hint')) + '</p>';
      return;
    }
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

    var app = deps.getAppState();
    if (!app || !app.aiGeneratedPlan) return;

    state.messages.push({ role: 'user', text: text });
    input.value = '';
    renderMessages();
    setLoading(true);

    var payload = {
      phase: 'chat_followup',
      userMessage: text,
      researchContext: buildResearchContext(app),
      currentGrade: app.grade,
      gradeId: app.grade,
      gradeLabel: app.gradeLabel,
      topic: app.topic,
      age: app.gradeAge,
      chatHistory: state.messages.slice(-8).map(function (m) {
        return { role: m.role, content: m.text || stripHtml(m.html) };
      }),
    };

    deps.sendResearch(payload).then(function (result) {
      var reply = (result && result.chatReply) || {};
      var answer = reply.answer || reply.answerHtml || '';
      var fromCache = Boolean(result && result._fromCache);
      if (!answer) throw new Error(deps.t('chat_error_empty'));
      state.messages.push({
        role: 'assistant',
        text: stripHtml(answer) || answer,
        html: reply.answerHtml || null,
        fromCache: fromCache,
      });
      renderMessages();
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

  function updateFabVisibility() {
    var fab = document.getElementById('lesson-chat-fab');
    var sidebar = document.getElementById('lesson-chat-sidebar');
    if (!fab || !sidebar) return;
    var app = deps.getAppState();
    var showFab = Boolean(
      app && app.aiGeneratedPlan && app.navSection === 'products' &&
      (sidebar.classList.contains('hidden') || sidebar.classList.contains('lesson-chat-sidebar--collapsed'))
    );
    fab.classList.toggle('hidden', !showFab);
    fab.classList.toggle('lesson-chat-fab--visible', showFab);
  }

  function toggleOpen() {
    state.open = !state.open;
    var sidebar = document.getElementById('lesson-chat-sidebar');
    if (sidebar) sidebar.classList.toggle('lesson-chat-sidebar--collapsed', !state.open);
    var toggle = document.getElementById('lesson-chat-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    updateFabVisibility();
  }

  function updateVisibility() {
    var sidebar = document.getElementById('lesson-chat-sidebar');
    var app = deps.getAppState();
    var productsShell = document.getElementById('product-panels-shell');
    var show = Boolean(
      app && app.aiGeneratedPlan &&
      productsShell && !productsShell.hidden &&
      app.navSection === 'products'
    );
    if (sidebar) {
      sidebar.classList.toggle('hidden', !show);
      if (show && state.open) sidebar.classList.remove('lesson-chat-sidebar--collapsed');
    }
    if (show) {
      var key = sessionKeyFromApp(app);
      if (key !== state.sessionKey) {
        state.sessionKey = key;
        state.messages = [];
        renderMessages();
      }
    }
    updateFabVisibility();
  }

  function bindUi() {
    var toggle = document.getElementById('lesson-chat-toggle');
    var closeBtn = document.getElementById('lesson-chat-close');
    var sendBtn = document.getElementById('lesson-chat-send');
    var input = document.getElementById('lesson-chat-input');
    var openFab = document.getElementById('lesson-chat-fab');

    if (toggle) toggle.addEventListener('click', toggleOpen);
    if (closeBtn) closeBtn.addEventListener('click', toggleOpen);
    if (openFab) openFab.addEventListener('click', function () {
      state.open = true;
      var sidebar = document.getElementById('lesson-chat-sidebar');
      if (sidebar) sidebar.classList.remove('lesson-chat-sidebar--collapsed');
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

  function init(options) {
    options = options || {};
    if (typeof options.t === 'function') deps.t = options.t;
    if (typeof options.isEnglish === 'function') deps.isEnglish = options.isEnglish;
    if (typeof options.getAppState === 'function') deps.getAppState = options.getAppState;
    if (typeof options.sendResearch === 'function') deps.sendResearch = options.sendResearch;
    if (typeof options.escapeHtml === 'function') deps.escapeHtml = options.escapeHtml;
    bindUi();
    updateVisibility();
    renderMessages();
  }

  global.LessonChatSidebar = {
    init: init,
    updateVisibility: updateVisibility,
    buildResearchContext: buildResearchContext,
    reset: function () {
      state.messages = [];
      state.sessionKey = '';
      renderMessages();
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
