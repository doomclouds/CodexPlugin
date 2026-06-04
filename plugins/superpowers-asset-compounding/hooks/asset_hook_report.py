#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any


def iter_events(root: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for path in sorted(root.rglob("events.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                events.append(payload)
    return events


def summarize(events: list[dict[str, Any]]) -> dict[str, Any]:
    by_hook = Counter(str(event.get("hookEventName") or "unknown") for event in events)
    decisions = Counter(str(event.get("decision") or "unknown") for event in events)
    reason_codes = Counter(str(event.get("reasonCode") or "unknown") for event in events)
    command_kinds = Counter(
        str(event.get("commandKind") or "none")
        for event in events
        if event.get("hookEventName") == "PostToolUse"
    )
    post_tool_events = [event for event in events if event.get("hookEventName") == "PostToolUse"]
    durations = sorted(
        int(event["durationMs"])
        for event in events
        if isinstance(event.get("durationMs"), int)
    )
    slow_events = sorted(
        (
            event
            for event in events
            if isinstance(event.get("durationMs"), int)
        ),
        key=lambda event: int(event["durationMs"]),
        reverse=True,
    )[:10]
    repo_names = sorted({str(event.get("repoName")) for event in events if event.get("repoName")})

    return {
        "total_events": len(events),
        "by_hook": dict(sorted(by_hook.items())),
        "decisions": dict(sorted(decisions.items())),
        "reason_codes": dict(sorted(reason_codes.items())),
        "stop_events": by_hook.get("Stop", 0),
        "stop_blocks": sum(1 for event in events if event.get("hookEventName") == "Stop" and event.get("decision") == "block"),
        "stop_allows": sum(1 for event in events if event.get("hookEventName") == "Stop" and event.get("decision") == "allow"),
        "asset_gate_present": reason_codes.get("asset_gate_present", 0),
        "subagent_missing_candidates": reason_codes.get("missing_asset_candidates", 0),
        "subagent_candidates_collected": sum(
            int(event.get("candidateCount") or 0)
            for event in events
            if event.get("hookEventName") == "SubagentStop" and event.get("reasonCode") == "candidates_reported"
        ),
        "verification_failed_detected": sum(1 for event in events if event.get("verificationStatus") == "failed"),
        "verification_passed_detected": sum(1 for event in events if event.get("verificationStatus") == "passed"),
        "verification_observed": sum(1 for event in events if event.get("verificationStatus") == "observed"),
        "asset_files_changed_events": sum(1 for event in events if event.get("assetFilesChanged") is True),
        "asset_files_changed_this_tool": sum(
            1 for event in post_tool_events if event.get("assetFilesChangedThisTool") is True
        ),
        "command_kinds": dict(sorted(command_kinds.items())),
        "unknown_command_kind_ratio": ratio(command_kinds.get("unknown", 0), len(post_tool_events)),
        "hook_duration_ms": duration_summary(durations),
        "slow_events": [
            {
                "hookEventName": event.get("hookEventName"),
                "decision": event.get("decision"),
                "reasonCode": event.get("reasonCode"),
                "durationMs": event.get("durationMs"),
                "toolName": event.get("toolName"),
                "commandKind": event.get("commandKind"),
                "repoName": event.get("repoName"),
            }
            for event in slow_events
        ],
        "repos": repo_names,
    }


def ratio(numerator: int, denominator: int) -> float:
    if denominator == 0:
        return 0.0
    return round(numerator / denominator, 4)


def duration_summary(durations: list[int]) -> dict[str, int | None]:
    if not durations:
        return {
            "count": 0,
            "min": None,
            "p50": None,
            "p95": None,
            "max": None,
        }
    return {
        "count": len(durations),
        "min": durations[0],
        "p50": percentile(durations, 0.50),
        "p95": percentile(durations, 0.95),
        "max": durations[-1],
    }


def percentile(sorted_values: list[int], fraction: float) -> int:
    if not sorted_values:
        raise ValueError("sorted_values must not be empty")
    index = min(len(sorted_values) - 1, max(0, round((len(sorted_values) - 1) * fraction)))
    return sorted_values[index]


def print_text(summary: dict[str, Any]) -> None:
    print(f"total_events: {summary['total_events']}")
    print(f"stop_blocks: {summary['stop_blocks']}")
    print(f"asset_gate_present: {summary['asset_gate_present']}")
    print(f"subagent_missing_candidates: {summary['subagent_missing_candidates']}")
    print(f"subagent_candidates_collected: {summary['subagent_candidates_collected']}")
    print(f"verification_failed_detected: {summary['verification_failed_detected']}")
    print(f"unknown_command_kind_ratio: {summary['unknown_command_kind_ratio']}")
    print(f"hook_duration_ms: {summary['hook_duration_ms']}")
    print("command_kinds:")
    for name, count in summary["command_kinds"].items():
        print(f"- {name}: {count}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize asset-compounding hook usage events.")
    parser.add_argument(
        "plugin_data",
        nargs="?",
        default=os.environ.get("PLUGIN_DATA") or ".asset-plugin-data",
        help="PLUGIN_DATA root containing per-session events.jsonl files.",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    events = iter_events(Path(args.plugin_data).resolve())
    summary = summarize(events)
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print_text(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
