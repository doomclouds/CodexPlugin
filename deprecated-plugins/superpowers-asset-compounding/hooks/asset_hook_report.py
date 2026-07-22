#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from collections import Counter
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any, BinaryIO, Iterator


def iter_event_records(root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []
    invalid_records: list[dict[str, Any]] = []
    for path in sorted(root.rglob("events.jsonl")):
        if any(part.startswith(".staging-") for part in path.parts):
            continue
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


def session_lifecycle_lock_path(root: Path, session_name: str) -> Path:
    return root / "_lifecycle-locks" / session_name


@contextmanager
def session_lifecycle_lock(root: Path, session_dir: Path) -> Iterator[None]:
    with file_lock(session_lifecycle_lock_path(root, session_dir.name), timeout_ms=lifecycle_lock_timeout_ms()):
        yield


def lock_timeout_ms(env_name: str, default: int) -> int:
    try:
        value = int(os.environ.get(env_name, str(default)))
    except ValueError:
        value = default
    return max(100, min(value, 60000))


def lifecycle_lock_timeout_ms() -> int:
    return lock_timeout_ms("ASSET_HOOK_LIFECYCLE_LOCK_TIMEOUT_MS", 30000)


@contextmanager
def file_lock(path: Path, *, timeout_ms: int | None = None) -> Iterator[None]:
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as stream:
        acquire_lock(stream, timeout_ms=timeout_ms)
        try:
            yield
        finally:
            release_lock(stream)


def acquire_lock(stream: BinaryIO, *, timeout_ms: int | None = None) -> None:
    resolved_timeout_ms = timeout_ms if timeout_ms is not None else lock_timeout_ms("ASSET_HOOK_EVENT_LOCK_TIMEOUT_MS", 1000)
    deadline = time.monotonic() + max(1, resolved_timeout_ms) / 1000
    while True:
        try:
            lock_stream(stream)
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.01)


def lock_stream(stream: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        stream.seek(0)
        if not stream.read(1):
            stream.seek(0)
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        return

    import fcntl

    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def release_lock(stream: BinaryIO) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    except OSError:
        return


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


def report_label(event: dict[str, Any], key: str) -> str:
    value = event.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return "unknown"


def session_lifecycle_counts(root: Path) -> dict[str, int]:
    counts = {
        "active_sessions": 0,
        "closed_sessions": 0,
        "legacy_state_sessions": 0,
    }
    for state_path in sorted(root.rglob("state.json")):
        if "_archives" in state_path.parts:
            continue
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            counts["legacy_state_sessions"] += 1
            continue
        if not isinstance(state, dict) or state.get("schemaVersion") != 2:
            counts["legacy_state_sessions"] += 1
            continue
        lifecycle = state.get("lifecycle")
        if lifecycle == "active":
            counts["active_sessions"] += 1
        elif lifecycle == "closed":
            counts["closed_sessions"] += 1
        else:
            counts["legacy_state_sessions"] += 1
    return counts


def summarize(
    events: list[dict[str, Any]],
    invalid_records: list[dict[str, Any]] | None = None,
    filters: dict[str, str | None] | None = None,
    session_context_events: list[dict[str, Any]] | None = None,
    lifecycle_counts: dict[str, int] | None = None,
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
    lifecycle_counts = lifecycle_counts or {
        "active_sessions": 0,
        "closed_sessions": 0,
        "legacy_state_sessions": 0,
    }
    plugin_versions = Counter(report_label(event, "pluginVersion") for event in strict_events)
    plugin_fingerprints = Counter(report_label(event, "pluginFingerprint") for event in strict_events)
    launcher_kinds = Counter(report_label(event, "launcherKind") for event in strict_events)
    verification_statuses = Counter(
        report_label(event, "verificationStatus")
        for event in strict_events
        if "verificationStatus" in event
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
        "plugin_versions": dict(sorted(plugin_versions.items())),
        "plugin_fingerprints": dict(sorted(plugin_fingerprints.items())),
        "launcher_kinds": dict(sorted(launcher_kinds.items())),
        "verification_statuses": dict(sorted(verification_statuses.items())),
        "active_sessions": int(lifecycle_counts.get("active_sessions", 0)),
        "closed_sessions": int(lifecycle_counts.get("closed_sessions", 0)),
        "legacy_state_sessions": int(lifecycle_counts.get("legacy_state_sessions", 0)),
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
        is_current = session_is_current(session_dir)
        if not include_current and is_current:
            continue
        if not session_matches_archive_filters(info, filters):
            continue
        matched_events = [event for event in info["events"] if event_matches_filters(event, filters)]
        info["matchedEventCount"] = len(matched_events)
        info["eventCount"] = len(info["events"])
        info["isCurrent"] = is_current
        info["sourceDir"] = session_dir
        sessions.append(info)
    return sessions


def session_is_current(session_dir: Path) -> bool:
    state_path = session_dir / "state.json"
    if not state_path.is_file():
        return False
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return True
    if not isinstance(state, dict):
        return True
    return not (state.get("schemaVersion") == 2 and state.get("lifecycle") == "closed")


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


def archive_file_row(root: Path, session_dir: Path, filters: dict[str, str | None], include_current: bool) -> dict[str, Any] | None:
    event_file = session_dir / "events.jsonl"
    if not event_file.is_file():
        return None
    if not include_current and session_is_current(session_dir):
        return None
    info = session_bounds(event_file)
    if not session_matches_archive_filters(info, filters):
        return None
    return {
        "session": str(info["session"]),
        "repoName": info["repoName"],
        "originalPath": str(session_dir.relative_to(root).as_posix()),
        "eventCount": len(info["events"]),
        "firstTimestampUtc": info["firstTimestampUtc"],
        "lastTimestampUtc": info["lastTimestampUtc"],
        "sha256": sha256_file(event_file),
    }


def archive_snapshot_row(root: Path, source_dir: Path, snapshot_dir: Path) -> dict[str, Any]:
    info = session_bounds(snapshot_dir / "events.jsonl")
    return {
        "session": str(info["session"]),
        "repoName": info["repoName"],
        "originalPath": str(source_dir.relative_to(root).as_posix()),
        "eventCount": len(info["events"]),
        "firstTimestampUtc": info["firstTimestampUtc"],
        "lastTimestampUtc": info["lastTimestampUtc"],
        "sha256": sha256_file(snapshot_dir / "events.jsonl"),
    }


def archive_dates(file_rows: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    dates = [
        timestamp_to_date(row.get(field))
        for row in file_rows
        for field in ("firstTimestampUtc", "lastTimestampUtc")
    ]
    known_dates = [date for date in dates if date is not None]
    return (min(known_dates), max(known_dates)) if known_dates else (None, None)


def archive_result(
    *,
    status: str,
    archive_path: Path | None,
    file_rows: list[dict[str, Any]],
    filters: dict[str, str | None],
    retained_source_sessions: list[str] | None = None,
) -> dict[str, Any]:
    from_date, until_date = archive_dates(file_rows)
    return {
        "status": status,
        "archivePath": str(archive_path) if archive_path is not None else None,
        "archiveHash": archive_hash(file_rows),
        "fromDate": from_date,
        "untilDate": until_date,
        "sessionCount": len(file_rows),
        "eventCount": sum(int(row["eventCount"]) for row in file_rows),
        "filters": filters,
        "files": file_rows,
        "retainedSourceSessions": sorted(retained_source_sessions or []),
    }


def run_archive(args: argparse.Namespace) -> int:
    root = Path(args.plugin_data).resolve()
    filters = archive_filters(args)
    sessions = select_archive_sessions(root, filters, args.include_current)
    initial_rows = [
        archive_file_row(root, Path(session["sourceDir"]), filters, args.include_current)
        for session in sessions
    ]
    file_rows = [row for row in initial_rows if row is not None]
    if args.dry_run:
        result = archive_result(status="dry_run", archive_path=None, file_rows=file_rows, filters=filters)
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print_archive_text(result)
        return 0

    archive_parent = root / "_archives"
    archive_parent.mkdir(parents=True, exist_ok=True)
    staging_root = archive_parent / f".staging-{os.getpid()}-{time.time_ns()}"
    staging_root.mkdir(parents=True, exist_ok=False)
    snapshots: list[dict[str, Any]] = []
    for row in sorted(file_rows, key=lambda item: str(item["session"])):
        source_dir = root / Path(str(row["originalPath"]))
        if not source_dir.is_dir():
            continue
        destination_dir = staging_root / str(row["session"])
        shutil.copytree(source_dir, destination_dir)
        snapshots.append(archive_snapshot_row(root, source_dir, destination_dir))

    retained_source_sessions: list[str] = []
    with ExitStack() as locks:
        for row in sorted(snapshots, key=lambda item: str(item["session"])):
            source_dir = root / Path(str(row["originalPath"]))
            locks.enter_context(session_lifecycle_lock(root, source_dir))

        final_rows: list[dict[str, Any]] = []
        for row in snapshots:
            source_dir = root / Path(str(row["originalPath"]))
            refreshed_row = archive_file_row(root, source_dir, filters, args.include_current)
            if refreshed_row is None or refreshed_row["sha256"] != row["sha256"]:
                retained_source_sessions.append(str(row["session"]))
                shutil.rmtree(staging_root / str(row["session"]))
                continue
            final_rows.append(row)

        if not final_rows:
            shutil.rmtree(staging_root)
            result = archive_result(
                status="archived",
                archive_path=None,
                file_rows=[],
                filters=filters,
                retained_source_sessions=retained_source_sessions,
            )
        else:
            from_date, until_date = archive_dates(final_rows)
            hash_value = archive_hash(final_rows)
            base_archive_root = (
                archive_parent / f"{from_date or 'unknown'}_to_{until_date or 'unknown'}" / hash_value
            )
            archive_root = resolve_archive_root(base_archive_root)
            manifest_rows = []
            for row in final_rows:
                manifest_row = dict(row)
                manifest_row["archivedPath"] = str((archive_root / str(row["session"])).relative_to(root).as_posix())
                manifest_rows.append(manifest_row)
            manifest = {
                "archiveHash": hash_value,
                "fromDate": from_date,
                "untilDate": until_date,
                "sessionCount": len(manifest_rows),
                "eventCount": sum(int(row["eventCount"]) for row in manifest_rows),
                "filters": filters,
                "files": manifest_rows,
            }
            (staging_root / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            saved_manifest = json.loads((staging_root / "manifest.json").read_text(encoding="utf-8"))
            if saved_manifest.get("archiveHash") != hash_value:
                raise RuntimeError("manifest verification failed")
            archive_root.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging_root, archive_root)
            for row in final_rows:
                source_dir = root / Path(str(row["originalPath"]))
                try:
                    shutil.rmtree(source_dir)
                except OSError:
                    retained_source_sessions.append(str(row["session"]))
            result = archive_result(
                status="archived",
                archive_path=archive_root,
                file_rows=manifest_rows,
                filters=filters,
                retained_source_sessions=retained_source_sessions,
            )
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
    print(f"plugin_versions: {summary['plugin_versions']}")
    print(f"plugin_fingerprints: {summary['plugin_fingerprints']}")
    print(f"launcher_kinds: {summary['launcher_kinds']}")
    print(f"verification_statuses: {summary['verification_statuses']}")
    print(f"active_sessions: {summary['active_sessions']}")
    print(f"closed_sessions: {summary['closed_sessions']}")
    print(f"legacy_state_sessions: {summary['legacy_state_sessions']}")
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
    plugin_data_root = Path(args.plugin_data).resolve()
    events, invalid_records = iter_event_records(plugin_data_root)
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
    summary = summarize(
        filtered_events,
        invalid_records,
        filters,
        session_context_events,
        session_lifecycle_counts(plugin_data_root),
    )
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print_text(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
