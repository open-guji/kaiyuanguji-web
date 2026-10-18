#!/bin/bash
# F5 公共函数：路径、锁、日志。被 rotate.sh / rollback.sh / install.sh source。
# 路径与命令均可用环境变量覆盖，单测靠这个把真机换成假目录。

FT_ROOT="${FT_ROOT:-/opt/fulltext}"
FT_LOCK="${INDEXER_LOCK:-/opt/indexer/.lock}"     # 与 Meili 重建／ingest 同一把锁（indexer/lib/ingest-support.mjs 协议）
FT_SYSTEMCTL="${FT_SYSTEMCTL:-systemctl}"
FT_UNIT="${FT_UNIT:-fulltext.service}"
FT_PORT="${FT_PORT:-8765}"
FT_CURL="${FT_CURL:-curl}"

EXIT_ARGS=2
EXIT_LOCK_BUSY=6      # 与 indexer 的 EXIT.LOCK_BUSY 一致
EXIT_MANIFEST_BAD=8   # 与 indexer 的 EXIT.MANIFEST_BAD 一致
EXIT_DISK=9
EXIT_SELFCHECK=10
EXIT_HEALTH_ROLLED_BACK=11
EXIT_ROLLBACK_FAILED=12

log() { echo "[$(date '+%F %T')] $*" >&2; }
die() { local code="$1"; shift; log "错误：$*"; exit "$code"; }

# 互斥锁：O_EXCL 建文件，内含持有者 JSON；同机持有进程已死则视为陈旧接管。
# 成功返回 0 并装 EXIT trap 释放；被占返回 1。
FT_LOCK_HELD=0
lock_acquire() {
    local task="${1:-fulltext}" host pid
    host="$(hostname)"
    mkdir -p "$(dirname "$FT_LOCK")"
    local attempt
    for attempt in 1 2; do
        if ( set -o noclobber; printf '{"pid":%s,"host":"%s","startedAt":"%s","task":"%s"}' \
                "$$" "$host" "$(date -u +%FT%TZ)" "$task" > "$FT_LOCK" ) 2>/dev/null; then
            FT_LOCK_HELD=1
            trap lock_release EXIT
            # 双保险：机上若还是不拿锁的旧版 Meili 脚本，也认进程名避开（GUJI-615）。
            # 只认以 node 开头的命令行，免得 grep／ssh 命令里恰好带这个文件名也被当成重建
            if [ -z "${FT_SKIP_PROC_CHECK:-}" ] && pgrep -f '^([^ ]*/)?node[^ ]* .*(full-reindex|indexer/ingest)\.mjs' >/dev/null 2>&1; then
                log "锁拿到了，但 Meili 重建／ingest 进程在跑（旧版脚本不拿锁），按锁忙处理"
                lock_release
                return 1
            fi
            return 0
        fi
        local raw; raw="$(cat "$FT_LOCK" 2>/dev/null || true)"
        pid="$(printf '%s' "$raw" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')"
        local lhost; lhost="$(printf '%s' "$raw" | sed -n 's/.*"host":"\([^"]*\)".*/\1/p')"
        local stale=0
        if [ -n "$pid" ] && [ "$lhost" = "$host" ] && ! kill -0 "$pid" 2>/dev/null; then stale=1
        elif [ -z "$pid" ]; then
            # 建了文件没写完就崩：空／损坏的锁超过 60 秒视为陈旧
            local age=$(( $(date +%s) - $(stat -c %Y "$FT_LOCK" 2>/dev/null || echo 0) ))
            [ "$age" -gt 60 ] && stale=1
        fi
        if [ "$stale" = 1 ] && [ "$(cat "$FT_LOCK" 2>/dev/null || true)" = "$raw" ]; then
            rm -f "$FT_LOCK"; continue
        fi
        log "锁被占：$raw"
        return 1
    done
    return 1
}
lock_release() { [ "$FT_LOCK_HELD" = 1 ] && rm -f "$FT_LOCK"; FT_LOCK_HELD=0; }

# 当前生效 release 的 stamp（目录名）；没有则空
current_stamp() { [ -L "$FT_ROOT/current" ] && basename "$(readlink -f "$FT_ROOT/current")" || true; }

# 切符号链接（原子）：link_swap <name> <target>
link_swap() { ln -sfn "$2" "$FT_ROOT/.$1.new" && mv -T "$FT_ROOT/.$1.new" "$FT_ROOT/$1"; }

# 通知服务重载：优先 reload，失败 restart
service_reload() {
    "$FT_SYSTEMCTL" reload "$FT_UNIT" 2>/dev/null || "$FT_SYSTEMCTL" restart "$FT_UNIT"
}

# 健康检查：/healthz 返回 200，最多等 N 秒
wait_healthy() {
    local port="$1" secs="${2:-30}" i
    for ((i = 0; i < secs; i++)); do
        [ "$("$FT_CURL" -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz" 2>/dev/null)" = 200 ] && return 0
        sleep 1
    done
    return 1
}
