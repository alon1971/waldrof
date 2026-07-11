/* Waldorf archive service worker — v2 word-export named open */
var WORD_EXPORT_PREFIX = '/__waldorf_word__/';
var wordExports = new Map();

self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

function asciiFilenameFallback(name) {
  var base = String(name || 'document.docx').replace(/[^\x20-\x7E]/g, '_').replace(/["\\\r\n]/g, '_');
  if (!/\.docx$/i.test(base)) base += '.docx';
  if (!base.replace(/[_.]/g, '')) base = 'waldorf-summary.docx';
  return base;
}

function buildContentDisposition(filename) {
  var utfName = String(filename || 'document.docx');
  var asciiName = asciiFilenameFallback(utfName);
  return (
    'inline; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(utfName)
  );
}

self.addEventListener('message', function (event) {
  var data = event.data;
  if (data && data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (!data || data.type !== 'WALDORF_WORD_EXPORT') return;
  var id = String(data.id || '').trim();
  if (!id || !data.buffer) {
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: false });
    return;
  }
  wordExports.set(id, {
    name: String(data.name || 'document.docx'),
    buffer: data.buffer,
    contentType:
      data.contentType ||
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    createdAt: Date.now(),
  });
  // Keep memory bounded — drop exports older than 10 minutes.
  var cutoff = Date.now() - 10 * 60 * 1000;
  wordExports.forEach(function (entry, key) {
    if (entry.createdAt < cutoff) wordExports.delete(key);
  });
  if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true, id: id });
});

self.addEventListener('fetch', function (event) {
  var url;
  try {
    url = new URL(event.request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf(WORD_EXPORT_PREFIX) !== 0) return;

  var id = String(url.searchParams.get('id') || '').trim();
  var entry = id ? wordExports.get(id) : null;
  if (!entry) {
    event.respondWith(new Response('Word export not found', { status: 404 }));
    return;
  }

  event.respondWith(
    new Response(entry.buffer, {
      status: 200,
      headers: {
        'Content-Type': entry.contentType,
        'Content-Disposition': buildContentDisposition(entry.name),
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  );
});
