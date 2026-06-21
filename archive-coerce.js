/**
 * Archive lesson result_data normalization — shared by api/cache.js (Node) and index.html (browser).
 * Maps legacy field names and extracts curriculum / inspiration from structured JSON or raw text dumps.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var jsonRepair = null;
    try {
      jsonRepair = require('./api/json-repair');
    } catch (e) { /* browser bundle */ }
    module.exports = factory(jsonRepair);
  } else {
    root.WaldorfArchiveCoerce = factory(null);
  }
}(typeof self !== 'undefined' ? self : this, function (jsonRepair) {
  'use strict';

  var CURRICULUM_LIST_KEYS = [
    'curriculum', 'days', 'items', 'lessons', 'dailyPlan', 'daily_plan',
    'rows', 'entries', 'schedule', 'plan', 'periodPlan', 'period_plan',
    'fifteenDayPlan', 'fifteen_day_plan', 'blockCurriculum', 'block_curriculum',
    'curriculumPlan', 'curriculum_plan', 'mainLessonPlan', 'main_lesson_plan',
  ];

  var CURRICULUM_TEXT_KEYS = [
    'curriculum_text', 'curriculumText', 'daily_plan_text', 'dailyPlanText',
    'period_plan_text', 'periodPlanText', 'fifteen_day_text', 'fifteenDayText',
    'block_plan_text', 'blockPlanText',
  ];

  var INSPIRATION_ALIASES = [
    'inspiration', 'inspiration_text', 'inspirationText', 'inspirationContent',
    'inspiration_content', 'creativeInspiration', 'creative_inspiration',
  ];

  var DAY_HEADER_RE = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*{0,2}\s*)?(?:(?:יום|יום\s*מס['\u2019]?|Day|DAY)\s*[#:.\-–—]?\s*)(\d{1,2})\b/gi;
  var NUMBERED_DAY_RE = /(?:^|\n)\s*(\d{1,2})\s*[.):\-–—]\s+/g;

  function tryParseCachedJsonText(text) {
    var trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (jsonRepair) {
      try {
        return jsonRepair.cleanAndParseJSON(trimmed, { fallbackOnError: false, unwrap: false });
      } catch (e) {
        if (typeof jsonRepair.safeParseJson === 'function') {
          return jsonRepair.safeParseJson(trimmed);
        }
      }
    }
    try {
      return JSON.parse(trimmed);
    } catch (e2) {
      return null;
    }
  }

  function tryParseArchiveJsonObject(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (!text || (text.charAt(0) !== '{' && text.charAt(0) !== '[')) return null;
    return tryParseCachedJsonText(text);
  }

  function archiveSectionText(sec) {
    if (!sec) return '';
    if (typeof sec === 'string') return sec.trim();
    return String(
      sec.content || sec.overview || sec.text || sec.body || sec.summary || sec.html || ''
    ).trim();
  }

  function looksLikeCurriculumText(text) {
    var raw = String(text || '');
    if (raw.length < 60) return false;
    if (/(?:יום|Day)\s*\d{1,2}/i.test(raw)) return true;
    if (/\n\s*\d{1,2}\s*[.):\-–—]\s+/m.test(raw)) return true;
    if (/תכנון\s*(?:תקופה|בלוק|15)/i.test(raw)) return true;
    return false;
  }

  function splitCurriculumChunks(raw, markers) {
    var rows = [];
    for (var i = 0; i < markers.length; i++) {
      var start = markers[i].headerEnd;
      var end = i + 1 < markers.length ? markers[i + 1].index : raw.length;
      var chunk = raw.slice(start, end).trim();
      if (!chunk) continue;
      var lines = chunk.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
      var topic = '';
      var content = chunk;
      if (lines.length) {
        topic = lines[0].replace(/^\*+|\*+$/g, '').replace(/^#+\s*/, '').trim();
        if (lines.length > 1) content = lines.slice(1).join('\n').trim();
        else content = '';
      }
      rows.push({
        day: markers[i].day,
        topic: topic || ('יום ' + markers[i].day),
        content: content || chunk,
        art: '',
        hint: '',
      });
    }
    return rows;
  }

  function parseCurriculumFromText(text) {
    var raw = String(text || '').trim();
    if (!raw) return [];

    if (raw.charAt(0) === '[' || raw.charAt(0) === '{') {
      var parsed = tryParseArchiveJsonObject(raw);
      var fromJson = coerceCurriculumRows(parsed);
      if (fromJson.length) return fromJson;
    }

    var markers = [];
    var m;
    var re = new RegExp(DAY_HEADER_RE.source, 'gi');
    while ((m = re.exec(raw)) !== null) {
      var dayNum = parseInt(m[1], 10);
      if (dayNum >= 1 && dayNum <= 20) {
        markers.push({ day: dayNum, index: m.index, headerEnd: m.index + m[0].length });
      }
    }
    if (markers.length >= 2) {
      return splitCurriculumChunks(raw, markers).slice(0, 15);
    }

    markers = [];
    re = new RegExp(NUMBERED_DAY_RE.source, 'g');
    while ((m = re.exec(raw)) !== null) {
      var n = parseInt(m[1], 10);
      if (n >= 1 && n <= 20) {
        markers.push({ day: n, index: m.index, headerEnd: m.index + m[0].length });
      }
    }
    if (markers.length >= 3) {
      return splitCurriculumChunks(raw, markers).slice(0, 15);
    }

    if (raw.length > 200) {
      return [{
        day: 1,
        topic: 'תכנון תקופה',
        content: raw,
        art: '',
        hint: '',
      }];
    }
    return [];
  }

  function coerceCurriculumRows(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') return parseCurriculumFromText(raw);
    if (typeof raw !== 'object') return [];

    var i;
    for (i = 0; i < CURRICULUM_LIST_KEYS.length; i++) {
      if (Array.isArray(raw[CURRICULUM_LIST_KEYS[i]])) return raw[CURRICULUM_LIST_KEYS[i]];
    }

    var numKeys = Object.keys(raw).filter(function (k) { return /^\d+$/.test(String(k)); });
    if (numKeys.length) {
      return numKeys.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); }).map(function (k) {
        var row = raw[k];
        if (row && typeof row === 'object' && row.day == null && row.dayNumber == null) {
          return Object.assign({ day: parseInt(k, 10) }, row);
        }
        return row;
      });
    }
    return [];
  }

  function firstNonEmptyString() {
    for (var i = 0; i < arguments.length; i++) {
      var v = String(arguments[i] || '').trim();
      if (v) return v;
    }
    return '';
  }

  function liftLegacyTopLevelFields(data) {
    if (!data || typeof data !== 'object') return data;

    if (!data.blockPlan && data.block_plan) data.blockPlan = data.block_plan;
    if (!data.blockPlan && data.blockPlanText) {
      data.blockPlan = tryParseArchiveJsonObject(data.blockPlanText) || { rawContent: data.blockPlanText };
    }

    var i;
    if (!data.inspiration) {
      for (i = 0; i < INSPIRATION_ALIASES.length; i++) {
        if (data[INSPIRATION_ALIASES[i]]) {
          data.inspiration = data[INSPIRATION_ALIASES[i]];
          break;
        }
      }
    }

    if (!data.curriculum) {
      for (i = 0; i < CURRICULUM_LIST_KEYS.length; i++) {
        var ck = CURRICULUM_LIST_KEYS[i];
        if (data[ck] && ck !== 'curriculum') {
          data.curriculum = data[ck];
          break;
        }
      }
    }

    for (i = 0; i < CURRICULUM_TEXT_KEYS.length; i++) {
      if (!data.curriculum && data[CURRICULUM_TEXT_KEYS[i]]) {
        data.curriculum = data[CURRICULUM_TEXT_KEYS[i]];
      }
    }

    if (!data.sources && data.bibliography) data.sources = data.bibliography;
    if (!data.sources && data.references) data.sources = data.references;

    return data;
  }

  function extractCurriculumFromArchivePlan(plan, dataRoot) {
    var sources = [];
    var textSources = [];

    function pushSource(val) {
      if (val == null) return;
      if (typeof val === 'string') textSources.push(val);
      else sources.push(val);
    }

    if (plan) {
      var j;
      for (j = 0; j < CURRICULUM_LIST_KEYS.length; j++) pushSource(plan[CURRICULUM_LIST_KEYS[j]]);
      if (plan.blockPlan && plan.blockPlan !== plan) {
        for (j = 0; j < CURRICULUM_LIST_KEYS.length; j++) pushSource(plan.blockPlan[CURRICULUM_LIST_KEYS[j]]);
      }
      pushSource(plan.rawContent);
      pushSource(plan.content);
      pushSource(plan.text);
    }

    if (dataRoot && dataRoot !== plan) {
      var k;
      for (k = 0; k < CURRICULUM_LIST_KEYS.length; k++) pushSource(dataRoot[CURRICULUM_LIST_KEYS[k]]);
      for (k = 0; k < CURRICULUM_TEXT_KEYS.length; k++) pushSource(dataRoot[CURRICULUM_TEXT_KEYS[k]]);
      if (dataRoot.blockPlan && dataRoot.blockPlan !== plan) {
        for (k = 0; k < CURRICULUM_LIST_KEYS.length; k++) pushSource(dataRoot.blockPlan[CURRICULUM_LIST_KEYS[k]]);
        pushSource(dataRoot.blockPlan.rawContent);
      }
      pushSource(dataRoot.rawText);
      pushSource(dataRoot.rawContent);
      pushSource(dataRoot.content);
    }

    var i;
    for (i = 0; i < sources.length; i++) {
      var rows = coerceCurriculumRows(sources[i]);
      if (rows.length) return rows;
    }

    for (i = 0; i < textSources.length; i++) {
      if (!looksLikeCurriculumText(textSources[i])) continue;
      var parsed = parseCurriculumFromText(textSources[i]);
      if (parsed.length) return parsed;
    }

    return [];
  }

  function liftArchivePhaseCFields(blockPlan, data) {
    if (!blockPlan || typeof blockPlan !== 'object') return blockPlan;
    if (!data || typeof data !== 'object') data = {};

    var i;
    if (!blockPlan.inspiration) {
      for (i = 0; i < INSPIRATION_ALIASES.length; i++) {
        var inspKey = INSPIRATION_ALIASES[i];
        if (data[inspKey]) blockPlan.inspiration = data[inspKey];
        if (blockPlan[inspKey]) blockPlan.inspiration = blockPlan[inspKey];
      }
    }

    if (!blockPlan.curriculum) {
      for (i = 0; i < CURRICULUM_LIST_KEYS.length; i++) {
        var ck = CURRICULUM_LIST_KEYS[i];
        if (data[ck]) blockPlan.curriculum = data[ck];
        if (blockPlan[ck] && ck !== 'curriculum') blockPlan.curriculum = blockPlan[ck];
      }
    }

    if (!blockPlan.sources) {
      blockPlan.sources = data.sources || data.bibliography || data.references || blockPlan.bibliography;
    }

    blockPlan.inspiration = tryParseArchiveJsonObject(blockPlan.inspiration) || blockPlan.inspiration;
    blockPlan.curriculum = tryParseArchiveJsonObject(blockPlan.curriculum) || blockPlan.curriculum;
    blockPlan.sources = tryParseArchiveJsonObject(blockPlan.sources) || blockPlan.sources;

    if (typeof blockPlan.inspiration === 'string' && blockPlan.inspiration.trim()) {
      blockPlan.inspiration = { rawContent: blockPlan.inspiration.trim() };
    }

    if (typeof blockPlan.curriculum === 'string' && blockPlan.curriculum.trim()) {
      var fromStr = coerceCurriculumRows(blockPlan.curriculum);
      blockPlan.curriculum = fromStr.length ? fromStr : parseCurriculumFromText(blockPlan.curriculum);
    }

    var curriculumRows = extractCurriculumFromArchivePlan(blockPlan, data);
    if (curriculumRows.length) blockPlan.curriculum = curriculumRows;

    if (!curriculumRows.length) {
      var textDump = firstNonEmptyString(
        blockPlan.rawContent, blockPlan.content, blockPlan.text, blockPlan.overview,
        data.rawText, data.rawContent, data.content
      );
      if (looksLikeCurriculumText(textDump)) {
        var fromDump = parseCurriculumFromText(textDump);
        if (fromDump.length) blockPlan.curriculum = fromDump;
      }
    }

    return blockPlan;
  }

  function coerceArchiveLessonResultData(raw) {
    if (!raw) return null;

    if (raw.resultData != null) {
      var inner = coerceArchiveLessonResultData(raw.resultData);
      if (!inner) return null;
      return Object.assign({}, inner, {
        cacheKey: raw.cacheKey || inner.cacheKey || null,
        gradeId: raw.gradeId || inner.gradeId || null,
        gradeLabel: raw.gradeLabel || inner.gradeLabel || null,
        topic: raw.topic || inner.topic || null,
      });
    }

    var data = tryParseArchiveJsonObject(raw) || raw;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    data = liftLegacyTopLevelFields(data);

    if (
      data.data != null &&
      typeof data.data === 'object' &&
      !Array.isArray(data.data) &&
      !data.blockPlan &&
      !data.webResearch &&
      !data.gradeInsights
    ) {
      var nested = coerceArchiveLessonResultData(data.data);
      if (nested) data = Object.assign({}, data, nested);
      data = liftLegacyTopLevelFields(data);
    }

    var blockPlan = tryParseArchiveJsonObject(data.blockPlan) || data.blockPlan;
    if (blockPlan && typeof blockPlan === 'object' && blockPlan.blockPlan && typeof blockPlan.blockPlan === 'object') {
      blockPlan = Object.assign({}, blockPlan.blockPlan, blockPlan);
      delete blockPlan.blockPlan;
    }

    if (!blockPlan || typeof blockPlan !== 'object') {
      if (data.inspiration || data.curriculum || data.sources || data.rawContent || data.content) {
        blockPlan = {};
      } else {
        return data;
      }
    }

    var rawContent = firstNonEmptyString(
      blockPlan.rawContent, blockPlan.content, blockPlan.overview, blockPlan.text,
      data.rawContent, data.content, data.overview, data.summary, data.rawText
    );

    var theory = tryParseArchiveJsonObject(blockPlan.theory) || blockPlan.theory;
    if (typeof theory === 'string' && theory.trim()) {
      blockPlan.theory = { title: '', sections: [{ heading: '', content: theory.trim() }] };
    } else if (theory && typeof theory === 'object') {
      if (!Array.isArray(theory.sections)) {
        var parsedSections = tryParseArchiveJsonObject(theory.sections);
        theory.sections = Array.isArray(parsedSections) ? parsedSections : coerceCurriculumRows(theory.sections);
      }
      if (!theory.sections.length) {
        var theoryBody = firstNonEmptyString(
          theory.content, theory.overview, theory.summary, theory.text, theory.body, theory.html
        );
        if (theoryBody) {
          theory.sections = [{ heading: theory.title || theory.heading || '', content: theoryBody }];
        }
      }
      theory.sections = theory.sections.map(function (sec) {
        if (!sec || typeof sec !== 'object') {
          var asText = String(sec || '').trim();
          return asText ? { heading: '', content: asText } : null;
        }
        var content = archiveSectionText(sec);
        return Object.assign({}, sec, {
          heading: sec.heading || sec.title || '',
          content: content || sec.content || '',
        });
      }).filter(Boolean);
      blockPlan.theory = theory;
    } else if (rawContent && !looksLikeCurriculumText(rawContent)) {
      blockPlan.theory = { title: '', sections: [{ heading: '', content: rawContent }] };
    } else if (rawContent) {
      blockPlan.rawContent = rawContent;
    }

    blockPlan = liftArchivePhaseCFields(blockPlan, data);
    if (rawContent && !String(blockPlan.rawContent || '').trim()) blockPlan.rawContent = rawContent;
    data.blockPlan = blockPlan;

    if (!data.webResearch || typeof data.webResearch !== 'object') data.webResearch = {};
    if (!String(data.webResearch.summary || '').trim()) {
      var wrSummary = firstNonEmptyString(
        data.webResearch.overview, data.webResearch.content, data.webResearch.text, data.webResearch.summary
      );
      if (wrSummary) data.webResearch.summary = wrSummary;
    }
    if (!String(data.webResearch.summary || '').trim() && rawContent && !looksLikeCurriculumText(rawContent)) {
      data.webResearch.summary = rawContent;
    }

    if (!data.gallery && data.visualGallery) data.gallery = data.visualGallery;

    return data;
  }

  return {
    CURRICULUM_LIST_KEYS: CURRICULUM_LIST_KEYS,
    archiveSectionText: archiveSectionText,
    coerceCurriculumRows: coerceCurriculumRows,
    coerceArchiveLessonResultData: coerceArchiveLessonResultData,
    extractCurriculumFromArchivePlan: extractCurriculumFromArchivePlan,
    liftArchivePhaseCFields: liftArchivePhaseCFields,
    looksLikeCurriculumText: looksLikeCurriculumText,
    parseCurriculumFromText: parseCurriculumFromText,
    tryParseArchiveJsonObject: tryParseArchiveJsonObject,
  };
}));
