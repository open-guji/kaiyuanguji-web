#!/bin/bash
# 轮换索引包：校验 → 磁盘闸 → 自检 → 原子切换 → 健康检查（失败自动切回 previous）。
#
# 用法：
#   rotate.sh <stamp>                          release 已在 $FT_ROOT/releases/<stamp>（rsync 到位）
#   rotate.sh --tar <包文件或URL> --manifest <manifest.json>
#                                              流式解压（不落盘 gz，峰值少一个包的大小）；
#                                              磁盘闸用 manifest 的 indexBytes，所以要先给 manifest
# 选项：--no-verify-files  跳过逐文件 sha256（7.7 GB 约读一遍盘；默认核）
#
# 退出码：0 成功；2 参数错；6 锁忙（与 Meili 重建／ingest 同锁）；8 manifest 不合格；9 磁盘不足；
#        10 新版自检失败（current 未动）；11 切换后健康检查失败，已自动切回 previous；12 回滚也失败（要人工）
#
# 环境变量（单测或特殊机器用）：FT_ROOT、INDEXER_LOCK、FT_SYSTEMCTL、FT_CURL、FT_UNIT、FT_PORT、
#   FT_SELFCHECK_PORT(默认 18765)、FT_START_CMD(自检用的临时实例命令；缺省用 $FT_ROOT/bin/run-service.sh)、
#   FT_MARGIN_GB(默认 5)、FT_AVAIL_KB(覆盖 df，测试用)、FT_TEXT_DIR(校验 bookTextCommit 用)、
#   FT_SELFCHECK_Q(默认 太極)、FT_HEALTH_WAIT(默认 30 秒)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"

STAMP="" TAR="" MANIFEST_SRC="" VERIFY=1
while [ $# -gt 0 ]; do
    case "$1" in
        --tar) TAR="${2:-}"; shift 2 ;;
        --manifest) MANIFEST_SRC="${2:-}"; shift 2 ;;
        --no-verify-files) VERIFY=0; shift ;;
        -*) die $EXIT_ARGS "未知选项 $1" ;;
        *) STAMP="$1"; shift ;;
    esac
done
if [ -n "$TAR" ]; then
    [ -n "$MANIFEST_SRC" ] || die $EXIT_ARGS "--tar 必须同时给 --manifest"
else
    [ -n "$STAMP" ] || die $EXIT_ARGS "用法：rotate.sh <stamp> | --tar <包> --manifest <manifest.json>"
fi
MARGIN_GB="${FT_MARGIN_GB:-5}"
SELF_PORT="${FT_SELFCHECK_PORT:-18765}"
REL="$FT_ROOT/releases"
mkdir -p "$REL"

lock_acquire fulltext-rotate || exit $EXIT_LOCK_BUSY

avail_kb() { [ -n "${FT_AVAIL_KB:-}" ] && echo "$FT_AVAIL_KB" || df -Pk "$FT_ROOT" | awk 'NR==2{print $4}'; }

# 磁盘闸：可用 ≥ 新版解压大小 + 余量（流式解压，不需要再算 gz）
disk_gate() {
    local need_bytes="$1"
    local need_kb=$(( need_bytes / 1024 + MARGIN_GB * 1024 * 1024 ))
    local have_kb; have_kb="$(avail_kb)"
    if [ "$have_kb" -lt "$need_kb" ]; then
        log "磁盘不足：可用 $((have_kb / 1024 / 1024)) GB，需要 ≥ $((need_kb / 1024 / 1024)) GB（解压 $((need_bytes / 1024 / 1024 / 1024)) GB + 余量 ${MARGIN_GB} GB）"
        return 1
    fi
}

# 删比 previous 更老的 release（保留 current、previous 和即将用的 $1）
prune_old() {
    local keep="$1" cur prev d
    cur="$(current_stamp)"; prev=""
    [ -L "$FT_ROOT/previous" ] && prev="$(basename "$(readlink -f "$FT_ROOT/previous")")"
    for d in "$REL"/*/ "$REL"/.*.partial/; do
        [ -d "$d" ] || continue
        d="$(basename "$d")"
        case "$d" in "$cur"|"$prev"|"$keep") continue ;; esac
        log "清理旧版 $d"
        rm -rf "${REL:?}/$d"
    done
}

CUR_MANIFEST=""
[ -f "$FT_ROOT/current/manifest.json" ] && CUR_MANIFEST="$FT_ROOT/current/manifest.json"

# ---- 取得 release 目录 ----
if [ -n "$TAR" ]; then
    NEWM="$MANIFEST_SRC"
    STAMP="$(python3 "$HERE/manifest_check.py" field "$NEWM" stamp)"
    [ -n "$STAMP" ] || die $EXIT_MANIFEST_BAD "manifest 读不出 stamp"
    ARGS=(validate "$NEWM"); [ -n "$CUR_MANIFEST" ] && ARGS+=(--current "$CUR_MANIFEST"); [ -n "${FT_TEXT_DIR:-}" ] && ARGS+=(--text-dir "$FT_TEXT_DIR")
    out="$(python3 "$HERE/manifest_check.py" "${ARGS[@]}")" || { log "manifest 不合格："; echo "$out" >&2; exit $EXIT_MANIFEST_BAD; }
    [ -d "$REL/$STAMP" ] && die $EXIT_ARGS "release $STAMP 已存在，请换 stamp 或先删"
    prune_old "$STAMP"
    disk_gate "$(python3 "$HERE/manifest_check.py" field "$NEWM" indexBytes)" || exit $EXIT_DISK
    PART="$REL/.$STAMP.partial"; rm -rf "$PART"; mkdir -p "$PART"
    log "流式解压 → $PART"
    case "$TAR" in
        http://*|https://*) "$FT_CURL" -fsS "$TAR" | tar -xz -C "$PART" ;;
        *) tar -xzf "$TAR" -C "$PART" ;;
    esac
    # 包内文件可能带顶层目录 fulltext-<stamp>/，拍平
    if [ ! -f "$PART/manifest.json" ]; then
        sub="$(find "$PART" -maxdepth 2 -name manifest.json -print -quit)"
        [ -n "$sub" ] && { mv "$(dirname "$sub")" "$REL/$STAMP"; rm -rf "$PART"; } || { rm -rf "$PART"; die $EXIT_MANIFEST_BAD "包里没有 manifest.json"; }
    else
        mv "$PART" "$REL/$STAMP"
    fi
else
    [ -d "$REL/$STAMP" ] || die $EXIT_ARGS "找不到 $REL/$STAMP"
    prune_old "$STAMP"
fi
DIR="$REL/$STAMP"

# ---- 校验 manifest 与文件（两种模式都做；tar 模式再核一次包内的那份）----
ARGS=(validate "$DIR/manifest.json"); [ -n "$CUR_MANIFEST" ] && [ "$(readlink -f "$FT_ROOT/current")" != "$(readlink -f "$DIR")" ] && ARGS+=(--current "$CUR_MANIFEST"); [ -n "${FT_TEXT_DIR:-}" ] && ARGS+=(--text-dir "$FT_TEXT_DIR")
out="$(python3 "$HERE/manifest_check.py" "${ARGS[@]}")" || { log "manifest 不合格："; echo "$out" >&2; exit $EXIT_MANIFEST_BAD; }
[ "$(python3 "$HERE/manifest_check.py" field "$DIR/manifest.json" stamp)" = "$STAMP" ] || die $EXIT_MANIFEST_BAD "manifest.stamp 与目录名 $STAMP 不一致"
if [ "$VERIFY" = 1 ]; then
    out="$(python3 "$HERE/manifest_check.py" verify-files "$DIR/manifest.json" "$DIR")" || { log "文件校验失败："; echo "$out" >&2; exit $EXIT_MANIFEST_BAD; }
    log "逐文件 sha256 通过"
fi

# ---- 新版自检：临时实例（另一端口、不动 current）----
START="${FT_START_CMD:-$FT_ROOT/bin/run-service.sh}"
SELF_LOG="$(mktemp)"
FT_PORT="$SELF_PORT" FT_INDEX_DIR="$DIR/index" FT_RELEASE_DIR="$DIR" $START >"$SELF_LOG" 2>&1 &
SELF_PID=$!
selfcheck_ok=0
if wait_healthy "$SELF_PORT" "${FT_HEALTH_WAIT:-30}"; then
    resp="$("$FT_CURL" -s --get --data-urlencode "q=${FT_SELFCHECK_Q:-太極}" "http://127.0.0.1:$SELF_PORT/api/fulltext" 2>/dev/null)"
    python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("total_hits",0)>0 else 1)' "$resp" 2>/dev/null && selfcheck_ok=1
fi
kill "$SELF_PID" 2>/dev/null; wait "$SELF_PID" 2>/dev/null
if [ "$selfcheck_ok" != 1 ]; then
    log "新版自检失败（临时实例 /healthz 或样本查询无命中），current 未动。服务日志尾部："
    tail -n 20 "$SELF_LOG" >&2; rm -f "$SELF_LOG"
    exit $EXIT_SELFCHECK
fi
rm -f "$SELF_LOG"
log "新版自检通过"

# ---- 原子切换 ----
OLD_TARGET="$(readlink "$FT_ROOT/current" 2>/dev/null || true)"
[ "$OLD_TARGET" = "releases/$STAMP" ] && { log "current 已是 $STAMP，无需切换"; exit 0; }
[ -n "$OLD_TARGET" ] && link_swap previous "$OLD_TARGET"
link_swap current "releases/$STAMP"
service_reload
if wait_healthy "$FT_PORT" "${FT_HEALTH_WAIT:-30}"; then
    log "轮换完成：current=$STAMP previous=${OLD_TARGET:-<无>}"
    prune_old "$STAMP"
    exit 0
fi

# ---- 健康检查失败：自动切回 ----
log "切换后 /healthz 不通，自动切回 ${OLD_TARGET:-<无 previous>}"
if [ -z "$OLD_TARGET" ]; then
    die $EXIT_ROLLBACK_FAILED "首次部署失败且无 previous 可回，请人工处理（current=$STAMP）"
fi
link_swap current "$OLD_TARGET"
service_reload
if wait_healthy "$FT_PORT" "${FT_HEALTH_WAIT:-30}"; then
    exit $EXIT_HEALTH_ROLLED_BACK
fi
die $EXIT_ROLLBACK_FAILED "自动回滚后仍不健康，请人工处理（current=$OLD_TARGET）"
