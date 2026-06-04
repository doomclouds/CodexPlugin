#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from _asset_utils import ASSET_AREAS, discover_superpowers_root


ENTRY_RE = re.compile(r"^- \[(?P<label>[^\]]+)\]\((?P<link>[^)]+)\):(?P<summary>.*)$")
MONTH_RE = re.compile(r"^## (?P<month>\d{4}-\d{2})\s*$")


def parse_index(index_file: Path) -> tuple[list[str], list[dict[str, str]]]:
    current_month: str | None = None
    months: list[str] = []
    entries: list[dict[str, str]] = []
    for line_no, line in enumerate(index_file.read_text(encoding="utf-8").splitlines(), start=1):
        month_match = MONTH_RE.match(line)
        if month_match:
            current_month = month_match.group("month")
            months.append(current_month)
            continue

        entry_match = ENTRY_RE.match(line)
        if entry_match:
            entries.append(
                {
                    "line": str(line_no),
                    "month": current_month or "",
                    "label": entry_match.group("label"),
                    "link": entry_match.group("link"),
                    "summary": entry_match.group("summary").strip(),
                }
            )
    return months, entries


def date_slug_from_name(name: str, suffix: str) -> tuple[str, str] | None:
    if not name.endswith(suffix):
        return None
    stem = name[: -len(suffix)]
    match = re.match(r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<slug>.+)$", stem)
    if not match:
        return None
    return match.group("date"), match.group("slug")


def check_area(superpowers_root: Path, area: str) -> list[dict[str, str]]:
    config = ASSET_AREAS[area]
    index_name = config.get("index")
    if not index_name:
        return []

    suffix = str(config["suffix"])
    area_root = superpowers_root / area
    issues: list[dict[str, str]] = []
    if not area_root.exists():
        return issues

    index_file = area_root / index_name
    asset_files = sorted(path for path in area_root.rglob(f"*{suffix}") if path.name != index_name)
    if not index_file.exists():
        if asset_files:
            issues.append({"severity": "error", "area": area, "code": "missing_index", "message": f"Missing {index_file}"})
        return issues

    months, entries = parse_index(index_file)
    expected_months = sorted(set(months), reverse=True)
    if months != expected_months:
        issues.append(
            {
                "severity": "error",
                "area": area,
                "code": "month_order",
                "message": f"Month headings are not newest-first: {months}",
            }
        )

    seen_targets: dict[str, str] = {}
    indexed_targets: set[Path] = set()
    entries_by_month: dict[str, list[dict[str, str]]] = {}
    for entry in entries:
        link = entry["link"].split("#", 1)[0]
        target = (index_file.parent / link).resolve()
        indexed_targets.add(target)
        entries_by_month.setdefault(entry["month"], []).append(entry)

        if str(target) in seen_targets:
            issues.append(
                {
                    "severity": "error",
                    "area": area,
                    "code": "duplicate_entry",
                    "message": f"Duplicate link at line {entry['line']}: {entry['link']}",
                }
            )
        seen_targets[str(target)] = entry["line"]

        if not target.exists():
            issues.append(
                {
                    "severity": "error",
                    "area": area,
                    "code": "dead_link",
                    "message": f"Dead link at line {entry['line']}: {entry['link']}",
                }
            )
            continue

        parsed = date_slug_from_name(target.name, suffix)
        if parsed and entry["month"] and parsed[0][:7] != entry["month"]:
            issues.append(
                {
                    "severity": "error",
                    "area": area,
                    "code": "wrong_month_group",
                    "message": f"{target.name} is under index month {entry['month']}",
                }
            )

        if not entry["summary"]:
            issues.append(
                {
                    "severity": "warning",
                    "area": area,
                    "code": "missing_summary",
                    "message": f"Missing summary at line {entry['line']}: {entry['link']}",
                }
            )

    for month, month_entries in entries_by_month.items():
        sortable: list[tuple[str, str, dict[str, str]]] = []
        for entry in month_entries:
            target = (index_file.parent / entry["link"].split("#", 1)[0]).resolve()
            parsed = date_slug_from_name(target.name, suffix)
            if parsed:
                sortable.append((parsed[0], parsed[1], entry))
        expected = sorted(sortable, key=lambda item: (-int(item[0].replace("-", "")), item[1]))
        if sortable != expected:
            issues.append(
                {
                    "severity": "error",
                    "area": area,
                    "code": "entry_order",
                    "message": f"Entries under {month} are not newest-first then slug-sorted",
                }
            )

    for asset_file in asset_files:
        if asset_file.resolve() not in indexed_targets:
            issues.append(
                {
                    "severity": "error",
                    "area": area,
                    "code": "orphan_asset",
                    "message": f"Asset file is missing from index: {asset_file.relative_to(area_root)}",
                }
            )

    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Superpowers archive/problem/inbox indexes.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root or docs/superpowers path.")
    parser.add_argument("--area", choices=["all", "archives", "problems", "inbox"], default="all")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    superpowers_root = discover_superpowers_root(Path(args.root))
    areas = ["archives", "problems", "inbox"] if args.area == "all" else [args.area]
    issues: list[dict[str, str]] = []
    for area in areas:
        issues.extend(check_area(superpowers_root, area))

    result = {"root": str(superpowers_root), "issues": issues}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if not issues:
            print(f"OK: indexes are valid under {superpowers_root}")
        else:
            for issue in issues:
                print(f"{issue['severity'].upper()} [{issue['area']}/{issue['code']}]: {issue['message']}")

    return 1 if any(issue["severity"] == "error" for issue in issues) else 0


if __name__ == "__main__":
    sys.exit(main())
