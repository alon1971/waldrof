/**
 * Shared paragraph chunking for knowledge_base inserts.
 */
function normalizeText(raw) {
  return String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\uFEFF/g, '')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]+/g, ' ')
    .trim();
}

function stripHtml(html) {
  return normalizeText(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

/**
 * Split into semantic paragraphs; merge short blocks; cap very long sections.
 */
function chunkText(text, opts) {
  const options = opts || {};
  const minLen = options.minChars || 120;
  const maxLen = options.maxChars || 1200;
  const paragraphs = normalizeText(text)
    .split(/\n\s*\n+/)
    .map(function (p) { return p.trim(); })
    .filter(Boolean);

  const chunks = [];
  let buffer = '';

  function flushBuffer() {
    const trimmed = buffer.trim();
    if (trimmed.length >= minLen) chunks.push(trimmed);
    buffer = '';
  }

  paragraphs.forEach(function (paragraph) {
    if (paragraph.length > maxLen) {
      flushBuffer();
      const sentences = paragraph.split(/(?<=[.!?׃。])\s+/);
      let part = '';
      sentences.forEach(function (sentence) {
        const next = part ? part + ' ' + sentence : sentence;
        if (next.length > maxLen && part.length >= minLen) {
          chunks.push(part.trim());
          part = sentence;
        } else {
          part = next;
        }
      });
      if (part.trim().length >= minLen) chunks.push(part.trim());
      return;
    }

    const combined = buffer ? buffer + '\n\n' + paragraph : paragraph;
    if (combined.length > maxLen) {
      flushBuffer();
      if (paragraph.length >= minLen) {
        chunks.push(paragraph);
      } else {
        buffer = paragraph;
      }
      return;
    }

    buffer = combined;
    if (buffer.length >= minLen) flushBuffer();
  });

  flushBuffer();
  return chunks;
}

module.exports = {
  normalizeText,
  stripHtml,
  chunkText,
};
