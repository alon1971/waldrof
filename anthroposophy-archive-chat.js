/**
 * anthroposophy-archive-chat.js
 * Isolated UI + client for "שאלות כלליות מתוך מאגרים אנתרופוסופיים בלבד".
 * Does not touch lesson chat, general search, community catalog, or Word export.
 */
(function (global) {
  'use strict';

  var state = {
    open: false,
    loading: false,
    messages: [],
    eventsBound: false,
  };

  var deps = {
    apiBase: '',
  };

  function apiUrl() {
    var base = String(deps.apiBase || '').replace(/\/$/, '');
    if (base) return base + '/api/anthroposophy-archive-chat';
    if (typeof location !== 'undefined' && location.origin && location.protocol !== 'file:') {
      return location.origin + '/api/anthroposophy-archive-chat';
    }
    return '/api/anthroposophy-archive-chat';
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function linkifyText(text) {
    var escaped = escapeHtml(text);
    return escaped.replace(
      /(https?:\/\/[^\s<>"']+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer" class="aac-link">$1</a>'
    );
  }

  function el(id) {
    return document.getElementById(id);
  }

  function setOpen(open) {
    state.open = !!open;
    var modal = el('aac-modal');
    var btn = el('btn-nav-anthroposophy-archive');
    if (!modal) return;
    if (state.open) {
      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('aac-modal-open');
      if (btn) btn.setAttribute('aria-expanded', 'true');
      var input = el('aac-input');
      if (input) {
        setTimeout(function () {
          try {
            input.focus();
          } catch (e) { /* ignore */ }
        }, 50);
      }
    } else {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('aac-modal-open');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  }

  function renderMessages() {
    var list = el('aac-messages');
    if (!list) return;
    if (!state.messages.length) {
      list.innerHTML =
        '<div class="aac-empty" role="status">' +
        '<i class="fa-solid fa-book-open" aria-hidden="true"></i>' +
        '<p>שאלו שאלה כללית — החיפוש יתבצע במאגרים אנתרופוסופיים ובוולדורף בלבד.</p>' +
        '</div>';
      return;
    }
    list.innerHTML = state.messages
      .map(function (m) {
        var roleClass = m.role === 'user' ? 'aac-msg--user' : 'aac-msg--assistant';
        var label = m.role === 'user' ? 'אתם' : 'מאגרים אנתרופוסופיים';
        var body =
          m.role === 'user'
            ? escapeHtml(m.text).replace(/\n/g, '<br>')
            : linkifyText(m.text).replace(/\n/g, '<br>');
        return (
          '<div class="aac-msg ' +
          roleClass +
          '">' +
          '<div class="aac-msg-label">' +
          escapeHtml(label) +
          '</div>' +
          '<div class="aac-msg-body">' +
          body +
          '</div>' +
          '</div>'
        );
      })
      .join('');
    list.scrollTop = list.scrollHeight;
  }

  function setLoading(loading) {
    state.loading = !!loading;
    var sendBtn = el('aac-send');
    var input = el('aac-input');
    var status = el('aac-status');
    if (sendBtn) sendBtn.disabled = state.loading;
    if (input) input.disabled = state.loading;
    if (status) {
      if (state.loading) {
        status.classList.remove('hidden');
        status.textContent = 'מחפש במאגרים אנתרופוסופיים…';
      } else {
        status.classList.add('hidden');
        status.textContent = '';
      }
    }
  }

  function historyPayload() {
    return state.messages.slice(-8).map(function (m) {
      return { role: m.role, content: m.text };
    });
  }

  function sendMessage() {
    if (state.loading) return;
    var input = el('aac-input');
    if (!input) return;
    var text = String(input.value || '').trim();
    if (!text) return;

    state.messages.push({ role: 'user', text: text });
    input.value = '';
    renderMessages();
    setLoading(true);

    fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: historyPayload().slice(0, -1),
      }),
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok, status: res.status, json: json };
        });
      })
      .then(function (result) {
        var json = result.json || {};
        var data = json.data || json;
        var answer =
          (data && data.answer) ||
          (json && json.answer) ||
          '';
        if (!result.ok || !answer) {
          var errMsg =
            (json && json.error) ||
            'לא הצלחנו לקבל תשובה. נסו שוב בעוד רגע.';
          state.messages.push({ role: 'assistant', text: errMsg });
        } else {
          state.messages.push({ role: 'assistant', text: String(answer) });
        }
        renderMessages();
      })
      .catch(function () {
        state.messages.push({
          role: 'assistant',
          text: 'שגיאת רשת. בדקו את החיבור ונסו שוב.',
        });
        renderMessages();
      })
      .then(function () {
        setLoading(false);
        if (input) {
          try {
            input.focus();
          } catch (e) { /* ignore */ }
        }
      });
  }

  function bindEvents() {
    if (state.eventsBound) return;
    state.eventsBound = true;

    var openBtn = el('btn-nav-anthroposophy-archive');
    var closeBtn = el('aac-modal-close');
    var backdrop = el('aac-modal-backdrop');
    var form = el('aac-form');
    var input = el('aac-input');

    if (openBtn) {
      openBtn.addEventListener('click', function (e) {
        e.preventDefault();
        setOpen(true);
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        setOpen(false);
      });
    }
    if (backdrop) {
      backdrop.addEventListener('click', function () {
        setOpen(false);
      });
    }
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        sendMessage();
      });
    }
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) setOpen(false);
    });
  }

  function init(options) {
    if (options && typeof options === 'object') {
      if (options.apiBase != null) deps.apiBase = String(options.apiBase || '');
    }
    bindEvents();
    renderMessages();
  }

  global.WaldorfAnthroposophyArchiveChat = {
    init: init,
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
  };
})(typeof window !== 'undefined' ? window : this);
