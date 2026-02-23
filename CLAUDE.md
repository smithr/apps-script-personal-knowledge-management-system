# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Google Apps Script that monitors a YouTube playlist, summarizes new videos using the Gemini API, and emails the summaries. It is designed as a personal knowledge management (PKM) tool — helping the user triage and retain knowledge from video content.

## Deployment Workflow (clasp)

This project uses [clasp](https://github.com/google/clasp) to sync local files with Google Apps Script. The script runs in the cloud; there is no local execution.

```bash
# Push local changes to Apps Script
clasp push

# Pull current remote state
clasp pull

# Open the script in the browser
clasp open
```

`Code.js` is the sole source file. The `.clasp.json` links this directory to the remote Apps Script project (`scriptId`).

## Architecture

**Single-file script** (`Code.js`) with these main functions:

- `processYouTubePlaylist()` — entry point, called by a time-driven trigger; orchestrates the full pipeline
- `getVideosFromPlaylist(playlistId)` — calls YouTube Data API v3 (via Advanced Service `YouTube`) with pagination
- `summarizeYouTubeVideo(videoUrl)` — calls Gemini REST API directly via `UrlFetchApp`; returns HTML
- `getProcessedVideoIds()` / `updateProcessedVideoIds()` — deduplication via Script Properties (`processedVideoIds` key stores a JSON array of video IDs)

**State storage:** Script Properties (not a Sheet) track which videos have already been processed. The `DEBUG: true` flag in `config` clears this state on each run for testing.

## Configuration (Script Properties)

All secrets and user-specific values live in Apps Script Script Properties — never in code:

| Property | Description |
|---|---|
| `EMAIL_ADDRESS` | Gmail address to send summaries to |
| `YOUTUBE_PLAYLIST_ID` | Target playlist ID (not built-in playlists like Watch Later) |
| `GEMINI_API_KEY` | API key from Google Cloud Console |

`GEMINI_MODEL` is set directly in the `config` object in code (currently `gemini-3-flash-preview`).

## Runtime Context

- Runs on Google's V8 runtime (see `appsscript.json`)
- Advanced Services enabled: YouTube Data API v3, Gmail API v1
- No `npm`, no local test runner — testing is done by running `processYouTubePlaylist` directly in the Apps Script editor
- Logs visible in Apps Script editor via `Logger.log()` and in Google Cloud Stackdriver

## Testing

Set `DEBUG: true` in the `config` object before running to force reprocessing of all playlist videos (clears the `processedVideoIds` Script Property). Reset to `false` before deploying to avoid redundant emails.
