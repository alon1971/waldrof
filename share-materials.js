/**
 * share-materials.js — Teacher community contribution form (community_knowledge_base).
 */
(function (global) {
  'use strict';

  var deps = {
    t: function (k) { return k; },
    getAppState: function () { return {}; },
    getGrades: function () { return []; },
    getContributor: function () { return null; },
    getAccessToken: function () { return Promise.resolve(null); },
    isAuthenticated: function () { return false; },
    showAuth: function () {},
    escapeHtml: function (s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    apiBase: '',
  };

  function shareApiUrl() {
    var base = String(deps.apiBase || '').replace(/\/$/, '');
    if (base) return base + '/api/share-material';
    if (typeof location !== 'undefined' && location.origin && location.protocol !== 'file:') {
      return location.origin + '/api/share-material';
    }
    return '/api/share-material';
  }

  function renderGradeOptions(selectedId) {
    var grades = deps.getGrades() || [];
    return grades.map(function (g) {
      var sel = g.id === selectedId ? ' selected' : '';
      var ageSuffix = g.age ? ' (' + deps.escapeHtml(deps.t('grade_age_prefix')) + ' ' + deps.escapeHtml(g.age) + ')' : '';
      return '<option value="' + deps.escapeHtml(g.id) + '"' + sel + '>' + deps.escapeHtml(g.label || g.id) + ageSuffix + '</option>';
    }).join('');
  }

  function buildFormHtml() {
    var app = deps.getAppState() || {};
    var contributor = deps.getContributor();
    var contributorLine = contributor && contributor.name
      ? '<p class="share-materials-contributor"><i class="fa-solid fa-user-pen" aria-hidden="true"></i> ' +
        deps.escapeHtml(deps.t('share_contributor_as')) + ' <strong>' + deps.escapeHtml(contributor.name) + '</strong></p>'
      : '';

    return (
      '<section class="share-materials-card" aria-labelledby="share-materials-title">' +
        '<div class="share-materials-header">' +
          '<span class="share-materials-icon" aria-hidden="true">🌱</span>' +
          '<div>' +
            '<h3 id="share-materials-title" class="share-materials-title">' + deps.escapeHtml(deps.t('share_materials_title')) + '</h3>' +
            '<p class="share-materials-lead">' + deps.escapeHtml(deps.t('share_materials_lead')) + '</p>' +
          '</div>' +
        '</div>' +
        contributorLine +
        '<form id="share-materials-form" class="share-materials-form" novalidate>' +
          '<label class="share-materials-label" for="share-material-title">' + deps.escapeHtml(deps.t('share_material_title_label')) + ' <span class="text-terracotta">*</span></label>' +
          '<input id="share-material-title" name="title" type="text" maxlength="120" required class="share-materials-input" placeholder="' + deps.escapeHtml(deps.t('share_material_title_ph')) + '" />' +
          '<div class="share-materials-row">' +
            '<div class="share-materials-field">' +
              '<label class="share-materials-label" for="share-material-grade">' + deps.escapeHtml(deps.t('share_material_grade_label')) + ' <span class="text-terracotta">*</span></label>' +
              '<select id="share-material-grade" name="gradeId" required class="share-materials-input">' +
                '<option value="">' + deps.escapeHtml(deps.t('share_material_grade_ph')) + '</option>' +
                renderGradeOptions(app.grade) +
              '</select>' +
            '</div>' +
            '<div class="share-materials-field">' +
              '<label class="share-materials-label" for="share-material-type">' + deps.escapeHtml(deps.t('share_material_type_label')) + '</label>' +
              '<select id="share-material-type" name="materialType" class="share-materials-input">' +
                '<option value="lesson_plan">' + deps.escapeHtml(deps.t('share_material_type_lesson')) + '</option>' +
                '<option value="main_lesson">' + deps.escapeHtml(deps.t('share_material_type_block')) + '</option>' +
                '<option value="pedagogy_note">' + deps.escapeHtml(deps.t('share_material_type_note')) + '</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<label class="share-materials-label" for="share-material-topic">' + deps.escapeHtml(deps.t('share_material_topic_label')) + ' <span class="text-terracotta">*</span></label>' +
          '<input id="share-material-topic" name="topic" type="text" maxlength="120" required class="share-materials-input" value="' + deps.escapeHtml(app.topic || '') + '" placeholder="' + deps.escapeHtml(deps.t('share_material_topic_ph')) + '" />' +
          '<label class="share-materials-label" for="share-material-text">' + deps.escapeHtml(deps.t('share_material_text_label')) + ' <span class="text-terracotta">*</span></label>' +
          '<textarea id="share-material-text" name="text" rows="8" maxlength="12000" required class="share-materials-textarea" placeholder="' + deps.escapeHtml(deps.t('share_material_text_ph')) + '"></textarea>' +
          '<p class="share-materials-hint">' + deps.escapeHtml(deps.t('share_material_hint')) + '</p>' +
          '<div class="share-materials-actions">' +
            '<button type="submit" id="share-materials-submit" class="share-materials-submit touch-btn">' +
              '<i class="fa-solid fa-heart" aria-hidden="true"></i> ' + deps.escapeHtml(deps.t('share_material_submit')) +
            '</button>' +
          '</div>' +
          '<p id="share-materials-status" class="share-materials-status hidden" role="status"></p>' +
        '</form>' +
      '</section>'
    );
  }

  function setStatus(message, type) {
    var el = document.getElementById('share-materials-status');
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove('hidden', 'share-materials-status--ok', 'share-materials-status--err');
    if (!message) {
      el.classList.add('hidden');
      return;
    }
    el.classList.add(type === 'ok' ? 'share-materials-status--ok' : 'share-materials-status--err');
  }

  function setLoading(loading) {
    var btn = document.getElementById('share-materials-submit');
    var form = document.getElementById('share-materials-form');
    if (btn) {
      btn.disabled = loading;
      btn.innerHTML = loading
        ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ' + deps.escapeHtml(deps.t('share_material_saving'))
        : '<i class="fa-solid fa-heart" aria-hidden="true"></i> ' + deps.escapeHtml(deps.t('share_material_submit'));
    }
    if (form) {
      form.querySelectorAll('input, textarea, select').forEach(function (field) {
        field.disabled = loading;
      });
    }
  }

  function bindForm() {
    var form = document.getElementById('share-materials-form');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!deps.isAuthenticated()) {
        setStatus(deps.t('share_material_need_auth'), 'err');
        deps.showAuth();
        return;
      }

      var title = form.title.value.trim();
      var gradeId = form.gradeId.value.trim();
      var topic = form.topic.value.trim();
      var text = form.text.value.trim();
      var materialType = form.materialType.value;
      var gradeSelect = form.gradeId;
      var gradeLabel = gradeSelect.options[gradeSelect.selectedIndex]
        ? gradeSelect.options[gradeSelect.selectedIndex].text
        : '';

      if (!title || !gradeId || !topic || text.length < 80) {
        setStatus(deps.t('share_material_validation'), 'err');
        return;
      }

      setLoading(true);
      setStatus('', 'ok');

      deps.getAccessToken().then(function (token) {
        var contributor = deps.getContributor();
        var headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;

        return fetch(shareApiUrl(), {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            title: title,
            gradeId: gradeId,
            gradeLabel: gradeLabel,
            topic: topic,
            text: text,
            materialType: materialType,
            contributor: contributor,
          }),
        });
      }).then(function (res) {
        return res.text().then(function (body) {
          var json;
          try { json = body ? JSON.parse(body) : {}; } catch (e) { json = {}; }
          if (!res.ok) throw new Error((json && json.error) || body || res.status);
          return json;
        });
      }).then(function (json) {
        var data = json.data || json;
        var chunks = data.chunks || data.inserted || 0;
        setStatus(deps.t('share_material_success', { count: chunks }), 'ok');
        form.text.value = '';
        if (!form.title.value && title) form.title.value = title;
      }).catch(function (err) {
        setStatus((err && err.message) || deps.t('share_material_error'), 'err');
      }).finally(function () {
        setLoading(false);
      });
    });
  }

  function mount(container) {
    if (!container) return;
    container.innerHTML = buildFormHtml();
    bindForm();
  }

  function refresh() {
    var container = document.getElementById('share-materials-mount');
    if (container) mount(container);
  }

  function init(options) {
    Object.assign(deps, options || {});
    refresh();
  }

  global.WaldorfShareMaterials = {
    init: init,
    refresh: refresh,
    mount: mount,
  };
})(typeof window !== 'undefined' ? window : globalThis);
