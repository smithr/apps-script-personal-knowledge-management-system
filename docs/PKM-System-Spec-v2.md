# PKM System — High Level Specification & Design

**Version:** 2.0  
**Date:** February 2026  
**Status:** Draft

---

## 1. Overview

### 1.1 Purpose

A personal knowledge management (PKM) system that automatically collects content from YouTube, Gmail, and Google Tasks, summarizes it using an LLM, routes summaries to the user for approval via email, and commits approved items to a structured Google Sheets and Docs knowledge base — making accumulated knowledge queryable and synthesizable via NotebookLM.

### 1.2 Goals

- Reduce friction between encountering interesting content and capturing it meaningfully
- Ensure nothing reaches permanent storage without deliberate human approval
- Produce summaries rich enough to make triage decisions without opening the original source
- Organize stored knowledge in a way that supports synthesis across topics over time
- Operate with zero infrastructure — no servers, no hosting, no maintenance overhead
- Stay entirely within the Google ecosystem for maximum integration simplicity

### 1.3 Non-Goals

- Full-text search across stored notes (Sheets filtering and NotebookLM handle this)
- Real-time ingestion (periodic polling is sufficient)
- Collaborative or multi-user access
- Mobile-native experience (mobile-friendly email and Sheets are sufficient)

---

## 2. Architecture Overview

The system is a single Google Apps Script project containing multiple files, bound to a Google Sheet, and connected to external APIs. It operates in two phases separated by a human approval step. The project is developed locally using clasp and pushed to Apps Script for execution.

```
┌─────────────────────────────────────────────────────┐
│                  PHASE 1: COLLECT                   │
│                                                     │
│  YouTube API ──┐                                    │
│  Gmail API ────┼──► Source Connectors               │
│  Tasks API ────┘         │                          │
│                          ▼                          │
│               Deduplication Check                   │
│                          │                          │
│                          ▼                          │
│               Gemini Summarization                  │
│                          │                          │
│                          ▼                          │
│               Sheets Inbox (Pending)                │
└─────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│                 DIGEST DELIVERY                     │
│                                                     │
│     Digest Email → User (multiple times/day)        │
│     [Save] or [Dismiss] links per item              │
└─────────────────────────────────────────────────────┘
                           │
                    User clicks link
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│                  PHASE 2: COMMIT                    │
│                                                     │
│     Web App Endpoint (doGet)                        │
│          │                    │                     │
│        Save                Dismiss                  │
│          │                    │                     │
│          ▼                    ▼                     │
│     Docs Writer        Status Update                │
│          │                                          │
│          ▼                                          │
│     Drive Topic Docs                                │
│          │                                          │
│          ▼                                          │
│     NotebookLM Notebooks                            │
└─────────────────────────────────────────────────────┘
```

---

## 3. Component Specifications

### 3.1 Source Connectors

Each connector is responsible for fetching new content from one source, normalizing it into a standard item structure, and passing it downstream. All connectors check the deduplication store before passing items forward.

**Normalized Item Structure**
```
{
  id:          string   // Source-specific unique ID
  sourceType:  string   // 'YouTube' | 'Gmail' | 'Tasks'
  title:       string   // Video title, email subject, or task title
  url:         string   // Link to original content
  content:     string   // Raw content for Gmail/Tasks; URL passed to Gemini for YouTube
  dateAdded:   string   // ISO timestamp of when item was fetched
  rawMetadata: object   // Source-specific extras (playlist name, label name, task notes)
}
```

**YouTube Connector**
- Uses YouTube Data API v3 to list videos in one or more configured playlists
- Detects new additions by comparing video IDs against the deduplication store
- Passes the video URL directly to Gemini — no transcript extraction required
- Gemini's native video understanding handles summarization from the URL alone
- Polls on a daily schedule

**Gmail Connector**
- Uses Apps Script's native Gmail service (`GmailApp`) to search for messages matching a configured label
- Fetches message subject, sender, and body (plain text preferred, HTML stripped)
- Marks messages as processed by storing their message ID in the deduplication store
- Polls every 15–30 minutes

**Google Tasks Connector**
- Uses Apps Script's native Tasks service (`Tasks`) — no API key or OAuth token required beyond standard Google account scopes
- Monitors a configured task list (default list or a dedicated PKM inbox list)
- Fetches task title and notes field (used to capture URLs or additional context)
- Marks tasks as completed after processing so they clear from the active list naturally
- Polls every 15–30 minutes

---

### 3.2 Scheduler / Trigger Layer

Two time-based Apps Script triggers manage the polling cadence:

| Trigger | Frequency | Runs |
|---|---|---|
| `runFrequentPipeline` | Every 15–30 min | Gmail, Tasks connectors |
| `runHourlyPipeline` | Every hour | YouTube connector |
| `sendDigest` | Multiple times/day | Frequent digest — new unseen items with full summaries |
| `sendWeeklyDigest` | Once weekly | Compact recap of all still-pending items, no summaries |
| `archiveProcessedItems` | Weekly or manual | Moves Saved/Dismissed rows from Inbox to Archive tab |

All triggers are managed within the Apps Script project's trigger dashboard. No external scheduler or cron is required.

---

### 3.3 Deduplication Store

A lightweight ID registry stored in Apps Script's `PropertiesService` as a JSON array. Before any item enters the summarization step, its source ID is checked here. After processing, the ID is added to the store.

The store is capped at 2,000 entries (rolling window) to stay within PropertiesService's 500KB storage limit. For a personal-scale system this is more than sufficient.

---

### 3.4 Summarization Engine

Calls the Gemini API with each new item and a source-specific prompt template. Gemini's native video understanding means YouTube URLs are passed directly — no transcript extraction step is required.

**Output Schema (JSON)**
```json
{
  "shortSummary": "2–3 sentence summary for triage",
  "fullSummary":  "Detailed summary with key points",
  "tags":         ["tag1", "tag2"],
  "keyTerms":     ["TermName: one-sentence definition", "AnotherTerm: definition"],
  "keyPoints":    ["point 1", "point 2"],
  "actionItems":  ["action 1"]
}
```

`keyTerms` contains 3–8 named concepts, tools, frameworks, or jargon from the source, each with a one-sentence definition using exact source terminology. This field is designed to improve NotebookLM query recall by ensuring precise terminology is preserved.

The engine instructs Gemini to return only valid JSON with no preamble or markdown fences, making the response safe to parse directly with `JSON.parse()`. The full JSON object is stored in the Sheets Inbox (col K) so all fields are available at save time — no data is lost between ingest and Doc commit.

---

### 3.5 Prompt Template Library

One prompt per source type, stored as constants in `Gemini.js`. Each prompt specifies the desired output schema, the level of detail expected, and source-specific instructions:

- **YouTube:** timestamps in concept headings (MM:SS format); focus on practical takeaways and whether the content is worth deeper engagement; video frames sampled at 0.1 fps to reduce token usage
- **Gmail:** flag any action items, deadlines, or decisions required; identify sender intent
- **Tasks:** treat the task title as a topic or URL to research and summarize; use the notes field for additional context

All prompts share the same base `fullSummary` instructions: preserve exact source terminology, state conclusions as direct claims rather than attributed opinions, include specific numbers and tool names, and produce dense concept-per-paragraph formatting. The YouTube prompt uses a variant that adds timestamp format to concept headings.

All prompts include a `keyTerms` instruction: extract 3–8 named concepts, tools, or frameworks with one-sentence definitions using exact source terminology.

Prompts are versioned in code comments so changes can be tracked over time.

---

### 3.6 Sheets Index

The master metadata database. One Google Sheet with three tabs:

**Inbox Tab** — active triage queue

| Column | Description |
|---|---|
| A — Item ID | UUID generated at ingest time |
| B — Date Added | ISO timestamp |
| C — Source Type | YouTube / Gmail / Tasks |
| D — Title | Content title or subject |
| E — Original URL | Link to source |
| F — Summary | Full summary text (human-readable) |
| G — Tags | Comma-separated topic tags |
| H — Status | Pending / Saved / Dismissed |
| I — Digest Sent | Boolean — has this been included in a digest |
| J — Doc Link | Deep link to section in aggregate Topic Doc (populated post-approval) |
| K — Summary JSON | Raw Gemini JSON blob (all fields including keyTerms, keyPoints, actionItems) — used internally at save time |

**Archive Tab** — same columns as Inbox; Saved and Dismissed items move here periodically to keep the Inbox tab performant.

**Config Tab** — maps topic tags to Drive folders and optional group names.

| Column | Description |
|---|---|
| A — Tag | Topic tag name (must match Gemini output exactly, case-insensitive) |
| B — Folder ID | Drive folder ID where Topic Docs for this tag are stored |
| C — Group | Optional. When set, tags sharing the same folder ID and group name write to a single consolidated Doc instead of separate per-tag Docs (e.g. "leadership" and "management" both pointing to the same folder with group "leadership-management") |

---

### 3.7 Docs Writer

Manages aggregate Topic Docs in Google Drive. On approval it:

1. Reads the item's tags from the Sheets row
2. Looks up the corresponding Drive folder ID from the Config tab
3. Finds the current active quarterly Doc for that topic (e.g. `AI-Research - 2026-Q1`)
4. Appends a formatted section with a consistent structure:
   - Metadata header: date, source type, original URL
   - Full summary
   - Key Terms (named concepts with definitions — omitted if empty)
   - Key Points (omitted if empty)
   - Action Items (omitted if empty)
5. Returns a deep link anchor to the appended section
6. Updates the Sheets row with the Doc link and changes status to `Saved`

**Tag Grouping:** Tags that share the same Drive folder ID and group name (configured in the Config tab, col C) are written to the same Doc. This allows related tags like "leadership" and "management" to consolidate into a single "leadership-management" Doc rather than creating two separate Docs. When an item has multiple tags that resolve to the same group, the entry is written once.

**Doc Rotation:** When a Topic Doc reaches approximately 50 items or end of quarter, a new Doc is created automatically. The old Doc remains in Drive and stays available as a NotebookLM source.

**Drive Folder Structure**
```
/PKM (root)
  /Projects
    /[Project Name]
      [Project Name] - Notes.doc
  /Topics
    /TopicOne
      TopicOne - 2026-Q1.doc
      TopicOne - 2026-Q2.doc
    /TopicTwo
      TopicTwo - 2026-Q1.doc
  /Archive
```

---

### 3.8 Digest Delivery

Two complementary digest functions handle different review cadences.

**Frequent Digest (`sendDigest`)** — runs multiple times per day. Queries the Inbox for rows where `Status = Pending` and `Digest Sent = false`. Each item is rendered as a full card:
- Source type badge and date
- Title (linked to original URL)
- Full summary
- Suggested tags
- **[Save to PKM]** and **[Dismiss]** action links

After sending, all included items have their `Digest Sent` flag set to `true` so they are not repeated in subsequent runs.

**Weekly Recap (`sendWeeklyDigest`)** — runs once per week. Queries the Inbox for all rows where `Status = Pending`, regardless of `Digest Sent`. Sends a compact table — no summaries, just source badge, linked title, date, and Save/Dismiss links. Does not update the `Digest Sent` flag. Useful as a catch-all reminder for items that were seen in the frequent digest but not yet actioned.

**Inbox Archiving (`archiveProcessedItems`)** — not an email function but complements the digest workflow. Moves all Saved and Dismissed rows from the Inbox tab to the Archive tab, keeping the Inbox lean. Safe to run repeatedly; only rows with a terminal status are moved. Recommended schedule: weekly, before the weekly recap runs so the recap reflects only genuinely unactioned items.

---

### 3.9 Web App Endpoint

A `doGet` function published as a deployed Apps Script web app. Receives approval actions from digest email link clicks.

**Request Parameters**
```
?id=ITEM_ID&action=save|dismiss
```

**Behavior**
- Validates the item ID exists in Sheets
- Checks current status — ignores the action if already Saved or Dismissed (idempotent)
- For `save`: calls Docs Writer, updates Sheets status to `Saved`
- For `dismiss`: updates Sheets status to `Dismissed`
- Returns a minimal HTML confirmation page viewable in the browser

**Security:** The web app is deployed to run as the script owner with access restricted to the owner's Google account. Approval links only function when the user is authenticated, preventing unintended saves if a link is forwarded.

---

### 3.10 NotebookLM Integration

NotebookLM is not a built component but a maintained configuration layer. Topic Doc folders in Drive are added as sources to corresponding NotebookLM notebooks.

**Notebook Structure**
- One notebook per active Project (scoped, finite corpus)
- One notebook per major Topic (ongoing, growing corpus)

Notebooks are manually curated — the pipeline produces the Docs, the user decides which notebooks they belong to. This curation step is intentional: it forces periodic review of what's worth synthesizing across.

---

## 4. Data Flow Summary

```
New Content Detected
       │
       ▼
Deduplication Check ──► Already seen → Skip
       │
       ▼
Gemini Summarization
       │
       ▼
Write to Sheets Inbox (Status: Pending)
       │
       ▼ (on digest schedule)
Compose & Send Digest Email
       │
       ▼ (user clicks link)
Web App Endpoint receives action
       │
    ┌──┴──┐
  Save  Dismiss
    │      │
    │    Update Sheets (Dismissed)
    │
    ▼
Docs Writer appends to Topic Doc
    │
    ▼
Update Sheets row (Saved + Doc Link)
    │
    ▼
Available in NotebookLM notebook
```

---

## 5. Configuration Reference

All configuration is stored in Apps Script Script Properties. No configuration is hardcoded in source files.

| Property Key | Description |
|---|---|
| `GEMINI_API_KEY` | Gemini API key from Google AI Studio |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key from Google Cloud Console |
| `YOUTUBE_PLAYLIST_IDS` | Comma-separated playlist IDs to monitor |
| `TASKS_LIST_ID` | Google Tasks list ID (`@default` for default list) |
| `GMAIL_LABEL` | Gmail label name to monitor (e.g. `PKM`) |
| `DIGEST_EMAIL` | Email address to receive digest emails |
| `SHEET_ID` | Google Sheets spreadsheet ID |
| `DRIVE_ROOT_FOLDER_ID` | Root Drive folder ID for Topic Docs |
| `WEBAPP_URL` | Deployed web app URL (set after first deploy) |
| `PROCESSED_IDS` | JSON array of processed item IDs (managed by system) |

---

## 6. File Structure

```
PKM-System/                  ← local project root
│
├── .clasp.json              ← clasp config linking to Apps Script project
├── appsscript.json          ← Apps Script manifest (scopes, timezone, etc.)
│
├── Code.gs                  ← Main entry points and trigger functions
├── Config.gs                ← Constants, property accessors, shared enums
├── Utils.gs                 ← Shared helpers, ID generation, normalization
├── YouTube.gs               ← YouTube source connector
├── Gmail.gs                 ← Gmail source connector
├── Tasks.gs                 ← Google Tasks source connector
├── Gemini.gs                ← Summarization engine and prompt templates
├── Sheets.gs                ← Sheets read/write operations
├── Docs.gs                  ← Topic Doc creation and append logic
├── Digest.gs                ← Digest email composition and delivery
└── WebApp.gs                ← doGet approval endpoint
```

---

## 7. Local Development Setup (clasp)

The project is developed locally using [clasp](https://github.com/google/clasp), Google's command-line tool for Apps Script. This allows all `.gs` files to be edited locally in any editor or with Claude Code, then pushed to Apps Script for execution.

### 7.1 Prerequisites

- Node.js 18 or later
- A Google account with Apps Script enabled
- A Google Cloud project with the following APIs enabled:
  - YouTube Data API v3
  - Google Sheets API
  - Google Drive API
  - Google Docs API
  - Tasks API

### 7.2 Initial Setup

```bash
# Install clasp globally
npm install -g @google/clasp

# Authenticate with your Google account
clasp login

# Create a new project folder
mkdir pkm-system && cd pkm-system

# Create the Apps Script project bound to a new Sheet
# (or use --type standalone and bind manually)
clasp create --type sheets --title "PKM System"
```

This creates `.clasp.json` in your project folder linking to the remote Apps Script project.

### 7.3 Development Workflow

```bash
# Push local changes to Apps Script
clasp push

# Open the Apps Script editor in the browser
clasp open

# Pull remote changes back to local (if edited in browser)
clasp pull
```

All testing and trigger management is done in the Apps Script browser editor after pushing. Apps Script cannot be executed locally — `clasp push` deploys files to Google's servers where they run.

### 7.4 Apps Script Manifest (appsscript.json)

The manifest must declare OAuth scopes explicitly. Use this as your starting `appsscript.json`:

```json
{
  "timeZone": "YOURTIMEZONE_GOES_HERE",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
```

Update `timeZone` to match your local timezone (e.g., "America/Chicago")

---

## 8. Build Sequence

Components are built in dependency order so each step produces a testable increment:

1. **Sheets Structure** — create tabs and column headers manually in Google Sheets
2. **Config.js** — property accessors, constants, enums
3. **Utils.js** — shared helpers, UUID generation, deduplication store
4. **Gemini.js** — summarization engine with prompt templates
5. **YouTube.js** — first source connector *(milestone: YouTube → Sheets end-to-end)*
6. **Digest.js** — digest email with placeholder approval links *(milestone: email delivery working)*
7. **WebApp.js** — approval endpoint *(milestone: Save/Dismiss flow working)*
8. **Docs.js** — Topic Doc writer *(milestone: full Save path complete)*
9. **Gmail.js** — second source connector
10. **Tasks.js** — third source connector
11. **Code.js** — wire all triggers, finalize scheduling

Each step after step 5 can be tested independently before moving to the next.

---

## 9. Key Design Decisions

**Single Apps Script project** — simplifies API key management, OAuth configuration, trigger management, and logging. All components share one `PropertiesService` namespace and one deployed web app URL.

**Google Tasks over Trello** — Tasks is a native Google service requiring no API key or external OAuth token. The Apps Script `Tasks` service provides first-class integration identical to Gmail. For a simple capture inbox, Tasks is sufficient and removes all external service dependencies from the system.

**Approval before storage** — nothing reaches permanent Docs storage without explicit user action. Summaries held in Sheets are cheap to store and easy to clear; Doc entries represent deliberate knowledge capture.

**Aggregate Topic Docs over per-item Docs** — keeps Drive organized, stays within NotebookLM's 50-source limit per notebook, and ensures each notebook source is substantively useful rather than a thin single-item file.

**Gemini for video summarization** — eliminates the need for transcript extraction by passing YouTube URLs directly. This removes a significant technical dependency and simplifies the YouTube connector considerably.

**Digest email as reading surface** — decouples content arrival from content review, batches triage into intentional sessions, and keeps the approval UX entirely within email with no separate tool to open.

**clasp for local development** — enables the use of Claude Code or any local editor for development, provides a proper file structure for version control, and makes the codebase portable and reviewable outside the browser-based Apps Script editor.

---

## 10. Limitations and Known Constraints

- Apps Script has a 6-minute execution time limit per run (30 minutes on Workspace Business/Enterprise). Incremental polling keeps individual runs well within this limit.
- `PropertiesService` has a total storage limit of 500KB. The deduplication store is capped at 2,000 IDs (~40KB) to stay safely within limits.
- NotebookLM notebooks support up to 50 sources. Quarterly Doc rotation and topic-scoped notebooks keep this manageable.
- Apps Script cannot be run locally — all execution happens on Google's servers. The development workflow is: edit locally with clasp → push → test in Apps Script editor.
- Gemini video understanding works with public YouTube URLs. Private or unlisted videos may not be accessible.
- Google Tasks has limited metadata compared to tools like Trello — only title, notes, and due date are available. This is sufficient for a simple capture inbox.

---

## 11. Getting Started with Claude Code

### 11.1 Recommended Opening Prompt

Once the project is scaffolded with clasp, start a Claude Code session in the project folder and use this prompt:

```
I'm building a personal knowledge management system using 
Google Apps Script, developed locally with clasp.

The full design spec is in @PKM-System-Spec-v2.md. Please 
read it carefully before writing any code.

I already have Config.js written — see @Config.js.

Please start by:
1. Scaffolding all remaining .js files with the correct 
   structure and placeholder functions based on the spec
2. Then implement Utils.js in full
```

### 11.2 Effective Prompting Tips

- Reference files with `@filename` so Claude Code reads them directly
- Ask Claude Code to implement one file at a time and confirm before moving on
- After each file is complete, push with `clasp push` and do a quick smoke test in the Apps Script editor before proceeding
- If a function produces unexpected output, paste the Apps Script execution log directly into Claude Code for debugging


