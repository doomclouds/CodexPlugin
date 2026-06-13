#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
hook_script="$script_dir/asset_hook.py"

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    platform="windows"
    ;;
  *)
    platform="posix"
    ;;
esac

is_windowsapps_python() {
  case "${1//\\//}" in
    */WindowsApps/python.exe|*/Microsoft/WindowsApps/python.exe|*/WINDOWSApps/python.exe)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_path() {
  if [ "$platform" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1" 2>/dev/null || printf '%s\n' "$1"
    return 0
  fi
  printf '%s\n' "$1"
}

is_executable_file() {
  local path
  path="$(normalize_path "${1:-}")"
  [ -n "$path" ] && [ -f "$path" ] && [ -x "$path" ]
}

find_python() {
  if is_executable_file "${CODEX_ASSET_PYTHON:-}"; then
    normalize_path "$CODEX_ASSET_PYTHON"
    return 0
  fi

  local candidates=()
  if [ "$platform" = "windows" ]; then
    local local_app_data="${LOCALAPPDATA:-}"
    local program_files="${ProgramFiles:-${PROGRAMFILES:-}}"
    candidates+=(
      "$local_app_data/Python/bin/python.exe"
      "$local_app_data/Programs/Python/Python314/python.exe"
      "$local_app_data/Programs/Python/Python313/python.exe"
      "$local_app_data/Programs/Python/Python312/python.exe"
      "$program_files/Python314/python.exe"
      "$program_files/Python313/python.exe"
      "$program_files/Python312/python.exe"
    )
  fi

  local candidate
  local normalized_candidate
  for candidate in "${candidates[@]}"; do
    normalized_candidate="$(normalize_path "$candidate")"
    if is_executable_file "$normalized_candidate" && ! is_windowsapps_python "$normalized_candidate"; then
      printf '%s\n' "$normalized_candidate"
      return 0
    fi
  done

  while IFS= read -r candidate; do
    normalized_candidate="$(normalize_path "$candidate")"
    if is_executable_file "$normalized_candidate" && ! is_windowsapps_python "$normalized_candidate"; then
      printf '%s\n' "$normalized_candidate"
      return 0
    fi
  done < <({ type -P -a python3 2>/dev/null; type -P -a python 2>/dev/null; } | awk '!seen[$0]++')

  return 1
}

python_exe="$(find_python)" || {
  echo "No real Python interpreter found. Set CODEX_ASSET_PYTHON." >&2
  exit 127
}

export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"
exec "$python_exe" -X utf8 "$hook_script"
