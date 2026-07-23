# Google Drive community catalog — local setup

Live community/Drive search + Gemini community summaries need these environment variables in `.env` (never commit `.env`).

## 1. Placeholders in `.env`

`.env` is gitignored (see `.gitignore`). Keep these keys present:

```env
GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID=1N50V9Njt3E6IQDX0OfktLM7qkhzyJ0Cs
GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON=
GEMINI_API_KEY=
```

Same template lives in `.env.example` (safe to commit).

| Variable | What to paste |
|----------|----------------|
| `GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID` | Root catalog folder ID. Canonical community root: `1N50V9Njt3E6IQDX0OfktLM7qkhzyJ0Cs` ([open folder](https://drive.google.com/drive/folders/1N50V9Njt3E6IQDX0OfktLM7qkhzyJ0Cs)). If omitted, the server defaults to this ID. |
| `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` | Full service-account JSON as **one line** (see below). Expected client email: `waldorf-service@careful-trainer-483207-r9.iam.gserviceaccount.com` |
| *(optional)* `service-account.json` | Place the JSON file in the project root instead of (or as fallback for) the env var |
| `GEMINI_API_KEY` | Required for pedagogical Drive summaries (`gemini-2.5-pro`, fallback `gemini-2.5-flash`) |

Also share the catalog folder with the service account `client_email` (role: **Editor** for organize/sync writes; **Viewer** is enough for search-only).

### Writing files (organize / PDF→Docs convert)

Service Accounts have **no storage quota on personal My Drive**. Creating folders and shortcuts works; uploading binaries or converting to Google Docs fails with `storageQuotaExceeded` — even when the folder is shared with the SA as Editor.

Pick **one** of these (recommended: A):

#### A) User OAuth — live site (recommended on Render)

Uploads run as the folder owner and use that account’s quota. Refresh token is stored in Supabase (`drive_oauth_credentials`) so it survives restarts without pasting into Render env.

1. Google Cloud Console → APIs & Services: enable **Google Drive API**, create an **OAuth client** of type **Web application**
2. Authorized redirect URI:
   `https://waldrof.onrender.com/api/auth/google-drive/callback`
3. On Render, set:
   - `GOOGLE_DRIVE_OAUTH_CLIENT_ID`
   - `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`
   - `CRON_SECRET` (same secret used for cron routes)
4. Run once in Supabase SQL editor: `supabase/drive_oauth_credentials.sql`
5. Open (replace the secret):

```
https://waldrof.onrender.com/api/auth/google-drive?secret=YOUR_CRON_SECRET
```

6. Sign in as the **owner** of `waldorfplanner drive`
7. After success, run catalog sync:

```
https://waldrof.onrender.com/api/cron/drive-catalog-sync?secret=YOUR_CRON_SECRET
```

Status check: `https://waldrof.onrender.com/api/auth/google-drive/status?secret=YOUR_CRON_SECRET`

There is **no** button in the main teacher UI — this is an admin URL protected by `CRON_SECRET`.

#### A2) User OAuth — local CLI

1. In Google Cloud Console → APIs & Services: enable **Google Drive API**, create an **OAuth client** (Desktop app, or Web with redirect `http://127.0.0.1:53682/oauth2callback`)
2. Put the client id/secret in `.env` (or pass flags), then run:

```bash
node scripts/google-drive-oauth-setup.js --write-env
```

3. Sign in as the **owner** of `waldorfplanner drive`
4. Re-run: `npm run organize-drive:apply`

Env keys written:

```env
GOOGLE_DRIVE_OAUTH_CLIENT_ID=...
GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=...
GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN=...
```

#### B) Shared Drive (Team Drive)

1. Create a **Shared Drive** in Google Workspace / Drive
2. Move `GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID` content into that Shared Drive (or set the root to a folder inside it)
3. Add the service account email as **Content Manager**
4. Re-run: `npm run organize-drive:apply`

#### C) Workspace domain-wide delegation

If the owner is a Google Workspace user, enable domain-wide delegation on the SA and set:

```env
GOOGLE_DRIVE_DELEGATE_EMAIL=owner@your-domain.com
```

Aliases accepted for the root id: `GOOGLE_DRIVE_CATALOG_ROOT_FOLDER_ID` or `DRIVE_ROOT_FOLDER_ID`.

## 2. Pack a multi-line JSON key into one line

```bash
# Print one-line JSON to the terminal (copy into .env)
node scripts/format-env-json.js path/to/service-account.json

# Or write directly into local .env
node scripts/format-env-json.js path/to/service-account.json --write-env
```

PowerShell pipe:

```powershell
Get-Content .\my-sa.json -Raw | node scripts/format-env-json.js
```

## 3. Supabase community Drive archive + OAuth store

Run once in the Supabase SQL editor:

- `supabase/community_drive_archive.sql` — Gemini community summaries (separate from Perplexity `cached_results`)
- `supabase/drive_oauth_credentials.sql` — refresh token from live `/api/auth/google-drive` connect

**Cache isolation:** Perplexity/web results live only in `cached_results`. Community Drive summaries live only in `community_drive_archive`. Community/repository probes must not fall back into `cached_results` (and vice versa).

Every hybrid search (including Perplexity cache hits) re-checks Drive for new/changed files and refreshes the summary only on delta.

## 4. Initial catalog sweep

```bash
# Optional: sync the whole tree into community_materials on boot
DRIVE_CATALOG_SYNC_ON_BOOT=1

# Or trigger the cron route (requires CRON_SECRET)
curl -X POST http://localhost:3000/api/cron/drive-catalog-sync -H "Authorization: Bearer $CRON_SECRET"
```

The sweep walks the root folder recursively, **resolves Drive shortcuts** to their targets, and indexes files under the inherited grade/topic path.

## 5. Verify

```bash
# Unit-ish Drive query builders
node scripts/test-drive-community-search.js

# Live Drive + Gemini + community_drive_archive
node scripts/probe-drive-community-search.js "רומא"

# Dedicated API (server must be running)
curl -X POST http://localhost:3000/api/community-search \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"רומא\",\"globalScan\":true}"
```

Expect `driveConfigured = true` and ideally `communityStatus = ok` with a Gemini summary.
When there are no matching files, `communitySummary` is exactly:

`כרגע אין חומר רלוונטי שהועלה למאגר הקהילתי, כשיתווסף אעדכן כאן`

## 6. Dual-stream modes

### A) Direct Drive Search — catalog tab «מאגר קהילתי»
- Navigation only (no Gemini summary)
- Query expansion (local pedagogical aliases + optional Gemini synonyms), e.g. `אדם חיה` → `אדם וחיות` / `האדם בממלכת החי`
- Relevance filter on **name/folder path** (rejects fullText-only false positives like גילגמש)
- UI shows only clickable file/folder name cards → Drive `webViewLink`
- API: `POST /api/community-search` with `{ "mode":"navigation", ... }`  
  or catalog `probe_community` via `/api/search-history`

### B) Standalone topic summarizer (decoupled from live web search)
- UI button: **סיכום נושא מתוך המאגר הקהילתי** → grade + topic form
- Drive root scan → public `community_drive_archive` lookup (no `userId`) → Gemini only on miss/delta
- Empty state (exact):  
  `אין חומר מהארכיון עבור נושא וכיתה זו`
- API: `POST /api/community-summarizer` with `{ "topic":"…", "gradeId":"5" }`
- Backend: `api/community-summarizer.js` + `api/community-drive-archive.js`
- Live search routes (`pure-general-search` / `pure-phase-c`) do **not** summarize Drive

Gemini uses **only** extracted Drive file text (no web grounding).
Catalog citations remain: `POST /api/community-search` (navigation only).

## 7. Missing credentials (safe fallback)

If the service account is empty/invalid:

- The server **starts normally** and logs that Drive is unavailable
- Live Drive search is skipped; UI shows the empty community message / `not_configured`
- Optional boot sync (`DRIVE_CATALOG_SYNC_ON_BOOT=1`) runs only when Drive is fully configured
