#!/usr/bin/env python3
from __future__ import annotations

import json
import hashlib
import os
import queue
import re
import sys
import importlib
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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
            "auditable asset_gate block."
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
    if asset_files_changed(tool_name, tool_input, command):
        asset_files_changed_this_tool = True
        state["assetFilesChanged"] = True
        bootstrap_result = bootstrap_asset_guidance(event)
        if bootstrap_result is not None:
            state["assetBootstrap"] = bootstrap_result
            asset_bootstrap_this_tool = bootstrap_result

    state["meaningfulWorkSignals"] = sorted(signals)
    save_state(event, state)
    command_kind = "plan-update" if is_plan_update_tool(tool_name) else classify_command_kind(command)
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


def repo_has_assets(event: dict[str, Any]) -> bool:
    cwd = Path(str(event.get("cwd") or "."))
    return (cwd / "docs" / "superpowers").is_dir()


def bootstrap_asset_guidance(event: dict[str, Any]) -> dict[str, Any] | None:
    root = Path(str(event.get("cwd") or "."))
    if not (root / "docs" / "superpowers").is_dir():
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


def state_path(event: dict[str, Any]) -> Path:
    session_id = safe_segment(str(event.get("session_id") or "unknown-session"))
    plugin_data = Path(os.environ.get("PLUGIN_DATA") or ".asset-plugin-data")
    return plugin_data / session_id / "state.json"


def events_path(event: dict[str, Any]) -> Path:
    return state_path(event).with_name("events.jsonl")


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
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(payload, ensure_ascii=False, sort_keys=True))
            stream.write("\n")
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
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(payload, ensure_ascii=False, sort_keys=True))
            stream.write("\n")
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


def classify_command_kind(command: str) -> str:
    if re.search(r"\bdotnet\s+test\b", command):
        return "dotnet-test"
    if re.search(r"\bdotnet\s+build\b", command):
        return "dotnet-build"
    if re.search(r"\bnpm\s+test\b", command):
        return "npm-test"
    if re.search(r"\bnpm\s+run\s+build\b", command):
        return "npm-run-build"
    if re.search(r"\bnpm\s+run\s+typecheck\b", command):
        return "npm-run-typecheck"
    git_match = re.search(r"\bgit\s+(commit|push|merge)\b", command)
    if git_match:
        return f"git-{git_match.group(1)}"
    if "docs/superpowers" in command.replace("\\", "/") and re.search(r"\b(?:rg|findstr|select-string)\b", command):
        return "asset-search-readonly"
    return "unknown"


def asset_files_changed(tool_name: str, tool_input: Any, command: str) -> bool:
    normalized_command = command.replace("\\", "/")
    if tool_name in {"apply_patch", "Edit", "Write"}:
        return "docs/superpowers" in normalized_tool_input(tool_input)
    if "docs/superpowers" not in normalized_command:
        return False
    return bool(
        re.search(
            r"\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|"
            r"python|pwsh|powershell|cmd|node|npm)\b",
            normalized_command,
        )
    )


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


def clear_closeout_state(state: dict[str, Any]) -> None:
    state["meaningfulWorkSignals"] = []
    state["verificationEvidence"] = []
    state["subagentCandidates"] = []
    state["assetFilesChanged"] = False
    state["stopContinuationUsed"] = False
    state["assetGateDue"] = False


if __name__ == "__main__":
    sys.exit(main())
