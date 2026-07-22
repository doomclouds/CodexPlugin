#!/usr/bin/env sh
set -eu

if [ -n "${PLUGIN_ROOT:-}" ] && [ -f "$PLUGIN_ROOT/hooks/asset_hook.py" ]; then
  hook_script="$PLUGIN_ROOT/hooks/asset_hook.py"
else
  case "$0" in
    */*) script_dir=${0%/*} ;;
    *) script_dir=. ;;
  esac
  script_dir=$(CDPATH= cd "$script_dir" && pwd -P)
  hook_script="$script_dir/asset_hook.py"
fi

case "$(uname -s 2>/dev/null || printf '%s' unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    platform="windows"
    ;;
  *)
    platform="posix"
    ;;
esac

is_windowsapps_python() {
  case "${1:-}" in
    *WindowsApps*|*WINDOWSApps*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_path() {
  if [ "$platform" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -u "${1:-}" 2>/dev/null || printf '%s\n' "${1:-}"
    return 0
  fi
  printf '%s\n' "${1:-}"
}

is_executable_file() {
  candidate_path=$(normalize_path "${1:-}")
  [ -n "$candidate_path" ] && [ -f "$candidate_path" ] && [ -x "$candidate_path" ]
}

find_python() {
  if is_executable_file "${CODEX_ASSET_PYTHON:-}" && ! is_windowsapps_python "${CODEX_ASSET_PYTHON:-}"; then
    normalize_path "$CODEX_ASSET_PYTHON"
    return 0
  fi

  if [ "$platform" = "windows" ]; then
    local_app_data=${LOCALAPPDATA:-}
    program_files=${ProgramFiles:-${PROGRAMFILES:-}}
    for candidate in \
      "$local_app_data/Python/bin/python.exe" \
      "$local_app_data/Python/pythoncore-3.14-64/python.exe" \
      "$local_app_data/Python/pythoncore-3.13-64/python.exe" \
      "$local_app_data/Python/pythoncore-3.12-64/python.exe" \
      "$local_app_data/Programs/Python/Python314/python.exe" \
      "$local_app_data/Programs/Python/Python313/python.exe" \
      "$local_app_data/Programs/Python/Python312/python.exe" \
      "$program_files/Python314/python.exe" \
      "$program_files/Python313/python.exe" \
      "$program_files/Python312/python.exe"
    do
      normalized_candidate=$(normalize_path "$candidate")
      if is_executable_file "$normalized_candidate" && ! is_windowsapps_python "$normalized_candidate"; then
        printf '%s\n' "$normalized_candidate"
        return 0
      fi
    done
  fi

  for command_name in python3 python; do
    candidate_path=$(command -v "$command_name" 2>/dev/null || true)
    normalized_candidate=$(normalize_path "$candidate_path")
    if is_executable_file "$normalized_candidate" && ! is_windowsapps_python "$normalized_candidate"; then
      printf '%s\n' "$normalized_candidate"
      return 0
    fi
  done

  return 1
}

python_exe=$(find_python) || {
  echo "No real Python interpreter found. Set CODEX_ASSET_PYTHON." >&2
  exit 127
}

export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"
export ASSET_HOOK_LAUNCHER="${ASSET_HOOK_LAUNCHER:-posix-shell}"
exec "$python_exe" -X utf8 "$hook_script"
