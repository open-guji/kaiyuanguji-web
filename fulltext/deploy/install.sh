#!/bin/bash
# 幂等安装（搜索机上以 root 跑）：建用户与目录、装脚本与 systemd 单元、建 env 模板（不含机密）。
# 用法：install.sh [--app-src <kaiyuanguji-web 仓的 fulltext/ 目录>]
#   --app-src 给了就把 common.py、charmap.json、service/ 同步到 /opt/fulltext/app/；不给则不动 app。
# 不会：启动服务、写任何凭据、动网关／防火墙／EdgeOne。
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${FT_ROOT:-/opt/fulltext}"
UNIT_DIR="${FT_UNIT_DIR:-/etc/systemd/system}"
ENV_FILE="${FT_ENV_FILE:-/etc/fulltext.env}"
DRY="${FT_DRY_RUN:-0}"    # 1＝只打印不做（干净容器 dry-run 验收用）
APP_SRC=""
while [ $# -gt 0 ]; do
    case "$1" in --app-src) APP_SRC="$2"; shift 2 ;; *) echo "未知参数 $1" >&2; exit 2 ;; esac
done
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }

id fulltext >/dev/null 2>&1 || run useradd --system --no-create-home --shell /usr/sbin/nologin fulltext
run mkdir -p "$ROOT/releases" "$ROOT/bin" "$ROOT/app"
run install -m 0755 "$HERE/run-service.sh" "$ROOT/bin/run-service.sh"
for f in lib.sh rotate.sh rollback.sh manifest_check.py; do
    run install -m 0755 "$HERE/$f" "$ROOT/bin/$f"
done
if [ -n "$APP_SRC" ]; then
    [ -f "$APP_SRC/common.py" ] && [ -d "$APP_SRC/service" ] || { echo "$APP_SRC 不是 fulltext/ 目录（缺 common.py 或 service/）" >&2; exit 2; }
    # 整目录换新（旧版留下的文件不残留）；不带源机属主（cp -a 会把 ubuntu:ubuntu 775 带过来）
    run rm -rf "$ROOT/app/service"
    run mkdir -p "$ROOT/app/service"
    run install -m 0644 "$APP_SRC/common.py" "$APP_SRC/charmap.json" "$ROOT/app/"
    run cp -R --no-preserve=mode,ownership "$APP_SRC/service"/. "$ROOT/app/service/"
    run rm -rf "$ROOT/app/service/tests"
    run find "$ROOT/app" -name __pycache__ -type d -prune -exec rm -rf {} +
fi
# 代码归 root、服务用户只读（服务以 fulltext 跑，unit 里另有 ReadOnlyPaths）
run chown -R root:root "$ROOT/app"
run chmod -R u=rwX,go=rX "$ROOT/app"
run install -m 0644 "$HERE/fulltext.service" "$UNIT_DIR/fulltext.service"
if [ ! -e "$ENV_FILE" ]; then
    run install -m 0600 "$HERE/fulltext.env.example" "$ENV_FILE"
else
    echo "已有 $ENV_FILE，保持不动"
fi
run chown -R root:root "$ROOT/bin"
run chown fulltext:fulltext "$ROOT/releases"
if [ "$DRY" != 1 ] && command -v systemctl >/dev/null; then
    systemctl daemon-reload
    echo "单元已装；首个 release 就位并 rotate 之后再 systemctl enable --now fulltext"
fi
