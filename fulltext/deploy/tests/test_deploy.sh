#!/bin/bash
# rotate.sh / rollback.sh 单测（假目录＋假服务，不碰真机）。运行：bash test_deploy.sh
set -u
T="$(cd "$(dirname "$0")" && pwd)"; D="$(dirname "$T")"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
eq()   { [ "$2" = "$3" ] && ok "$1" || bad "$1（期望 $3，实际 $2）"; }

export FT_PORT=18766 FT_SELFCHECK_PORT=18765 FT_HEALTH_WAIT=5
setup() {
    W="$(mktemp -d)"; export FT_ROOT="$W/ft" INDEXER_LOCK="$W/lock/.lock" FT_SYSTEMCTL="$T/fake-systemctl.sh"
    export FT_SYSTEMCTL_LOG="$W/systemctl.log" FT_START_CMD="$T/run-fake.sh" FT_AVAIL_KB=99999999
    mkdir -p "$FT_ROOT/releases" "$W/lock"; unset FT_TEXT_DIR
    python3 "$T/mkpack.py" "$FT_ROOT/releases/20261001-0000" 20261001-0000 1000
    ln -sfn releases/20261001-0000 "$FT_ROOT/current"
    "$T/run-fake.sh" >/dev/null 2>&1 & SVC=$!    # 主端口服务（跟 current 走）
    sleep 0.5
}
teardown() { kill "$SVC" 2>/dev/null; wait "$SVC" 2>/dev/null; rm -rf "$W"; }
run() { bash "$D/$1" "${@:2}" >"$W/out" 2>&1; echo $?; }
cur() { basename "$(readlink -f "$FT_ROOT/current")"; }

echo "成功切换"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20261002-0000" 20261002-0000 2000
eq "退出码 0" "$(run rotate.sh 20261002-0000)" 0
eq "current 指向新版" "$(cur)" 20261002-0000
eq "previous 指向旧版" "$(basename "$(readlink -f "$FT_ROOT/previous")")" 20261001-0000
grep -q "reload" "$FT_SYSTEMCTL_LOG" && ok "调用了 reload" || bad "没调用 reload"
[ -e "$INDEXER_LOCK" ] && bad "锁未释放" || ok "锁已释放"
teardown

echo "锁忙 → 退出 6，current 不动"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20261002-0000" 20261002-0000 2000
printf '{"pid":%s,"host":"%s","startedAt":"x","task":"ingest"}' "$$" "$(hostname)" > "$INDEXER_LOCK"
eq "退出码 6" "$(run rotate.sh 20261002-0000)" 6
eq "current 未动" "$(cur)" 20261001-0000
rm -f "$INDEXER_LOCK"
echo "陈旧锁（持有进程已死）→ 接管"
printf '{"pid":999999,"host":"%s","startedAt":"x","task":"old"}' "$(hostname)" > "$INDEXER_LOCK"
eq "退出码 0" "$(run rotate.sh 20261002-0000)" 0
teardown

echo "没拿锁的旧版 Meili 重建进程在跑 → 退出 6，锁文件不留"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20261002-0000" 20261002-0000 2000
( exec -a "node /opt/indexer/full-reindex.mjs" sleep 30 ) & FAKE=$!
sleep 0.3
eq "退出码 6" "$(run rotate.sh 20261002-0000)" 6
eq "current 未动" "$(cur)" 20261001-0000
[ -e "$INDEXER_LOCK" ] && bad "锁未释放" || ok "锁已释放"
kill $FAKE 2>/dev/null; wait $FAKE 2>/dev/null
eq "进程走后退出码 0" "$(run rotate.sh 20261002-0000)" 0
teardown

echo "manifest 过期（createdAtEpoch 早于当前）→ 8"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20260901-0000" 20260901-0000 500
eq "退出码 8" "$(run rotate.sh 20260901-0000)" 8
eq "current 未动" "$(cur)" 20261001-0000
teardown

echo "manifest 缺 bookTextCommit → 8"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20261002-0000" 20261002-0000 2000 --no-commit
eq "退出码 8" "$(run rotate.sh 20261002-0000)" 8
teardown

echo "旧版 v1 包（schemaVersion≠2）→ 8"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20261002-0000" 20261002-0000 2000 --v1
eq "退出码 8" "$(run rotate.sh 20261002-0000)" 8
eq "current 未动" "$(cur)" 20261001-0000
teardown

echo "文件 sha256 不符 → 8"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20261002-0000" 20261002-0000 2000 --bad-sha
eq "退出码 8" "$(run rotate.sh 20261002-0000)" 8
teardown

echo "新版自检失败（索引无命中）→ 10，current 不动"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20261002-0000" 20261002-0000 2000 --bad-index
eq "退出码 10" "$(run rotate.sh 20261002-0000)" 10
eq "current 未动" "$(cur)" 20261001-0000
teardown

echo "切换后不健康 → 自动切回，退出 11"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20261002-0000" 20261002-0000 2000 --flaky
eq "退出码 11" "$(run rotate.sh 20261002-0000)" 11
eq "current 已切回旧版" "$(cur)" 20261001-0000
teardown

echo "磁盘不足 → 9（tar 模式，解压前拦下）"
setup
python3 "$T/mkpack.py" "$W/src" 20261003-0000 3000
tar -czf "$W/p.tgz" -C "$W/src" .
eq "退出码 9" "$(FT_AVAIL_KB=1000 run rotate.sh --tar "$W/p.tgz" --manifest "$W/src/manifest.json")" 9
[ -d "$FT_ROOT/releases/20261003-0000" ] && bad "不该解压" || ok "未解压"
eq "current 未动" "$(cur)" 20261001-0000
teardown

echo "tar 模式成功（流式解压）"
setup
python3 "$T/mkpack.py" "$W/src" 20261003-0000 3000
tar -czf "$W/p.tgz" -C "$W/src" .
eq "退出码 0" "$(run rotate.sh --tar "$W/p.tgz" --manifest "$W/src/manifest.json")" 0
eq "current 指向新版" "$(cur)" 20261003-0000
teardown

echo "--latest 模式：读指针取包（file:// 模拟 COS）"
setup
mkdir -p "$W/cos/fulltext/20261003-0000"
python3 "$T/mkpack.py" "$W/src" 20261003-0000 3000
tar -czf "$W/cos/fulltext/20261003-0000/fulltext-20261003-0000.tar.gz" -C "$W/src" .
cp "$W/src/manifest.json" "$W/cos/fulltext/20261003-0000/manifest.json"
printf '{"stamp":"20261003-0000","pack":"fulltext/20261003-0000/fulltext-20261003-0000.tar.gz","manifest":"fulltext/20261003-0000/manifest.json"}' > "$W/cos/fulltext/latest.json"
eq "退出码 0" "$(run rotate.sh --latest "file://$W/cos/fulltext/latest.json")" 0
eq "current 指向新版" "$(cur)" 20261003-0000
eq "再跑一次：已是最新，退出 0" "$(run rotate.sh --latest "file://$W/cos/fulltext/latest.json")" 0
grep -q "已是最新" "$W/out" && ok "提示已是最新" || bad "没提示已是最新"
printf '{"stamp":"20261004-0000","pack":"../etc/passwd","manifest":"fulltext/x"}' > "$W/cos/fulltext/latest.json"
eq "坏指针 → 8" "$(run rotate.sh --latest "file://$W/cos/fulltext/latest.json")" 8
teardown

echo "只留 current+previous：第三版上线后最老的被删"
setup
for s in 2 3; do
    python3 "$T/mkpack.py" "$FT_ROOT/releases/2026100$s-0000" "2026100$s-0000" "${s}000"
    run rotate.sh "2026100$s-0000" >/dev/null
done
[ -d "$FT_ROOT/releases/20261001-0000" ] && bad "最老版本没删" || ok "最老版本已删"
eq "current" "$(cur)" 20261003-0000
teardown

echo "rollback.sh"
setup
python3 "$T/mkpack.py" "$FT_ROOT/releases/20261002-0000" 20261002-0000 2000
run rotate.sh 20261002-0000 >/dev/null
eq "退出码 0" "$(run rollback.sh)" 0
eq "current 回到旧版" "$(cur)" 20261001-0000
eq "previous 变成新版" "$(basename "$(readlink -f "$FT_ROOT/previous")")" 20261002-0000
teardown
setup
eq "没有 previous → 12" "$(run rollback.sh)" 12
teardown

echo; echo "通过 $PASS，失败 $FAIL"
[ "$FAIL" = 0 ]
