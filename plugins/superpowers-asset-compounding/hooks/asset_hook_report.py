#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any


def iter_event_records(root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []
    invalid_records: list[dict[str, Any]] = []
    for path in sorted(root.rglob("events.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                invalid_records.append(
                    {
                        "file": str(path),
                        "line": line_number,
                    }
                )
                continue
            if isinstance(payload, dict):
                payload["_eventFile"] = str(path)
                payload["_session"] = path.parent.name
                payload["_archived"] = "_archives" in path.parts
                events.append(payload)
    return events, invalid_records


def iter_events(root: Path) -> list[dict[str, Any]]:
    events, _invalid_records = iter_event_records(root)
    return events


def parse_date_filter(value: str | None) -> str | None:
    return value or None


def event_date(event: dict[str, Any]) -> str | None:
    timestamp = event.get("timestampUtc")
    if not isinstance(timestamp, str) or len(timestamp) < 10:
        return None
    return timestamp[:10]


def event_matches_filters(event: dict[str, Any], filters: dict[str, str | None]) -> bool:
    date = event_date(event)
    if filters.get("since") and (date is None or date < str(filters["since"])):
        return False
    if filters.get("until") and (date is None or date > str(filters["until"])):
        return False
    if filters.get("repo") and event.get("repoName") != filters["repo"]:
        return False
    if filters.get("reason") and event.get("reasonCode") != filters["reason"]:
        return False
    return True


def session_summaries(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        grouped.setdefault(str(event.get("_session") or "unknown"), []).append(event)
    summaries = []
    for session, session_events in sorted(grouped.items()):
        timestamps = [str(event.get("timestampUtc")) for event in session_events if event.get("timestampUtc")]
        final_signals: list[str] = []
        for event in session_events:
            signals = event.get("signals")
            if isinstance(signals, list):
                final_signals = sorted(str(signal) for signal in signals)
        stop_blocks = [
            event for event in session_events if event.get("hookEventName") == "Stop" and event.get("decision") == "block"
        ]
        summaries.append(
            {
                "session": session,
                "repoName": next((event.get("repoName") for event in session_events if event.get("repoName")), None),
                "firstTimestampUtc": min(timestamps) if timestamps else None,
                "lastTimestampUtc": max(timestamps) if timestamps else None,
                "toolEventCount": sum(1 for event in session_events if event.get("hookEventName") == "PostToolUse"),
                "stopBlockCount": len(stop_blocks),
                "reasonCodes": sorted({str(event.get("reasonCode")) for event in stop_blocks}),
                "finalSignals": final_signals,
                "assetGateDueEver": any(event.get("assetGateDue") is True for event in session_events),
                "assetFilesChangedEver": any(event.get("assetFilesChanged") is True for event in session_events),
                "signalsAdded": sorted(
                    {
                        str(signal)
                        for event in session_events
                        for signal in (event.get("signalsAdded") or [])
                    }
                ),
            }
        )
    return summaries


def summarize(
    events: list[dict[str, Any]],
    invalid_records: list[dict[str, Any]] | None = None,
    filters: dict[str, str | None] | None = None,
    session_context_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    invalid_records = invalid_records or []
    filters = filters or {"since": None, "until": None, "repo": None, "reason": None}
    session_context_events = session_context_events or events
    by_hook = Counter(str(event.get("hookEventName") or "unknown") for event in events)
    decisions = Counter(str(event.get("decision") or "unknown") for event in events)
    reason_codes = Counter(str(event.get("reasonCode") or "unknown") for event in events)
    command_kinds = Counter(
        str(event.get("commandKind") or "none")
        for event in session_context_events
        if event.get("hookEventName") == "PostToolUse"
    )
    post_tool_events = [event for event in session_context_events if event.get("hookEventName") == "PostToolUse"]
    unknown_command_events = [
        event
        for event in post_tool_events
        if str(event.get("commandKind") or "none") == "unknown"
    ]
    durations = sorted(
        int(event["durationMs"])
        for event in session_context_events
        if isinstance(event.get("durationMs"), int)
    )
    slow_events = sorted(
        (
            event
            for event in session_context_events
            if isinstance(event.get("durationMs"), int)
        ),
        key=lambda event: int(event["durationMs"]),
        reverse=True,
    )[:10]
    repo_names = sorted({str(event.get("repoName")) for event in session_context_events if event.get("repoName")})
    stop_blocks_by_reason = Counter(
        str(event.get("reasonCode") or "unknown")
        for event in events
        if event.get("hookEventName") == "Stop" and event.get("decision") == "block"
    )
    sessions = session_summaries(session_context_events)
    stop_block_sessions = [session for session in sessions if int(session["stopBlockCount"]) > 0]
    signal_sets = Counter(
        tuple(sorted(str(signal) for signal in event.get("signals", [])))
        for event in session_context_events
        if isinstance(event.get("signals"), list) and event.get("signals")
    )
    signals_added = Counter(
        str(signal)
        for event in session_context_events
        for signal in (event.get("signalsAdded") or [])
    )

    return {
        "filters": filters,
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
        "stop_blocks_by_reason": dict(sorted(stop_blocks_by_reason.items())),
        "stop_block_sessions": stop_block_sessions,
        "sessions_with_gate_due": sum(1 for session in sessions if session["assetGateDueEver"] is True),
        "top_signal_sets": [
            {"signals": list(signals), "count": count}
            for signals, count in sorted(signal_sets.items(), key=lambda item: (-item[1], list(item[0])))
        ][:10],
        "signals_added": dict(sorted(signals_added.items())),
        "command_kinds": dict(sorted(command_kinds.items())),
        "unknown_command_kind_ratio": ratio(command_kinds.get("unknown", 0), len(post_tool_events)),
        "unknown_command_tools": dict(
            sorted(Counter(str(event.get("toolName") or "unknown") for event in unknown_command_events).items())
        ),
        "unknown_command_repos": dict(
            sorted(Counter(str(event.get("repoName") or "unknown") for event in unknown_command_events).items())
        ),
        "unknown_command_clusters": unknown_command_clusters(unknown_command_events),
        "invalid_json_lines": len(invalid_records),
        "invalid_json_files": len({str(record.get("file") or "") for record in invalid_records}),
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


def unknown_command_clusters(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: Counter[tuple[str | None, int | None, str, str]] = Counter()
    for event in events:
        command_hash = event.get("commandHash")
        command_length = event.get("commandLength")
        key = (
            command_hash if isinstance(command_hash, str) else None,
            command_length if isinstance(command_length, int) else None,
            str(event.get("toolName") or "unknown"),
            str(event.get("repoName") or "unknown"),
        )
        grouped[key] += 1

    clusters = []
    for (command_hash, command_length, tool_name, repo_name), count in grouped.items():
        clusters.append(
            {
                "count": count,
                "commandHash": command_hash,
                "commandLength": command_length,
                "toolName": tool_name,
                "repoName": repo_name,
            }
        )
    clusters.sort(
        key=lambda item: (
            -int(item["count"]),
            str(item["toolName"]),
            str(item["repoName"]),
            str(item["commandHash"] or ""),
            int(item["commandLength"] or -1),
        )
    )
    return clusters[:10]


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
    print(f"invalid_json_lines: {summary['invalid_json_lines']}")
    print(f"invalid_json_files: {summary['invalid_json_files']}")
    print(f"hook_duration_ms: {summary['hook_duration_ms']}")
    print("command_kinds:")
    for name, count in summary["command_kinds"].items():
        print(f"- {name}: {count}")
    print("unknown_command_tools:")
    for name, count in summary["unknown_command_tools"].items():
        print(f"- {name}: {count}")
    print("unknown_command_clusters:")
    for cluster in summary["unknown_command_clusters"]:
        print(
            f"- count={cluster['count']} tool={cluster['toolName']} repo={cluster['repoName']} "
            f"hash={cluster['commandHash']} length={cluster['commandLength']}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize asset-compounding hook usage events.")
    parser.add_argument(
        "plugin_data",
        nargs="?",
        default=os.environ.get("PLUGIN_DATA") or ".asset-plugin-data",
        help="PLUGIN_DATA root containing per-session events.jsonl files.",
    )
    parser.add_argument("--since")
    parser.add_argument("--until")
    parser.add_argument("--repo")
    parser.add_argument("--reason")
    parser.add_argument("--active-only", action="store_true")
    parser.add_argument("--archives-only", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.active_only and args.archives_only:
        error = {"error": "cannot combine --active-only with --archives-only"}
        if args.json:
            print(json.dumps(error, ensure_ascii=False, indent=2))
        else:
            print(error["error"])
        return 1

    filters = {
        "since": parse_date_filter(args.since),
        "until": parse_date_filter(args.until),
        "repo": args.repo or None,
        "reason": args.reason or None,
    }
    events, invalid_records = iter_event_records(Path(args.plugin_data).resolve())
    if args.active_only:
        events = [event for event in events if event.get("_archived") is not True]
    elif args.archives_only:
        events = [event for event in events if event.get("_archived") is True]
    scoped_events = [event for event in events if event_matches_filters(event, {**filters, "reason": None})]
    filtered_events = [event for event in scoped_events if event_matches_filters(event, filters)]
    matched_sessions = {str(event.get("_session") or "unknown") for event in filtered_events}
    session_context_events = [
        event for event in scoped_events if str(event.get("_session") or "unknown") in matched_sessions
    ]
    summary = summarize(filtered_events, invalid_records, filters, session_context_events)
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print_text(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
