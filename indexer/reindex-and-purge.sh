#!/bin/bash
# reindex + purge: 重建 Meili 索引，成功后立刻清 EdgeOne 缓存。
#
# 用 set -e + 单独的 wrapper：reindex 失败时不 purge，避免空索引被推到边缘。
#
# 部署：放在 /opt/indexer/ 下，跟 full-reindex.mjs / purge-edgeone.mjs 同级。
# 用法：
#   ./reindex-and-purge.sh           # 手动跑
#   或 cron: 0 4 * * * /opt/indexer/reindex-and-purge.sh >> /var/log/indexer.log 2>&1

set -e
cd "$(dirname "$0")"

# 1) Meili 凭证（MASTER_KEY 等） —— 在 /etc/meilisearch.env，chmod 600
if [ -f /etc/meilisearch.env ]; then
    set -a
    . /etc/meilisearch.env
    set +a
fi

# 2) EdgeOne 凭证 —— 在本地 .env（chmod 600）
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
else
    echo "⚠️  .env 不存在，purge 步骤会失败（reindex 仍会跑）" >&2
fi

# full-reindex.mjs 需要这些（保持和 README 里手动命令一致）
export DRAFT_DIR="${DRAFT_DIR:-/root/book-index-draft}"
export MEILI_URL="${MEILI_URL:-http://127.0.0.1:7700}"
export MEILI_KEY="${MEILI_KEY:-$MASTER_KEY}"

ts() { date -Iseconds; }

echo "[$(ts)] === full-reindex.mjs 开始 ==="
node full-reindex.mjs "$@"
echo "[$(ts)] === full-reindex.mjs 完成 ==="

echo "[$(ts)] === purge-edgeone.mjs 开始 ==="
node purge-edgeone.mjs
echo "[$(ts)] === purge-edgeone.mjs 完成 ==="

echo "[$(ts)] ✅ all done"
