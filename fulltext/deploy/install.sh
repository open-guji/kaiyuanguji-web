#!/bin/bash
# 幂等安装（搜索机上以 root 跑）：建用户与目录、装脚本与 systemd 单元、建 env 模板（不含机密）。
# 用法：install.sh [--app-src <service 源码目录>]
#   --app-src 给了就把 F4 的 service/ 同步到 /opt/fulltext/app/service；不给则不动 app。
# 不会：启动服务、写任何凭据、动网关／防火墙／EdgeOne（对外路由是 F5 步 4，另批）。
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
    [ -d "$APP_SRC" ] || { echo "找不到 $APP_SRC" >&2; exit 2; }
    run mkdir -p "$ROOT/app/service"
    run cp -a "$APP_SRC"/. "$ROOT/app/service/"
fi
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
