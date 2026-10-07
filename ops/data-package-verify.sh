#!/usr/bin/env bash
# 打好的数据包的基础闸（overview#470 P1）：原先写在 deploy.yml 的 build 任务里的三步
# （Verify bundled data／Verify production entries bundled／Verify no private text），抽成脚本给数据流程（data.yml）用。
# deploy.yml 里的那三步在代码流程去掉数据（SPLIT_DATA_FLOW 切换）之前保持原样，到时再删。
#
# 用法：KYG_DATA_ROOT=<数据根> bash ops/data-package-verify.sh [book-index 检出目录，默认 book-index]
# 任何一项不过就非零退出。
set -euo pipefail

: "${KYG_DATA_ROOT:?需要 KYG_DATA_ROOT（数据包根目录）}"
BOOK_INDEX_DIR="${1:-book-index}"
WORKSPACE="$(pwd)"

# S2：public/ 下不应再有任何数据产物
for f in data data-h1 data-h1-text latest.json; do
  if [ -e "nextjs/public/$f" ]; then
    echo "❌ nextjs/public/$f 不应存在（数据产物应在 KYG_DATA_ROOT=$KYG_DATA_ROOT）"; exit 1
  fi
done

cd "$KYG_DATA_ROOT/data"
# 历史遗留产物（Phase 1 之前的 index.json / search_s.json，Phase 2 的 chunks/）若仍存在说明 bundle-data.mjs 没走干净
for f in index.json search_s.json; do
  if [ -f "$f" ]; then echo "❌ Stale $f should not be present"; exit 1; fi
done
if [ -d chunks ]; then echo "❌ Stale chunks/ should not be present (Phase 3 改 entry/)"; exit 1; fi
for f in meta.json resource.json resource-catalog.json resource-collection.json resource-site.json recommended.json version.json; do
  if [ ! -f "$f" ]; then echo "❌ Missing $f"; exit 1; fi
  echo "✓ $f ($(wc -c < "$f") bytes)"
done
# 14.7 万文件时 ls entry/*.json 参数展开过长，改用 find 并设下限
N_ENTRY=$(find entry -maxdepth 1 -name '*.json' | wc -l)
echo "✓ $N_ENTRY entry files"
if [ "$N_ENTRY" -lt 100000 ]; then
  echo "❌ entry 文件只有 $N_ENTRY 个（应在 14 万以上），打包可能不完整"; exit 1
fi
ls search/core-*.json | wc -l | xargs -I{} echo "✓ {} search shards"
# latest.json 由 bundle-data.mjs 输出到 data/ 同级
[ -f ../latest.json ] && echo "✓ latest.json ($(wc -c < ../latest.json) bytes)" || { echo "❌ Missing \$KYG_DATA_ROOT/latest.json"; exit 1; }

# 守卫：production（已升格）条目必须进入产物。bundle-data.mjs 在 production 仓缺失时是**静默**跳过的，
# 只靠上面的文件存在性检查发现不了 —— 这里逐个比对正式库索引里的 ID。
cd "$WORKSPACE"
BOOK_INDEX_DIR="$BOOK_INDEX_DIR" node -e "
const fs = require('fs');
const prodIndex = JSON.parse(fs.readFileSync(process.env.BOOK_INDEX_DIR + '/index/collections.json', 'utf-8'));
const ids = Object.keys(prodIndex);
if (ids.length === 0) {
  console.log('· production 索引为空，跳过校验');
  process.exit(0);
}
const missing = ids.filter(
  id => !fs.existsSync(process.env.KYG_DATA_ROOT + '/data/entry/' + id + '.json'));
if (missing.length) {
  console.error('❌ ' + missing.length + '/' + ids.length +
    ' 个正式条目未进入产物（BOOK_INDEX_PRODUCTION_DIR 没生效？）');
  console.error('   缺失示例: ' + missing.slice(0, 5).join(', '));
  process.exit(1);
}
console.log('✓ ' + ids.length + ' 个正式丛编条目均已打包');
"

# 私有文本设计上从不进 bundle-data.mjs；这一步是事后防线，防「以后有人手滑把私有目录接进去」
cd "$KYG_DATA_ROOT/data"
if grep -rl "book-text-private\|仅内部校对使用\|不得公开" . ; then
  echo "❌ 公开产物里出现了私有文本相关内容，上一条命令列出的文件即命中位置"; exit 1
fi
echo "✓ public/data 全量 grep 私有文本标记（book-text-private／仅内部校对使用／不得公开）：0 命中"
