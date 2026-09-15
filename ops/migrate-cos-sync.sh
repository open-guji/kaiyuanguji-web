#!/usr/bin/env bash
# COS 迁移：向新桶全量同步
#
# 用法（先干跑看清单，确认无误再实跑）：
#   export COS_SECRET_ID=xxx COS_SECRET_KEY=xxx
#   export COS_BUCKET=book-index-data-<APPID> COS_REGION=ap-shanghai
#   bash ops/migrate-cos-sync.sh --dry     # 干跑
#   bash ops/migrate-cos-sync.sh           # 实跑
set -euo pipefail

cd "$(dirname "$0")/.."

: "${COS_SECRET_ID:?必须设置 COS_SECRET_ID}"
: "${COS_SECRET_KEY:?必须设置 COS_SECRET_KEY}"
: "${COS_BUCKET:?必须设置 COS_BUCKET（新桶名）}"
: "${COS_REGION:?必须设置 COS_REGION（如 ap-shanghai）}"

DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

echo "桶:   $COS_BUCKET"
echo "区域: $COS_REGION"
echo "模式: $([ $DRY -eq 1 ] && echo 'DRY RUN（只打印不上传）' || echo 'UPLOAD（真实上传）')"
echo

# 数据源必须就绪。CI 里由 bundle-data.mjs 产出；本地跑需先自行准备。
if [ ! -d nextjs/public/data ]; then
  echo "✗ nextjs/public/data 不存在，需先跑数据打包（bundle-data.mjs）" >&2
  exit 1
fi

# ⚠️ 关键：.sync-state.json 缓存的是「上次同步的远端状态」。
# 换桶后这份缓存对应旧桶，不重建会让脚本误判「文件已存在」而【静默漏传】。
# 首次同步到新桶必须 SYNC_REBUILD_STATE=1，强制重新 list 远端。
STATE=nextjs/.next/.sync-state.json
if [ -f "$STATE" ]; then
  echo "· 发现旧 sync-state，备份并强制重建（换桶必须，否则会漏传）"
  cp "$STATE" "$STATE.bak-$(date +%Y%m%d%H%M%S)"
fi

cd nextjs
export SYNC_REBUILD_STATE=1
[ $DRY -eq 1 ] && export DRY_RUN=1

node scripts/sync-to-cos.mjs

echo
if [ $DRY -eq 1 ]; then
  echo "✓ 干跑完成。确认清单无误后去掉 --dry 实跑。"
else
  echo "✓ 同步完成。下一步：跑 ops/migrate-cos-verify.sh 验证完整性。"
  echo "  NEW_HOST=${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com bash ops/migrate-cos-verify.sh"
fi
