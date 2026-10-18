#!/bin/bash
# 手动回滚：current ⇄ previous 互换，重载服务，健康检查。用法：rollback.sh
# 也会抢同一把锁（与 Meili 重建／ingest 串行）。退出码：0 成功；6 锁忙；12 无 previous 或回滚后仍不健康。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"

[ -L "$FT_ROOT/previous" ] || die $EXIT_ROLLBACK_FAILED "没有 previous，无可回滚"
lock_acquire fulltext-rollback || exit $EXIT_LOCK_BUSY

cur="$(readlink "$FT_ROOT/current" 2>/dev/null || true)"
prev="$(readlink "$FT_ROOT/previous")"
[ -d "$FT_ROOT/$prev" ] || [ -d "$prev" ] || die $EXIT_ROLLBACK_FAILED "previous 指向的目录不存在：$prev"
log "回滚：current ${cur:-<无>} → $prev"
link_swap current "$prev"
[ -n "$cur" ] && link_swap previous "$cur"
service_reload
if wait_healthy "$FT_PORT" "${FT_HEALTH_WAIT:-30}"; then
    log "回滚完成，健康检查通过（current=$prev）"
    exit 0
fi
die $EXIT_ROLLBACK_FAILED "回滚后 /healthz 仍不通，请人工处理（current=$prev）"
