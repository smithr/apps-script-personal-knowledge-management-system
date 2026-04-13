# PKM Wiki — Design Spec
**Date:** 2026-04-13

## Overview

A weekly-generated, Google Docs-based knowledge wiki layered on top of the existing PKM pipeline. Each topic group gets a stable `.gdoc` synthesizing all saved items into a living reference article. A top-level index doc maps the full knowledge base. No new UI rendering — the web app links to Drive docs directly.

Inspired by the Karpathy "second brain" model: Topic Docs are the raw layer, wiki articles are the organized synthesis layer.

---

## Goals

- One wiki article per Config topic group, rebuilt weekly from saved items
- Each article contains: narrative overview, key terms glossary, recurring themes, action items, recent additions, related topics
- A `Wiki-Index.gdoc` that maps all topics with one-line descriptions and cross-links
- Seamless integration with existing Apps Script / Google Docs infrastructure
- No performance-sensitive custom UI — wiki content is read natively in Drive

---

## Architecture

### New File
- **`Wiki.js`** — all wiki generation logic (`buildWiki`, `buildWikiPrompt`, `callGeminiForWiki`, `parseWikiJson`, `writeWikiDoc`, `buildIndexPrompt`, `writeIndexDoc`, `getOrCreateWikiFolder`, `getOrCreateWikiDoc`)

### Modified Files
- **`Code.js`** — adds `runWeeklyWiki()` trigger entry point
- **`WebApp.js`** — adds "Wiki" nav link that opens `Wiki-Index.gdoc` in Drive

### Drive Structure
```
/PKM (DRIVE_ROOT_FOLDER_ID)
  /Wiki/                        ← new, created on first run
    Wiki-Index.gdoc             ← top-level topic map
    [group-name].gdoc           ← one per Config group
```

### New Script Properties
| Key | Description |
|---|---|
| `WIKI_FOLDER_ID` | Drive folder ID for wiki docs |
| `WIKI_INDEX_DOC_ID` | Doc ID for the Wiki-Index |
| `WIKI_DOC_[GROUPNAME]` | Doc ID per group — group name uppercased, spaces replaced with `_` (e.g. `WIKI_DOC_MACHINE_LEARNING`) |

Doc IDs are cached after first creation so subsequent runs skip Drive folder scans.

---

## Data Flow

1. `runWeeklyWiki` → `buildWiki()`
2. Read Config sheet → get all topic groups and their tags
3. Read library index JSON from Drive → group items by their tags
4. For each group:
   - Build prompt from items' `shortSummary`, `keyTerms`, `keyPoints`
   - Call Gemini → parse structured JSON response
   - Write/overwrite group's `.gdoc` via Docs REST API `batchUpdate`
5. After all group articles written:
   - Build index prompt from each group's `overview`
   - Call Gemini → parse index JSON
   - Write/overwrite `Wiki-Index.gdoc`
6. Log summary of groups processed / skipped

---

## Gemini Schema

### Per-Group Article Prompt
Sends one block per saved item:
```
Title: [title]
Date: [date]
Source: [sourceType]
Tags: [tags]
Summary: [shortSummary]
Key Terms: [keyTerms joined]
Key Points: [keyPoints joined]
```

Instruction: synthesize into a wiki article for topic group `[name]`, identifying related topics from the list `[all other group names]`.

**Response JSON:**
```json
{
  "overview": "3-5 sentence narrative synthesis",
  "keyTerms": [{ "term": "...", "definition": "..." }],
  "recurringThemes": ["theme 1", "theme 2"],
  "actionItems": ["action 1"],
  "relatedTopics": [{ "group": "...", "reason": "one sentence" }]
}
```

### Index Prompt
Sends each group name + its `overview`. Asks for a knowledge base map.

**Response JSON:**
```json
{
  "summary": "one paragraph describing the full knowledge base",
  "topics": [{ "group": "...", "description": "one-line description" }]
}
```

---

## Doc Format

Each wiki article is a plain-text Google Doc (no heading styles), consistent with existing Topic Docs:

```
[Group Name] — Knowledge Wiki
Last updated: [ISO date]
─────────────────────────────

OVERVIEW
[narrative paragraph]

KEY TERMS
[Term]: [definition]
...

RECURRING THEMES
• [theme]
...

ACTION ITEMS
• [action]
...

RECENT ADDITIONS (last 5)
[date] — [title]: [shortSummary]
...

RELATED TOPICS
[Group]: [reason]
...
```

**Doc lifecycle:** On first run, a new doc is created and its ID cached. On subsequent runs, the doc body is cleared via `deleteContentRange` then rewritten — same URL every week, bookmark-stable.

---

## Error Handling

- Per-group try/catch: a failed group is logged and skipped; other groups still process
- A failed group retains its previous doc untouched (overwrite only happens on success)
- Index generation is attempted even if some groups failed (uses whichever articles succeeded)
- Follows same pattern as `runWeeklySynthesis` in `Synthesis.js`

---

## Trigger Schedule

| Function | Suggested schedule |
|---|---|
| `runWeeklyWiki` | Sunday night, after `archiveProcessedItems` |

Rationale: runs after the weekly archive so the wiki reflects fully-committed knowledge, not in-progress inbox items.

---

## Web App Integration

The existing library view nav gets one addition: a **"Wiki"** link that opens `Wiki-Index.gdoc` in Drive. Implementation: one `google.script.run` call to fetch the cached `WIKI_INDEX_DOC_ID`, then `window.open` to the Drive URL. No wiki content is rendered in the web app.

---

## Out of Scope

- Wiki search UI
- Diff/changelog between weekly runs
- Per-item deep links from wiki articles
- Email notification on wiki rebuild
- Heading styles or rich formatting in wiki docs
