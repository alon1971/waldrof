#!/usr/bin/env node
/**
 * Upload Waldorf / Anthroposophical texts into Supabase knowledge_base.
 *
 * Usage:
 *   node scripts/upload-text.js --file ./articles/steiner-ga291.txt --title "GA 291" --author "Rudolf Steiner" --type lecture
 *   node scripts/upload-text.js --text "Inline paragraph one.\n\nParagraph two." --title "Notes"
 *   type article.txt | node scripts/upload-text.js --stdin --title "Imported article"
 *
 * Env (.env in project root):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required)
 *   OPENAI_API_KEY (optional — enables vector embeddings)
 */
const fs = require('fs');
const path = require('path');
const embeddings = require('../api/embeddings');

(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
})();

function getSupabaseConfig() {
  return {
    url: String(process.env.SUPABASE_URI || process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim(),
  };
}

function parseArgs(argv) {
  const opts = {
    file: '',
    text: '',
    stdin: false,
    title: '',
    author: '',
    type: 'article',
    minChars: 120,
    maxChars: 1200,
    dryRun: false,
    noEmbed: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) { opts.file = argv[++i]; continue; }
    if (arg === '--text' && argv[i + 1]) { opts.text = argv[++i]; continue; }
    if (arg === '--stdin') { opts.stdin = true; continue; }
    if (arg === '--title' && argv[i + 1]) { opts.title = argv[++i]; continue; }
    if (arg === '--author' && argv[i + 1]) { opts.author = argv[++i]; continue; }
    if (arg === '--type' && argv[i + 1]) { opts.type = argv[++i]; continue; }
    if (arg === '--min-chars' && argv[i + 1]) { opts.minChars = parseInt(argv[++i], 10) || opts.minChars; continue; }
    if (arg === '--max-chars' && argv[i + 1]) { opts.maxChars = parseInt(argv[++i], 10) || opts.maxChars; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--no-embed') { opts.noEmbed = true; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
  }

  return opts;
}

function printHelp() {
  console.log(
    'Upload text chunks to Supabase knowledge_base.\n\n' +
    'Options:\n' +
    '  --file <path>       Read article from file (UTF-8)\n' +
    '  --text <string>     Inline text content\n' +
    '  --stdin             Read full text from stdin\n' +
    '  --title <title>     Document title (required)\n' +
    '  --author <name>     Source author (optional)\n' +
    '  --type <type>       article|lecture|book|essay|other (default: article)\n' +
    '  --min-chars <n>     Minimum paragraph size (default: 120)\n' +
    '  --max-chars <n>     Max chunk size before split (default: 1200)\n' +
    '  --no-embed          Skip OpenAI embeddings (text search only)\n' +
    '  --dry-run           Parse and print chunks without uploading\n'
  );
}

function normalizeText(raw) {
  return String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\uFEFF/g, '')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]+/g, ' ')
    .trim();
}

/**
 * Split into semantic paragraphs; merge short blocks; cap very long sections.
 */
function chunkText(text, opts) {
  const minLen = opts.minChars || 120;
  const maxLen = opts.maxChars || 1200;
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

function readStdin() {
  return new Promise(function (resolve, reject) {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (chunk) { data += chunk; });
    process.stdin.on('end', function () { resolve(data); });
    process.stdin.on('error', reject);
  });
}

async function loadSourceText(opts) {
  if (opts.text) return opts.text;
  if (opts.file) {
    const filePath = path.resolve(opts.file);
    if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
    return fs.readFileSync(filePath, 'utf8');
  }
  if (opts.stdin) return readStdin();
  throw new Error('Provide --file, --text, or --stdin');
}

async function insertRows(rows) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const res = await fetch(cfg.url + '/rest/v1/knowledge_base', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error('Supabase insert failed (' + res.status + '): ' + text.slice(0, 400));
  }

  return text ? JSON.parse(text) : [];
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (!opts.title) {
    console.error('Error: --title is required');
    printHelp();
    process.exit(1);
  }

  const allowedTypes = ['article', 'lecture', 'book', 'essay', 'other'];
  if (allowedTypes.indexOf(opts.type) < 0) {
    console.error('Error: --type must be one of: ' + allowedTypes.join(', '));
    process.exit(1);
  }

  const rawText = await loadSourceText(opts);
  const chunks = chunkText(rawText, opts);

  if (!chunks.length) {
    console.error('No chunks produced — text may be too short (min ' + opts.minChars + ' chars per chunk).');
    process.exit(1);
  }

  console.log('Document:', opts.title);
  console.log('Chunks:', chunks.length);

  if (opts.dryRun) {
    chunks.forEach(function (chunk, i) {
      console.log('\n--- Chunk ' + (i + 1) + ' (' + chunk.length + ' chars) ---\n' + chunk.slice(0, 500) + (chunk.length > 500 ? '…' : ''));
    });
    process.exit(0);
  }

  const useEmbeddings = !opts.noEmbed && Boolean(embeddings.resolveEmbeddingApiKey());
  if (!useEmbeddings) {
    console.log('Embeddings: skipped (set OPENAI_API_KEY for vector search)');
  }

  const batchSize = useEmbeddings ? 16 : 32;
  let inserted = 0;

  for (let start = 0; start < chunks.length; start += batchSize) {
    const slice = chunks.slice(start, start + batchSize);
    let vectors = [];

    if (useEmbeddings) {
      try {
        vectors = await embeddings.embedTexts(slice);
      } catch (embedErr) {
        console.warn('Embedding batch failed, uploading without vectors:', embedErr.message || embedErr);
        vectors = [];
      }
    }

    const rows = slice.map(function (content, idx) {
      const globalIndex = start + idx;
      const row = {
        document_title: opts.title,
        source_author: opts.author || null,
        source_type: opts.type,
        chunk_index: globalIndex,
        content: content,
        metadata: {
          uploaded_at: new Date().toISOString(),
          char_count: content.length,
          upload_script: 'scripts/upload-text.js',
        },
      };
      if (vectors[idx]) row.embedding = vectors[idx];
      return row;
    });

    const saved = await insertRows(rows);
    inserted += saved.length;
    console.log('Uploaded', inserted + '/' + chunks.length);
  }

  console.log('Done. Inserted', inserted, 'rows into knowledge_base.');
}

main().catch(function (err) {
  console.error('Upload failed:', err.message || err);
  process.exit(1);
});
