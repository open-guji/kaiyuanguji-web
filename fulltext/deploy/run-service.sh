#!/bin/bash
# 服务启动包装：systemd 单元和 rotate.sh 的自检临时实例共用。
# systemd 经 EnvironmentFile 注入 /etc/fulltext.env；rotate.sh 自检直接调本脚本，所以这里补读一次（已设的变量优先）。
# 给了 FT_RELEASE_DIR（rotate 自检）时，索引、书名、boost 一律取该 release，不读 current。
ROOT="${FT_ROOT:-/opt/fulltext}"
ENV_FILE="${FT_ENV_FILE:-/etc/fulltext.env}"
if [ -r "$ENV_FILE" ]; then
    while IFS='=' read -r k v; do
        [ -z "${!k+x}" ] && export "$k=$v"
    done < <(grep -E '^FT_[A-Z0-9_]+=' "$ENV_FILE")
fi
if [ -n "${FT_RELEASE_DIR:-}" ]; then
    export FT_INDEX_DIR="$FT_RELEASE_DIR/index" FT_TITLES="$FT_RELEASE_DIR/titles.json" FT_BOOST="$FT_RELEASE_DIR/boost.json"
fi
cd "$ROOT/app" || exit 1
exec "${FT_PYTHON:-/usr/bin/python3}" -I "$ROOT/app/service/run.py"
