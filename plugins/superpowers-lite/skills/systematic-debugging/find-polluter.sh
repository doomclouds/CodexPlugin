#!/usr/bin/env bash
# Find the first test that creates unwanted files or state.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "用法：$0 <要检查的文件或目录> <测试文件模式>"
  echo "示例：$0 '.git' 'src/**/*.test.ts'"
  exit 1
fi

POLLUTION_CHECK="$1"
TEST_PATTERN="$2"

if [[ -e "$POLLUTION_CHECK" || -L "$POLLUTION_CHECK" ]]; then
  echo "错误：检测目标在测试开始前已经存在：$POLLUTION_CHECK" >&2
  exit 2
fi

if [[ "$TEST_PATTERN" != ./* && "$TEST_PATTERN" != /* ]]; then
  TEST_PATTERN="./$TEST_PATTERN"
fi

TEST_FILES=()
while IFS= read -r -d '' test_file; do
  TEST_FILES+=("$test_file")
done < <(find . -path "$TEST_PATTERN" -print0 | LC_ALL=C sort -z)

TOTAL=${#TEST_FILES[@]}
if [[ "$TOTAL" -eq 0 ]]; then
  echo "错误：未找到匹配的测试文件：$TEST_PATTERN" >&2
  exit 2
fi

echo "🔍 正在查找创建检测目标的测试：$POLLUTION_CHECK"
echo "测试文件模式：$TEST_PATTERN"
echo "共找到 $TOTAL 个测试文件"
echo

COUNT=0
for TEST_FILE in "${TEST_FILES[@]}"; do
  COUNT=$((COUNT + 1))

  printf '[%d/%d] 正在运行：%q\n' "$COUNT" "$TOTAL" "$TEST_FILE"

  npm test "$TEST_FILE" >/dev/null 2>&1 || true

  if [[ -e "$POLLUTION_CHECK" || -L "$POLLUTION_CHECK" ]]; then
    echo
    echo "🎯 找到污染源"
    printf '   测试文件：%s\n' "$TEST_FILE"
    printf '   创建目标：%s\n' "$POLLUTION_CHECK"
    echo
    echo "污染目标详情："
    ls -la -- "$POLLUTION_CHECK"
    echo
    echo "后续排查命令："
    printf '  npm test %q\n' "$TEST_FILE"
    exit 1
  fi
done

echo
echo "✅ 未找到污染源，所有测试均保持清洁"
exit 0
