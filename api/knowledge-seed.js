/**
 * Auto-seed knowledge_base with starter Anthroposophical content when empty.
 * Runs once on server boot (non-blocking).
 */
const knowledgeIngest = require('./knowledge-ingest');
const env = require('./env');

const SEED_ENTRIES = [
  {
    title: 'תקופת לימוד ראשית — עקרונות יסוד',
    author: 'חינוך ולדורף',
    content:
      'תקופת לימוד ראשית בחינוך הולדורפי נמשכת שלושה עד שישה שבועות ועוסקת בנושא אחד לעומק. ' +
      'המורה בונה סיפור מרכזי שמתפתח מיום ליום, ומחבר בין אמנות, מעשה, שירה וחקר. ' +
      'הילד נפגש עם החומר דרך דימוי וחוויה, לא רק דרך הסבר אינטלקטואלי. ' +
      'הקצב האיטי והעמוק מאפשר לנבוט רגשי ורוחני לצד הידע.',
  },
  {
    title: 'תמונת גיל — כיתה א׳',
    author: 'Rudolf Steiner',
    content:
      'בגיל שבע עד שמונה הילד חווה את העולם כמקשה אחת. הוא לומד דרך חיקוי, קצב ודימוי. ' +
      'המורה הוא דמות סמכות טבעית; הסיפור, המעשה והשיר הם כלי הלימוד המרכזיים. ' +
      'אין לזרז את הקריאה והכתיבה לפני שהילד בשל מספיק — הגוף והנשמה צריכים להתבגר יחד.',
  },
  {
    title: 'אור וחושך — רעיונות לתקופת לימוד',
    author: 'פדגוגיה ולדורפית',
    content:
      'נושא האור והחושך מתאים לתקופת סתיו וחורף ולשאלות ראשוניות של הילד על העולם. ' +
      'אפשר לפתוח בסיפור על נר דולק, להמשיך בניסוי צל וצבע, ולשלב ציורי שמן או פחם. ' +
      'המורה שומר על איזון בין רגש ומחשבה — לא להעמיק מוקדם מדי בפיזיקה, אלא להשאיר מקום לפלא.',
  },
  {
    title: 'שיעור ראשון — אווירה וקצב',
    author: 'חינוך ולדורף',
    content:
      'שיעור ראשון בכל תקופה קובע את האווירה. פתיחה בשיר או בקטע נגינה, רגע של שקט, ואז סיפור חדש. ' +
      'המורה עומד בגובה העיניים של הילדים, מדבר בקול ברור וחם, ואינו ממהר. ' +
      'המטרה היא לעורר סקרנות ולא לספק את כל המידע — הילד צריך לצאת עם שאלה פתוחה.',
  },
];

function getSupabaseConfig() {
  return {
    url: env.getSupabaseUrl(),
    key: env.getSupabaseServerKey(),
  };
}

async function getRowCount() {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return -1;

  const res = await fetch(
    cfg.url + '/rest/v1/knowledge_base?select=id&limit=1',
    {
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        Prefer: 'count=exact',
      },
    }
  );

  if (!res.ok) return -1;
  const range = res.headers.get('content-range') || '';
  const match = range.match(/\/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

async function seedKnowledgeBaseIfEmpty() {
  if (!knowledgeIngest.isIngestEnabled()) {
    console.log('[knowledge-seed] skipped — Supabase not configured');
    return { skipped: true, reason: 'no_supabase' };
  }

  if (process.env.SKIP_KNOWLEDGE_SEED === '1') {
    return { skipped: true, reason: 'env_disabled' };
  }

  try {
    const count = await getRowCount();
    if (count < 0) {
      console.warn('[knowledge-seed] could not read knowledge_base count');
      return { skipped: true, reason: 'count_failed' };
    }
    if (count > 0) {
      console.log('[knowledge-seed] skipped —', count, 'rows already present');
      return { skipped: true, reason: 'not_empty', existing: count };
    }

    let inserted = 0;
    for (let i = 0; i < SEED_ENTRIES.length; i++) {
      const entry = SEED_ENTRIES[i];
      const result = await knowledgeIngest.insertKnowledgeText(entry.content, {
        title: entry.title,
        author: entry.author,
        origin: 'auto_seed',
      });
      inserted += result.inserted || 0;
    }

    console.log('[knowledge-seed] inserted', inserted, 'starter chunks');
    return { seeded: true, inserted: inserted };
  } catch (err) {
    console.warn('[knowledge-seed] failed:', err.message || err);
    return { skipped: true, reason: 'error', error: err.message || String(err) };
  }
}

function seedKnowledgeBaseIfEmptyAsync() {
  seedKnowledgeBaseIfEmpty().catch(function (err) {
    console.warn('[knowledge-seed] async failed:', err.message || err);
  });
}

module.exports = {
  seedKnowledgeBaseIfEmpty,
  seedKnowledgeBaseIfEmptyAsync,
  SEED_ENTRIES,
};
