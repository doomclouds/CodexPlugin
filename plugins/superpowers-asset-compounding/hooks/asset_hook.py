#!/usr/bin/env python3
from __future__ import annotations

import json
import hashlib
import os
import queue
import re
import subprocess
import sys
import importlib
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Iterator


ASSET_PATH_MARKERS = ("docs/superpowers", "docs/milestones", "docs/technical-debt")


def main() -> int:
    started_at = time.perf_counter()
    raw_input = read_stdin_with_timeout(started_at)
    if raw_input is None:
        return 1
    try:
        event = json.loads(raw_input)
    except (UnicodeDecodeError, json.JSONDecodeError):
        append_raw_usage_event(
            "HookInput",
            decision="error",
            reason_code="invalid_json",
            durationMs=elapsed_ms(started_at),
        )
        print(
            "资产复利未完成：Hook 输入格式无效；主要任务可能已完成，但本轮知识尚未沉淀。"
            "下一步：重试当前操作。",
            file=sys.stderr,
        )
        return 1

    if not isinstance(event, dict):
        append_raw_usage_event(
            "HookInput",
            decision="error",
            reason_code="invalid_event_shape",
            durationMs=elapsed_ms(started_at),
        )
        print(
            "资产复利未完成：Hook 输入类型无效；主要任务可能已完成，但本轮知识尚未沉淀。"
            "下一步：重试当前操作。",
            file=sys.stderr,
        )
        return 1

    event["_assetHookStartedAt"] = started_at
    try:
        hook_event_name = str(event.get("hook_event_name", ""))
        handlers = {
            "SessionStart": handle_session_start,
            "PostToolUse": handle_post_tool_use,
            "Stop": handle_stop,
            "PreCompact": handle_pre_compact,
            "PostCompact": handle_post_compact,
        }
        handler = handlers.get(hook_event_name)
        if handler is None:
            return 0
        output = handler(event)
        if output is not None:
            print(json.dumps(output, ensure_ascii=False))
        return 0
    except Exception:  # pragma: no cover - exercised through the process boundary
        append_raw_usage_event(
            "HookRuntime",
            decision="error",
            reason_code="dispatch_error",
            durationMs=elapsed_ms(started_at),
        )
        print(
            "资产复利未完成：Hook 运行失败；主要任务可能已完成，但本轮知识尚未沉淀。"
            "下一步：重试当前操作。",
            file=sys.stderr,
        )
        return 1


def read_stdin_with_timeout(started_at: float) -> str | None:
    timeout_ms = stdin_timeout_ms()
    result_queue: queue.Queue[bytes | BaseException] = queue.Queue(maxsize=1)

    def read_stdin() -> None:
        try:
            result_queue.put(sys.stdin.buffer.read())
        except BaseException as exc:  # pragma: no cover - defensive hook boundary
            result_queue.put(exc)

    reader = threading.Thread(target=read_stdin, name="asset-hook-stdin-reader", daemon=True)
    reader.start()
    try:
        result = result_queue.get(timeout=timeout_ms / 1000)
    except queue.Empty:
        append_raw_usage_event(
            "HookInput",
            decision="error",
            reason_code="stdin_timeout",
            durationMs=elapsed_ms(started_at),
            timeoutMs=timeout_ms,
        )
        print(
            "资产复利未完成：Hook 输入超时；主要任务可能已完成，但本轮知识尚未沉淀。"
            "下一步：重试当前操作。",
            file=sys.stderr,
        )
        sys.stderr.flush()
        os._exit(1)
    if isinstance(result, BaseException):
        append_raw_usage_event(
            "HookInput",
            decision="error",
            reason_code="stdin_read_error",
            durationMs=elapsed_ms(started_at),
            error=type(result).__name__,
        )
        print(
            "资产复利未完成：Hook 输入读取失败；主要任务可能已完成，但本轮知识尚未沉淀。"
            "下一步：重试当前操作。",
            file=sys.stderr,
        )
        return None
    try:
        return result.decode("utf-8-sig")
    except UnicodeDecodeError:
        append_raw_usage_event(
            "HookInput",
            decision="error",
            reason_code="stdin_decode_error",
            durationMs=elapsed_ms(started_at),
        )
        print(
            "资产复利未完成：Hook 输入格式无效；主要任务可能已完成，但本轮知识尚未沉淀。"
            "下一步：重试当前操作。",
            file=sys.stderr,
        )
        return None


def stdin_timeout_ms() -> int:
    raw_value = os.environ.get("ASSET_HOOK_STDIN_TIMEOUT_MS", "8000")
    try:
        value = int(raw_value)
    except ValueError:
        value = 8000
    return max(100, min(value, 60000))


def handle_session_start(event: dict[str, Any]) -> dict[str, Any] | None:
    if not repo_has_assets(event):
        return None
    with state_transaction(event) as state:
        reopen_session_state(state)
    append_usage_event(event, "SessionStart", decision="context", reason_code="asset_repo_detected")
    return additional_context(
        "SessionStart",
        (
            "This repository uses hook-assisted asset compounding. Keep asset "
            "workflow concise: subagents report candidates, the main agent owns "
            "route decisions and writes, and meaningful closeout needs an "
            "auditable asset_gate block. Put the auditable asset_gate in an HTML "
            "comment before final handoff; keep route none silent, report "
            "successful asset writes once with the written path, and expose "
            "unrecovered failures. "
            f"{workspace_context(event)}"
        ),
    )


def handle_post_tool_use(event: dict[str, Any]) -> dict[str, Any] | None:
    if not repo_has_assets(event):
        return None
    tool_name = str(event.get("tool_name", ""))
    tool_input = event.get("tool_input")
    command = extract_command(tool_input).lower()
    verification_command = is_verification_command(command)
    exit_code, exit_code_source = extract_exit_code(event.get("tool_response")) if verification_command else (None, None)
    verification_result = verification_status(exit_code) if verification_command else None
    asset_files_changed_this_tool = asset_files_changed(tool_name, tool_input, command)
    command_kind = "plan-update" if is_plan_update_tool(tool_name) else classify_command_kind(command, tool_name)
    asset_bootstrap_this_tool: dict[str, Any] | None = None
    if asset_files_changed_this_tool:
        bootstrap_result = bootstrap_asset_guidance(event)
        if bootstrap_result is not None:
            asset_bootstrap_this_tool = bootstrap_result

    with state_transaction(event) as state:
        reopen_session_state(state)
        signals = set(state.get("meaningfulWorkSignals", []))
        signals_before = set(signals)
        plan_update_gate_due_before = bool(state.get("assetGateDue"))
        plan_update_reminder_due = False

        if tool_name == "apply_patch":
            signals.add("edited-files")
        if is_plan_update_tool(tool_name):
            signals.add("plan-boundary")
            if plan_update_gate_due_before:
                plan_update_reminder_due = True
            if plan_has_completed_step(tool_input):
                state["assetGateDue"] = True
        if verification_command:
            signals.add(verification_signal(str(verification_result)))
            evidence = {
                "commandKind": command_kind,
                "commandHash": stable_hash(command),
                "commandLength": len(command),
                "status": verification_result,
            }
            if exit_code is not None:
                evidence["exitCode"] = exit_code
            if exit_code_source is not None:
                evidence["exitCodeSource"] = exit_code_source
            state.setdefault("verificationEvidence", []).append(evidence)
        if is_git_closeout_command(command):
            signals.add("git-closeout")
            state["lastGitCloseoutKind"] = classify_command_kind(command)
        if asset_files_changed_this_tool:
            state["assetFilesChanged"] = True
            if asset_bootstrap_this_tool is not None:
                state["assetBootstrap"] = asset_bootstrap_this_tool

        state["meaningfulWorkSignals"] = sorted(signals)
        state_signals = list(state["meaningfulWorkSignals"])
        state_asset_files_changed = bool(state.get("assetFilesChanged"))
        state_asset_bootstrap = state.get("assetBootstrap")
        state_asset_gate_due = bool(state.get("assetGateDue"))

    append_usage_event(
        event,
        "PostToolUse",
        decision="recorded",
        reason_code="tool_observed",
        toolName=tool_name,
        commandKind=command_kind,
        commandPresent=bool(command),
        commandHash=stable_hash(command) if command else None,
        commandLength=len(command) if command else None,
        exitCode=exit_code,
        exitCodeSource=exit_code_source,
        verificationStatus=verification_result,
        signalsAdded=sorted(signals - signals_before),
        signals=state_signals,
        assetFilesChangedThisTool=asset_files_changed_this_tool,
        assetFilesChanged=state_asset_files_changed,
        assetBootstrap=state_asset_bootstrap.get("action")
        if isinstance(state_asset_bootstrap, dict)
        else None,
        assetBootstrapThisTool=asset_bootstrap_this_tool.get("action")
        if isinstance(asset_bootstrap_this_tool, dict)
        else None,
        assetGateDue=state_asset_gate_due,
        assetGateReminder=plan_update_reminder_due if is_plan_update_tool(tool_name) else None,
    )
    if plan_update_reminder_due:
        return {
            "systemMessage": (
                "Asset-compounding checkpoint is due from a completed plan step. "
                "Before starting the next planned task, run the main-agent asset "
                "gate: decide route none, inbox, update-existing, archive, "
                "new-problem, or both; use the asset-compounding scripts when "
                "you need deterministic evidence. Put the auditable asset_gate "
                "in an HTML comment before final handoff; keep route none silent, "
                "report successful asset writes once with the written path, and "
                "expose unrecovered failures."
            )
        }
    return None


def handle_stop(event: dict[str, Any]) -> dict[str, Any] | None:
    if not repo_has_assets(event):
        return None
    message = str(event.get("last_assistant_message") or "")
    with state_transaction(event) as state:
        if not has_stop_closeout_work(state):
            append_usage_event(
                event,
                "Stop",
                decision="allow",
                reason_code="no_meaningful_work",
                hasAssetGate="asset_gate:" in message,
                hasMeaningfulWork=False,
            )
            close_session_state(state)
            return None
        if "asset_gate:" in message:
            handoff_checks = import_handoff_checks_module()
            validation = handoff_checks.validate_asset_gate_text(message, allow_defaults=True)
            if not validation.get("valid"):
                sanitized_validation = sanitize_validation_for_audit(validation)
                if event.get("stop_hook_active") or state.get("stopContinuationUsed"):
                    append_usage_event(
                        event,
                        "Stop",
                        decision="warn",
                        reason_code="continuation_already_used",
                        hasAssetGate=True,
                        hasMeaningfulWork=has_stop_closeout_work(state),
                        signals=state.get("meaningfulWorkSignals", []),
                        candidateCount=len(state.get("subagentCandidates", [])),
                        validation=sanitized_validation,
                    )
                    return {
                        "systemMessage": (
                            "Asset compounding still lacks a valid hidden asset gate after one Stop retry."
                        )
                    }
                state["stopContinuationUsed"] = True
                append_usage_event(
                    event,
                    "Stop",
                    decision="block",
                    reason_code="invalid_asset_gate",
                    hasAssetGate=True,
                    hasMeaningfulWork=has_stop_closeout_work(state),
                    signals=state.get("meaningfulWorkSignals", []),
                    candidateCount=len(state.get("subagentCandidates", [])),
                    validation=sanitized_validation,
                )
                return {
                    "decision": "block",
                    "reason": (
                        "资产复利未完成：隐藏门限无效（"
                        f"{validation_reason(validation)}"
                        "）；主要任务结果不受影响，但本轮知识尚未完成沉淀。"
                        "下一步：重新生成有效的隐藏门限后重试。"
                    ),
                }
            defaulted_fields = list(validation.get("defaultedFields") or [])
            append_usage_event(
                event,
                "Stop",
                decision="allow",
                reason_code="asset_gate_present",
                hasAssetGate=True,
                hasMeaningfulWork=has_stop_closeout_work(state),
                signals=state.get("meaningfulWorkSignals", []),
                candidateCount=len(state.get("subagentCandidates", [])),
                defaultedFields=defaulted_fields or None,
            )
            close_session_state(state)
            return None
        if is_push_only_closeout(state):
            append_usage_event(
                event,
                "Stop",
                decision="allow",
                reason_code="push_only_closeout",
                hasAssetGate=False,
                hasMeaningfulWork=True,
                signals=state.get("meaningfulWorkSignals", []),
            )
            close_session_state(state)
            return None
        if is_merge_only_closeout(state):
            append_usage_event(
                event,
                "Stop",
                decision="allow",
                reason_code="merge_only_closeout",
                hasAssetGate=False,
                hasMeaningfulWork=True,
                signals=state.get("meaningfulWorkSignals", []),
            )
            close_session_state(state)
            return None
        if event.get("stop_hook_active") or state.get("stopContinuationUsed"):
            append_usage_event(
                event,
                "Stop",
                decision="warn",
                reason_code="continuation_already_used",
                hasAssetGate=False,
                hasMeaningfulWork=True,
                signals=state.get("meaningfulWorkSignals", []),
                candidateCount=len(state.get("subagentCandidates", [])),
            )
            return {
                "systemMessage": (
                    "Asset compounding still lacks a valid hidden asset gate after one Stop retry."
                )
            }

        state["stopContinuationUsed"] = True
        append_usage_event(
            event,
            "Stop",
            decision="block",
            reason_code="missing_asset_gate",
            hasAssetGate=False,
            hasMeaningfulWork=True,
            signals=state.get("meaningfulWorkSignals", []),
            candidateCount=len(state.get("subagentCandidates", [])),
        )
        return {
            "decision": "block",
            "reason": (
                "资产复利未完成：缺少隐藏门限；主要任务结果不受影响，"
                "但本轮知识尚未完成沉淀。下一步：生成有效的隐藏门限后重试。"
            ),
        }


def handle_pre_compact(event: dict[str, Any]) -> dict[str, Any] | None:
    if not repo_has_assets(event):
        return None
    with state_transaction(event) as state:
        state["lastCompactTrigger"] = str(event.get("trigger", ""))
        candidate_count = len(state.get("subagentCandidates", []))
    if candidate_count:
        append_usage_event(
            event,
            "PreCompact",
            decision="warn",
            reason_code="pending_candidates",
            candidateCount=candidate_count,
        )
        return {
            "systemMessage": (
                "Asset-compounding state saved before compaction with pending "
                f"candidates: {candidate_count}."
            )
        }
    append_usage_event(event, "PreCompact", decision="allow", reason_code="no_pending_candidates")
    return None


def handle_post_compact(event: dict[str, Any]) -> dict[str, Any] | None:
    if not repo_has_assets(event):
        return None
    state = load_state(event)
    candidate_count = len(state.get("subagentCandidates", []))
    if candidate_count == 0 and not has_meaningful_work(state):
        append_usage_event(event, "PostCompact", decision="allow", reason_code="no_pending_state")
        return None
    append_usage_event(
        event,
        "PostCompact",
        decision="recorded",
        reason_code="pending_state_restored",
        candidateCount=candidate_count,
        signals=state.get("meaningfulWorkSignals", []),
    )
    return None


def additional_context(event_name: str, context: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": context,
        }
    }


def workspace_context(event: dict[str, Any]) -> str:
    cwd = Path(str(event.get("cwd") or "."))
    parts = [f"Workspace: `{cwd.name}`."]
    if any(part.lower() == ".worktrees" for part in cwd.parts):
        parts.append("This workspace appears to be a git worktree; verify repository scope before cleanup or closeout.")
    branch = current_git_branch(cwd)
    if branch:
        parts.append(f"Git branch: `{branch}`.")
    return " ".join(parts)


def current_git_branch(cwd: Path) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--abbrev-ref", "HEAD"],
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=0.35,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if completed.returncode != 0:
        return ""
    branch = completed.stdout.strip()
    if not branch or branch == "HEAD":
        return ""
    return branch[:120]


def repo_has_assets(event: dict[str, Any]) -> bool:
    cwd = Path(str(event.get("cwd") or "."))
    return any((cwd / marker).is_dir() for marker in ASSET_PATH_MARKERS)


def bootstrap_asset_guidance(event: dict[str, Any]) -> dict[str, Any] | None:
    root = Path(str(event.get("cwd") or "."))
    if not any((root / marker).is_dir() for marker in ASSET_PATH_MARKERS):
        return None

    try:
        module = import_bootstrap_module()
        result = module.bootstrap(root, None, True)
    except Exception:  # pragma: no cover - defensive hook boundary
        return {
            "action": "failed",
            "errorCode": "bootstrap_failed",
        }

    return {
        "action": "written" if result.get("changed") else "unchanged",
        "createdDirs": result.get("created_dirs", []),
        "guidanceAction": result.get("guidance", {}).get("action"),
    }


def import_bootstrap_module() -> Any:
    plugin_root = Path(os.environ.get("PLUGIN_ROOT") or Path(__file__).resolve().parents[1])
    scripts_root = plugin_root / "skills" / "compound-development-asset" / "scripts"
    if str(scripts_root) not in sys.path:
        sys.path.insert(0, str(scripts_root))
    return importlib.import_module("bootstrap_asset_compounding")


def import_handoff_checks_module() -> Any:
    plugin_root = Path(os.environ.get("PLUGIN_ROOT") or Path(__file__).resolve().parents[1])
    scripts_root = plugin_root / "skills" / "compound-development-asset" / "scripts"
    if str(scripts_root) not in sys.path:
        sys.path.insert(0, str(scripts_root))
    return importlib.import_module("checks.handoff_checks")


def state_path(event: dict[str, Any]) -> Path:
    plugin_data = Path(os.environ.get("PLUGIN_DATA") or ".asset-plugin-data")
    return plugin_data / audit_session_segment(event) / "state.json"


_SESSION_LIFECYCLE_LOCKS = threading.local()


def session_lifecycle_lock_path(event: dict[str, Any]) -> Path:
    plugin_data = Path(os.environ.get("PLUGIN_DATA") or ".asset-plugin-data")
    return plugin_data / "_lifecycle-locks" / audit_session_segment(event)


@contextmanager
def session_lifecycle_lock(event: dict[str, Any]) -> Iterator[None]:
    path = session_lifecycle_lock_path(event)
    key = str(path)
    depths = getattr(_SESSION_LIFECYCLE_LOCKS, "depths", None)
    if depths is None:
        depths = {}
        _SESSION_LIFECYCLE_LOCKS.depths = depths
    if key in depths:
        depths[key] += 1
        try:
            yield
        finally:
            depths[key] -= 1
            if depths[key] == 0:
                del depths[key]
        return
    with file_lock(path, timeout_ms=lifecycle_lock_timeout_ms()):
        depths[key] = 1
        try:
            yield
        finally:
            depths[key] -= 1
            if depths[key] == 0:
                del depths[key]


def events_path(event: dict[str, Any]) -> Path:
    return state_path(event).with_name("events.jsonl")


def audit_session_segment(event: dict[str, Any]) -> str:
    project_name = Path(str(event.get("cwd") or "unknown-project")).name or "unknown-project"
    session_id = str(event.get("session_id") or "unknown-session")
    return f"{safe_segment(project_name)}--{safe_segment(session_id)}"


def plugin_runtime_identity() -> dict[str, str]:
    plugin_root = Path(os.environ.get("PLUGIN_ROOT") or Path(__file__).resolve().parents[1])
    version = "unknown"
    manifest_path = plugin_root / ".codex-plugin" / "plugin.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = None
    if isinstance(manifest, dict) and isinstance(manifest.get("version"), str) and manifest["version"].strip():
        version = manifest["version"].strip()

    fingerprint_paths = (
        ".codex-plugin/plugin.json",
        "hooks/hooks.json",
        "hooks/asset_hook.py",
    )
    digest = hashlib.sha256()
    try:
        for relative_path in fingerprint_paths:
            content = (plugin_root / relative_path).read_bytes()
            normalized = content.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            digest.update(relative_path.encode("utf-8"))
            digest.update(b"\0")
            digest.update(normalized)
            digest.update(b"\0")
    except OSError:
        fingerprint = "unknown"
    else:
        fingerprint = digest.hexdigest()[:16]
    return {
        "pluginVersion": version,
        "pluginFingerprint": fingerprint,
    }


def event_runtime_identity(event: dict[str, Any]) -> dict[str, str]:
    cached = event.get("_assetPluginRuntimeIdentity")
    if isinstance(cached, dict) and all(isinstance(cached.get(key), str) for key in ("pluginVersion", "pluginFingerprint")):
        return {
            "pluginVersion": str(cached["pluginVersion"]),
            "pluginFingerprint": str(cached["pluginFingerprint"]),
        }
    identity = plugin_runtime_identity()
    event["_assetPluginRuntimeIdentity"] = identity
    return identity


def append_usage_event(
    event: dict[str, Any],
    hook_event_name: str,
    *,
    decision: str,
    reason_code: str,
    **extra: Any,
) -> None:
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "timestampUtc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "hookEventName": hook_event_name,
        "decision": decision,
        "reasonCode": reason_code,
        "durationMs": elapsed_ms(event.get("_assetHookStartedAt")),
        "processId": os.getpid(),
        "sessionHash": stable_hash(str(event.get("session_id") or "")),
        "turnHash": stable_hash(str(event.get("turn_id") or "")),
        "repoName": Path(str(event.get("cwd") or "")).name,
        "repoHash": stable_hash(str(event.get("cwd") or "").lower()),
        "launcherKind": os.environ.get("ASSET_HOOK_LAUNCHER") or "unknown",
        **event_runtime_identity(event),
    }
    for key, value in extra.items():
        if value is not None:
            payload[key] = value
    path = events_path(event)
    try:
        with session_lifecycle_lock(event):
            append_jsonl_event(path, payload)
    except OSError:
        return


def append_raw_usage_event(
    hook_event_name: str,
    *,
    decision: str,
    reason_code: str,
    **extra: Any,
) -> None:
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "timestampUtc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "hookEventName": hook_event_name,
        "decision": decision,
        "reasonCode": reason_code,
        "processId": os.getpid(),
        "launcherKind": os.environ.get("ASSET_HOOK_LAUNCHER") or "unknown",
        **plugin_runtime_identity(),
    }
    for key, value in extra.items():
        if value is not None:
            payload[key] = value
    plugin_data = Path(os.environ.get("PLUGIN_DATA") or ".asset-plugin-data")
    path = plugin_data / "_hook" / "events.jsonl"
    try:
        append_jsonl_event(path, payload)
    except OSError:
        return


def append_jsonl_event(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n"
    with file_lock(path):
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(line)
            stream.flush()


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
    with lock_path.open("a+b") as lock_stream:
        acquire_lock(lock_stream, timeout_ms=timeout_ms)
        try:
            yield
        finally:
            release_lock(lock_stream)


@contextmanager
def event_file_lock(path: Path) -> Iterator[None]:
    with file_lock(path):
        yield


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


def elapsed_ms(started_at: Any) -> int | None:
    if not isinstance(started_at, (float, int)):
        return None
    return max(0, int((time.perf_counter() - float(started_at)) * 1000))


def stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:16]


def repo_identity(event: dict[str, Any]) -> dict[str, str]:
    cwd = str(event.get("cwd") or "")
    return {
        "repoName": Path(cwd).name,
        "repoHash": stable_hash(cwd.lower()),
    }


SAFE_BOOTSTRAP_CREATED_DIRS = frozenset(
    {
        "docs/superpowers",
        "docs/superpowers/specs",
        "docs/superpowers/plans",
        "docs/superpowers/archives",
        "docs/superpowers/problems",
        "docs/superpowers/inbox",
        "docs/milestones",
        "docs/technical-debt",
    }
)
SAFE_BOOTSTRAP_GUIDANCE_ACTIONS = frozenset({"inserted", "updated", "unchanged"})
SAFE_VERIFICATION_STATUSES = frozenset({"passed", "failed", "observed"})
SAFE_EXIT_CODE_SOURCES = frozenset({"top-level", "nested", "text", "unknown"})
SAFE_COMMAND_KIND_RE = re.compile(r"^[a-z0-9-]{1,80}$")
SAFE_COMMAND_HASH_RE = re.compile(r"^[0-9a-f]{16}$")


def sanitize_verification_evidence(entries: Any) -> list[dict[str, Any]]:
    if not isinstance(entries, list):
        return []
    sanitized_entries: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        raw_command = entry.get("command")
        if isinstance(raw_command, str):
            command_kind = classify_command_kind(raw_command)
            command_hash = stable_hash(raw_command)
            command_length = len(raw_command)
        else:
            candidate_kind = entry.get("commandKind")
            command_kind = (
                candidate_kind
                if isinstance(candidate_kind, str) and SAFE_COMMAND_KIND_RE.fullmatch(candidate_kind)
                else "unknown"
            )
            candidate_hash = entry.get("commandHash")
            command_hash = (
                candidate_hash
                if isinstance(candidate_hash, str) and SAFE_COMMAND_HASH_RE.fullmatch(candidate_hash)
                else None
            )
            candidate_length = entry.get("commandLength")
            command_length = candidate_length if isinstance(candidate_length, int) and candidate_length >= 0 else None

        status = entry.get("status")
        sanitized: dict[str, Any] = {
            "commandKind": command_kind,
            "status": status
            if isinstance(status, str) and status in SAFE_VERIFICATION_STATUSES
            else "observed",
        }
        if command_hash is not None:
            sanitized["commandHash"] = command_hash
        if command_length is not None:
            sanitized["commandLength"] = command_length
        exit_code = entry.get("exitCode")
        if isinstance(exit_code, int) and not isinstance(exit_code, bool):
            sanitized["exitCode"] = exit_code
        exit_code_source = entry.get("exitCodeSource")
        if isinstance(exit_code_source, str) and exit_code_source in SAFE_EXIT_CODE_SOURCES:
            sanitized["exitCodeSource"] = exit_code_source
        sanitized_entries.append(sanitized)
    return sanitized_entries


def sanitize_asset_bootstrap(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    action = value.get("action")
    sanitized: dict[str, Any] = {
        "action": action
        if isinstance(action, str) and action in {"written", "unchanged", "failed"}
        else "unknown"
    }
    created_dirs = value.get("createdDirs")
    if isinstance(created_dirs, list):
        safe_dirs = [
            directory.replace("\\", "/")
            for directory in created_dirs
            if isinstance(directory, str) and directory.replace("\\", "/") in SAFE_BOOTSTRAP_CREATED_DIRS
        ]
        if safe_dirs:
            sanitized["createdDirs"] = safe_dirs
    guidance_action = value.get("guidanceAction")
    if isinstance(guidance_action, str) and guidance_action in SAFE_BOOTSTRAP_GUIDANCE_ACTIONS:
        sanitized["guidanceAction"] = guidance_action
    if value.get("errorCode") == "bootstrap_failed":
        sanitized["errorCode"] = "bootstrap_failed"
    return sanitized


def sanitize_state_for_storage(state: dict[str, Any]) -> None:
    state.pop("cwd", None)
    state["verificationEvidence"] = sanitize_verification_evidence(state.get("verificationEvidence"))
    asset_bootstrap = sanitize_asset_bootstrap(state.get("assetBootstrap"))
    if asset_bootstrap is None:
        state.pop("assetBootstrap", None)
    else:
        state["assetBootstrap"] = asset_bootstrap


def load_state(event: dict[str, Any]) -> dict[str, Any]:
    return load_state_path(state_path(event), event)


def load_state_path(path: Path, event: dict[str, Any]) -> dict[str, Any]:
    if path.is_file():
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(state, dict):
                return state
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
    return default_state(event)


def default_state(event: dict[str, Any]) -> dict[str, Any]:
    identity = event_runtime_identity(event)
    return {
        "schemaVersion": 2,
        "sessionId": str(event.get("session_id") or ""),
        "turnId": str(event.get("turn_id") or ""),
        **repo_identity(event),
        "repoHasSuperpowersAssets": repo_has_assets(event),
        "lifecycle": "active",
        "closedAtUtc": None,
        **identity,
        "meaningfulWorkSignals": [],
        "verificationEvidence": [],
        "subagentCandidates": [],
        "assetFilesChanged": False,
        "stopContinuationUsed": False,
        "assetGateDue": False,
        "lastGitCloseoutKind": "",
    }


@contextmanager
def state_transaction(event: dict[str, Any]) -> Iterator[dict[str, Any]]:
    path = state_path(event)
    with session_lifecycle_lock(event):
        with file_lock(path):
            state = load_state_path(path, event)
            yield state
            save_state_path_atomic(path, state, event)


def save_state(event: dict[str, Any], state: dict[str, Any]) -> None:
    path = state_path(event)
    with session_lifecycle_lock(event):
        with file_lock(path):
            save_state_path_atomic(path, state, event)


def save_state_path_atomic(path: Path, state: dict[str, Any], event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["schemaVersion"] = 2
    state["turnId"] = str(event.get("turn_id") or state.get("turnId") or "")
    state.update(repo_identity(event))
    state.setdefault("sessionId", str(event.get("session_id") or ""))
    state.setdefault("repoHasSuperpowersAssets", repo_has_assets(event))
    state.setdefault("lifecycle", "active")
    state.setdefault("closedAtUtc", None)
    state.update(event_runtime_identity(event))
    state.setdefault("meaningfulWorkSignals", [])
    state.setdefault("verificationEvidence", [])
    state.setdefault("subagentCandidates", [])
    state.setdefault("assetFilesChanged", False)
    state.setdefault("stopContinuationUsed", False)
    state.setdefault("assetGateDue", False)
    state.setdefault("lastGitCloseoutKind", "")
    sanitize_state_for_storage(state)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with temp_path.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(state, ensure_ascii=False, indent=2))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


def safe_segment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._") or "unknown"


def extract_command(tool_input: Any) -> str:
    if isinstance(tool_input, dict):
        for key in ("command", "cmd", "script"):
            command = tool_input.get(key)
            if isinstance(command, str):
                return command
    return ""


EXIT_CODE_KEYS = ("exit_code", "exitCode", "returncode", "returnCode")
EXIT_CODE_LINE_RE = re.compile(r"(?im)^\s*(?:exit|return)\s+code\s*:\s*(-?\d+)\s*$")
MAX_EXIT_CODE_RESPONSE_DEPTH = 6
MAX_EXIT_CODE_RESPONSE_NODES = 256
MAX_EXIT_CODE_TEXT_CHARS = 4096


def extract_exit_code(tool_response: Any) -> tuple[int | None, str]:
    return extract_exit_code_from_value(
        tool_response,
        depth=0,
        top_level=True,
        remaining_nodes=[MAX_EXIT_CODE_RESPONSE_NODES],
    )


def extract_exit_code_from_value(
    value: Any,
    *,
    depth: int,
    top_level: bool,
    remaining_nodes: list[int],
) -> tuple[int | None, str]:
    if depth > MAX_EXIT_CODE_RESPONSE_DEPTH or remaining_nodes[0] <= 0:
        return None, "unknown"
    remaining_nodes[0] -= 1
    if isinstance(value, dict):
        for key in EXIT_CODE_KEYS:
            candidate = value.get(key)
            if isinstance(candidate, int) and not isinstance(candidate, bool):
                return candidate, "top-level" if top_level else "nested"
        for candidate in value.values():
            if remaining_nodes[0] <= 0:
                break
            exit_code, source = extract_exit_code_from_value(
                candidate,
                depth=depth + 1,
                top_level=False,
                remaining_nodes=remaining_nodes,
            )
            if exit_code is not None:
                return exit_code, source
        return None, "unknown"
    if isinstance(value, (list, tuple)):
        for candidate in value:
            if remaining_nodes[0] <= 0:
                break
            exit_code, source = extract_exit_code_from_value(
                candidate,
                depth=depth + 1,
                top_level=False,
                remaining_nodes=remaining_nodes,
            )
            if exit_code is not None:
                return exit_code, source
        return None, "unknown"
    if isinstance(value, str):
        match = EXIT_CODE_LINE_RE.search(value[:MAX_EXIT_CODE_TEXT_CHARS])
        if match:
            return int(match.group(1)), "text"
    return None, "unknown"


def verification_status(exit_code: int | None) -> str:
    if exit_code is None:
        return "observed"
    return "passed" if exit_code == 0 else "failed"


def verification_signal(status: str) -> str:
    return {
        "passed": "verification-ran",
        "failed": "verification-failed",
        "observed": "verification-observed",
    }.get(status, "verification-observed")


def is_verification_command(command: str) -> bool:
    return is_dotnet_verification_command(command) or is_npm_verification_command(command)


def is_dotnet_verification_command(command: str) -> bool:
    for match in re.finditer(r"\bdotnet\s+(?:test|build)\b(?P<args>[^;&|\r\n]*)", command):
        args = match.group("args")
        if re.search(r"(?:^|\s)--version(?:\s|$)", args):
            continue
        return True
    return False


def is_npm_verification_command(command: str) -> bool:
    return bool(
        re.search(r"\bnpm\s+test\b", command)
        or re.search(r"\bnpm\s+run\s+(?:build|typecheck)\b", command)
    )


def is_git_closeout_command(command: str) -> bool:
    return bool(re.search(r"\bgit\s+(?:commit|push|merge)\b", command))


def is_plan_update_tool(tool_name: str) -> bool:
    return tool_name in {"functions.update_plan", "update_plan"}


def plan_has_completed_step(tool_input: Any) -> bool:
    if not isinstance(tool_input, dict):
        return False
    plan = tool_input.get("plan")
    if not isinstance(plan, list):
        return False
    for item in plan:
        if not isinstance(item, dict):
            continue
        if str(item.get("status") or "").lower() == "completed":
            return True
    return False


def classify_command_kind(command: str, tool_name: str = "") -> str:
    normalized_command = command.replace("\\", "/")
    if tool_name in {"apply_patch", "Edit", "Write"}:
        return "file-edit"
    if re.search(r"\bdotnet\s+test\b", command):
        return "dotnet-test"
    if re.search(r"\bdotnet\s+build\b", command):
        return "dotnet-build"
    if re.search(r"\bpython(?:\.exe)?\s+-m\s+unittest\b", command):
        return "python-unittest"
    if re.search(r"\b(?:python(?:\.exe)?|py)\s+-m\s+pytest\b", command) or re.search(r"\bpytest\b", command):
        return "pytest"
    if re.search(r"(?:^|[\\/])vitest(?:\.cmd|\.ps1|\.exe)?\b", normalized_command) or re.search(
        r"\bvitest\s+run\b",
        command,
    ):
        return "vitest"
    if re.search(r"\b(?:python(?:\.exe)?|py)\b", command):
        return "python-script"
    if re.search(r"\bnode(?:\.exe)?\s+", command):
        return "node-script"
    if re.search(
        r"\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item)\b",
        command,
        re.IGNORECASE,
    ):
        return "powershell-write"
    if re.search(r"\bnpm\s+test\b", command):
        return "npm-test"
    if re.search(r"\bnpm\s+run\s+build\b", command):
        return "npm-run-build"
    if re.search(r"\bnpm\s+run\s+typecheck\b", command):
        return "npm-run-typecheck"
    if re.search(r"\bcodex\s+plugin\b", command):
        return "codex-plugin-cli"
    if re.search(r"\bcolcon(?:\.exe)?\s+", command):
        return "colcon"
    if re.search(r"\bros2(?:\.exe)?\s+", command):
        return "ros2"
    if re.search(r"\bwsl(?:\.exe)?\b", command):
        return "wsl"
    if re.search(r"\b(?:curl|curl\.exe|invoke-webrequest|iwr)\b", command, re.IGNORECASE):
        return "http-request"
    git_match = re.search(r"\bgit\s+(commit|push|merge|status|diff|show|log|add|branch|worktree)\b", command)
    if git_match:
        return f"git-{git_match.group(1)}"
    if has_asset_path(command.replace("\\", "/")) and re.search(r"\b(?:rg|findstr|select-string)\b", command):
        return "asset-search-readonly"
    if re.search(r"\brg\s+", command):
        return "rg-search-readonly"
    if ";" in command and re.search(
        r"\b(?:get-content|select-string|get-childitem|test-path|set-location|where-object|foreach-object)\b",
        command,
        re.IGNORECASE,
    ):
        return "powershell-multi-command"
    if re.search(r"\b(?:get-content|select-string|get-childitem|test-path)\b", command, re.IGNORECASE):
        return "powershell-readonly"
    return "unknown"


def asset_files_changed(tool_name: str, tool_input: Any, command: str) -> bool:
    normalized_command = command.replace("\\", "/")
    if tool_name in {"apply_patch", "Edit", "Write"}:
        return has_asset_path(normalized_tool_input(tool_input))
    if not has_asset_path(normalized_command):
        return False
    return bool(
        re.search(
            r"\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|"
            r"python|pwsh|powershell|cmd|node|npm)\b",
            normalized_command,
        )
    )


def has_asset_path(text: str) -> bool:
    normalized = text.replace("\\", "/").lower()
    return any(marker in normalized for marker in ASSET_PATH_MARKERS)


def normalized_tool_input(tool_input: Any) -> str:
    if isinstance(tool_input, str):
        return tool_input.replace("\\", "/").lower()
    try:
        return json.dumps(tool_input, ensure_ascii=False).replace("\\", "/").lower()
    except TypeError:
        return ""


def has_meaningful_work(state: dict[str, Any]) -> bool:
    return bool(
        state.get("meaningfulWorkSignals")
        or state.get("subagentCandidates")
        or state.get("assetFilesChanged")
    )


def has_stop_closeout_work(state: dict[str, Any]) -> bool:
    hard_stop_signals = set(state.get("meaningfulWorkSignals") or []) - {"plan-boundary"}
    return bool(
        hard_stop_signals
        or state.get("subagentCandidates")
        or state.get("assetFilesChanged")
    )


def validation_reason(result: dict[str, Any]) -> str:
    parts: list[str] = []
    missing = result.get("missing") or []
    invalid = result.get("invalid") or []
    if missing:
        parts.append(f"missing required fields: {', '.join(str(item) for item in missing)}")
    if invalid:
        invalid_fields = [str(item).split("=", 1)[0].strip() or "asset_gate" for item in invalid]
        parts.append(f"invalid values: {', '.join(invalid_fields)}")
    if not parts:
        return "asset_gate validation failed"
    return "; ".join(parts)


def sanitize_validation_for_audit(result: dict[str, Any]) -> dict[str, Any]:
    invalid_entries = []
    for item in result.get("invalid") or []:
        value = str(item)
        field_name = value.split("=", 1)[0].strip()
        invalid_entries.append(field_name or value)
    sanitized: dict[str, Any] = {
        "valid": bool(result.get("valid")),
        "code": str(result.get("code") or "invalid_asset_gate_output"),
        "missing": [str(item) for item in (result.get("missing") or [])],
        "invalid": invalid_entries,
    }
    return sanitized


def is_push_only_closeout(state: dict[str, Any]) -> bool:
    signals = set(state.get("meaningfulWorkSignals") or [])
    return bool(
        signals == {"git-closeout"}
        and state.get("lastGitCloseoutKind") == "git-push"
        and not state.get("subagentCandidates")
        and not state.get("assetFilesChanged")
        and not state.get("verificationEvidence")
    )


def is_merge_only_closeout(state: dict[str, Any]) -> bool:
    signals = set(state.get("meaningfulWorkSignals") or [])
    return bool(
        signals == {"git-closeout"}
        and state.get("lastGitCloseoutKind") == "git-merge"
        and not state.get("subagentCandidates")
        and not state.get("assetFilesChanged")
        and not state.get("verificationEvidence")
    )


def clear_closeout_state(state: dict[str, Any]) -> None:
    state["meaningfulWorkSignals"] = []
    state["verificationEvidence"] = []
    state["subagentCandidates"] = []
    state["assetFilesChanged"] = False
    state["stopContinuationUsed"] = False
    state["assetGateDue"] = False
    state["lastGitCloseoutKind"] = ""


def close_session_state(state: dict[str, Any]) -> None:
    clear_closeout_state(state)
    state["lifecycle"] = "closed"
    state["closedAtUtc"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def reopen_session_state(state: dict[str, Any]) -> None:
    state["lifecycle"] = "active"
    state["closedAtUtc"] = None


if __name__ == "__main__":
    sys.exit(main())
