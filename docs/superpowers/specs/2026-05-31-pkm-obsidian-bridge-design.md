# PKM → Obsidian Bridge Design Spec
Date: 2026-05-31

## Problem

The current PKM system excels at collection, summarization, and triage but does not compound. Knowledge is saved to Google Docs (human-readable archive) and a custom wiki layer (Wiki.js, Synthesis.js) that regenerates from scratch and has no knowledge graph. The Linux server plan (2026-05-10) would have built a custom compounding wiki + FastAPI web app, but that approach is being replaced by the claude-obsidian plugin, which provides a richer, lower-infrastructure solution.

## Goal

Bridge the existing Google Apps Script PKM pipeline to an Obsidian vault managed by claude-obsidian. The vault becomes a compounding knowledge graph — connecting external sources (YouTube, Gmail, Tasks) with the user's own principles and frameworks — queryable and explorable via Claude Code skills.

---

## Data Flow

```
Google Apps Script (existing, unchanged)
  YouTube playlist → Gemini summary → Sheets Inbox
  Gmail label     → Gemini summary → Sheets Inbox
  Google Tasks    → Gemini summary → Sheets Inbox
        ↓
  Digest email → user triage → WebApp.js (existing)
        ↓
  handleSaveConfirm (existing: writes to Google Doc — kept as archive)
        ↓  NEW
  RawStore.js → writes markdown to Drive /PKM/raw/
        ↓
  Google Drive for Desktop (Windows) syncs /PKM/raw/ → vault .raw/
        ↓
  /wiki-ingest  (claude-obsidian skill, run in Claude Code session)
        ↓
  vault wiki/   ← entity articles, concept articles, topic MOCs, index
        ↓
  Obsidian graph view + /wiki-query + /autoresearch + /save
```

Google Docs output is kept as the human-readable archive. The Drive raw files are the machine-readable input for the wiki. No Linux server, no FastAPI app, no cron jobs.

---

## Vault Structure

```
your-vault/
  .raw/                         ← Drive for Desktop syncs here
    {itemId}-{slug}.md          ← approved PKM items (one file per item)
    insights/
      {timestamp}-{slug}.md     ← Q&A insights saved via /save during sessions
  wiki/
    index.md                    ← routing document (all topics, entities, concepts)
    topics/                     ← MOC pages (navigational, not content)
      leadership-management.md
      fitness.md
      career.md
      ...
    entities/                   ← one article per concrete thing
      atomic-habits.md
      andy-grove.md
      okr-framework.md
      zone-2-training.md
      ...
    concepts/                   ← emergent cross-cutting ideas (wikilinks to entities)
      feedback-loops.md
      habit-formation.md
      compounding-returns.md
      ...
  principles/                   ← user's own frameworks, captured via /save
    {slug}.md
```

**Granularity:** Entity-level, not topic-level. PKM tag groups (from Config.js) are the routing signal that tells `/wiki-ingest` which topic MOC to link a new entity into — but content lives at entity level. This keeps the Obsidian knowledge graph meaningful as the vault grows.

### Raw File Format

```markdown
---
id: {itemId}
title: {title}
url: {url}
date: {ISO timestamp}
sourceType: youtube|gmail|task|web
tags: [tag1, tag2]
shortSummary: {Gemini short summary}
---

{full text body}
```

Filename: `{itemId}-{title-slug}.md`

---

## RawStore.js — Content Capture by Source

Called from `WebApp.js handleSaveConfirm` after the existing Google Doc write succeeds.

| Source | Full-text strategy |
|---|---|
| YouTube | Fetch video page → parse `ytInitialPlayerResponse` JSON from `<script>` tag → extract caption track URL → fetch transcript XML → strip timing tags to plain text. Falls back to `shortSummary` if no captions. |
| Gmail | Full email body (already in scope via GmailApp) |
| Task (plain) | Title + notes field |
| Task (URL) | `UrlFetchApp` fetch → HTML tag strip. Falls back to `shortSummary`. |

**Graceful degradation:** All sources fall back to `shortSummary` if full-text capture fails. The wiki still compounds from what it has.

---

## Personal Principles Workflow

Principles are not pre-written — they are captured organically in two modes:

**Reactive:** During a `/wiki-query` problem-solving session, the user articulates a belief. They run `/save` with a title and a few sentences. The principle lands in `principles/` as a first-class wiki node and is connected to related entities and concepts on the next `/wiki-ingest`.

**Deliberate (one-time bootstrap):** A principles review session in Claude Code. The user shares existing scattered notes; Claude helps distill them into individual principle articles, each saved via `/save`. This bootstraps the principles layer before the live pipeline starts.

Principles participate in the knowledge graph identically to external sources. A `/wiki-query` answer can draw from both a saved YouTube talk and a personal principle — weighted by relevance, not by whether the source was external or internal.

---

## Backfill

A one-time script processes the existing ~200 library items from `pkm-library-index.json` into `.raw/` markdown files directly in the vault (no Drive sync needed — runs locally in WSL2).

- Web articles: `trafilatura` for body text extraction
- YouTube: `shortSummary` fallback (transcript extraction via `ytInitialPlayerResponse` is Apps Script-only; trafilatura cannot process YouTube)
- Paywalled / JS-heavy: `shortSummary` fallback

After the backfill, one `/wiki-ingest` session builds the initial wiki from all items. From that point, Drive for Desktop handles new items automatically.

---

## Apps Script Changes

### New
- `RawStore.js` — Drive write logic, per-source content capture, YouTube transcript extraction

### Unchanged
- `YouTube.js`, `Gmail.js`, `Tasks.js` — all ingest connectors
- `Gemini.js` — summarization engine
- `Sheets.js`, `Digest.js` (frequent digest), `WebApp.js` — triage flow
- Google Docs output — kept as human-readable archive

### Deprecated (remove triggers; delete files after confirming wiki is stable)
- `Wiki.js` — replaced by `/wiki-ingest`
- `Synthesis.js` — replaced by `/wiki-query` and `/autoresearch`
- `sendWeeklyDigest` in `Digest.js` — replaced by on-demand `/wiki-query`

### Abandoned
- Linux server plan (`docs/superpowers/plans/2026-05-10-linux-server-wiki.md`)
- `sync.py`, `compile.py`, `web_app.py`, `backfill.py` (Python server approach)
- FastAPI, nginx, cloudflared, systemd services

---

## Key Properties

- **No server infrastructure:** Drive for Desktop is the only sync mechanism. No Linux server, no cron jobs, no exposed ports.
- **Entity-level granularity:** Hundreds of interconnected wiki nodes, not a handful of topic blobs. Obsidian graph is meaningful.
- **Principles as first-class nodes:** User's own frameworks connect to external knowledge in the graph; problem-solving sessions draw from both.
- **On-demand compilation:** `/wiki-ingest` runs when the user opens a Claude Code session, not on a cron. Acceptable tradeoff for zero infrastructure.
- **Graceful degradation:** All sources fall back to Gemini shortSummary if full-text capture fails.
- **Ingest unchanged:** YouTube playlist, Gmail label, Google Tasks — all existing zero-friction workflows preserved.
- **Future mobile access:** Obsidian Sync enables mobile access if the system proves valuable.
- **Vault location:** Start with the vault on the Windows filesystem — Drive for Desktop and Obsidian both run natively there. Claude Code accesses it via `/mnt/c/`. If `/wiki-ingest` performance is unacceptable as the vault grows, migrate the vault to the WSL2 Linux filesystem; Obsidian for Windows can open it via `\\wsl$\Ubuntu\...`.
