#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from asset_core.issues import issue
from asset_core.topics import canonical_slug
from checks.archive_checks import check_archive_coverage
from checks.handoff_checks import check_asset_gate_text
from checks.repo_structure_checks import check_relayout_leftovers, check_solution_folders, discover_possible_root_dirs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check asset-compounding completion gate evidence.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root.")
    parser.add_argument("--handoff-text", default="", help="Final handoff or gate text to inspect.")
    parser.add_argument("--handoff-file", help="File containing final handoff or gate text.")
    parser.add_argument("--require-asset-gate", action="store_true", help="Fail if handoff text lacks asset_gate output.")
    parser.add_argument("--asset-candidate", action="append", default=[], help="Candidate lesson from reviewer/subagent/tool output. Can repeat.")
    parser.add_argument("--completed-topic", action="append", default=[], help="Completed requirement slug/topic to verify archive coverage. Can repeat.")
    parser.add_argument("--require-asset-candidates", action="store_true", help="Warn when no candidate list was supplied.")
    parser.add_argument("--skip-structure-checks", action="store_true", help="Skip src/tests and solution-folder checks.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    issues: list[dict[str, str]] = []
    candidates = [candidate.strip() for candidate in args.asset_candidate if candidate.strip()]

    handoff_text = args.handoff_text
    if args.handoff_file:
        handoff_path = Path(args.handoff_file)
        if not handoff_path.is_absolute():
            handoff_path = root / handoff_path
        if handoff_path.is_file():
            handoff_text += "\n" + handoff_path.read_text(encoding="utf-8")
        else:
            issues.append(issue("error", "handoff_file_missing", "Handoff file does not exist.", path=str(handoff_path)))

    if args.require_asset_gate:
        check_asset_gate_text(handoff_text, issues)

    if args.require_asset_candidates and not candidates:
        issues.append(
            issue(
                "warning",
                "missing_asset_candidates",
                "No asset candidates were supplied; record 'none' explicitly when there are none.",
            )
        )

    issues.extend(check_archive_coverage(root, args.completed_topic))

    if not args.skip_structure_checks and root.is_dir():
        issues.extend(check_relayout_leftovers(root))
        issues.extend(check_solution_folders(root))

    errors = [item for item in issues if item["severity"] == "error"]
    result = {
        "status": "needs_attention" if issues else "pass",
        "issues": issues,
        "asset_candidates": candidates,
        "checks": {
            "asset_gate_required": args.require_asset_gate,
            "asset_candidates_required": args.require_asset_candidates,
            "completed_topics": [canonical_slug(topic) for topic in args.completed_topic],
            "structure_checks": not args.skip_structure_checks,
            "possible_root_dirs": discover_possible_root_dirs(root) if root.is_dir() else [],
        },
        "note": "This script reports completion-gate evidence and candidates; the main agent still chooses the final asset route.",
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"status: {result['status']}")
        for item in issues:
            path = f" ({item['path']})" if "path" in item else ""
            print(f"- {item['severity']} {item['code']}: {item['message']}{path}")
        if candidates:
            print("asset_candidates:")
            for candidate in candidates:
                print(f"- {candidate}")
        print(result["note"])
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
