#!/usr/bin/env bash
# 正式站全栈产物（nextjs/.edgeone）的上线前检查（overview#341 从 deploy.yml 的三步里抽出来）。
# 现在有三处要查同一份东西：build 的正式站构建、prod-artifact 任务构建的正式站产物、promote 时解包出来的产物，
# 判据放一处，免得三份漂移。判据本身与原来 deploy.yml 里的一样：
#   ① 构建模式：客户端 chunk 里带着数据源模式（cos／bundle）
#   ② 正式站口径：无 noindex、无角标、robots 允许收录、不读测试站数据、条目页与失效接口在云函数、带 edge-functions 与 sitemap
#   ③ 文件数闸：≤ 5000（2026-09-27 h1 数据混进产物、Pages 静默不发布的教训）
#
# 用法：ops/check-edgeone-artifact.sh <nextjs 目录> <cos|bundle> [static|proxy]
#   第三个参数（默认 static）：条目 sitemap 的方式。static＝产物里带 sitemap-index.xml（现行）；
#   proxy＝数据流程已拆出（overview#470 P1），sitemap 走路由代理，产物里不该有静态文件、云函数路由里要有 /sitemap-proxy
set -euo pipefail

N_DIR="${1:?用法：check-edgeone-artifact.sh <nextjs 目录> <cos|bundle>}"
MODE="${2:?用法：check-edgeone-artifact.sh <nextjs 目录> <cos|bundle> [static|proxy]}"
SITEMAP="${3:-static}"
case "$SITEMAP" in static|proxy) ;; *) echo "❌ 第三个参数只能是 static 或 proxy：$SITEMAP"; exit 1 ;; esac
E="$N_DIR/.edgeone"
A="$E/assets"
CF="$E/cloud-functions/ssr-node/config.json"

if grep -r "\"$MODE\"" "$A/_next/static/chunks/" > /dev/null 2>&1; then
  echo "✓ EdgeOne build confirmed using $MODE mode"
else
  echo "❌ EdgeOne build not using $MODE mode!"; exit 1
fi

! grep -q 'noindex' "$A/index.html" || { echo "❌ 正式站产物含 noindex meta，混入了测试站构建"; exit 1; }
! grep -q 'staging-badge' "$A/index.html" || { echo "❌ 正式站产物含测试站角标"; exit 1; }
grep -qx 'Allow: /' "$A/robots.txt" || { echo "❌ robots.txt 不是正式站口径："; cat "$A/robots.txt"; exit 1; }
! grep -rq 'data.kaiyuanguji.com/staging' "$A/_next/static/chunks/" || { echo "❌ 正式站产物读的是测试站数据"; exit 1; }
grep -q '"\^/item/' "$CF" || { echo "❌ 云函数路由里没有 /item/[id]"; exit 1; }
grep -q '"\^/internal/revalidate' "$CF" || { echo "❌ 云函数路由里没有 /internal/revalidate"; exit 1; }
test -f "$E/edge-functions/config.json" || { echo "❌ 全栈产物里没有 edge-functions"; exit 1; }
if [ "$SITEMAP" = proxy ]; then
  test ! -e "$A/sitemap-index.xml" || { echo "❌ sitemap 走路由代理，产物里不该有静态 sitemap-index.xml"; exit 1; }
  grep -Eq '"\^/sitemap(\\\\)?-proxy/' "$CF" || { echo "❌ 云函数路由里没有 /sitemap-proxy"; exit 1; }
else
  test -f "$A/sitemap-index.xml" || { echo "❌ 产物里没有 sitemap-index.xml"; exit 1; }
  grep -q '<loc>https://www.openguji.com/' "$A/sitemap-index.xml" || { echo "❌ sitemap 索引里的地址不是 www"; exit 1; }
fi
echo "✓ 正式站产物：无 noindex、无角标、robots 允许收录、读正式数据、条目页与失效接口在云函数、带 edge-functions 与 sitemap"

N=$(find "$E" -type f | wc -l)
echo "EdgeOne (fullstack) bundle file count: $N"
if [ "$N" -gt 5000 ]; then
  echo "❌ 产物 $N 个文件（上限 5000）——数据目录混进来了？按目录统计："
  find "$E" -type f | awk -F/ '{print $(NF-2)"/"$(NF-1)}' | sort | uniq -c | sort -rn | head -10
  exit 1
fi
