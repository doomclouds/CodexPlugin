#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from _asset_utils import discover_superpowers_root
from asset_core.indexes import check_area


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Superpowers and project-level asset indexes.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root or docs/superpowers path.")
    parser.add_argument(
        "--area",
        choices=["all", "archives", "problems", "inbox", "milestones", "technical-debt"],
        default="all",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    superpowers_root = discover_superpowers_root(Path(args.root))
    areas = ["archives", "problems", "inbox", "milestones", "technical-debt"] if args.area == "all" else [args.area]
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
