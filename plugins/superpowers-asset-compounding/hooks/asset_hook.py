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
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        append_raw_usage_event(
            "HookInput",
            decision="error",
            reason_code="invalid_json",
            durationMs=elapsed_ms(started_at),
        )
        print(f"Invalid hook JSON: {exc}", file=sys.stderr)
        return 1

    event["_assetHookStartedAt"] = started_at
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
        print(f"Hook stdin read timed out after {timeout_ms}ms", file=sys.stderr)
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
        print(f"Hook stdin read failed: {result}", file=sys.stderr)
        return None
    try:
        return result.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        append_raw_usage_event(
            "HookInput",
            decision="error",
            reason_code="stdin_decode_error",
            durationMs=elapsed_ms(started_at),
        )
        print(f"Invalid hook JSON: {exc}", file=sys.stderr)
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
    append_usage_event(event, "SessionStart", decision="context", reason_code="asset_repo_detected")
    return additional_context(
        "SessionStart",
        (
            "This repository uses hook-assisted asset compounding. Keep asset "
            "workflow concise: subagents report candidates, the main agent owns "
            "route decisions and writes, and meaningful closeout needs an "
            "auditable asset_gate block. "
            f"{workspace_context(event)}"
        ),
    )


def handle_post_tool_use(event: dict[str, Any]) -> dict[str, Any] | None:
    if not repo_has_assets(event):
        return None
    state = load_state(event)
    tool_name = str(event.get("tool_name", ""))
    tool_input = event.get("tool_input")
    command = extract_command(tool_input).lower()
    signals = set(state.get("meaningfulWorkSignals", []))
    signals_before = set(signals)
    asset_files_changed_this_tool = False
    asset_bootstrap_this_tool: dict[str, Any] | None = None
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
    if is_verification_command(command):
        exit_code = extract_exit_code(event.get("tool_response"))
        status = verification_status(exit_code)
        signals.add("verification-failed" if status == "failed" else "verification-ran")
        evidence = {
            "command": summarize_command(command),
            "status": status,
            "summary": "tool output observed by PostToolUse",
        }
        if exit_code is not None:
            evidence["exitCode"] = exit_code
        state.setdefault("verificationEvidence", []).append(
            evidence
        )
    if is_git_closeout_command(command):
        signals.add("git-closeout")
        state["lastGitCloseoutKind"] = classify_command_kind(command)
    if asset_files_changed(tool_name, tool_input, command):
        asset_files_changed_this_tool = True
        state["assetFilesChanged"] = True
        bootstrap_result = bootstrap_asset_guidance(event)
        if bootstrap_result is not None:
            state["assetBootstrap"] = bootstrap_result
            asset_bootstrap_this_tool = bootstrap_result

    state["meaningfulWorkSignals"] = sorted(signals)
    save_state(event, state)
    command_kind = "plan-update" if is_plan_update_tool(tool_name) else classify_command_kind(command, tool_name)
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
        exitCode=extract_exit_code(event.get("tool_response")),
        verificationStatus=verification_status(extract_exit_code(event.get("tool_response")))
        if is_verification_command(command)
        else None,
        signalsAdded=sorted(signals - signals_before),
        signals=state["meaningfulWorkSignals"],
        assetFilesChangedThisTool=asset_files_changed_this_tool,
        assetFilesChanged=bool(state.get("assetFilesChanged")),
        assetBootstrap=state.get("assetBootstrap", {}).get("action")
        if isinstance(state.get("assetBootstrap"), dict)
        else None,
        assetBootstrapThisTool=asset_bootstrap_this_tool.get("action")
        if isinstance(asset_bootstrap_this_tool, dict)
        else None,
        assetGateDue=bool(state.get("assetGateDue")),
        assetGateReminder=plan_update_reminder_due if is_plan_update_tool(tool_name) else None,
    )
    if plan_update_reminder_due:
        return {
            "systemMessage": (
                "Asset-compounding checkpoint is due from a completed plan step. "
                "Before starting the next planned task, run the main-agent asset "
                "gate: decide route none, inbox, update-existing, archive, "
                "new-problem, or both; use the asset-compounding scripts when "
                "you need deterministic evidence."
            )
        }
    return None


def handle_stop(event: dict[str, Any]) -> dict[str, Any] | None:
    if not repo_has_assets(event):
        return None
    message = str(event.get("last_assistant_message") or "")
    if "asset_gate:" in message:
        state = load_state(event)
        handoff_checks = import_handoff_checks_module()
        validation = handoff_checks.validate_asset_gate_text(message)
        if not validation.get("valid"):
            sanitized_validation = sanitize_validation_for_audit(validation)
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
                    f"invalid asset_gate block: {validation_reason(validation)}\n"
                    "Use this flat template:\n"
                    f"{handoff_checks.asset_gate_template()}"
                ),
            }
        append_usage_event(
            event,
            "Stop",
            decision="allow",
            reason_code="asset_gate_present",
            hasAssetGate=True,
            hasMeaningfulWork=has_stop_closeout_work(state),
            signals=state.get("meaningfulWorkSignals", []),
            candidateCount=len(state.get("subagentCandidates", [])),
        )
        clear_closeout_state(state)
        save_state(event, state)
        return None
    state = load_state(event)
    if not has_stop_closeout_work(state):
        append_usage_event(
            event,
            "Stop",
            decision="allow",
            reason_code="no_meaningful_work",
            hasAssetGate=False,
            hasMeaningfulWork=False,
        )
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
        clear_closeout_state(state)
        save_state(event, state)
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
        clear_closeout_state(state)
        save_state(event, state)
        return None
    if is_cleanup_only_closeout(state, message):
        append_usage_event(
            event,
            "Stop",
            decision="allow",
            reason_code="cleanup_only_auto_none",
            hasAssetGate=False,
            hasMeaningfulWork=True,
            signals=state.get("meaningfulWorkSignals", []),
            cleanupOnly=True,
        )
        clear_closeout_state(state)
        save_state(event, state)
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
                "Asset-compounding closeout still appears to be missing an "
                "asset_gate block, but the Stop hook already continued once."
            )
        }

    state["stopContinuationUsed"] = True
    save_state(event, state)
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
            "Run the asset-compounding closeout gate for this turn. Include an "
            "auditable asset_gate block with event_type, route, reason, "
            "evidence, related_assets, asset_candidates, deferred_signals, and "
            "next_step. If no asset is needed, choose route: none and give the "
            "concrete reason."
        ),
    }


def handle_pre_compact(event: dict[str, Any]) -> dict[str, Any] | None:
    if not repo_has_assets(event):
        return None
    state = load_state(event)
    state["lastCompactTrigger"] = str(event.get("trigger", ""))
    save_state(event, state)
    if state.get("subagentCandidates"):
        append_usage_event(
            event,
            "PreCompact",
            decision="warn",
            reason_code="pending_candidates",
            candidateCount=len(state.get("subagentCandidates", [])),
        )
        return {
            "systemMessage": (
                "Asset-compounding state saved before compaction with pending "
                f"candidates: {len(state.get('subagentCandidates', []))}."
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
    except Exception as exc:  # pragma: no cover - defensive hook boundary
        return {
            "action": "failed",
            "error": str(exc),
        }

    return {
        "action": "written" if result.get("changed") else "unchanged",
        "createdDirs": result.get("created_dirs", []),
        "agentsFile": result.get("guidance", {}).get("agents_file"),
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


def events_path(event: dict[str, Any]) -> Path:
    return state_path(event).with_name("events.jsonl")


def audit_session_segment(event: dict[str, Any]) -> str:
    project_name = Path(str(event.get("cwd") or "unknown-project")).name or "unknown-project"
    session_id = str(event.get("session_id") or "unknown-session")
    return f"{safe_segment(project_name)}--{safe_segment(session_id)}"


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
    }
    for key, value in extra.items():
        if value is not None:
            payload[key] = value
    path = events_path(event)
    try:
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
    with event_file_lock(path):
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(line)
            stream.flush()


@contextmanager
def event_file_lock(path: Path) -> Iterator[None]:
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock_stream:
        acquire_lock(lock_stream)
        try:
            yield
        finally:
            release_lock(lock_stream)


def acquire_lock(stream: BinaryIO) -> None:
    timeout_ms = int(os.environ.get("ASSET_HOOK_EVENT_LOCK_TIMEOUT_MS", "1000"))
    deadline = time.monotonic() + max(1, timeout_ms) / 1000
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


def load_state(event: dict[str, Any]) -> dict[str, Any]:
    path = state_path(event)
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {
        "schemaVersion": 1,
        "sessionId": str(event.get("session_id") or ""),
        "turnId": str(event.get("turn_id") or ""),
        "cwd": str(event.get("cwd") or ""),
        "repoHasSuperpowersAssets": repo_has_assets(event),
        "meaningfulWorkSignals": [],
        "verificationEvidence": [],
        "subagentCandidates": [],
        "assetFilesChanged": False,
        "stopContinuationUsed": False,
        "assetGateDue": False,
        "lastGitCloseoutKind": "",
    }


def save_state(event: dict[str, Any], state: dict[str, Any]) -> None:
    path = state_path(event)
    path.parent.mkdir(parents=True, exist_ok=True)
    state["turnId"] = str(event.get("turn_id") or state.get("turnId") or "")
    state["cwd"] = str(event.get("cwd") or state.get("cwd") or "")
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def safe_segment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._") or "unknown"


def extract_command(tool_input: Any) -> str:
    if isinstance(tool_input, dict):
        for key in ("command", "cmd", "script"):
            command = tool_input.get(key)
            if isinstance(command, str):
                return command
    return ""


def summarize_command(command: str) -> str:
    return " ".join(command.split())[:240]


def extract_exit_code(tool_response: Any) -> int | None:
    if not isinstance(tool_response, dict):
        return None
    for key in ("exit_code", "exitCode", "returncode", "returnCode"):
        value = tool_response.get(key)
        if isinstance(value, int):
            return value
    return None


def verification_status(exit_code: int | None) -> str:
    if exit_code is None:
        return "observed"
    return "passed" if exit_code == 0 else "failed"


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
        parts.append(f"invalid values: {', '.join(str(item) for item in invalid)}")
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


def is_cleanup_only_closeout(state: dict[str, Any], message: str) -> bool:
    if not (
        state.get("assetFilesChanged")
        or "edited-files" in set(state.get("meaningfulWorkSignals") or [])
        or "git-closeout" in set(state.get("meaningfulWorkSignals") or [])
    ):
        return False
    normalized = message.lower()
    return bool(
        re.search(
            r"cleanup-only|清理|删除|移除|放弃|废弃|不再|remove|delete|cleanup|abandon|deprecated",
            normalized,
        )
    )


def clear_closeout_state(state: dict[str, Any]) -> None:
    state["meaningfulWorkSignals"] = []
    state["verificationEvidence"] = []
    state["subagentCandidates"] = []
    state["assetFilesChanged"] = False
    state["stopContinuationUsed"] = False
    state["assetGateDue"] = False
    state["lastGitCloseoutKind"] = ""


if __name__ == "__main__":
    sys.exit(main())
