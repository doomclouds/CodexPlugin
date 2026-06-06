#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from _problem_asset_utils import extract_metadata, read_text


OPEN_LIFECYCLES = {"Open", "Partially promoted"}
VALID_LIFECYCLES = OPEN_LIFECYCLES | {"Promoted", "Closed"}


def configure_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def discover_superpowers_root(root: Path) -> Path:
    root = root.resolve()
    if root.name == "superpowers" and root.is_dir():
        return root
    candidate = root / "docs" / "superpowers"
    if candidate.is_dir():
        return candidate.resolve()
    if (root / "inbox").is_dir():
        return root
    raise FileNotFoundError(f"Cannot find docs/superpowers under {root}")


def tokenize(raw_terms: list[str]) -> list[str]:
    terms: list[str] = []
    for raw in raw_terms:
        for part in re.split(r"[\s,;:/\\|]+", raw.strip().lower()):
            if part:
                terms.append(part)
                if "-" in part:
                    terms.extend(token for token in part.split("-") if token)
    return list(dict.fromkeys(terms))


def first_heading(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return None


def score_text(path: Path, text: str, terms: list[str]) -> tuple[int, list[str]]:
    if not terms:
        return 1, []
    haystack = f"{path.as_posix()}\n{text}".lower()
    score = 0
    hits: list[str] = []
    for term in terms:
        count = haystack.count(term)
        if count:
            score += min(count, 8)
            hits.append(term)
    return score, hits


def inspect_inbox(superpowers_root: Path, terms: list[str]) -> list[dict[str, object]]:
    inbox_root = superpowers_root / "inbox"
    if not inbox_root.is_dir():
        return []

    items: list[dict[str, object]] = []
    for path in sorted(inbox_root.rglob("*-inbox.md")):
        if path.name == "INDEX.md":
            continue
        text = read_text(path)
        score, hits = score_text(path, text, terms)
        if score <= 0:
            continue
        metadata = extract_metadata(text)
        lifecycle = metadata.get("Lifecycle")
        revisit_trigger = metadata.get("Revisit trigger")
        issues: list[str] = []
        if not lifecycle or not revisit_trigger:
            issues.append("missing_lifecycle")
        elif lifecycle not in VALID_LIFECYCLES:
            issues.append("invalid_lifecycle")

        needs_revisit = bool(issues) or lifecycle in OPEN_LIFECYCLES
        items.append(
            {
                "score": score,
                "title": first_heading(text),
                "path": str(path.relative_to(superpowers_root.parent.parent if superpowers_root.parent.name == "docs" else superpowers_root)),
                "topic_slug": metadata.get("Topic slug"),
                "lifecycle": lifecycle,
                "revisit_trigger": revisit_trigger,
                "route_candidate": metadata.get("Route candidate"),
                "needs_revisit": needs_revisit,
                "issues": issues,
                "hits": hits,
            }
        )

    items.sort(key=lambda item: (-int(item["score"]), str(item["path"])))
    return items


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Inspect related inbox notes and lifecycle status.")
    parser.add_argument("root", help="Repository root or docs/superpowers path.")
    parser.add_argument("keywords", nargs="*", help="Keywords or slug fragments. Omit to list all inbox notes.")
    parser.add_argument("--needs-revisit-only", action="store_true", help="Only show Open, Partially promoted, or lifecycle-missing notes.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    superpowers_root = discover_superpowers_root(Path(args.root))
    items = inspect_inbox(superpowers_root, tokenize(args.keywords))
    if args.needs_revisit_only:
        items = [item for item in items if item["needs_revisit"]]

    result = {
        "root": str(superpowers_root),
        "items": items,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if not items:
            print("No matching inbox notes found.")
        for item in items:
            flag = "needs-revisit" if item["needs_revisit"] else "closed"
            issues = f" issues={','.join(item['issues'])}" if item["issues"] else ""
            print(f"{item['lifecycle'] or 'Legacy':<18} {flag:<14} {item['path']}{issues}")
            if item["revisit_trigger"]:
                print(f"    revisit: {item['revisit_trigger']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
