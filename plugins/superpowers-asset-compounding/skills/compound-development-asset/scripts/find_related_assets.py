#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from _asset_utils import discover_superpowers_root, iter_assets, read_text, tokenize_query


AREA_WEIGHTS = {
    "problems": 5,
    "archives": 4,
    "inbox": 3,
    "specs": 2,
    "plans": 2,
}


def score_asset(path: Path, text: str, terms: list[str]) -> tuple[int, list[str]]:
    haystacks = {
        "path": path.as_posix().lower(),
        "title": "\n".join(line for line in text.lower().splitlines() if line.startswith("#")),
        "body": text.lower(),
    }
    score = 0
    hits: list[str] = []
    for term in terms:
        term_score = 0
        if term in haystacks["path"]:
            term_score += 8
        if term in haystacks["title"]:
            term_score += 5
        body_count = haystacks["body"].count(term)
        if body_count:
            term_score += min(body_count, 8)
        if term_score:
            score += term_score
            hits.append(term)
    return score, hits


def main() -> int:
    parser = argparse.ArgumentParser(description="Find related specs/plans/archives/problems/inbox notes.")
    parser.add_argument("root", help="Repository root or docs/superpowers path.")
    parser.add_argument("keywords", nargs="+", help="Slug fragments or keywords.")
    parser.add_argument("--area", action="append", choices=["specs", "plans", "archives", "problems", "inbox"], help="Limit search area. Can be repeated.")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    terms = tokenize_query(args.keywords)
    superpowers_root = discover_superpowers_root(Path(args.root))
    results = []
    for asset in iter_assets(superpowers_root, args.area):
        text = read_text(asset.path)
        score, hits = score_asset(asset.path, text, terms)
        if not score:
            continue
        score += AREA_WEIGHTS.get(asset.area, 0)
        results.append(
            {
                "score": score,
                "area": asset.area,
                "kind": asset.kind,
                "date": asset.date,
                "slug": asset.slug,
                "title": asset.title,
                "path": str(asset.path.relative_to(superpowers_root.parent.parent if superpowers_root.parent.name == "docs" else superpowers_root)),
                "hits": hits,
            }
        )

    results.sort(key=lambda item: (-item["score"], item["area"], item["path"]))
    results = results[: args.limit]

    if args.json:
        print(json.dumps({"root": str(superpowers_root), "terms": terms, "results": results}, ensure_ascii=False, indent=2))
    else:
        if not results:
            print("No related assets found.")
        for item in results:
            title = f" - {item['title']}" if item["title"] else ""
            print(f"{item['score']:>3} {item['kind']:<7} {item['path']}{title}")
            print(f"    hits: {', '.join(item['hits'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
