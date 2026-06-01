# Linux Server Wiki Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Linux server pipeline that polls Drive for raw markdown files, compiles them into a compounding wiki via Gemini, and serves a FastAPI web app with wiki browsing, search, and Q&A.

**Architecture:** Drive sync cron downloads new raw items from /PKM/raw/; wiki compiler cron (offset 10 min) feeds each topic's current article + new items to Gemini and writes the updated article back; FastAPI web app always-on serves browse/search/Q&A with HTMX, accessible remotely via Cloudflare Tunnel.

**Tech Stack:** Python 3.11+, FastAPI, Jinja2, HTMX, mistune (markdown), python-frontmatter, trafilatura, google-api-python-client (Drive), requests (Gemini REST), pytest, nginx, cloudflared

---

## File Structure

```
server/
  config.py              ← env var loader (PKM_DATA_DIR, GEMINI_API_KEY, etc.)
  sync.py                ← Drive sync cron script
  compile.py             ← wiki compiler cron script
  backfill.py            ← one-time backfill from pkm-library-index.json
  web_app.py             ← FastAPI application
  requirements.txt       ← Python dependencies
  templates/
    base.html            ← shared layout with HTMX CDN
    wiki.html            ← wiki browser view
    search.html          ← search results view
    qa.html              ← Q&A view
  tests/
    conftest.py          ← shared fixtures (tmp data dir, mock Drive, mock Gemini)
    test_sync.py         ← sync.py unit tests
    test_compile.py      ← compile.py unit tests
    test_web_app.py      ← FastAPI route tests (TestClient)
    test_backfill.py     ← backfill.py unit tests
  infra/
    pkm-sync.cron        ← crontab entry for sync
    pkm-compile.cron     ← crontab entry for compile
    pkm-web.service      ← systemd unit for web app
    nginx.conf           ← nginx reverse proxy config snippet
    cloudflared-setup.md ← cloudflared install + tunnel creation steps
```

Data directory (configurable via `PKM_DATA_DIR`, default `/pkm/data`):
```
/pkm/data/
  raw/
    {itemId}-{slug}.md        ← downloaded from Drive
    insights/
      {timestamp}-{slug}.md   ← Q&A insights filed from web app
  wiki/
    index.md
    topics/
      {topic-slug}.md
    concepts/
      {concept-slug}.md
  state/
    last_sync.txt
    last_compile.txt
    library-index.json        ← downloaded from Drive by sync
```

---

## Task 1: Project Scaffold and Config

**Files:**
- Create: `server/config.py`
- Create: `server/requirements.txt`
- Create: `server/tests/conftest.py`

- [ ] **Step 1: Write `server/requirements.txt`**

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
jinja2==3.1.4
python-frontmatter==1.1.0
mistune==3.0.2
google-api-python-client==2.143.0
google-auth==2.35.0
requests==2.32.3
trafilatura==1.12.0
pytest==8.3.3
httpx==0.27.2
```

- [ ] **Step 2: Write `server/config.py`**

```python
import os
from pathlib import Path

DATA_DIR      = Path(os.environ.get("PKM_DATA_DIR", "/pkm/data"))
RAW_DIR       = DATA_DIR / "raw"
INSIGHTS_DIR  = RAW_DIR / "insights"
WIKI_DIR      = DATA_DIR / "wiki"
TOPICS_DIR    = WIKI_DIR / "topics"
CONCEPTS_DIR  = WIKI_DIR / "concepts"
INDEX_FILE    = WIKI_DIR / "index.md"
STATE_DIR     = DATA_DIR / "state"
LAST_SYNC     = STATE_DIR / "last_sync.txt"
LAST_COMPILE  = STATE_DIR / "last_compile.txt"
LIBRARY_INDEX = STATE_DIR / "library-index.json"

GEMINI_API_KEY    = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL      = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
DRIVE_FOLDER_ID   = os.environ["PKM_DRIVE_FOLDER_ID"]   # Drive /PKM/raw/ folder ID
DRIVE_LIBRARY_ID  = os.environ["PKM_LIBRARY_INDEX_ID"]  # Drive file ID of pkm-library-index.json
SERVICE_ACCOUNT   = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]  # path to service account JSON

GEMINI_DELAY_SECONDS = float(os.environ.get("GEMINI_DELAY_SECONDS", "2"))
GEMINI_RETRY_DELAY   = float(os.environ.get("GEMINI_RETRY_DELAY", "60"))
```

- [ ] **Step 3: Write `server/tests/conftest.py`**

```python
import json
import os
import pytest
from pathlib import Path


@pytest.fixture
def data_dir(tmp_path):
    """Sets PKM_DATA_DIR to a fresh tmp directory and creates all subdirs."""
    dirs = [
        tmp_path / "raw" / "insights",
        tmp_path / "wiki" / "topics",
        tmp_path / "wiki" / "concepts",
        tmp_path / "state",
    ]
    for d in dirs:
        d.mkdir(parents=True)
    os.environ["PKM_DATA_DIR"] = str(tmp_path)
    yield tmp_path
    del os.environ["PKM_DATA_DIR"]


@pytest.fixture
def library_index(data_dir):
    """Writes a minimal library-index.json to state/."""
    index = {
        "tagGroups": {
            "leadership": {"group": "Leadership & Management", "folderId": "f1"},
            "management": {"group": "Leadership & Management", "folderId": "f1"},
            "fitness":    {"group": "Fitness",                 "folderId": "f2"},
        }
    }
    path = data_dir / "state" / "library-index.json"
    path.write_text(json.dumps(index))
    return index


@pytest.fixture(autouse=True)
def mock_env(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY",           "test-key")
    monkeypatch.setenv("PKM_DRIVE_FOLDER_ID",      "drive-folder-id")
    monkeypatch.setenv("PKM_LIBRARY_INDEX_ID",     "library-file-id")
    monkeypatch.setenv("GOOGLE_SERVICE_ACCOUNT_JSON", "/fake/sa.json")
```

- [ ] **Step 4: Create directory structure**

```bash
mkdir -p server/tests server/templates server/infra
touch server/__init__.py server/tests/__init__.py
```

- [ ] **Step 5: Install dependencies**

```bash
cd server && pip install -r requirements.txt
```

Expected: all packages install without error.

- [ ] **Step 6: Commit**

```bash
git add server/
git commit -m "feat(server): scaffold config, requirements, test fixtures"
```

---

## Task 2: Drive Sync

**Files:**
- Create: `server/sync.py`
- Create: `server/tests/test_sync.py`

- [ ] **Step 1: Write failing tests**

```python
# server/tests/test_sync.py
import json
from pathlib import Path
from unittest.mock import MagicMock, patch, call
import pytest


def make_drive_file(file_id, name, modified):
    return {"id": file_id, "name": name, "modifiedTime": modified}


class TestReadLastSync:
    def test_returns_epoch_when_missing(self, data_dir):
        from server.sync import read_last_sync
        assert read_last_sync() == "1970-01-01T00:00:00Z"

    def test_returns_stored_timestamp(self, data_dir):
        from server import config
        config.LAST_SYNC.write_text("2026-01-01T12:00:00Z")
        from server.sync import read_last_sync
        assert read_last_sync() == "2026-01-01T12:00:00Z"


class TestWriteLastSync:
    def test_writes_timestamp(self, data_dir):
        from server.sync import write_last_sync
        write_last_sync("2026-05-10T08:00:00Z")
        from server import config
        assert config.LAST_SYNC.read_text() == "2026-05-10T08:00:00Z"


class TestListNewFiles:
    def test_returns_files_from_drive(self, data_dir):
        from server.sync import list_new_files
        mock_service = MagicMock()
        files = [make_drive_file("id1", "abc-slug.md", "2026-05-10T09:00:00Z")]
        mock_service.files().list().execute.return_value = {"files": files}

        result = list_new_files(mock_service, "2026-01-01T00:00:00Z", "folder-id")

        assert len(result) == 1
        assert result[0]["id"] == "id1"

    def test_returns_empty_when_no_new_files(self, data_dir):
        from server.sync import list_new_files
        mock_service = MagicMock()
        mock_service.files().list().execute.return_value = {"files": []}

        result = list_new_files(mock_service, "2026-05-10T00:00:00Z", "folder-id")
        assert result == []


class TestDownloadFile:
    def test_writes_file_to_dest(self, data_dir):
        from server.sync import download_file
        mock_service = MagicMock()
        mock_service.files().get_media().execute.return_value = b"# content"
        dest = data_dir / "raw" / "test.md"

        download_file(mock_service, "file-id", dest)

        assert dest.read_bytes() == b"# content"


class TestSyncLibraryIndex:
    def test_downloads_library_index(self, data_dir):
        from server.sync import sync_library_index
        mock_service = MagicMock()
        payload = json.dumps({"tagGroups": {}}).encode()
        mock_service.files().get_media().execute.return_value = payload

        sync_library_index(mock_service, "lib-file-id")

        from server import config
        saved = json.loads(config.LIBRARY_INDEX.read_text())
        assert saved == {"tagGroups": {}}
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd server && python -m pytest tests/test_sync.py -v 2>&1 | head -30
```

Expected: `ImportError` or `ModuleNotFoundError` for `server.sync`.

- [ ] **Step 3: Implement `server/sync.py`**

```python
"""Drive sync: downloads new raw files from /PKM/raw/ in Drive."""
import logging
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import io

from server import config

log = logging.getLogger(__name__)
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


def build_drive_service():
    creds = service_account.Credentials.from_service_account_file(
        config.SERVICE_ACCOUNT, scopes=SCOPES
    )
    return build("drive", "v3", credentials=creds)


def read_last_sync() -> str:
    if config.LAST_SYNC.exists():
        return config.LAST_SYNC.read_text().strip()
    return "1970-01-01T00:00:00Z"


def write_last_sync(ts: str) -> None:
    config.LAST_SYNC.write_text(ts)


def list_new_files(service, since: str, folder_id: str) -> list[dict]:
    query = (
        f"'{folder_id}' in parents"
        f" and modifiedTime > '{since}'"
        f" and mimeType != 'application/vnd.google-apps.folder'"
        f" and trashed = false"
    )
    result = (
        service.files()
        .list(q=query, fields="files(id,name,modifiedTime)", orderBy="modifiedTime")
        .execute()
    )
    return result.get("files", [])


def download_file(service, file_id: str, dest: Path) -> None:
    request = service.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    dest.write_bytes(buf.getvalue())
    log.info("Downloaded %s → %s", file_id, dest)


def sync_library_index(service, file_id: str) -> None:
    request = service.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    config.LIBRARY_INDEX.write_bytes(buf.getvalue())
    log.info("Library index synced (%d bytes)", len(buf.getvalue()))


def run_sync() -> None:
    service    = build_drive_service()
    last_sync  = read_last_sync()
    new_files  = list_new_files(service, last_sync, config.DRIVE_FOLDER_ID)
    log.info("Sync: %d new file(s) since %s", len(new_files), last_sync)

    newest_ts  = last_sync
    for f in new_files:
        dest = config.RAW_DIR / f["name"]
        try:
            download_file(service, f["id"], dest)
            if f["modifiedTime"] > newest_ts:
                newest_ts = f["modifiedTime"]
        except Exception as e:
            log.error("Failed to download %s: %s", f["name"], e)

    sync_library_index(service, config.DRIVE_LIBRARY_ID)

    if newest_ts != last_sync:
        write_last_sync(newest_ts)
        log.info("Sync complete. Last sync updated to %s", newest_ts)
    else:
        log.info("Sync complete. No new files.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_sync()
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd server && python -m pytest tests/test_sync.py -v
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/sync.py server/tests/test_sync.py
git commit -m "feat(server): Drive sync — download new raw files and library index"
```

---

## Task 3: Wiki Compiler

**Files:**
- Create: `server/compile.py`
- Create: `server/tests/test_compile.py`

- [ ] **Step 1: Write failing tests**

```python
# server/tests/test_compile.py
import json
from pathlib import Path
from unittest.mock import patch, MagicMock
import frontmatter
import pytest


def write_raw_item(raw_dir, item_id, slug, tags, short_summary, body="", date="2026-05-01T00:00:00Z"):
    content = f"""---
id: {item_id}
title: "Test Article"
url: https://example.com
date: {date}
sourceType: Tasks
tags: {json.dumps(tags)}
shortSummary: {json.dumps(short_summary)}
---

{body}"""
    (raw_dir / f"{item_id}-{slug}.md").write_text(content)


class TestReadLastCompile:
    def test_returns_epoch_when_missing(self, data_dir):
        from server.compile import read_last_compile
        assert read_last_compile() == "1970-01-01T00:00:00Z"

    def test_returns_stored_value(self, data_dir):
        from server import config
        config.LAST_COMPILE.write_text("2026-04-01T00:00:00Z")
        from server.compile import read_last_compile
        assert read_last_compile() == "2026-04-01T00:00:00Z"


class TestLoadTopicGroups:
    def test_extracts_unique_groups(self, data_dir, library_index):
        from server.compile import load_topic_groups
        groups = load_topic_groups()
        assert "Leadership & Management" in groups
        assert "Fitness" in groups
        assert len(groups) == 2

    def test_maps_tags_to_groups(self, data_dir, library_index):
        from server.compile import load_topic_groups
        groups = load_topic_groups()
        lm = groups["Leadership & Management"]
        assert "leadership" in lm["tags"]
        assert "management" in lm["tags"]


class TestFindNewItems:
    def test_finds_items_newer_than_threshold(self, data_dir, library_index):
        write_raw_item(data_dir / "raw", "id1", "old", ["leadership"], "old item", date="2026-01-01T00:00:00Z")
        write_raw_item(data_dir / "raw", "id2", "new", ["leadership"], "new item", date="2026-05-10T00:00:00Z")

        from server.compile import find_new_items
        items = find_new_items(["leadership"], "2026-03-01T00:00:00Z")

        ids = [i.metadata["id"] for i in items]
        assert "id2" in ids
        assert "id1" not in ids

    def test_returns_empty_when_no_new(self, data_dir, library_index):
        write_raw_item(data_dir / "raw", "id1", "old", ["leadership"], "old", date="2026-01-01T00:00:00Z")
        from server.compile import find_new_items
        items = find_new_items(["leadership"], "2026-06-01T00:00:00Z")
        assert items == []


class TestCallGemini:
    def test_returns_text_on_success(self, data_dir):
        from server.compile import call_gemini
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": "Updated article text"}]}}]
        }
        with patch("server.compile.requests.post", return_value=mock_resp):
            result = call_gemini("prompt text")
        assert result == "Updated article text"

    def test_retries_on_429(self, data_dir):
        from server.compile import call_gemini
        rate_limited = MagicMock(status_code=429)
        success = MagicMock(status_code=200)
        success.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": "ok"}]}}]
        }
        with patch("server.compile.requests.post", side_effect=[rate_limited, success]):
            with patch("server.compile.time.sleep"):
                result = call_gemini("prompt")
        assert result == "ok"

    def test_raises_on_second_failure(self, data_dir):
        from server.compile import call_gemini
        rate_limited = MagicMock(status_code=429)
        with patch("server.compile.requests.post", return_value=rate_limited):
            with patch("server.compile.time.sleep"):
                with pytest.raises(RuntimeError, match="Gemini"):
                    call_gemini("prompt")


class TestBuildTopicPrompt:
    def test_includes_seed_and_items(self, data_dir):
        from server.compile import build_topic_update_prompt
        seed = "# Leadership\n\nExisting content."
        items = ["Item 1 summary", "Item 2 summary"]
        prompt = build_topic_update_prompt("Leadership & Management", seed, items)
        assert "Leadership & Management" in prompt
        assert "Existing content" in prompt
        assert "Item 1 summary" in prompt

    def test_no_seed_uses_placeholder(self, data_dir):
        from server.compile import build_topic_update_prompt
        prompt = build_topic_update_prompt("Fitness", "", ["run more"])
        assert "Fitness" in prompt
        assert "run more" in prompt


class TestUpdateTopicArticle:
    def test_creates_article_when_absent(self, data_dir, library_index):
        write_raw_item(data_dir / "raw", "id1", "run", ["fitness"], "Running tips", body="Run daily.")
        from server.compile import update_topic_article
        with patch("server.compile.call_gemini", return_value="# Fitness\n\nRun daily."):
            with patch("server.compile.time.sleep"):
                update_topic_article("Fitness", ["fitness"], "1970-01-01T00:00:00Z")
        article = (data_dir / "wiki" / "topics" / "fitness.md")
        assert article.exists()
        assert "Fitness" in article.read_text()

    def test_skips_when_no_new_items(self, data_dir, library_index):
        write_raw_item(data_dir / "raw", "id1", "old", ["fitness"], "old", date="2026-01-01T00:00:00Z")
        from server.compile import update_topic_article
        with patch("server.compile.call_gemini") as mock_gemini:
            update_topic_article("Fitness", ["fitness"], "2026-06-01T00:00:00Z")
        mock_gemini.assert_not_called()
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd server && python -m pytest tests/test_compile.py -v 2>&1 | head -30
```

Expected: `ImportError` for `server.compile`.

- [ ] **Step 3: Implement `server/compile.py`**

```python
"""Wiki compiler: incrementally updates topic and concept articles via Gemini."""
import json
import logging
import time
from pathlib import Path

import frontmatter
import requests

from server import config

log = logging.getLogger(__name__)

GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{config.GEMINI_MODEL}:generateContent"
)


def read_last_compile() -> str:
    if config.LAST_COMPILE.exists():
        return config.LAST_COMPILE.read_text().strip()
    return "1970-01-01T00:00:00Z"


def write_last_compile(ts: str) -> None:
    config.LAST_COMPILE.write_text(ts)


def load_topic_groups() -> dict:
    """Returns {group_name: {tags: [...], folderId: str}} from library-index.json."""
    data = json.loads(config.LIBRARY_INDEX.read_text())
    groups: dict[str, dict] = {}
    for tag, meta in data.get("tagGroups", {}).items():
        group = meta["group"]
        if group not in groups:
            groups[group] = {"tags": [], "folderId": meta.get("folderId", "")}
        groups[group]["tags"].append(tag)
    return groups


def find_new_items(tags: list[str], since: str) -> list:
    """Returns parsed frontmatter posts from raw/ whose tags overlap and date > since."""
    items = []
    for path in config.RAW_DIR.glob("*.md"):
        try:
            post = frontmatter.load(path)
        except Exception as e:
            log.warning("Could not parse %s: %s", path, e)
            continue
        item_date = str(post.metadata.get("date", ""))
        item_tags = post.metadata.get("tags", [])
        if not isinstance(item_tags, list):
            item_tags = [item_tags]
        if item_date > since and any(t in tags for t in item_tags):
            items.append(post)
    return items


def call_gemini(prompt: str) -> str:
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    headers = {"Content-Type": "application/json"}
    params  = {"key": config.GEMINI_API_KEY}

    resp = requests.post(GEMINI_URL, json=payload, headers=headers, params=params)
    if resp.status_code == 429:
        log.warning("Gemini rate limited — waiting %ss", config.GEMINI_RETRY_DELAY)
        time.sleep(config.GEMINI_RETRY_DELAY)
        resp = requests.post(GEMINI_URL, json=payload, headers=headers, params=params)
    if resp.status_code != 200:
        raise RuntimeError(f"Gemini error {resp.status_code}: {resp.text[:200]}")

    return resp.json()["candidates"][0]["content"]["parts"][0]["text"]


def build_topic_update_prompt(group_name: str, seed: str, item_texts: list[str]) -> str:
    items_block = "\n\n---\n\n".join(item_texts)
    seed_block  = seed if seed else f"# {group_name}\n\n(No prior content — this is the first entry.)"
    return f"""You are maintaining a personal knowledge base wiki.

Topic: {group_name}

Current wiki article:
{seed_block}

New items added since the last update:
{items_block}

Instructions:
- Preserve and refine existing content
- Integrate insights from the new items naturally
- Expand key themes, terms, and mental models
- Note connections to other topics where relevant
- Keep the article well-structured with markdown headers
- Do not add a date or metadata header — return only the article body

Return the updated wiki article as markdown."""


def _item_text(post) -> str:
    title   = post.metadata.get("title", "")
    summary = post.metadata.get("shortSummary", "")
    body    = post.content.strip()
    parts   = [f"**{title}**", summary, body]
    return "\n\n".join(p for p in parts if p)


def update_topic_article(group_name: str, tags: list[str], since: str) -> bool:
    """Updates the topic article if there are new items. Returns True if updated."""
    new_items = find_new_items(tags, since)
    if not new_items:
        log.info("Topic '%s': no new items — skipping", group_name)
        return False

    slug    = group_name.lower().replace(" ", "-").replace("&", "and")
    article = config.TOPICS_DIR / f"{slug}.md"
    seed    = article.read_text() if article.exists() else ""

    item_texts = [_item_text(p) for p in new_items]
    log.info("Topic '%s': updating with %d new item(s)", group_name, len(new_items))

    prompt  = build_topic_update_prompt(group_name, seed, item_texts)
    updated = call_gemini(prompt)
    time.sleep(config.GEMINI_DELAY_SECONDS)

    config.TOPICS_DIR.mkdir(parents=True, exist_ok=True)
    article.write_text(updated)
    log.info("Topic '%s': article written (%d chars)", group_name, len(updated))
    return True


def build_concepts_prompt(topic_articles: dict[str, str], existing_concepts: list[str]) -> str:
    articles_block = "\n\n---\n\n".join(
        f"## {name}\n\n{text}" for name, text in topic_articles.items()
    )
    existing_block = ", ".join(existing_concepts) if existing_concepts else "none yet"
    return f"""You are maintaining a personal knowledge base wiki.

Below are all current topic articles:

{articles_block}

Existing concept articles already in the wiki: {existing_block}

Instructions:
- Identify concepts, mental models, or themes that appear across 2 or more topics
- For each cross-topic concept NOT already in the existing list, write a short concept article
- For concepts already in the existing list, output nothing (they will be updated separately)
- A concept article should: name the concept clearly, explain it in 2-4 sentences, then list the topics it connects and how
- Keep each concept article under 300 words

Return a JSON array. Each element: {{"name": "concept name", "slug": "url-safe-slug", "content": "markdown article text"}}
If no new concepts are found, return an empty array []."""


def update_concepts(topic_updated: bool) -> None:
    if not topic_updated:
        log.info("Concepts: no topics updated — skipping cross-topic pass")
        return

    topic_articles = {}
    for f in sorted(config.TOPICS_DIR.glob("*.md")):
        topic_articles[f.stem] = f.read_text()

    if len(topic_articles) < 2:
        return

    existing = [f.stem for f in config.CONCEPTS_DIR.glob("*.md")]
    prompt   = build_concepts_prompt(topic_articles, existing)

    try:
        raw = call_gemini(prompt)
        time.sleep(config.GEMINI_DELAY_SECONDS)
        # Strip markdown code fences if Gemini wraps output
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        concepts = json.loads(raw)
    except Exception as e:
        log.error("Concepts pass failed: %s", e)
        return

    config.CONCEPTS_DIR.mkdir(parents=True, exist_ok=True)
    for c in concepts:
        path = config.CONCEPTS_DIR / f"{c['slug']}.md"
        path.write_text(c["content"])
        log.info("Concept '%s' written", c["name"])


def update_index() -> None:
    """Regenerates wiki/index.md with a summary of every topic and concept article."""
    summaries = []

    for f in sorted(config.TOPICS_DIR.glob("*.md")):
        lines = f.read_text().strip().splitlines()
        headline = next((l for l in lines if l.startswith("#")), f.stem)
        snippet  = " ".join(l for l in lines[1:] if l.strip())[:200]
        summaries.append(f"### topics/{f.name}\n{headline}\n\n{snippet}")

    for f in sorted(config.CONCEPTS_DIR.glob("*.md")):
        lines = f.read_text().strip().splitlines()
        headline = next((l for l in lines if l.startswith("#")), f.stem)
        snippet  = " ".join(l for l in lines[1:] if l.strip())[:200]
        summaries.append(f"### concepts/{f.name}\n{headline}\n\n{snippet}")

    index_text = "# Wiki Index\n\n" + "\n\n".join(summaries)
    config.INDEX_FILE.write_text(index_text)
    log.info("Index updated: %d articles", len(summaries))


def run_compile() -> None:
    since  = read_last_compile()
    now    = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    groups = load_topic_groups()

    any_updated = False
    for group_name, meta in groups.items():
        try:
            updated = update_topic_article(group_name, meta["tags"], since)
            if updated:
                any_updated = True
        except Exception as e:
            log.error("Failed to update topic '%s': %s", group_name, e)

    update_concepts(any_updated)
    update_index()
    write_last_compile(now)
    log.info("Compile complete.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_compile()
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd server && python -m pytest tests/test_compile.py -v
```

Expected: all 14 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/compile.py server/tests/test_compile.py
git commit -m "feat(server): wiki compiler — incremental topic and concept updates via Gemini"
```

---

## Task 4: Web App

**Files:**
- Create: `server/web_app.py`
- Create: `server/templates/base.html`
- Create: `server/templates/wiki.html`
- Create: `server/templates/search.html`
- Create: `server/templates/qa.html`
- Create: `server/tests/test_web_app.py`

- [ ] **Step 1: Write failing tests**

```python
# server/tests/test_web_app.py
import json
from pathlib import Path
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def wiki_content(data_dir):
    """Seeds the wiki with minimal content for route tests."""
    (data_dir / "wiki" / "topics" / "fitness.md").write_text(
        "# Fitness\n\nRun every day."
    )
    (data_dir / "wiki" / "concepts" / "habit-formation.md").write_text(
        "# Habit Formation\n\nSmall consistent actions."
    )
    (data_dir / "wiki" / "index.md").write_text(
        "# Wiki Index\n\n### topics/fitness.md\n# Fitness\n\nRun every day."
    )


@pytest.fixture
def client(data_dir, wiki_content):
    from server.web_app import app
    return TestClient(app)


class TestWikiRoutes:
    def test_index_redirects_to_wiki(self, client):
        resp = client.get("/", follow_redirects=False)
        assert resp.status_code in (301, 302, 307, 308)
        assert "/wiki" in resp.headers["location"]

    def test_wiki_lists_articles(self, client):
        resp = client.get("/wiki")
        assert resp.status_code == 200
        assert "fitness" in resp.text.lower()

    def test_wiki_article_renders(self, client):
        resp = client.get("/wiki/topics/fitness.md")
        assert resp.status_code == 200
        assert "Run every day" in resp.text

    def test_wiki_article_not_found(self, client):
        resp = client.get("/wiki/topics/nonexistent.md")
        assert resp.status_code == 404


class TestSearchRoute:
    def test_search_returns_matches(self, client):
        resp = client.get("/search?q=fitness")
        assert resp.status_code == 200
        assert "fitness" in resp.text.lower()

    def test_search_empty_query(self, client):
        resp = client.get("/search?q=")
        assert resp.status_code == 200

    def test_search_no_results(self, client):
        resp = client.get("/search?q=xyzquux999")
        assert resp.status_code == 200
        assert "no results" in resp.text.lower()


class TestQARoute:
    def test_qa_page_loads(self, client):
        resp = client.get("/qa")
        assert resp.status_code == 200
        assert "ask" in resp.text.lower()

    def test_qa_submit_returns_answer(self, client):
        with patch("server.web_app.call_gemini_qa", return_value=("42", ["topics/fitness.md"])):
            resp = client.post("/qa", data={"question": "What is the meaning?"})
        assert resp.status_code == 200
        assert "42" in resp.text

    def test_qa_empty_question(self, client):
        resp = client.post("/qa", data={"question": ""})
        assert resp.status_code == 422


class TestSaveInsight:
    def test_saves_insight_file(self, client, data_dir):
        with patch("server.web_app.call_gemini_qa", return_value=("42", ["topics/fitness.md"])):
            client.post("/qa", data={"question": "What is the meaning?"})

        resp = client.post(
            "/qa/save-insight",
            data={"question": "What is the meaning?", "answer": "42"},
        )
        assert resp.status_code == 200
        insights = list((data_dir / "raw" / "insights").glob("*.md"))
        assert len(insights) == 1
        content = insights[0].read_text()
        assert "What is the meaning?" in content
        assert "42" in content
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd server && python -m pytest tests/test_web_app.py -v 2>&1 | head -30
```

Expected: `ImportError` for `server.web_app`.

- [ ] **Step 3: Write templates**

`server/templates/base.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PKM Wiki{% if title %} — {{ title }}{% endif %}</title>
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; display: flex; height: 100vh; }
    nav { width: 240px; min-width: 240px; border-right: 1px solid #ddd; padding: 1rem; overflow-y: auto; }
    main { flex: 1; padding: 2rem; overflow-y: auto; max-width: 800px; }
    nav h2 { font-size: 0.85rem; text-transform: uppercase; color: #888; margin: 1rem 0 0.25rem; }
    nav a { display: block; padding: 2px 0; text-decoration: none; color: #333; font-size: 0.9rem; }
    nav a:hover { color: #0066cc; }
    .search-bar { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    .search-bar input { flex: 1; padding: 0.4rem; }
    .qa-form textarea { width: 100%; min-height: 80px; }
    .sources { font-size: 0.85rem; color: #666; margin-top: 1rem; }
    .result { border-left: 3px solid #0066cc; padding-left: 1rem; margin: 1rem 0; }
  </style>
</head>
<body>
<nav>
  <strong>PKM Wiki</strong>
  <a href="/wiki">Home</a>
  <a href="/search">Search</a>
  <a href="/qa">Q&amp;A</a>
  {% if topics %}
  <h2>Topics</h2>
  {% for slug, name in topics %}
  <a href="/wiki/topics/{{ slug }}.md">{{ name }}</a>
  {% endfor %}
  {% endif %}
  {% if concepts %}
  <h2>Concepts</h2>
  {% for slug, name in concepts %}
  <a href="/wiki/concepts/{{ slug }}.md">{{ name }}</a>
  {% endfor %}
  {% endif %}
</nav>
<main>
  {% block content %}{% endblock %}
</main>
</body>
</html>
```

`server/templates/wiki.html`:
```html
{% extends "base.html" %}
{% block content %}
{% if article %}
{{ article | safe }}
{% else %}
<p>Select an article from the sidebar.</p>
{% endif %}
{% endblock %}
```

`server/templates/search.html`:
```html
{% extends "base.html" %}
{% block content %}
<h1>Search</h1>
<form class="search-bar" method="get" action="/search">
  <input name="q" value="{{ query }}" placeholder="Search wiki…" autofocus>
  <button type="submit">Search</button>
</form>
{% if query %}
  {% if results %}
    {% for r in results %}
    <div class="result">
      <a href="/wiki/{{ r.path }}"><strong>{{ r.title }}</strong></a>
      <p>{{ r.excerpt }}</p>
    </div>
    {% endfor %}
  {% else %}
    <p>No results for <em>{{ query }}</em>.</p>
  {% endif %}
{% endif %}
{% endblock %}
```

`server/templates/qa.html`:
```html
{% extends "base.html" %}
{% block content %}
<h1>Ask</h1>
<form class="qa-form" method="post" action="/qa"
      hx-post="/qa" hx-target="#answer" hx-swap="innerHTML">
  <textarea name="question" placeholder="Ask a question about your knowledge base…" required>{{ question or "" }}</textarea>
  <br>
  <button type="submit">Ask</button>
</form>
<div id="answer">
{% if answer %}
<hr>
<div>{{ answer | safe }}</div>
{% if sources %}
<div class="sources">Sources: {% for s in sources %}<a href="/wiki/{{ s }}">{{ s }}</a>{% if not loop.last %}, {% endif %}{% endfor %}</div>
{% endif %}
{% if question and answer %}
<form method="post" action="/qa/save-insight"
      hx-post="/qa/save-insight" hx-target="#save-status" hx-swap="innerHTML">
  <input type="hidden" name="question" value="{{ question | e }}">
  <input type="hidden" name="answer" value="{{ answer_raw | e }}">
  <button type="submit">Save this insight</button>
</form>
<div id="save-status"></div>
{% endif %}
{% endif %}
</div>
{% endblock %}
```

- [ ] **Step 4: Implement `server/web_app.py`**

```python
"""FastAPI web app: wiki browser, search, Q&A, insight filing."""
import re
import time
import logging
from pathlib import Path
from typing import Annotated

import frontmatter
import mistune
import requests
from fastapi import FastAPI, Form, HTTPException, Request, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from server import config

log = logging.getLogger(__name__)
app = FastAPI()
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{config.GEMINI_MODEL}:generateContent"
)
_md = mistune.create_markdown()


def _nav_lists():
    topics   = [(f.stem, f.stem.replace("-", " ").title()) for f in sorted(config.TOPICS_DIR.glob("*.md"))]
    concepts = [(f.stem, f.stem.replace("-", " ").title()) for f in sorted(config.CONCEPTS_DIR.glob("*.md"))]
    return topics, concepts


def _render_context(request: Request, **extra):
    topics, concepts = _nav_lists()
    return {"request": request, "topics": topics, "concepts": concepts, **extra}


@app.get("/", response_class=HTMLResponse)
def root():
    return RedirectResponse("/wiki")


@app.get("/wiki", response_class=HTMLResponse)
def wiki_home(request: Request):
    ctx = _render_context(request, title="Wiki", article=None)
    return templates.TemplateResponse("wiki.html", ctx)


@app.get("/wiki/{category}/{filename}", response_class=HTMLResponse)
def wiki_article(request: Request, category: str, filename: str):
    base = config.WIKI_DIR / category / filename
    if not base.exists():
        raise HTTPException(status_code=404, detail="Article not found")
    raw   = base.read_text()
    html  = _md(raw)
    title = filename.replace(".md", "").replace("-", " ").title()
    ctx   = _render_context(request, title=title, article=html)
    return templates.TemplateResponse("wiki.html", ctx)


@app.get("/search", response_class=HTMLResponse)
def search(request: Request, q: str = Query(default="")):
    results = []
    if q:
        pattern = re.compile(re.escape(q), re.IGNORECASE)
        for path in sorted(config.WIKI_DIR.rglob("*.md")):
            text = path.read_text()
            if pattern.search(text):
                rel   = path.relative_to(config.WIKI_DIR)
                lines = text.splitlines()
                title = next((l.lstrip("#").strip() for l in lines if l.startswith("#")), str(rel))
                match = pattern.search(text)
                start = max(0, match.start() - 80)
                excerpt = "…" + text[start:start + 200] + "…"
                results.append({"path": str(rel), "title": title, "excerpt": excerpt})
    ctx = _render_context(request, title="Search", query=q, results=results)
    return templates.TemplateResponse("search.html", ctx)


def call_gemini_qa(prompt: str) -> tuple[str, list[str]]:
    """Two-step Q&A: route via index, then answer from relevant articles."""
    index_text = config.INDEX_FILE.read_text() if config.INDEX_FILE.exists() else ""

    # Step 1: route
    route_prompt = (
        f"Wiki index:\n{index_text}\n\nQuestion: {prompt}\n\n"
        "Return ONLY a JSON array of 2-3 article paths (e.g. [\"topics/fitness.md\"]) "
        "that are most relevant to this question. No other text."
    )
    route_resp = _gemini_post(route_prompt)
    try:
        raw = route_resp.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        sources: list[str] = json_loads_safe(raw)
    except Exception:
        sources = []

    # Step 2: answer
    articles_text = ""
    valid_sources = []
    for src in sources[:3]:
        path = config.WIKI_DIR / src
        if path.exists():
            articles_text += f"\n\n--- {src} ---\n{path.read_text()}"
            valid_sources.append(src)

    answer_prompt = (
        f"Use the following wiki articles to answer the question.\n"
        f"{articles_text}\n\nQuestion: {prompt}\n\nAnswer concisely."
    )
    answer = _gemini_post(answer_prompt)
    return answer, valid_sources


def _gemini_post(prompt: str) -> str:
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    params  = {"key": config.GEMINI_API_KEY}
    resp    = requests.post(GEMINI_URL, json=payload, params=params)
    if resp.status_code == 429:
        time.sleep(config.GEMINI_RETRY_DELAY)
        resp = requests.post(GEMINI_URL, json=payload, params=params)
    if resp.status_code != 200:
        raise RuntimeError(f"Gemini error {resp.status_code}")
    return resp.json()["candidates"][0]["content"]["parts"][0]["text"]


def json_loads_safe(raw: str):
    import json
    return json.loads(raw)


@app.get("/qa", response_class=HTMLResponse)
def qa_get(request: Request):
    ctx = _render_context(request, title="Q&A", question="", answer=None, sources=[])
    return templates.TemplateResponse("qa.html", ctx)


@app.post("/qa", response_class=HTMLResponse)
def qa_post(request: Request, question: Annotated[str, Form(min_length=1)]):
    answer_raw, sources = call_gemini_qa(question)
    answer_html = _md(answer_raw)
    ctx = _render_context(
        request, title="Q&A",
        question=question, answer=answer_html, answer_raw=answer_raw, sources=sources
    )
    return templates.TemplateResponse("qa.html", ctx)


@app.post("/qa/save-insight", response_class=HTMLResponse)
def save_insight(
    request: Request,
    question: Annotated[str, Form()],
    answer: Annotated[str, Form()],
):
    config.INSIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    ts   = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    slug = re.sub(r"[^a-z0-9]+", "-", question.lower())[:40].strip("-")
    path = config.INSIGHTS_DIR / f"{ts}-{slug}.md"
    content = f"""---
type: insight
date: {time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
question: {question!r}
---

**Q:** {question}

**A:** {answer}
"""
    path.write_text(content)
    log.info("Insight saved: %s", path)
    return HTMLResponse("<p>Insight saved. It will be integrated on the next compile run.</p>")
```

- [ ] **Step 5: Run tests — expect pass**

```bash
cd server && python -m pytest tests/test_web_app.py -v
```

Expected: all 12 tests pass.

- [ ] **Step 6: Smoke-test the server locally**

```bash
cd server
PKM_DATA_DIR=/tmp/pkm-test \
  GEMINI_API_KEY=test \
  PKM_DRIVE_FOLDER_ID=x \
  PKM_LIBRARY_INDEX_ID=x \
  GOOGLE_SERVICE_ACCOUNT_JSON=/dev/null \
  uvicorn server.web_app:app --reload --port 8765
```

Open `http://localhost:8765/wiki` in a browser. Expected: sidebar loads, wiki home shows, no errors.

- [ ] **Step 7: Commit**

```bash
git add server/web_app.py server/templates/
git commit -m "feat(server): FastAPI web app — wiki browser, search, Q&A, insight filing"
```

---

## Task 5: Backfill Script

**Files:**
- Create: `server/backfill.py`
- Create: `server/tests/test_backfill.py`

- [ ] **Step 1: Write failing tests**

```python
# server/tests/test_backfill.py
import json
from pathlib import Path
from unittest.mock import patch, MagicMock
import pytest


def make_library_item(item_id, title, url, source_type, tags, short_summary):
    return {
        "itemId":      item_id,
        "title":       title,
        "url":         url,
        "sourceType":  source_type,
        "tags":        tags,
        "shortSummary": short_summary,
        "dateAdded":   "2026-01-15T10:00:00Z",
    }


@pytest.fixture
def library_json(data_dir):
    items = [
        make_library_item("id1", "Article One", "https://example.com/a", "Tasks",
                          ["leadership"], "Summary of article one."),
        make_library_item("id2", "YouTube Video", "https://www.youtube.com/watch?v=abc",
                          "YouTube", ["fitness"], "Summary of youtube."),
    ]
    path = data_dir / "state" / "library-index.json"
    path.write_text(json.dumps({"items": items, "tagGroups": {}}))
    return path


class TestSlugify:
    def test_basic(self):
        from server.backfill import slugify
        assert slugify("Hello World") == "hello-world"

    def test_special_chars(self):
        from server.backfill import slugify
        assert slugify("C++ & Python!") == "c-python"

    def test_max_length(self):
        from server.backfill import slugify
        long = "a" * 100
        assert len(slugify(long)) <= 60


class TestFetchContent:
    def test_uses_trafilatura_for_web_url(self, data_dir):
        from server.backfill import fetch_content
        with patch("server.backfill.trafilatura.fetch_url", return_value="<html>Article body</html>"):
            with patch("server.backfill.trafilatura.extract", return_value="Article body"):
                result = fetch_content("https://example.com/article", "Tasks", "")
        assert result == "Article body"

    def test_returns_summary_for_youtube(self, data_dir):
        from server.backfill import fetch_content
        result = fetch_content("https://youtube.com/watch?v=x", "YouTube", "YT summary here")
        assert result == "YT summary here"

    def test_returns_empty_on_trafilatura_failure(self, data_dir):
        from server.backfill import fetch_content
        with patch("server.backfill.trafilatura.fetch_url", return_value=None):
            result = fetch_content("https://example.com/", "Tasks", "fallback")
        assert result == "fallback"


class TestWriteBackfillItem:
    def test_writes_markdown_file(self, data_dir):
        from server.backfill import write_backfill_item
        item = make_library_item("id1", "Test Article", "https://x.com", "Tasks",
                                 ["leadership"], "A summary.")
        write_backfill_item(item, "Full body text.", data_dir / "raw")

        files = list((data_dir / "raw").glob("*.md"))
        assert len(files) == 1
        content = files[0].read_text()
        assert "id1" in content
        assert "Test Article" in content
        assert "Full body text." in content
        assert "leadership" in content

    def test_skips_existing_file(self, data_dir):
        from server.backfill import write_backfill_item
        item = make_library_item("id1", "Test", "https://x.com", "Tasks", ["t"], "s")
        dest = data_dir / "raw"
        write_backfill_item(item, "first", dest)
        write_backfill_item(item, "second", dest)  # should not overwrite
        files = list(dest.glob("*.md"))
        assert len(files) == 1
        assert "first" in files[0].read_text()
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd server && python -m pytest tests/test_backfill.py -v 2>&1 | head -30
```

Expected: `ImportError` for `server.backfill`.

- [ ] **Step 3: Implement `server/backfill.py`**

```python
"""One-time backfill: reads pkm-library-index.json, fetches URLs, writes raw/ markdown files."""
import json
import logging
import re
import sys
import time
from pathlib import Path

import trafilatura

from server import config

log = logging.getLogger(__name__)


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:60]


def fetch_content(url: str, source_type: str, short_summary: str) -> str:
    """Fetch article text. YouTube and paywalled URLs fall back to short_summary."""
    if source_type == "YouTube" or "youtube.com" in url:
        return short_summary

    try:
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            text = trafilatura.extract(downloaded)
            if text:
                return text[:50000]
    except Exception as e:
        log.warning("trafilatura failed for %s: %s", url, e)

    return short_summary


def write_backfill_item(item: dict, body: str, raw_dir: Path) -> None:
    slug     = slugify(item["title"])
    filename = f"{item['itemId']}-{slug}.md"
    dest     = raw_dir / filename

    if dest.exists():
        log.info("Skip (exists): %s", filename)
        return

    tags     = item.get("tags", [])
    tags_str = json.dumps(tags)
    content  = f"""---
id: {item['itemId']}
title: {json.dumps(item['title'])}
url: {item.get('url', '')}
date: {item.get('dateAdded', '')}
sourceType: {item.get('sourceType', '')}
tags: {tags_str}
shortSummary: {json.dumps(item.get('shortSummary', ''))}
---

{body}"""
    dest.write_text(content)
    log.info("Wrote: %s (%d chars)", filename, len(content))


def run_backfill(library_path: Path, raw_dir: Path, delay: float = 1.0) -> None:
    data  = json.loads(library_path.read_text())
    items = data.get("items", [])
    log.info("Backfill: %d items to process", len(items))

    for i, item in enumerate(items):
        log.info("[%d/%d] %s", i + 1, len(items), item.get("title", ""))
        body = fetch_content(
            item.get("url", ""),
            item.get("sourceType", ""),
            item.get("shortSummary", ""),
        )
        write_backfill_item(item, body, raw_dir)
        time.sleep(delay)

    log.info("Backfill complete.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    library_path = Path(sys.argv[1]) if len(sys.argv) > 1 else config.LIBRARY_INDEX
    raw_dir      = config.RAW_DIR
    raw_dir.mkdir(parents=True, exist_ok=True)
    run_backfill(library_path, raw_dir)
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd server && python -m pytest tests/test_backfill.py -v
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/backfill.py server/tests/test_backfill.py
git commit -m "feat(server): backfill script — fetch existing library items into raw/"
```

---

## Task 6: Infrastructure Files

**Files:**
- Create: `server/infra/pkm-sync.cron`
- Create: `server/infra/pkm-compile.cron`
- Create: `server/infra/pkm-web.service`
- Create: `server/infra/nginx.conf`
- Create: `server/infra/cloudflared-setup.md`

- [ ] **Step 1: Write crontab files**

`server/infra/pkm-sync.cron`:
```
# PKM Drive sync — every 20 minutes
# Install: crontab -e, paste this block
# Assumes: virtualenv at /pkm/venv, env vars in /pkm/.env
*/20 * * * * source /pkm/.env && /pkm/venv/bin/python -m server.sync >> /pkm/logs/sync.log 2>&1
```

`server/infra/pkm-compile.cron`:
```
# PKM wiki compiler — every 20 minutes, offset 10 min from sync
# Runs after sync so new files are already present when compile starts
10,30,50 * * * * source /pkm/.env && /pkm/venv/bin/python -m server.compile >> /pkm/logs/compile.log 2>&1
```

- [ ] **Step 2: Write systemd service**

`server/infra/pkm-web.service`:
```ini
[Unit]
Description=PKM Wiki Web App
After=network.target

[Service]
Type=simple
User=pkm
WorkingDirectory=/pkm/repo
EnvironmentFile=/pkm/.env
ExecStart=/pkm/venv/bin/uvicorn server.web_app:app --host 127.0.0.1 --port 8765
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Write nginx config snippet**

`server/infra/nginx.conf`:
```nginx
# Drop this in /etc/nginx/sites-available/pkm and symlink to sites-enabled/
# nginx handles TLS termination if using Let's Encrypt; cloudflared bypasses this
server {
    listen 80;
    server_name pkm.local;

    location / {
        proxy_pass         http://127.0.0.1:8765;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

- [ ] **Step 4: Write cloudflared setup guide**

`server/infra/cloudflared-setup.md`:
```markdown
# Cloudflare Tunnel Setup

## Prerequisites
- Cloudflare account (free tier works)
- Domain name pointed to Cloudflare nameservers (or use the free .trycloudflare.com URL for dev)

## Install cloudflared

```bash
# On Debian/Ubuntu
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

## Create the tunnel

```bash
cloudflared tunnel login        # opens browser, pick your zone
cloudflared tunnel create pkm   # creates tunnel, saves credentials JSON
```

Note the tunnel UUID from the output.

## Configure the tunnel

Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: <YOUR-TUNNEL-UUID>
credentials-file: /root/.cloudflared/<YOUR-TUNNEL-UUID>.json

ingress:
  - hostname: pkm.yourdomain.com
    service: http://localhost:8765
  - service: http_status:404
```

## Create DNS record

```bash
cloudflared tunnel route dns pkm pkm.yourdomain.com
```

## Run as a service

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

## Verify

Visit `https://pkm.yourdomain.com` — you should see the PKM wiki home page.

## Environment file template

`/pkm/.env` (chmod 600, chown pkm:pkm):

```bash
export PKM_DATA_DIR=/pkm/data
export GEMINI_API_KEY=<your-key>
export GEMINI_MODEL=gemini-2.0-flash
export PKM_DRIVE_FOLDER_ID=<Drive /PKM/raw/ folder ID>
export PKM_LIBRARY_INDEX_ID=<Drive pkm-library-index.json file ID>
export GOOGLE_SERVICE_ACCOUNT_JSON=/pkm/service-account.json
```
```

- [ ] **Step 5: Create logs directory placeholder**

```bash
mkdir -p server/infra
touch server/infra/.gitkeep
```

- [ ] **Step 6: Commit**

```bash
git add server/infra/
git commit -m "feat(server): infrastructure — cron, systemd, nginx, cloudflared setup guide"
```

---

## Task 7: Full Test Suite Pass and Deployment

**Files:** No new files — verification and wiring.

- [ ] **Step 1: Run the full test suite**

```bash
cd server && python -m pytest tests/ -v --tb=short
```

Expected: all tests pass. Fix any failures before proceeding.

- [ ] **Step 2: Create the service account on your Linux server**

On your server (not in this repo):

```bash
# Create system user
sudo useradd -r -s /bin/false pkm
sudo mkdir -p /pkm/{data,logs,venv}
sudo chown -R pkm:pkm /pkm

# Clone the repo
sudo -u pkm git clone <repo-url> /pkm/repo
```

In Google Cloud Console (same project as the Apps Script):
1. IAM → Service Accounts → Create Service Account (`pkm-server@your-project.iam.gserviceaccount.com`)
2. Download JSON key → copy to `/pkm/service-account.json` on the server
3. In Drive, share the `/PKM/raw/` folder with the service account email (Viewer)
4. Share `pkm-library-index.json` with the service account email (Viewer)

- [ ] **Step 3: Set up virtualenv and install**

```bash
sudo -u pkm python3 -m venv /pkm/venv
sudo -u pkm /pkm/venv/bin/pip install -r /pkm/repo/server/requirements.txt
```

- [ ] **Step 4: Create `/pkm/.env` and test the sync**

```bash
# Write /pkm/.env from the template in cloudflared-setup.md
sudo chmod 600 /pkm/.env
sudo chown pkm:pkm /pkm/.env

# Test sync manually
sudo -u pkm bash -c 'source /pkm/.env && /pkm/venv/bin/python -m server.sync'
```

Expected: log shows files downloaded to `/pkm/data/raw/`, `state/last_sync.txt` written.

- [ ] **Step 5: Run the backfill**

```bash
sudo -u pkm bash -c 'source /pkm/.env && /pkm/venv/bin/python -m server.backfill /pkm/data/state/library-index.json'
```

Expected: ~200 `.md` files in `/pkm/data/raw/`. Some YouTube/paywall items will have empty bodies — that's expected.

- [ ] **Step 6: Run the compiler**

```bash
sudo -u pkm bash -c 'source /pkm/.env && /pkm/venv/bin/python -m server.compile'
```

Expected: topic articles appear in `/pkm/data/wiki/topics/`, concept articles in `/pkm/data/wiki/concepts/`, `index.md` written. Each Gemini call logged.

- [ ] **Step 7: Install and start all services**

```bash
# Web app
sudo cp /pkm/repo/server/infra/pkm-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pkm-web

# Cron jobs
sudo -u pkm crontab /pkm/repo/server/infra/pkm-sync.cron
sudo -u pkm crontab -l | sudo -u pkm tee -a <(cat /pkm/repo/server/infra/pkm-compile.cron)

# nginx
sudo cp /pkm/repo/server/infra/nginx.conf /etc/nginx/sites-available/pkm
sudo ln -s /etc/nginx/sites-available/pkm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# cloudflared (follow cloudflared-setup.md)
```

- [ ] **Step 8: Smoke-test the live deployment**

1. Open `https://pkm.yourdomain.com/wiki` — sidebar shows topic and concept articles
2. Click a topic article — content renders
3. Open `/search?q=leadership` — returns matches
4. Open `/qa`, ask "What themes recur across my leadership reading?" — answer returns with sources
5. Click "Save this insight" — confirm success message; check `/pkm/data/raw/insights/` for the file
6. Wait for next cron run (or run `compile.py` manually) — insight appears integrated in the relevant topic article

- [ ] **Step 9: Commit final state**

```bash
git add .
git commit -m "feat(server): complete Linux server pipeline — sync, compile, web app, infra"
```

---

## Self-Review

**Spec coverage:**
- ✅ Drive sync cron (sync.py, Task 2)
- ✅ Wiki compiler with per-topic pass (compile.py, Task 3)
- ✅ Cross-topic concepts pass (compile.py `update_concepts`)
- ✅ Index update (compile.py `update_index`)
- ✅ Wiki browser, search, Q&A, insight filing (web_app.py, Task 4)
- ✅ Backfill from library index (backfill.py, Task 5)
- ✅ Cloudflare Tunnel + nginx (Task 6)
- ✅ Service account auth for Drive
- ✅ Gemini via REST + rate-limit retry
- ✅ HTMX (qa.html hx-post)
- ✅ insights/ written to raw/ and compiled on next run
- ✅ TDD throughout (Tasks 2–5)

**Placeholder scan:** No TBDs. All code is complete.

**Type consistency:** `call_gemini` in compile.py matches internal usage. `call_gemini_qa` in web_app.py is distinct and patched correctly in tests. `find_new_items` returns list of frontmatter posts throughout.
