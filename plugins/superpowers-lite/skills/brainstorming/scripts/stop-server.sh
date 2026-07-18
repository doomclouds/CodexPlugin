#!/usr/bin/env bash
# Stop the brainstorm server and clean up
# Usage: stop-server.sh <session_dir>
#
# Kills the server process. Only deletes session directory if it's
# under /tmp (ephemeral). Persistent directories (.superpowers/) are
# kept so mockups can be reviewed later.

SESSION_DIR="$1"

if [[ -z "$SESSION_DIR" ]]; then
  echo '{"error": "用法：stop-server.sh <session_dir>"}'
  exit 1
fi

canonical_tmp="$(cd -P /tmp 2>/dev/null && pwd -P)"
DELETE_SESSION_DIR=""

resolve_safe_ephemeral_session() {
  local candidate="$1"
  local normalized_input="/${candidate//\\//}/"
  local canonical_candidate
  local candidate_parent
  local candidate_name

  [[ "$normalized_input" != *'/../'* ]] || return 1
  if [[ -L "$candidate" ]]; then
    return 1
  fi
  if command -v node >/dev/null 2>&1 &&
    node -e "const fs=require('fs'); process.exit(fs.lstatSync(process.argv[1]).isSymbolicLink() ? 0 : 1)" "$candidate" 2>/dev/null; then
    return 1
  fi
  [[ -d "$candidate" ]] || return 1

  canonical_candidate="$(cd -P -- "$candidate" 2>/dev/null && pwd -P)" || return 1
  candidate_parent="$(dirname -- "$canonical_candidate")"
  candidate_name="$(basename -- "$canonical_candidate")"

  [[ "$candidate_parent" == "$canonical_tmp" ]] || return 1
  [[ "$candidate_name" == brainstorm-* ]] || return 1
  printf '%s\n' "$canonical_candidate"
}

if [[ "$SESSION_DIR" == /tmp || "$SESSION_DIR" == /tmp/* ]]; then
  if ! DELETE_SESSION_DIR="$(resolve_safe_ephemeral_session "$SESSION_DIR")"; then
    echo '{"status": "refused", "error": "不安全的临时会话目录"}' >&2
    exit 1
  fi
fi

STATE_DIR="${SESSION_DIR}/state"
PID_FILE="${STATE_DIR}/server.pid"
SERVER_ID_FILE="${STATE_DIR}/server-instance-id"

mark_stopped() {
  local reason="$1"
  rm -f "${STATE_DIR}/server-info"
  printf '{"reason":"%s","timestamp":%s}\n' "$reason" "$(date +%s)" > "${STATE_DIR}/server-stopped"
}

read_expected_server_id() {
  [[ -f "$SERVER_ID_FILE" ]] || return 1
  local id
  id="$(tr -d '\r\n' < "$SERVER_ID_FILE" 2>/dev/null || true)"
  [[ "$id" =~ ^[A-Za-z0-9_-]{32,64}$ ]] || return 1
  printf '%s\n' "$id"
}

command_line_for_pid() {
  local pid="$1"
  if [[ -r "/proc/$pid/cmdline" ]]; then
    tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null || true
    return 0
  fi
  ps -ww -p "$pid" -o command= 2>/dev/null || ps -f -p "$pid" 2>/dev/null | sed '1d' || true
}

command_has_server_id() {
  local pid="$1"
  local expected="$2"
  local expected_arg="--brainstorm-server-id=$expected"
  if [[ -r "/proc/$pid/cmdline" ]]; then
    local arg
    while IFS= read -r -d '' arg || [[ -n "$arg" ]]; do
      [[ "$arg" == "$expected_arg" ]] && return 0
    done < "/proc/$pid/cmdline"
    return 1
  fi
  local command_line
  command_line="$(command_line_for_pid "$pid")"
  [[ -n "$command_line" ]] || return 1
  case " $command_line " in
    *" $expected_arg "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Confirm a PID has this session's per-start instance id, not just a familiar
# process name. Ambiguous or legacy metadata fails closed as stale_pid.
is_brainstorm_server() {
  kill -0 "$1" 2>/dev/null || return 1
  local expected_id
  expected_id="$(read_expected_server_id)" || return 1
  command_has_server_id "$1" "$expected_id" || return 1
  return 0
}

if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE")

  # Refuse to signal a PID we can't prove is our server. A stale pid file may
  # point at an unrelated process after a reboot/PID wraparound.
  if ! is_brainstorm_server "$pid"; then
    rm -f "$PID_FILE" "$SERVER_ID_FILE"
    mark_stopped "stale_pid"
    echo '{"status": "stale_pid"}'
    exit 0
  fi

  # Try to stop gracefully, fallback to force if still alive
  kill "$pid" 2>/dev/null || true

  # Wait for graceful shutdown (up to ~2s)
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  # If still running, escalate to SIGKILL
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true

    # Give SIGKILL a moment to take effect
    sleep 0.1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo '{"status": "failed", "error": "进程仍在运行"}'
    exit 1
  fi

  rm -f "$PID_FILE" "$SERVER_ID_FILE" "${STATE_DIR}/server.log"
  mark_stopped "stop-server.sh"

  # Delete only a canonical, direct /tmp/brainstorm-* child validated above.
  if [[ -n "$DELETE_SESSION_DIR" ]]; then
    revalidated_session_dir="$(resolve_safe_ephemeral_session "$DELETE_SESSION_DIR")" || {
      echo '{"status": "refused", "error": "删除前临时会话目录校验失败"}' >&2
      exit 1
    }
    if [[ "$revalidated_session_dir" != "$DELETE_SESSION_DIR" ]]; then
      echo '{"status": "refused", "error": "删除前临时会话目录已变化"}' >&2
      exit 1
    fi
    rm -rf -- "$revalidated_session_dir"
  fi

  echo '{"status": "stopped"}'
else
  echo '{"status": "not_running"}'
fi
