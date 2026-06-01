#!/usr/bin/env python3
"""
One-time backfill: converts pkm-library-index.json into .raw/ markdown files
for the Obsidian vault's claude-obsidian ingest directory.

Usage:
  python backfill/backfill.py <path-to-pkm-library-index.json> <path-to-vault/.raw>

Example (WSL2 → Windows vault):
  python backfill/backfill.py pkm-library-index.json \
    "/mnt/c/Users/rsmith/Documents/Obsidian/vault/.raw"
"""
import json
import re
import sys
import time
from pathlib import Path

import trafilatura


def slugify(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', str(text).lower()).strip('-')[:60]


def fetch_content(url: str, source_type: str, short_summary: str) -> str:
    source_lower = source_type.lower()

    # YouTube and Gmail: cannot re-fetch — use stored summary
    if source_lower in ('youtube', 'gmail'):
        return short_summary

    if not url or not url.startswith('http'):
        return short_summary

    try:
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            text = trafilatura.extract(downloaded)
            if text:
                return text[:50000]
    except Exception as e:
        print(f"    trafilatura failed: {e}")

    return short_summary


def build_markdown(item: dict, body: str) -> str:
    tags          = json.dumps(item.get('tags', []))
    short_summary = json.dumps(item.get('shortSummary', ''))
    return '\n'.join([
        '---',
        f"id: {item.get('id', '')}",
        f"title: {json.dumps(item.get('title', ''))}",
        f"url: {item.get('url', '')}",
        f"date: {item.get('date', '')}",
        f"sourceType: {item.get('sourceType', '')}",
        f"tags: {tags}",
        f"shortSummary: {short_summary}",
        '---',
        '',
        body,
    ]).strip()


def run_backfill(library_path: Path, raw_dir: Path, delay: float = 1.0) -> None:
    data  = json.loads(library_path.read_text(encoding='utf-8'))
    items = data.get('items', [])
    print(f"Backfill: {len(items)} items → {raw_dir}")
    raw_dir.mkdir(parents=True, exist_ok=True)

    written = skipped = failed = 0

    for i, item in enumerate(items):
        item_id  = item.get('id', f'item-{i}')
        title    = item.get('title', '')
        filename = f"{item_id}-{slugify(title)}.md"
        dest     = raw_dir / filename

        if dest.exists():
            print(f"  [{i+1}/{len(items)}] skip (exists): {filename}")
            skipped += 1
            continue

        print(f"  [{i+1}/{len(items)}] {title[:70]}")

        try:
            body    = fetch_content(item.get('url', ''), item.get('sourceType', ''), item.get('shortSummary', ''))
            content = build_markdown(item, body)
            dest.write_text(content, encoding='utf-8')
            written += 1
            print(f"    wrote {filename} ({len(content)} chars)")
        except Exception as e:
            print(f"    ERROR: {e}")
            failed += 1

        if delay:
            time.sleep(delay)

    print(f"\nDone: {written} written, {skipped} skipped, {failed} failed")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    library_path = Path(sys.argv[1])
    raw_dir      = Path(sys.argv[2])

    if not library_path.exists():
        print(f"Error: {library_path} not found")
        sys.exit(1)

    run_backfill(library_path, raw_dir)
