#!/bin/bash
# reindex + purge: 重建 Meili 索引，成功后立刻清 EdgeOne 缓存。
#
# 用 set -e + 单独的 wrapper：reindex 失败时不 purge，避免空索引被推到边缘。
#
# 部署：放在 /opt/indexer/ 下，跟 full-reindex.mjs / purge-edgeone.mjs 同级。
# 用法：
#   ./reindex-and-purge.sh           # 手动跑
#   或 cron: 0 4 * * * /opt/indexer/reindex-and-purge.sh >> /var/log/indexer.log 2>&1
#
# ⚠️ 低配机（上海云 2 核 / 2GB / 无 swap）**不要直接跑本脚本**：
# 2026-09-04 实测会把整机压到失去响应（SSH 握不上手、/health 返 000）。
# 改用同目录的 ./reindex-limited.sh，它用 systemd-run 上 cgroup 硬限制。

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
# production 仓不可缺：已升格条目（2026-08 已 2.3 万条）全在这里，
# 只给 draft 的话它们在搜索里只剩墓碑裸标题
export PRODUCTION_DIR="${PRODUCTION_DIR:-/root/book-index}"
export MEILI_URL="${MEILI_URL:-http://127.0.0.1:7700}"
export MEILI_KEY="${MEILI_KEY:-$MASTER_KEY}"

ts() { date -Iseconds; }

# 关键：先拉新数据再建索引。此前缺这一步，cron 每晚都在对同一份陈旧
# checkout 重建索引，搜索结果永远停在最后一次人工 pull 的状态
# （2026-08-25 查实）。--ff-only 失败就整体中止：宁可显式报错，也好过
# 无声地把过期数据推上线——与本脚本 set -e 的 fail-fast 设计一致。
echo "[$(ts)] === git pull $DRAFT_DIR ==="
git -C "$DRAFT_DIR" pull --ff-only
git -C "$DRAFT_DIR" log -1 --format='  HEAD: %h %ci %s'

echo "[$(ts)] === git pull $PRODUCTION_DIR ==="
if [ -d "$PRODUCTION_DIR/.git" ]; then
    git -C "$PRODUCTION_DIR" pull --ff-only
else
    echo "  首次运行：克隆 production 仓"
    git clone --depth 1 https://github.com/open-guji/book-index.git "$PRODUCTION_DIR"
fi
git -C "$PRODUCTION_DIR" log -1 --format='  HEAD: %h %ci %s'

echo "[$(ts)] === full-reindex.mjs 开始 ==="
node full-reindex.mjs "$@"
echo "[$(ts)] === full-reindex.mjs 完成 ==="

echo "[$(ts)] === purge-edgeone.mjs 开始 ==="
node purge-edgeone.mjs
echo "[$(ts)] === purge-edgeone.mjs 完成 ==="

echo "[$(ts)] ✅ all done"
