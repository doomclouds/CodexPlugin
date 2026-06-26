#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
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


def session_event_files(root: Path, include_archives: bool = False) -> list[Path]:
    files: list[Path] = []
    for path in sorted(root.rglob("events.jsonl")):
        in_archives = "_archives" in path.parts
        if in_archives and not include_archives:
            continue
        if not in_archives:
            files.append(path)
    return files


def read_event_file(path: Path) -> tuple[list[dict[str, Any]], int]:
    events: list[dict[str, Any]] = []
    invalid = 0
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return [], 0
    for line in lines:
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            invalid += 1
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return events, invalid


def session_bounds(path: Path) -> dict[str, Any]:
    events, invalid = read_event_file(path)
    timestamps = [str(event.get("timestampUtc")) for event in events if event.get("timestampUtc")]
    return {
        "path": path,
        "session": path.parent.name,
        "events": events,
        "invalid": invalid,
        "firstTimestampUtc": min(timestamps) if timestamps else None,
        "lastTimestampUtc": max(timestamps) if timestamps else None,
        "repoName": next((event.get("repoName") for event in events if event.get("repoName")), None),
    }


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
    strict_events = events
    by_hook = Counter(str(event.get("hookEventName") or "unknown") for event in events)
    decisions = Counter(str(event.get("decision") or "unknown") for event in events)
    reason_codes = Counter(str(event.get("reasonCode") or "unknown") for event in events)
    command_kinds = Counter(
        str(event.get("commandKind") or "none")
        for event in strict_events
        if event.get("hookEventName") == "PostToolUse"
    )
    post_tool_events = [event for event in strict_events if event.get("hookEventName") == "PostToolUse"]
    unknown_command_events = [
        event
        for event in post_tool_events
        if str(event.get("commandKind") or "none") == "unknown"
    ]
    durations = sorted(
        int(event["durationMs"])
        for event in strict_events
        if isinstance(event.get("durationMs"), int)
    )
    slow_events = sorted(
        (
            event
            for event in strict_events
            if isinstance(event.get("durationMs"), int)
        ),
        key=lambda event: int(event["durationMs"]),
        reverse=True,
    )[:10]
    repo_names = sorted({str(event.get("repoName")) for event in strict_events if event.get("repoName")})
    stop_blocks_by_reason = Counter(
        str(event.get("reasonCode") or "unknown")
        for event in events
        if event.get("hookEventName") == "Stop" and event.get("decision") == "block"
    )
    session_summary_items = session_summaries(session_context_events)
    stop_block_sessions = [session for session in session_summary_items if int(session["stopBlockCount"]) > 0]
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
        "sessions_with_gate_due": sum(1 for session in session_summary_items if session["assetGateDueEver"] is True),
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def archive_hash(file_rows: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in sorted(file_rows, key=lambda item: str(item["originalPath"])):
        digest.update(str(row["originalPath"]).encode("utf-8"))
        digest.update(str(row["sha256"]).encode("utf-8"))
    return digest.hexdigest()[:16]


def archive_filters(args: argparse.Namespace) -> dict[str, str | None]:
    until = parse_date_filter(args.until or args.before)
    return {
        "since": parse_date_filter(args.since),
        "until": until,
        "repo": args.repo or None,
        "reason": None,
    }


def select_archive_sessions(root: Path, filters: dict[str, str | None], include_current: bool) -> list[dict[str, Any]]:
    sessions: list[dict[str, Any]] = []
    for event_file in session_event_files(root):
        info = session_bounds(event_file)
        session_dir = event_file.parent
        if session_dir.name == "_archives" or "_archives" in session_dir.parts:
            continue
        if not include_current and (session_dir / "state.json").exists():
            continue
        if not session_matches_archive_filters(info, filters):
            continue
        matched_events = [event for event in info["events"] if event_matches_filters(event, filters)]
        info["matchedEventCount"] = len(matched_events)
        info["eventCount"] = len(info["events"])
        info["isCurrent"] = (session_dir / "state.json").exists()
        info["sourceDir"] = session_dir
        sessions.append(info)
    return sessions


def session_matches_archive_filters(session: dict[str, Any], filters: dict[str, str | None]) -> bool:
    first_date = timestamp_to_date(session.get("firstTimestampUtc"))
    last_date = timestamp_to_date(session.get("lastTimestampUtc"))
    if filters.get("repo") and session.get("repoName") != filters["repo"]:
        return False
    if filters.get("since") and (first_date is None or first_date < str(filters["since"])):
        return False
    if filters.get("until") and (last_date is None or last_date > str(filters["until"])):
        return False
    return True


def timestamp_to_date(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    return value[:10]


def resolve_archive_root(base_root: Path) -> Path:
    if not base_root.exists():
        return base_root
    suffix = 2
    while True:
        candidate = base_root.with_name(f"{base_root.name}-{suffix}")
        if not candidate.exists():
            return candidate
        suffix += 1


def run_archive(args: argparse.Namespace) -> int:
    root = Path(args.plugin_data).resolve()
    filters = archive_filters(args)
    sessions = select_archive_sessions(root, filters, args.include_current)
    total_events = sum(int(session["eventCount"]) for session in sessions)
    timestamps = [
        timestamp[:10]
        for session in sessions
        for timestamp in (
            str(event.get("timestampUtc"))
            for event in session["events"]
            if isinstance(event.get("timestampUtc"), str) and len(str(event.get("timestampUtc"))) >= 10
        )
    ]
    from_date = min(timestamps) if timestamps else None
    until_date = max(timestamps) if timestamps else None
    file_rows: list[dict[str, Any]] = []
    for session in sessions:
        source_dir = Path(session["sourceDir"])
        event_file = source_dir / "events.jsonl"
        file_rows.append(
            {
                "session": str(session["session"]),
                "repoName": session["repoName"],
                "originalPath": str(source_dir.relative_to(root).as_posix()),
                "eventCount": int(session["eventCount"]),
                "firstTimestampUtc": session["firstTimestampUtc"],
                "lastTimestampUtc": session["lastTimestampUtc"],
                "sha256": sha256_file(event_file),
            }
        )
    hash_value = archive_hash(file_rows)
    base_archive_root = (
        root / "_archives" / f"{from_date or 'unknown'}_to_{until_date or 'unknown'}" / hash_value
    )
    archive_root = resolve_archive_root(base_archive_root)
    result = {
        "status": "dry_run" if args.dry_run else "archived",
        "archivePath": None if args.dry_run else str(archive_root),
        "archiveHash": hash_value,
        "fromDate": from_date,
        "untilDate": until_date,
        "sessionCount": len(sessions),
        "eventCount": total_events,
        "filters": filters,
        "files": file_rows,
    }
    if args.dry_run:
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print_archive_text(result)
        return 0

    archive_root.mkdir(parents=True, exist_ok=False)
    manifest_rows: list[dict[str, Any]] = []
    for row in file_rows:
        source_dir = root / Path(str(row["originalPath"]))
        destination_dir = archive_root / str(row["session"])
        shutil.copytree(source_dir, destination_dir)
        destination_hash = sha256_file(destination_dir / "events.jsonl")
        if destination_hash != row["sha256"]:
            raise RuntimeError(f"hash mismatch for {row['session']}")
        manifest_row = dict(row)
        manifest_row["archivedPath"] = str(destination_dir.relative_to(root).as_posix())
        manifest_rows.append(manifest_row)

    manifest = {
        "archiveHash": hash_value,
        "fromDate": from_date,
        "untilDate": until_date,
        "sessionCount": len(sessions),
        "eventCount": total_events,
        "filters": filters,
        "files": manifest_rows,
    }
    (archive_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    saved_manifest = json.loads((archive_root / "manifest.json").read_text(encoding="utf-8"))
    if saved_manifest.get("archiveHash") != hash_value:
        raise RuntimeError("manifest verification failed")
    for row in file_rows:
        source_dir = root / Path(str(row["originalPath"]))
        shutil.rmtree(source_dir)
    result["files"] = manifest_rows
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_archive_text(result)
    return 0


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


def print_archive_text(result: dict[str, Any]) -> None:
    print(f"status: {result['status']}")
    print(f"archive_hash: {result['archiveHash']}")
    print(f"from_date: {result['fromDate']}")
    print(f"until_date: {result['untilDate']}")
    print(f"session_count: {result['sessionCount']}")
    print(f"event_count: {result['eventCount']}")
    archive_path = result.get("archivePath")
    if archive_path:
        print(f"archive_path: {archive_path}")
    print("files:")
    for row in result["files"]:
        line = (
            f"- session={row['session']} repo={row['repoName']} events={row['eventCount']} "
            f"original_path={row['originalPath']}"
        )
        if row.get("archivedPath"):
            line += f" archived_path={row['archivedPath']}"
        print(line)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Summarize asset-compounding hook usage events.")
    parser.add_argument(
        "plugin_data",
        help="PLUGIN_DATA root containing per-session events.jsonl files.",
    )
    parser.add_argument("--since")
    parser.add_argument("--until")
    parser.add_argument("--repo")
    parser.add_argument("--reason")
    parser.add_argument("--active-only", action="store_true")
    parser.add_argument("--archives-only", action="store_true")
    parser.add_argument("--json", action="store_true")

    subparsers = parser.add_subparsers(dest="command")
    archive = subparsers.add_parser(
        "archive",
        description="Archive asset-compounding hook usage events.",
        help="Archive asset-compounding hook usage events.",
    )
    archive.add_argument("--before")
    archive.add_argument("--since")
    archive.add_argument("--until")
    archive.add_argument("--repo")
    archive.add_argument("--dry-run", action="store_true")
    archive.add_argument("--include-current", action="store_true")
    archive.add_argument("--json", action="store_true")
    return parser


def normalize_argv(argv: list[str], default_plugin_data: str) -> list[str]:
    if not argv:
        return [default_plugin_data]
    if argv[0] == "archive" or argv[0].startswith("-"):
        return [default_plugin_data, *argv]
    return argv


def main() -> int:
    parser = build_parser()
    default_plugin_data = os.environ.get("PLUGIN_DATA") or ".asset-plugin-data"
    args = parser.parse_args(normalize_argv(sys.argv[1:], default_plugin_data))

    if getattr(args, "command", None) == "archive":
        return run_archive(args)

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
