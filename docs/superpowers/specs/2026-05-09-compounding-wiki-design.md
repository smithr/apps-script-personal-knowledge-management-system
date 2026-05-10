# PKM Compounding Wiki System — Design Spec
Date: 2026-05-09

## Problem

The current PKM system excels at collection and summarization but does not compound. Knowledge is collected, summarized, and stored in static Topic Docs. The weekly wiki (Wiki.js) regenerates from scratch each run, losing evolution history. Synthesis outputs are emailed and discarded. There is no Q&A loop, no cross-topic connection growth, and no way to ask questions against the accumulated knowledge base. NotebookLM provides Q&A but is passive — it does not learn or grow.

## Goal

Transform the PKM system into a compounding knowledge base: one that gets richer with each new item, surfaces cross-topic connections automatically, and lets the user query and file insights back in — so every exploration adds up.

---

## Architecture

The system splits into two halves that communicate through Google Drive as a passive message bus.

```
Google half (existing + enhanced)
  ├── Apps Script ingest (YouTube, Gmail, Tasks) — unchanged
  ├── Gemini summarization — unchanged
  ├── Human triage (WebApp.js) — unchanged
  └── RawStore.js (new) — writes full-text markdown to Drive /PKM/raw/ on save

Drive /PKM/raw/  ←── message bus ───►  Linux server

Linux server half (new)
  ├── drive-sync (cron, 15–30 min) — polls Drive, downloads new raw files
  ├── wiki-compiler (cron, after sync) — incremental wiki updates via Gemini
  └── web-app (always-on FastAPI) — browse, search, Q&A, insight filing
       └── cloudflared → Cloudflare → public HTTPS URL
```

No git push friction. No ports exposed. Drive is the handoff point between the two halves.

---

## Google Half Changes

### Full-Text Capture by Source

When a user saves an item through the WebApp triage step, Apps Script captures full content alongside the existing Gemini summary:

| Source | Full-text strategy |
|---|---|
| Gmail | Full email body — already in scope, not currently stored |
| YouTube | Transcript via captions API; falls back to video description |
| Tasks (plain) | Task title + notes field |
| Tasks (URL) | Fetch URL with UrlFetchApp, extract page title and body text |
| Gmail links / web articles | UrlFetchApp + HTML tag strip |

**Graceful degradation:** JavaScript-rendered pages and paywalled articles will yield partial or no body text. In those cases the shortSummary from the frontmatter remains the usable signal — the wiki still compounds from what it has.

### New File: RawStore.js

Called by `WebApp.js` inside `handleSaveConfirm`, after the existing Doc write succeeds. Responsibilities:
- Determine and fetch full-text content based on sourceType
- Write a markdown file to `/PKM/raw/` in Drive

Markdown file format:
```markdown
---
id: {itemId}
title: {page title or item title}
url: {url}
date: {ISO timestamp}
sourceType: {youtube|gmail|task|web}
tags: [tag1, tag2]
shortSummary: {Gemini short summary}
---

{full text body}
```

Filename: `{itemId}-{title-slug}.md`

`WebApp.js` is not modified except to call `writeRawItem(item, summary, selectedTags)` after the existing save logic. All Drive logic lives in `RawStore.js`.

---

## Linux Server Half

### Directory Structure

```
/pkm/
  raw/                         ← downloaded from Drive (Drive sync writes here)
    {itemId}-{slug}.md
    insights/
      {timestamp}-{slug}.md    ← Q&A insights filed back by the web app
  wiki/
    index.md                   ← global routing document (all topics + concepts)
    topics/
      leadership-management.md
      career.md
      fitness.md
      ...
    concepts/                  ← LLM-generated, emergent cross-topic articles
      systems-thinking.md
      habit-formation.md
      ...
  state/
    last_sync.txt              ← timestamp of last successful Drive sync
```

### 1. Drive Sync (cron, every 15–30 min)

`sync.py` — Python script using a Google service account.

- Reads `state/last_sync.txt` for the last sync timestamp
- Queries Drive API for files in `/PKM/raw/` modified after that timestamp
- Downloads new files to local `raw/`
- Also downloads `pkm-library-index.json` to `state/library-index.json` — this is the compiler's source of truth for topic groups and tag mappings (it already contains the full Config sheet tag-to-group structure)
- Updates `state/last_sync.txt` on success

No wiki logic. Isolated, restartable, idempotent.

### 2. Wiki Compiler (cron, offset 10 min after sync)

`compile.py` — the compounding engine.

**Per-topic pass:**
For each topic group (read from `state/library-index.json` — synced from Drive by the sync job):
1. Identify raw items tagged to this topic that arrived since the last compile
2. If no new items, skip
3. Read the current `wiki/topics/{topic}.md` (the "seed")
4. Read the new raw items (frontmatter + full text)
5. Call Gemini: *"Here is the current wiki article. Here are new items added since the last update. Update the article — preserve and refine existing content, integrate new insights, expand key terms and themes, and note new connections to other topics."*
6. Write the updated article back

The wiki article is the memory. It grows richer with each run rather than being regenerated from scratch.

**Cross-topic pass (runs after all topic updates):**
1. Read all topic articles
2. Call Gemini: *"Identify concepts that appear across multiple topics. For each concept not already in wiki/concepts/, generate a new concept article. Update existing concept articles where new items added relevant material."*
3. Write new/updated concept articles to `wiki/concepts/`

**Index update (runs last):**
Regenerates `wiki/index.md` with a one-paragraph summary of every topic and concept article. This is the LLM's routing document for Q&A.

**Rate limiting:** 2-second delay between Gemini calls. Retries once on 429 with 60-second backoff (matching the existing Apps Script pattern).

**State tracking:** `state/last_compile.txt` records the last successful compile timestamp, so the compiler knows which raw items are new.

### 3. Web App (always-on FastAPI)

Three views served from `web_app.py`:

**Wiki browser (`/wiki`):**
- Sidebar lists all topic and concept articles from `wiki/`
- Selected article rendered from markdown to HTML
- Internal wiki links work natively (article filenames are the link targets)

**Search (`/search`):**
- Text input, grep across all markdown files server-side
- Results show matching excerpts with article title and link
- `index.md` summaries appear first (anchored to the routing document)

**Q&A (`/qa`):**
Two-step flow:
1. Read `wiki/index.md`, pass to Gemini with the user's question → Gemini returns the 2-3 most relevant article names
2. Read those articles, pass to Gemini with the question → return answer + source list

Each answer shows a "Sources" footer with links to the consulted articles so the user always knows what it drew from.

**"Save this insight" button:**
Appears below every Q&A answer. On click, writes the question + answer as a markdown file to `raw/insights/`. The next compiler run picks it up as a `Query` source type and integrates it into the relevant topic or concept articles. Explorations compound back into the wiki.

**Infrastructure:**
- FastAPI + HTMX frontend (no heavy JS framework)
- Markdown rendered server-side with `mistune`
- Behind nginx → `cloudflared` → Cloudflare
- No exposed ports; HTTPS handled by Cloudflare

---

## Backfill Plan

A one-time Python script (`backfill.py`) to process the existing ~200 library items:

1. Read `pkm-library-index.json` (already contains all item metadata + URLs)
2. For each item, use `trafilatura` to extract clean article text from the URL
3. Write a markdown file to local `raw/` (same format as the live pipeline)
4. Paywalled / JS-heavy pages produce partial text — same graceful degradation as live
5. After all items are written, run `compile.py` topic by topic to build the initial wiki

`trafilatura` is a Python library specifically designed for article text extraction — significantly more reliable than a raw UrlFetchApp + tag-strip approach for backfill purposes.

The backfill wiki compilation processes each topic separately (not all 200 items at once), keeping each Gemini call within a manageable token budget (~75-150K tokens per topic depending on item count and article length).

---

## Search and Q&A Scaling

At current scale (~200 items, ~15 topic articles, ~10-20 concept articles), grep + `index.md` routing is sufficient. Total wiki content will be under 500KB.

The article-per-file structure is the correct unit of retrieval whether using grep or vector embeddings. If the wiki grows to 500+ articles and Q&A precision degrades, plugging in `chromadb` or a similar vector store is a drop-in addition — embed the same markdown files, replace the grep step in the Q&A flow.

---

## Apps Script Changes: Deprecations

`Wiki.js` and `Synthesis.js` are deprecated and their triggers removed. The server-side wiki compiler replaces both: it handles incremental wiki article updates (Wiki.js) and cross-topic synthesis (Synthesis.js) with richer compounding. The weekly synthesis email can optionally be preserved by having the web app generate a digest from the latest index.md, but it is not part of the initial implementation.

---

## Key Properties

- **No git friction:** Drive is the message bus; no manual commits or pushes
- **True compounding:** Wiki articles are the memory, updated iteratively from their own prior state
- **Emergent concepts:** Cross-topic concept articles surface patterns the user didn't explicitly tag
- **Q&A loop:** Insights are filed back as raw items and integrated into the wiki on the next compile
- **Graceful degradation:** Paywalled/JS-heavy content falls back to Gemini summary
- **Pluggable search:** Article-per-file structure supports vector search without restructuring
- **Remote access:** Cloudflare Tunnel + Cloudflare HTTPS, accessible from any device anywhere
- **Ingest unchanged:** YouTube playlist, Gmail label, Google Tasks — all existing zero-friction workflows preserved
