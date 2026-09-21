#!/usr/bin/env bash
# COS 迁移：新桶完整性验证
#
# 用法：
#   NEW_HOST=book-index-data-<APPID>.cos.<region>.myqcloud.com \
#   OLD_HOST=book-index-data-1394543882.cos.ap-singapore.myqcloud.com \
#   bash ops/migrate-cos-verify.sh
#
# 直连两个桶的 COS 原生域名逐项比对，绕过 EdgeOne 缓存，避免被陈旧副本误导。
# （既有教训：核验线上必须用随机 cache-buster，别用 ?v=<commit>）
set -uo pipefail

NEW_HOST="${NEW_HOST:-}"
OLD_HOST="${OLD_HOST:-book-index-data-1394543882.cos.ap-singapore.myqcloud.com}"

if [ -z "$NEW_HOST" ]; then
  echo "✗ 必须设置 NEW_HOST（新桶的 COS 原生域名）" >&2
  exit 1
fi

fail=0
cb() { echo "cb=$RANDOM$RANDOM"; }

# fetch <host> <path> <outfile> -> 打印 http_code
# 注意：不要写成 `curl ... || echo 000`——curl 超时时 -w 已经输出了 000，
# 再叠加一个 echo 会得到 "000000" 这种伪造码，看起来像桶坏了，其实是脚本 bug。
# 重试 2 次：COS 对短时间内的密集请求会限速，单次超时不代表对象缺失。
get() {
  local code
  for _ in 1 2; do
    code=$(curl -s -o "$3" -w '%{http_code}' --max-time 30 "https://$1/$2?$(cb)" 2>/dev/null)
    case "$code" in 2*|3*|4*) echo "$code"; return 0 ;; esac
    sleep 1
  done
  echo "${code:-000}"
}

echo "旧桶: $OLD_HOST"
echo "新桶: $NEW_HOST"
echo

# ── 1. latest.json 必须存在且内容一致 ──
echo "## 1. latest.json"
t_old=$(mktemp); t_new=$(mktemp)
c_old=$(get "$OLD_HOST" "latest.json" "$t_old")
c_new=$(get "$NEW_HOST" "latest.json" "$t_new")
echo "   旧 $c_old / 新 $c_new"
if [ "$c_new" != "200" ]; then
  echo "   ✗ 新桶取不到 latest.json"; fail=$((fail+1))
elif diff -q "$t_old" "$t_new" >/dev/null 2>&1; then
  echo "   ✓ 内容一致"
else
  echo "   ⚠ 内容不一致（若旧桶已有新数据推入属正常，人工确认）"
  echo "     旧: $(head -c 200 "$t_old")"
  echo "     新: $(head -c 200 "$t_new")"
fi

# 注意：路径必须走 argv 传入，不能用 shell 插值拼进 python 源码——
# Git Bash 的 /tmp/xxx 路径在 Windows Python 下按字面量解析会失败。
COMMIT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('commitId',''))" "$t_new" 2>/dev/null || echo '')
echo "   新桶 commitId: ${COMMIT:-<解析失败>}"
rm -f "$t_old" "$t_new"
echo

# ── 2. 抽样 entry 比对 ──
# ID 取自 book-index 生产仓；如仓不在本机，用内置样本
echo "## 2. current/entry 抽样比对"
IDS=$(find /d/workspace/book-index/Work -name '*.json' 2>/dev/null \
      | shuf -n 20 2>/dev/null \
      | sed 's#.*/##; s/-.*//' | grep -E '^[a-z0-9]+$' | head -20)
[ -z "$IDS" ] && IDS="d59eza2ec000 d59f207tw000 d59f24lus000 d59f27xyc000 d59f2849w000"

n=0; ok=0; miss=0; diffn=0
for id in $IDS; do
  n=$((n+1))
  a=$(mktemp); b=$(mktemp)
  ca=$(get "$OLD_HOST" "current/entry/$id.json" "$a")
  cb_=$(get "$NEW_HOST" "current/entry/$id.json" "$b")
  if [ "$cb_" != "200" ]; then
    echo "   ✗ $id 新桶 $cb_（旧桶 $ca）"; miss=$((miss+1))
  elif diff -q "$a" "$b" >/dev/null 2>&1; then
    ok=$((ok+1))
  else
    echo "   ⚠ $id 内容不一致"; diffn=$((diffn+1))
  fi
  rm -f "$a" "$b"
  sleep 0.3
done
echo "   共 $n 个：一致 $ok / 缺失 $miss / 不一致 $diffn"
[ "$miss" -gt 0 ] && fail=$((fail+1))
echo

# ── 3. 搜索分片齐全（8 个 core-*） ──
echo "## 3. 搜索分片 v/$COMMIT/search/"
if [ -n "$COMMIT" ]; then
  sn=0
  for f in meta.json core-book.json core-collection.json core-entity.json \
           core-work-0.json core-work-1.json core-work-2.json core-work-3.json; do
    c=$(get "$NEW_HOST" "v/$COMMIT/search/$f" /dev/null)
    if [ "$c" = "200" ]; then sn=$((sn+1)); else echo "   ✗ $f -> $c"; fi
    sleep 0.3
  done
  echo "   $sn/8 就绪"
  [ "$sn" -lt 8 ] && fail=$((fail+1))
else
  echo "   ⊘ 跳过（commitId 未解析出）"
fi
echo

# ── 4. 权限配置必须与旧桶一致：公开读 + 禁列举 ──
echo "## 4. 权限（应为 公开读 + 禁列举）"
r_obj=$(get "$NEW_HOST" "latest.json" /dev/null)
r_lst=$(get "$NEW_HOST" "" /dev/null)
echo "   对象读取 -> $r_obj （期望 200）"
echo "   桶根列举 -> $r_lst （期望 403）"
[ "$r_obj" != "200" ] && { echo "   ✗ 对象不可公开读，EdgeOne 域名源站会回源失败"; fail=$((fail+1)); }
[ "$r_lst" = "200" ]  && { echo "   ✗ 可枚举全部文件，应关闭列举权限"; fail=$((fail+1)); }
echo

echo "────────────────────────"
if [ "$fail" -eq 0 ]; then
  echo "✓ 全部通过，可以切 EdgeOne 源站"
else
  echo "✗ $fail 项未通过，先修复再切换"
fi
exit "$fail"
