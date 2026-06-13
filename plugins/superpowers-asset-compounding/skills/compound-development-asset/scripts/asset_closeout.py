#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from asset_status import build_status


def has_milestone_progress_issue(status: dict[str, object]) -> bool:
    milestone_status = status.get("milestone_status", {})
    if not isinstance(milestone_status, dict):
        return False
    issues = milestone_status.get("issues", [])
    if not isinstance(issues, list):
        return False
    for item in issues:
        if not isinstance(item, dict):
            continue
        code = str(item.get("code", ""))
        message = str(item.get("message", "")).lower()
        if code in {"milestone_status_progress_drift", "milestone_progress_mismatch", "milestone_index_mismatch"}:
            return True
        if "status/progress" in message or ("progress" in message and "milestone" in message):
            return True
    return False


def has_technical_debt_issue(status: dict[str, object]) -> bool:
    technical_debt_status = status.get("technical_debt_status", {})
    if not isinstance(technical_debt_status, dict):
        return False
    issues = technical_debt_status.get("issues", [])
    return isinstance(issues, list) and bool(issues)


def build_closeout(root: Path, topic: str) -> dict[str, object]:
    status = build_status(root, topic)
    missing: list[str] = []
    required_actions: list[str] = []

    requirement_archive = status["requirement_archive"]
    assert isinstance(requirement_archive, dict)
    if requirement_archive["status"] != "found":
        missing.append("requirement_archive")
        required_actions.append(f"write archive for topic {status['topic']}")

    indexes = status["indexes"]
    completion_gate = status["completion_gate"]
    assert isinstance(indexes, dict)
    assert isinstance(completion_gate, dict)
    if indexes["status"] != "pass":
        missing.append("index_health")
        required_actions.append("fix asset index issues")
    if completion_gate["status"] != "pass" and "requirement_archive" not in missing:
        missing.append("completion_gate")
        required_actions.append("resolve completion gate issues")
    if has_milestone_progress_issue(status):
        missing.append("milestone_progress")
        required_actions.append("update milestone progress")
    if has_technical_debt_issue(status):
        missing.append("technical_debt")
        required_actions.append("resolve or update technical debt records")

    route = "none"
    if "requirement_archive" in missing:
        route = "archive"
    elif required_actions:
        route = "update-existing"

    gate = "pass" if not required_actions else "fail"
    result = {
        "status": "pass" if gate == "pass" else "needs_attention",
        "topic": status["topic"],
        "route": route,
        "missing": missing,
        "required_actions": required_actions,
        "related_assets": {
            "archive": requirement_archive.get("path"),
            "problems": [item["path"] for item in status["problem_assets"]],
            "inbox": [item["path"] for item in status["inbox_assets"]],
            "milestones": [item["path"] for item in status["milestone_assets"]],
            "technical_debt": [item["path"] for item in status["technical_debt_assets"]],
        },
        "asset_candidates": [],
        "handoff_block": {
            "requirement_archive": "yes" if requirement_archive["status"] == "found" else "no",
            "problem_archive": "yes" if status["problem_assets"] else "no",
            "inbox": "none" if not status["inbox_assets"] else str(len(status["inbox_assets"])),
            "gate": gate,
        },
        "asset_gate": {
            "event_type": "implementation-boundary",
            "route": route,
            "reason": "closeout checks passed" if gate == "pass" else "closeout checks found missing asset work",
            "evidence": "asset_status, check_indexes, and completion_gate results",
            "related_assets": "see related_assets",
            "asset_candidates": "none",
            "deferred_signals": "none",
            "next_step": "none" if gate == "pass" else "writer skill",
        },
        "status_detail": status,
    }
    return result


def print_text(result: dict[str, object]) -> None:
    print(f"Asset closeout: {result['status']}")
    print(f"- route: {result['route']}")
    print(f"- missing: {', '.join(result['missing']) if result['missing'] else 'none'}")
    print("- handoff:")
    handoff = result["handoff_block"]
    assert isinstance(handoff, dict)
    for key in ("requirement_archive", "problem_archive", "inbox", "gate"):
        print(f"  {key}: {handoff[key]}")
    required_actions = result["required_actions"]
    assert isinstance(required_actions, list)
    if required_actions:
        print("- required_actions:")
        for action in required_actions:
            print(f"  - {action}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run closeout-oriented asset checks for one topic.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root or docs/superpowers path.")
    parser.add_argument("--topic", required=True, help="Completed requirement topic slug or keywords.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    result = build_closeout(Path(args.root).resolve(), args.topic)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_text(result)
    return 1 if result["status"] != "pass" else 0


if __name__ == "__main__":
    sys.exit(main())
