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
    pendingArchiveSuggestion: null,
  };

  var CHAT_GREETING_FALLBACK_HE = 'שלום! ברוכים הבאים למתכנן הפדגוגי.';
  var chatInitialized = false;
  var BODY_MODE_CLASSES = ['lesson-chat-mode-bubble', 'lesson-chat-mode-panel', 'lesson-chat-mode-fullscreen'];
  var MOBILE_CHAT_MQ = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(max-width: 767px)')
    : null;

  function isMobileViewport() {
    return MOBILE_CHAT_MQ ? MOBILE_CHAT_MQ.matches : false;
  }

  function openChatModeForViewport() {
    return isMobileViewport() ? 'fullscreen' : 'panel';
  }

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
    focusMainTopicInput: null,
    resetTopicResearchLoading: null,
    openCommunityCatalog: null,
    renderCommunityAlert: null,
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

  function hasUnresolvedArchiveSuggestion() {
    if (state.pendingArchiveSuggestion && !state.pendingArchiveSuggestion.resolved) return true;
    return state.messages.some(function (m) {
      return m && m.archiveSuggest && !m.archiveSuggestResolved;
    });
  }

  function ensureWelcomeMessage() {
    if (hasUnresolvedArchiveSuggestion()) return;
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
    var body;
    if (msg.archiveSuggest && !msg.archiveSuggestResolved) {
      body = '<div class="lesson-chat-bubble-body">' +
        deps.escapeHtml(msg.text) +
        '<div class="lesson-chat-suggest-actions">' +
          '<button type="button" class="lesson-chat-suggest-btn lesson-chat-suggest-btn--yes" data-archive-suggest="yes">' +
            deps.escapeHtml(deps.t('archive_suggest_yes')) +
          '</button>' +
          '<button type="button" class="lesson-chat-suggest-btn lesson-chat-suggest-btn--no" data-archive-suggest="no">' +
            deps.escapeHtml(deps.t('archive_suggest_no')) +
          '</button>' +
        '</div>' +
      '</div>';
    } else if (msg.role === 'assistant' && msg.html) {
      body = '<div class="lesson-chat-bubble-body prose-ai">' + msg.html + '</div>';
    } else {
      var preClass = msg.preserveLineBreaks ? ' lesson-chat-bubble-body--pre' : '';
      body = '<div class="lesson-chat-bubble-body' + preClass + '">' + deps.escapeHtml(msg.text) + '</div>';
    }
    return '<div class="lesson-chat-bubble ' + roleClass + '"' +
      (msg.archiveSuggestId ? ' data-archive-suggest-id="' + deps.escapeHtml(msg.archiveSuggestId) + '"' : '') +
      '>' + cacheTag + body + '</div>';
  }

  function bindArchiveSuggestClicks(list) {
    if (!list || list.dataset.archiveSuggestBound) return;
    list.dataset.archiveSuggestBound = '1';
    list.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-archive-suggest]') : null;
      if (!btn || btn.disabled) return;
      var action = btn.getAttribute('data-archive-suggest');
      var bubble = btn.closest('[data-archive-suggest-id]');
      if (!bubble) return;
      var suggestId = bubble.getAttribute('data-archive-suggest-id');
      var pending = state.pendingArchiveSuggestion;
      if (!pending || pending.id !== suggestId || pending.resolved) return;
      pending.resolved = true;
      state.messages.forEach(function (m) {
        if (m.archiveSuggestId === suggestId) m.archiveSuggestResolved = true;
      });
      renderMessages();
      if (action === 'yes' && typeof pending.onConfirm === 'function') {
        pending.onConfirm(pending);
      } else if (action === 'no') {
        setLoading(false);
        var rejectHandler = pending.onReject;
        pending.onConfirm = null;
        pending.onReject = null;
        state.pendingArchiveSuggestion = null;
        if (typeof rejectHandler === 'function') {
          rejectHandler(pending);
        } else {
          showArchiveRefineHint();
        }
        return;
      }
      state.pendingArchiveSuggestion = null;
    });
  }

  function showArchiveTopicSuggestion(options) {
    options = options || {};
    var suggestedTopic = String(options.suggestedTopic || '').trim();
    var cacheKey = String(options.cacheKey || '').trim();
    if (!suggestedTopic || !cacheKey) return;

    setDisplayMode(openChatModeForViewport());

    var suggestId = 'archive-' + Date.now();
    state.pendingArchiveSuggestion = {
      id: suggestId,
      cacheKey: cacheKey,
      suggestedTopic: suggestedTopic,
      query: options.query || '',
      resolved: false,
      onConfirm: options.onConfirm || null,
      onReject: options.onReject || null,
    };

    state.messages = [{
      role: 'assistant',
      text: deps.t('archive_suggest_prompt', { topic: suggestedTopic }),
      archiveSuggest: true,
      archiveSuggestId: suggestId,
      archiveSuggestResolved: false,
      fromCache: true,
    }];
    renderMessages();

    var list = document.getElementById('lesson-chat-messages');
    bindArchiveSuggestClicks(list);
    var fsBody = document.getElementById('lesson-chat-fullscreen-body');
    if (fsBody) {
      var fsThread = fsBody.querySelector('.lesson-chat-fullscreen-thread');
      bindArchiveSuggestClicks(fsThread || fsBody);
    }
  }

  function clearArchiveSuggestionState() {
    if (state.pendingArchiveSuggestion) {
      state.pendingArchiveSuggestion.resolved = true;
      state.pendingArchiveSuggestion.onConfirm = null;
      state.pendingArchiveSuggestion.onReject = null;
      state.pendingArchiveSuggestion = null;
    }
    state.messages.forEach(function (m) {
      if (m && m.archiveSuggest && !m.archiveSuggestResolved) {
        m.archiveSuggestResolved = true;
      }
    });
  }

  function showArchiveRefineHint(options) {
    options = options || {};
    setLoading(false);
    if (typeof deps.resetTopicResearchLoading === 'function') {
      deps.resetTopicResearchLoading();
    }
    if (state.displayMode === 'bubble') {
      setDisplayMode(openChatModeForViewport());
    }
    state.messages.push({
      role: 'assistant',
      text: deps.t('archive_suggest_refine'),
      preserveLineBreaks: true,
    });
    renderMessages();
    if (typeof options.onAfterShow === 'function') {
      options.onAfterShow();
    } else if (typeof deps.focusMainTopicInput === 'function') {
      deps.focusMainTopicInput();
    }
  }

  function renderMessages() {
    ensureWelcomeMessage();
    var list = document.getElementById('lesson-chat-messages');
    if (!list) return;

    list.innerHTML = state.messages.map(renderMessageBubble).join('');
    list.scrollTop = list.scrollHeight;
    syncExportBarVisibility();
    if (state.displayMode === 'fullscreen') {
      renderFullscreenContent();
      syncExportBarVisibility();
    }
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

  function historyListTargets() {
    return [
      document.getElementById('lesson-chat-history-list'),
      document.getElementById('lesson-chat-fullscreen-history-list'),
    ].filter(Boolean);
  }

  function setHistoryListHtml(html) {
    historyListTargets().forEach(function (list) { list.innerHTML = html; });
  }

  function syncFabReportLayout() {
    var panel = document.getElementById('grade-insights-panel');
    var inReport = !!(panel && !panel.classList.contains('hidden'));
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('grade-report-visible', inReport);
    }
  }

  function historyItemKey(item) {
    return String(item.cacheKey || '') + '|' + String(item.createdAt || item.question || '');
  }

  function normalizeChatHistoryItems(items) {
    return (items || []).map(function (item) {
      return {
        cacheKey: item.cacheKey,
        historyKey: historyItemKey(item),
        gradeLabel: item.gradeLabel,
        topic: item.topic,
        question: item.question || deps.t('chat_history_untitled'),
        createdAt: item.createdAt,
        answerPreview: String(item.answerPreview || '').slice(0, 280),
        answerHtml: item.answerHtml || null,
      };
    });
  }

  function renderHistoryList() {
    if (!historyListTargets().length) return;

    if (state.historyLoading) {
      setHistoryListHtml('<p class="lesson-chat-history-status">' + deps.escapeHtml(deps.t('chat_history_loading')) + '</p>');
      return;
    }

    if (!deps.isAuthenticated()) {
      setHistoryListHtml('<p class="lesson-chat-history-status">' + deps.escapeHtml(deps.t('chat_history_signin')) + '</p>');
      return;
    }

    if (!state.historyItems.length) {
      setHistoryListHtml('<p class="lesson-chat-history-status">' + deps.escapeHtml(deps.t('chat_history_empty')) + '</p>');
      return;
    }

    setHistoryListHtml(state.historyItems.map(function (item) {
      var itemKey = item.historyKey || historyItemKey(item);
      var expanded = state.historyExpandedKey === itemKey;
      var meta = [];
      if (item.gradeLabel) meta.push(item.gradeLabel);
      if (item.topic) meta.push(item.topic);
      var answerBlock = '';
      if (expanded) {
        if (item.answerHtml) {
          answerBlock = '<div class="lesson-chat-history-answer prose-ai">' + item.answerHtml + '</div>';
        } else if (item.answerPreview) {
          answerBlock = '<p class="lesson-chat-history-answer">' + deps.escapeHtml(item.answerPreview) + '</p>';
        }
      }
      return (
        '<button type="button" class="lesson-chat-history-item' + (expanded ? ' lesson-chat-history-item--open' : '') + '" data-history-key="' + deps.escapeHtml(itemKey) + '">' +
        '<span class="lesson-chat-history-item-q">' + deps.escapeHtml(item.question || '') + '</span>' +
        '<span class="lesson-chat-history-item-meta">' + deps.escapeHtml(formatHistoryDate(item.createdAt)) +
        (meta.length ? ' · ' + deps.escapeHtml(meta.join(' · ')) : '') + '</span>' +
        answerBlock +
        '</button>'
      );
    }).join(''));
  }

  function fetchTeacherChatHistoryItems() {
    var headers = { 'Content-Type': 'application/json' };
    var tokenPromise = typeof deps.getAccessToken === 'function'
      ? Promise.resolve(deps.getAccessToken())
      : Promise.resolve(null);

    return tokenPromise.then(function (token) {
      if (token) headers.Authorization = 'Bearer ' + token;
      var body = { action: 'list_chat', limit: 40 };
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
        return normalizeChatHistoryItems(Array.isArray(data.items) ? data.items : []);
      });
    });
  }

  function loadChatHistory() {
    state.historyLoading = true;
    renderHistoryList();

    fetchTeacherChatHistoryItems().then(function (items) {
      state.historyItems = items;
    }).catch(function () {
      state.historyItems = [];
      setHistoryListHtml('<p class="lesson-chat-history-status lesson-chat-history-status--err">' +
        deps.escapeHtml(deps.t('chat_history_error')) + '</p>');
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

  function formatAssistantTextForWord(text) {
    var escaped = deps.escapeHtml(text || '');
    return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  function buildChatWordHtml(messages) {
    var en = deps.isEnglish();
    var dir = en ? 'ltr' : 'rtl';
    var align = en ? 'left' : 'right';
    var title = en ? 'Chat transcript — Pedagogy assistant' : 'תיעוד שיחה - עוזר פדגוגי';
    var userLabel = en ? 'Question: ' : 'שאלה: ';
    var answerLabel = en ? 'Answer:' : 'תשובה:';
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="utf-8"><style>' +
      'body { font-family: "Segoe UI", "Arial", "David", sans-serif; direction: ' + dir + '; text-align: ' + align + '; line-height: 1.6; padding: 20px; }' +
      '.user-box { background-color: #f3f4f6; padding: 10px; margin-bottom: 10px; border-' + (en ? 'left' : 'right') + ': 4px solid #3b82f6; font-weight: bold; }' +
      '.assistant-box { padding: 10px; margin-bottom: 20px; border-' + (en ? 'left' : 'right') + ': 4px solid #10b981; white-space: pre-wrap; }' +
      'h2 { color: #1f2937; border-bottom: 2px solid #e5e7eb; padding-bottom: 5px; }' +
      '</style></head><body>' +
      '<h2>' + deps.escapeHtml(title) + '</h2>';

    messages.forEach(function (m) {
      if (m.role === 'user') {
        html += '<div class="user-box">' + userLabel + deps.escapeHtml(m.text || '') + '</div>';
      } else {
        var body = m.html
          ? m.html
          : formatAssistantTextForWord(m.text || '');
        html += '<div class="assistant-box"><strong>' + answerLabel + '</strong><br>' + body + '</div>';
      }
    });

    html += '</body></html>';
    return html;
  }

  function downloadChatMessagesDoc() {
    var persistable = getPersistableMessages();
    if (!persistable.length) {
      alert(deps.isEnglish() ? 'No chat content to download' : 'אין תוכן בצ\'אט להורדה');
      return;
    }
    var htmlContent = buildChatWordHtml(persistable);
    var blob = new Blob(['\ufeff' + htmlContent], { type: 'application/msword;charset=utf-8' });
    var link = document.createElement('a');
    var url = URL.createObjectURL(blob);
    link.href = url;
    link.download = deps.isEnglish() ? 'pedagogy_chat.doc' : 'שיחה_עוזר_פדגוגי.doc';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function bindChatExportButton(btn) {
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', downloadChatMessagesDoc);
  }

  function resetChatConversation() {
    var confirmMsg = deps.isEnglish()
      ? 'Reset the chat conversation?'
      : 'האם ברצונך לאפס את שיחת הצ\'אט?';
    if (!window.confirm(confirmMsg)) return;
    clearArchiveSuggestionState();
    state.messages = [buildGreetingMessage()];
    state.ragContext = '';
    state.ragChunkIds = [];
    try { localStorage.removeItem('chat_history'); } catch (e) { /* ignore */ }
    renderMessages();
    if (typeof deps.onChatStateSync === 'function') {
      deps.onChatStateSync({ messages: [], lastReply: null });
    }
  }

  function syncChatExportLabel(btn) {
    if (!btn) return;
    var label = btn.querySelector('.lesson-chat-export-label');
    if (!label) return;
    label.textContent = deps.t('chat_download_word');
    if (label.textContent === 'chat_download_word') label.textContent = 'הורד למסמך וורד';
  }

  function ensureFullscreenExportBar() {
    var fsBar = document.getElementById('lesson-chat-fullscreen-export-bar');
    if (fsBar) return fsBar;

    var footer = document.querySelector('.lesson-chat-fullscreen-footer');
    var stack = footer && footer.closest('.lesson-chat-panel-footer-stack');
    if (!stack && footer) {
      stack = document.createElement('div');
      stack.className = 'lesson-chat-panel-footer-stack';
      footer.parentNode.insertBefore(stack, footer);
      stack.appendChild(footer);
    }
    if (!stack) return null;

    fsBar = document.createElement('div');
    fsBar.id = 'lesson-chat-fullscreen-export-bar';
    fsBar.className = 'lesson-chat-export-bar hidden';
    fsBar.setAttribute('dir', 'rtl');
    fsBar.innerHTML =
      '<button type="button" id="lesson-chat-fullscreen-export-word" class="lesson-chat-export-btn" dir="rtl">' +
        '<i class="fa-solid fa-file-word" aria-hidden="true"></i>' +
        '<span class="lesson-chat-export-label">' + deps.escapeHtml(deps.t('chat_download_word')) + '</span>' +
      '</button>';
    stack.insertBefore(fsBar, stack.firstChild);
    return fsBar;
  }

  function ensureChatExportBar() {
    ensureFullscreenExportBar();
    var panelBar = document.getElementById('lesson-chat-export-bar');
    var fsBar = document.getElementById('lesson-chat-fullscreen-export-bar');
    syncChatExportLabel(document.getElementById('lesson-chat-export-word'));
    syncChatExportLabel(document.getElementById('lesson-chat-fullscreen-export-word'));
    bindChatExportButton(document.getElementById('lesson-chat-export-word'));
    bindChatExportButton(document.getElementById('lesson-chat-fullscreen-export-word'));
    return { panelBar: panelBar, fsBar: fsBar };
  }

  function syncExportBarVisibility() {
    var bars = ensureChatExportBar();
    var hasChatContent = getPersistableMessages().length > 0;
    if (bars.panelBar) {
      bars.panelBar.classList.toggle('hidden', !hasChatContent || state.displayMode !== 'panel');
    }
    if (bars.fsBar) {
      bars.fsBar.classList.toggle('hidden', !hasChatContent || state.displayMode !== 'fullscreen');
    }
  }

  function ensureSessionKey() {
    var app = deps.getAppState() || {};
    var key = sessionKeyFromApp(app);
    if (key && key !== '|') state.sessionKey = key;
  }

  function syncChatInputs(fromMode, toMode) {
    var input = document.getElementById('lesson-chat-input');
    var fsInput = document.getElementById('lesson-chat-fullscreen-input');
    if (!input || !fsInput) return;
    if (fromMode === 'panel' && toMode === 'fullscreen') {
      fsInput.value = input.value;
    } else if (fromMode === 'fullscreen' && toMode === 'panel') {
      input.value = fsInput.value;
    }
  }

  function setLoading(loading) {
    state.loading = loading;
    var btn = document.getElementById('lesson-chat-send');
    var input = document.getElementById('lesson-chat-input');
    var fsBtn = document.getElementById('lesson-chat-fullscreen-send');
    var fsInput = document.getElementById('lesson-chat-fullscreen-input');
    if (btn) btn.disabled = loading;
    if (input) input.disabled = loading;
    if (fsBtn) fsBtn.disabled = loading;
    if (fsInput) fsInput.disabled = loading;
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

    ensureSessionKey();
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
      var communityMatches = (meta && Array.isArray(meta.communityMatches) && meta.communityMatches.length)
        ? meta.communityMatches
        : (result && Array.isArray(result._communityMatches) ? result._communityMatches : []);
      if (typeof deps.renderCommunityAlert === 'function') {
        deps.renderCommunityAlert(communityMatches);
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
    var prevMode = state.displayMode;
    if (prevMode === 'panel' && mode === 'fullscreen') syncChatInputs('panel', 'fullscreen');
    if (prevMode === 'fullscreen' && mode === 'panel') syncChatInputs('fullscreen', 'panel');
    state.displayMode = mode;
    if (mode === 'bubble') state.historyOpen = false;
    ensureSessionKey();
    var body = document.body;
    if (body) {
      BODY_MODE_CLASSES.forEach(function (cls) { body.classList.remove(cls); });
      body.classList.add('lesson-chat-mode-' + mode);
    }
    syncDisplayUi();
    if (state.historyOpen) renderHistoryList();
    renderMessages();
  }

  function syncDisplayUi() {
    var sidebar = document.getElementById('lesson-chat-sidebar');
    var fabWrap = document.getElementById('lesson-chat-fab-wrap');
    var fullscreen = document.getElementById('lesson-chat-fullscreen');
    var drawer = document.getElementById('lesson-chat-history-drawer');
    var mainView = document.getElementById('lesson-chat-main-view');
    var fsDrawer = document.getElementById('lesson-chat-fullscreen-history-drawer');
    var fsMain = document.getElementById('lesson-chat-fullscreen-main-view');

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
    if (drawer) {
      drawer.classList.toggle('hidden', !state.historyOpen || state.displayMode !== 'panel');
      drawer.setAttribute('aria-hidden', (!state.historyOpen || state.displayMode !== 'panel') ? 'true' : 'false');
    }
    if (mainView) {
      mainView.classList.toggle('hidden', state.historyOpen && state.displayMode === 'panel');
    }
    if (fsDrawer) {
      fsDrawer.classList.toggle('hidden', !state.historyOpen || state.displayMode !== 'fullscreen');
      fsDrawer.setAttribute('aria-hidden', (!state.historyOpen || state.displayMode !== 'fullscreen') ? 'true' : 'false');
    }
    if (fsMain) {
      fsMain.classList.toggle('hidden', state.historyOpen && state.displayMode === 'fullscreen');
    }

    syncExportBarVisibility();
  }

  function syncSessionFromApp(app) {
    if (!app) return;
    if (hasUnresolvedArchiveSuggestion()) return;
    var key = sessionKeyFromApp(app);
    if (!key || key === '|') return;
    if (key === state.sessionKey) return;
    var preserveConversation = !hasOnlyGreeting();
    state.sessionKey = key;
    if (!preserveConversation) {
      state.messages = [buildGreetingMessage()];
      state.ragContext = '';
      state.ragChunkIds = [];
      renderMessages();
    }
  }

  function updateVisibility() {
    syncFabReportLayout();
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
    var mobileCloseBtn = document.getElementById('lesson-chat-fullscreen-mobile-close');
    var refreshBtn = document.getElementById('lesson-chat-refresh-btn');
    var fsRefreshBtn = document.getElementById('lesson-chat-fullscreen-refresh-btn');
    var historyBtn = document.getElementById('lesson-chat-history-btn');
    var fsHistoryBtn = document.getElementById('lesson-chat-fullscreen-history-btn');
    var historyClose = document.getElementById('lesson-chat-history-close');
    var fsHistoryClose = document.getElementById('lesson-chat-fullscreen-history-close');
    var historyList = document.getElementById('lesson-chat-history-list');
    var fsHistoryList = document.getElementById('lesson-chat-fullscreen-history-list');
    var sendBtn = document.getElementById('lesson-chat-send');
    var input = document.getElementById('lesson-chat-input');
    var fsSendBtn = document.getElementById('lesson-chat-fullscreen-send');
    var fsInput = document.getElementById('lesson-chat-fullscreen-input');

    if (fab) fab.addEventListener('click', function () { setDisplayMode(openChatModeForViewport()); });
    if (closeBtn) closeBtn.addEventListener('click', function () { closeHistory(); setDisplayMode('bubble'); });
    if (expandBtn) expandBtn.addEventListener('click', function () { setDisplayMode('fullscreen'); });
    if (collapseBtn) collapseBtn.addEventListener('click', function () { setDisplayMode('panel'); });
    if (mobileCloseBtn) mobileCloseBtn.addEventListener('click', function () { closeHistory(); setDisplayMode('bubble'); });
    if (refreshBtn) refreshBtn.addEventListener('click', resetChatConversation);
    if (fsRefreshBtn) fsRefreshBtn.addEventListener('click', resetChatConversation);
    if (historyBtn) historyBtn.addEventListener('click', function () {
      if (state.historyOpen) closeHistory();
      else openHistory();
    });
    if (fsHistoryBtn) fsHistoryBtn.addEventListener('click', function () {
      if (state.historyOpen) closeHistory();
      else openHistory();
    });
    if (historyClose) historyClose.addEventListener('click', closeHistory);
    if (fsHistoryClose) fsHistoryClose.addEventListener('click', closeHistory);

    function bindHistoryListClick(list) {
      if (!list || list.dataset.bound) return;
      list.dataset.bound = '1';
      list.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.lesson-chat-history-item') : null;
        if (!btn) return;
        var key = btn.getAttribute('data-history-key') || '';
        state.historyExpandedKey = state.historyExpandedKey === key ? '' : key;
        renderHistoryList();
      });
    }

    bindHistoryListClick(historyList);
    bindHistoryListClick(fsHistoryList);

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

    bindArchiveSuggestClicks(document.getElementById('lesson-chat-messages'));
    var fsBodyInit = document.getElementById('lesson-chat-fullscreen-body');
    if (fsBodyInit) bindArchiveSuggestClicks(fsBodyInit);

    setDisplayMode('bubble');

    if (MOBILE_CHAT_MQ && typeof MOBILE_CHAT_MQ.addEventListener === 'function') {
      MOBILE_CHAT_MQ.addEventListener('change', function () {
        if (isMobileViewport() && state.displayMode === 'panel') {
          setDisplayMode('fullscreen');
        }
      });
    } else if (MOBILE_CHAT_MQ && typeof MOBILE_CHAT_MQ.addListener === 'function') {
      MOBILE_CHAT_MQ.addListener(function () {
        if (isMobileViewport() && state.displayMode === 'panel') {
          setDisplayMode('fullscreen');
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
    renderMessages();
    if (options.openChat === true) {
      setDisplayMode(openChatModeForViewport());
    }
  }

  function refreshWelcome() {
    if (hasUnresolvedArchiveSuggestion()) return;
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
    if (typeof options.focusMainTopicInput === 'function') deps.focusMainTopicInput = options.focusMainTopicInput;
    if (typeof options.resetTopicResearchLoading === 'function') deps.resetTopicResearchLoading = options.resetTopicResearchLoading;
    if (typeof options.openCommunityCatalog === 'function') deps.openCommunityCatalog = options.openCommunityCatalog;
    if (typeof options.renderCommunityAlert === 'function') deps.renderCommunityAlert = options.renderCommunityAlert;
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
    syncFabReportLayout: syncFabReportLayout,
    setDisplayMode: setDisplayMode,
    getDisplayMode: function () { return state.displayMode; },
    isHistoryOpen: function () { return state.historyOpen; },
    openForLesson: function (resetChat) {
      if (resetChat && !hasUnresolvedArchiveSuggestion()) {
        var app = deps.getAppState() || {};
        state.sessionKey = sessionKeyFromApp(app);
        state.messages = [buildGreetingMessage()];
        state.ragContext = '';
        state.ragChunkIds = [];
        state.pendingArchiveSuggestion = null;
        renderMessages();
      }
      updateVisibility();
    },
    hasPendingArchiveSuggestion: hasUnresolvedArchiveSuggestion,
    clearArchiveSuggestionState: clearArchiveSuggestionState,
    showArchiveTopicSuggestion: showArchiveTopicSuggestion,
    showArchiveRefineHint: showArchiveRefineHint,
    reset: function () {
      clearArchiveSuggestionState();
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
