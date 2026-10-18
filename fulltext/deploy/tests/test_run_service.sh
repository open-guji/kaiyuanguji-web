#!/bin/bash
# run-service.sh 单测：补读 env 文件（已设变量优先）、FT_RELEASE_DIR 覆盖索引与书名路径。运行：bash test_run_service.sh
set -u
T="$(cd "$(dirname "$0")" && pwd)"; D="$(dirname "$T")"
PASS=0; FAIL=0
eq() { [ "$2" = "$3" ] && { PASS=$((PASS+1)); echo "  ✓ $1"; } || { FAIL=$((FAIL+1)); echo "  ✗ $1（期望 $3，实际 $2）"; }; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/app/service"
# 假 run.py：把关心的环境变量打出来
cat > "$W/app/service/run.py" <<'PY'
import os
print('|'.join(os.environ.get(k, '-') for k in ('FT_PORT', 'FT_INDEX_DIR', 'FT_TITLES', 'FT_BOOST', 'FT_EXACT_SCAN')))
PY
printf 'FT_PORT=8765\nFT_INDEX_DIR=/opt/fulltext/current/index\nFT_TITLES=/opt/fulltext/current/titles.json\nFT_EXACT_SCAN=3000\n# 注释\n' > "$W/env"
run() { env -i PATH="$PATH" FT_ROOT="$W" FT_ENV_FILE="$W/env" FT_PYTHON="$(command -v python3)" "$@" bash "$D/run-service.sh"; }
echo "systemd 式启动：变量全来自 env 文件"
eq "读到 env" "$(run)" "8765|/opt/fulltext/current/index|/opt/fulltext/current/titles.json|-|3000"
echo "rotate 自检：端口沿用调用方，路径取 release"
eq "自检覆盖" "$(run FT_PORT=18765 FT_RELEASE_DIR=/r/x)" "18765|/r/x/index|/r/x/titles.json|/r/x/boost.json|3000"
echo "没有 env 文件也能起"
eq "无 env" "$(env -i PATH="$PATH" FT_ROOT="$W" FT_ENV_FILE="$W/nope" FT_PYTHON="$(command -v python3)" FT_PORT=1 bash "$D/run-service.sh")" "1|-|-|-|-"
echo; echo "通过 $PASS，失败 $FAIL"
[ "$FAIL" = 0 ]
