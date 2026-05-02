# Google Drive Full-Text Search Web App (Google Apps Script)

A serverless, no-signup full-text search web app for Google Drive — built entirely with Google Apps Script, Google Sheets, and Drive API v3. No external server required.

---

## ⚠️ Language Notice

This project was born from a real need in **Korean K-12 education** — specifically, helping high school teachers search university admission materials stored in a shared Google Drive. As a result, the UI text in `index.html` is currently written in Korean.

**Important clarifications:**

- The **search engine itself is fully language-agnostic** — it uses Drive API v3's `fullText contains` operator, which works with any language content (English, Spanish, Japanese, etc.)
- Only the **UI labels and placeholder text** are in Korean
- Changing the UI language takes about **5 minutes**: open `index.html`, search for Korean strings (hangul characters), and replace them with your language

🌍 **Internationalization (i18n) contributions are warmly welcome!** If you create an English or other-language version of `index.html`, please open a PR — we'd love to include it as a template.

---

## Key Features

- **Filename + full file content search simultaneously** — uses Drive API v3 `fullText contains`, which searches inside PDFs, Docs, Sheets, and more
- **Boolean operators** — supports `AND`, `OR`, `NOT`, and `( )` grouping for precise queries
- **6-hour caching** via Apps Script `CacheService` — repeated searches return instantly without calling Drive API again
- **Automatic daily index rebuild** at 02:00 + **cache warming 4× per day** (02:30 / 07:30 / 12:30 / 17:30) for the top 100 most-searched keywords
- **Anonymous keyword frequency logging** — tracks which terms are searched most, used to prioritize cache warming; stale keywords (not searched in 3 days) are purged automatically at 03:00
- **Large-folder support** — a resume mechanism handles index builds that exceed Apps Script's 6-minute execution limit, allowing up to ~100,000 files

---

## Why This Project?

**Born from a real need in Korean education.**

High school teachers in Korea maintain large shared Google Drive folders full of university admission guidebooks, statistical reports, and counseling reference PDFs — sometimes tens of thousands of files accumulated over years. Google Drive's native search is powerful but lacks Boolean operators, has no caching layer, and cannot be embedded in a custom interface.

This project solves that with a fully self-hosted, zero-cost search engine that runs entirely inside Google's own ecosystem.

**It generalizes to any organization with Google Drive:**

You don't need to be a Korean school to benefit. Anywhere that people share files on Google Drive and need to find content quickly — this app works.

---

## Use Cases

| Scenario | Example |
|----------|---------|
| **Educational institutions** | Teachers searching shared Drive folders of PDFs — e.g., Korean university admission guides, research papers, or curriculum materials |
| **Small research teams** | Lab members searching a shared folder of academic papers, datasets, and reports by keyword |
| **Non-profits with limited budgets** | Organizations that can't afford enterprise search tools but already use Google Workspace |
| **Startups needing an internal knowledge base** | Teams indexing internal docs, runbooks, and product specs stored in Drive |

---

## Comparison: Native Google Drive Search vs. This Web App

| Feature | Google Drive Native Search | This Web App |
|---------|---------------------------|--------------|
| Full-text search inside files | ✅ | ✅ |
| Boolean operators (`AND`, `OR`, `NOT`) | ❌ | ✅ |
| Parentheses grouping | ❌ | ✅ |
| Result caching (6-hour) | ❌ | ✅ |
| Automatic cache warming | ❌ | ✅ |
| Custom UI / embeddable | ❌ | ✅ |
| Scoped to a specific folder tree | ❌ (searches all Drive) | ✅ |
| No login required (configurable) | ❌ | ✅ |
| External server or database needed | — | ❌ None |
| Cost | Free | Free |

---

## Setup Guide

Follow these steps before deploying the web app.

### Step 1 — Create a Google Spreadsheet

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet.
2. Rename the default sheet to **`FileIndex`**.
3. Add a second sheet and name it **`KeywordLog`**.
4. Copy the spreadsheet ID from the URL:
   ```
   https://docs.google.com/spreadsheets/d/[THIS_IS_THE_ID]/edit
   ```

### Step 2 — Get Your Google Drive Folder ID

Open the root folder you want to search, and copy the folder ID from the URL:

```
https://drive.google.com/drive/folders/[THIS_IS_THE_ID]
```

### Step 3 — Create an Apps Script Project and Paste the Code

1. In your spreadsheet, go to **Extensions → Apps Script**.
2. Delete the default content of `Code.gs` and paste the contents of `src/Code.gs` from this repository.
3. Click the **`+`** button to add an HTML file, name it **`index`** (exactly), and paste the contents of `src/index.html`.

> **UI language note:** `index.html` contains Korean text. See the [Customization](#customization) section if you want to change the interface language before deploying.

### Step 4 — Replace the Constants

At the top of `Code.gs`, replace the three placeholder values:

```js
const INDEX_SHEET_ID = 'your_spreadsheet_id';   // From Step 1
const FOLDER_ID      = 'your_root_folder_id';   // From Step 2
const ADMIN_PASSWORD = 'admin1234';             // Change this — used to trigger manual reindexing
```

> `ADMIN_PASSWORD` is stored as plaintext intentionally: Apps Script source code is never exposed to end users after deployment, so there is no leakage risk. Still, use something stronger than the default.

### Step 5 — Enable Drive API v3

1. In the Apps Script editor, click **Services (+)** in the left sidebar.
2. Select **Drive API** from the list.
3. Set the version to **v3**, keep the identifier as **`Drive`**, and click Add.

### Step 6 — Run the Initial Index Build

In the Apps Script editor, select `rebuildMetadataIndex` from the function dropdown and click **Run**.

```
Select rebuildMetadataIndex → click Run → confirm the FileIndex sheet is populated
```

> When prompted, grant Drive access permissions.

### Step 7 — Install Scheduled Triggers

Select `setupTriggers` from the function dropdown and click **Run**. This installs 6 time-based triggers automatically. Verify them under **Triggers** in the left sidebar.

### Step 8 — Deploy as a Web App

1. Click **Deploy → New deployment** in the top-right corner.
2. Type: **Web app**
3. Settings:
   - Execute as: **Me (script owner)**
   - Who has access: **Anyone** (for public access) or **Anyone with a Google account** (for internal use)
4. Copy the **Web App URL** and share it with your users.

---

## Access Permission Structure

The web app URL controls **who can search**. Google Drive folder sharing controls **who can open the files**.

**Scenario 1 — Fully public (anyone can search and open files)**

Set the Drive root folder sharing to **"Anyone with the link → Viewer"**. Users can click search results and open files without logging in.

**Scenario 2 — Internal use only (anyone can search, but only members can open files)**

Add specific Google accounts to the Drive folder's sharing settings. Users without access will see a "Request Access" screen when they click a result link. Suitable for department-internal or team-restricted document libraries.

---

## Search Examples

| Query | Behavior |
|-------|----------|
| `admission AND math AND Seoul` | All three keywords must appear |
| `math OR english` | Either keyword matches |
| `math NOT Seoul` | Contains "math" but not "Seoul" |
| `(math OR english) NOT Seoul` | Grouped Boolean with parentheses |

---

## Customization

### Changing the UI Language

All user-visible text lives in `src/index.html`. To localize it:

1. Open `src/index.html` in any text editor.
2. Search for Korean characters (any hangul: `가-힣` range, or simply look for text that appears garbled in your editor).
3. Replace each Korean string with your preferred language equivalent.
4. Key strings to change include the page title, search placeholder, guide text, and result card labels.

The Apps Script entry point in `Code.gs` also sets the browser tab title:

```js
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('대학진학자료 통합검색기'); // ← change this to your title
}
```

### Contributing Localized Templates

If you create a localized version of `index.html`, please submit a PR! The vision is to collect language templates (e.g., `index_en.html`, `index_es.html`) that users can drop in as a starting point.

---

## Architecture

```
Browser (index.html)
  └─ google.script.run.doSearch(query)
        └─ tokenize → buildExpressionTree → evaluate
              └─ getFileIdsForKeyword(keyword)
                    ├─ CacheService HIT  → return fileId array immediately
                    └─ CacheService MISS → Drive API fullText search → save to cache
              └─ Set operations (AND: intersect / OR: union / NOT: difference)
        └─ lookupMetadata(fileIds) — query FileIndex sheet for file details

Scheduled Triggers (installed by setupTriggers())
  02:00  rebuildMetadataIndex  — full FileIndex sheet rebuild (with resume support)
  02:30  warmCache             — pre-cache top 100 keywords
  03:00  purgeStaleKeywords    — delete keywords not searched in 3 days
  07:30  warmCache
  12:30  warmCache
  17:30  warmCache
```

**Caching detail:** CacheService has a hard 100KB per-entry limit. The app splits large metadata payloads into 30,000-character chunks (≈90KB for multi-byte text) and reassembles them on read. Keyword result sets are also chunked the same way.

**Resume mechanism:** `rebuildMetadataIndex` stores its folder traversal queue in `PropertiesService`. If execution hits the 4-minute safety cutoff, it installs a temporary one-time trigger to resume from where it left off — enabling indexing of very large folder trees without manual intervention.

---

## Spreadsheet Structure

| Sheet | Purpose | Columns |
|-------|---------|---------|
| `FileIndex` | File metadata index | `fileId` \| filename \| folderPath \| URL \| modifiedDate |
| `KeywordLog` | Keyword frequency log | keyword \| searchCount \| lastSearchDate |

---

## Constants Reference

| Constant | Default | Description |
|----------|---------|-------------|
| `FOLDER_ID` | _(replace)_ | Root Google Drive folder ID to search |
| `INDEX_SHEET_ID` | _(replace)_ | Google Spreadsheet ID |
| `ADMIN_PASSWORD` | `admin1234` | Password for manual reindex via the admin UI — **change before deploying** |
| `FILE_INDEX_SHEET` | `FileIndex` | Name of the metadata index sheet |
| `KEYWORD_LOG_SHEET` | `KeywordLog` | Name of the keyword frequency log sheet |
| `CACHE_TTL` | `21600` | Cache duration in seconds (6 hours — Google's hard maximum) |
| `CACHE_CHUNK_SIZE` | `30000` | Characters per cache chunk (keeps each chunk under the 100KB CacheService limit) |
| `PRECACHE_TOP_N` | `100` | Number of top keywords to pre-warm on each `warmCache` run |
| `DRIVE_SERVICE` | `Drive` | Apps Script service identifier for Drive API v3 |

---

## Service Limits

| Item | Practical Limit | Notes |
|------|----------------|-------|
| Concurrent users | **~30** | Google Apps Script concurrent execution limit |
| Keywords per query | **≤ 5 recommended** | More keywords work but increase response time |
| Active cached keywords | **100** | Auto-maintained by `warmCache` (runs 4×/day); others are cached on first search |
| Indexed files | **≤ 100,000 recommended** | Larger folders are supported via the resume mechanism, but index build time increases |

---

## FAQ

**Q: Can I use this for non-Korean content?**

Yes, absolutely. The search engine uses Drive API v3's `fullText contains` operator, which is fully language-agnostic. The only Korean-specific part is the UI text in `index.html`, which you can replace in a few minutes (see [Customization](#customization)).

**Q: How do I change the interface to English (or Spanish, Japanese, etc.)?**

Open `src/index.html`, find all Korean text strings (look for hangul characters), and replace them with your language. Also update the `.setTitle(...)` call in `doGet()` inside `Code.gs`. That's it — no build step, no framework.

**Q: Is my data safe? Does this send anything to external servers?**

No external servers are involved at any point. Everything runs inside Google's infrastructure: Apps Script, Google Sheets, and Drive API. The only network calls are between your browser and Google's own services.

**Q: What happens if the index build times out on very large folders?**

The `rebuildMetadataIndex` function has a built-in resume mechanism. It saves its traversal progress to `PropertiesService` and installs a temporary trigger to continue where it left off. Folders with up to ~100,000 files are handled without manual intervention.

**Q: Why is `ADMIN_PASSWORD` stored as plaintext in Code.gs?**

Apps Script source code is never exposed to end users after deployment — only the web app URL is shared, not the underlying script. The password is hashed client-side (SHA-256 via the Web Crypto API) before being sent to the backend, where it's compared against the stored value. This is an intentional design choice, not an oversight.

---

## Privacy & Compliance

- **Data collection**: Only anonymous search keywords are logged — no user identifiers, no file content, no personal information
- **OAuth scope**: Requires Drive read access only; the script never writes to or modifies any Drive files
- **First-time setup**: Users may see an "Unverified app" warning from Google — this is normal for self-deployed Apps Script projects and can be dismissed by clicking "Advanced → Go to `project name`"
- **Quota management**: The 6-hour caching layer limits Drive API calls, keeping usage well within Google's free-tier quotas under normal load

---

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork this repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Make your changes and test them in your own Apps Script deployment
4. Submit a pull request with a clear description of what changed and why

### 🌍 Internationalization (i18n) Contributions Especially Welcome!

If you localize `index.html` into any language, please submit it as a PR. Suggested filename convention: `index_en.html`, `index_es.html`, `index_ja.html`, etc.

Even partial translations or corrections to existing Korean text are appreciated — open an issue if you spot anything confusing.

**Bug reports and feature requests:** Please open a [GitHub Issue](../../issues).

---

## License

MIT License. See [LICENSE](LICENSE) for details.

Free to use, modify, and distribute — commercially or otherwise. Attribution appreciated but not required.
