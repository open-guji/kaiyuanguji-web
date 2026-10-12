#!/bin/bash
# reindex + purge: 重建 Meili 索引，成功后立刻清 EdgeOne 缓存。
#
# 用 set -e + 单独的 wrapper：reindex 失败时不 purge，避免空索引被推到边缘。
#
# 部署：放在 /opt/indexer/ 下，跟 full-reindex.mjs / purge-edgeone.mjs 同级。
# 用法：
#   ./reindex-limited.sh             # 平时一律走这个（cgroup 限制版，会调用本脚本）
#   或 cron: 0 4 * * * /opt/indexer/reindex-limited.sh >> /var/log/indexer.log 2>&1
#
# ⚠️ 低配机（上海云 2 核 / 2GB / 无 swap）**不要直接跑本脚本**：
# 2026-09-04 实测会把整机压到失去响应（SSH 握不上手、/health 返 000）。
# 改用同目录的 ./reindex-limited.sh，它用 systemd-run 上 cgroup 硬限制。

set -e
set -o pipefail
cd "$(dirname "$0")"

# 退出码约定（overview#556）：0＝全好；3＝重建完成、但有仓没拉到最新（用的是陈旧本地 checkout）；
# 4＝重建日志缺「下限闸通过」（自检环节没跑或被绕过）；其余非 0＝重建或 purge 本身失败。
# 非 0 时 reindex-search.yml 会开卡／续评论告警，不再让 job 显示 success 把问题吞掉。
STALE_REPOS=""

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
# 文本仓（2026-08-26 从 book-index 拆出）：整理本正文只在这里。
# 缺了 juans 索引为 0，整理本正文一个字都搜不到（2026-09-06 查实）。
export TEXT_DIR="${TEXT_DIR:-/root/book-text}"
export MEILI_URL="${MEILI_URL:-http://127.0.0.1:7700}"
export MEILI_KEY="${MEILI_KEY:-$MASTER_KEY}"

ts() { date -Iseconds; }

# pull 失败不中止：上海机对 GitHub 只能走代理，代理时不时 403/超时（2026-09-07 book-index
# 就被 gh-proxy 403 过一次）。一次网络失败让整轮 reindex 都不跑，比用稍旧的本地
# checkout 重建更糟——后者至少把 book-text 的整理本正文和新条目推上去了。
# 失败时大声警告并打印本地 HEAD 日期，让人看得见数据有多旧；数据也可以从本机
# 经 SSH 直推到服务器仓（见 README「数据仓怎么更新」）。
pull_or_warn() {
    local dir="$1"
    if git -C "$dir" pull --ff-only; then
        return 0
    fi
    echo "⚠️  [$(ts)] git pull $dir 失败——继续用本地 checkout 重建（数据可能陈旧！）" >&2
    STALE_REPOS="$STALE_REPOS $(basename "$dir")"
    return 0
}

# 关键：先拉新数据再建索引。此前缺这一步，cron 每晚都在对同一份陈旧
# checkout 重建索引，搜索结果永远停在最后一次人工 pull 的状态
# （2026-08-25 查实）。--ff-only 失败就整体中止：宁可显式报错，也好过
# 无声地把过期数据推上线——与本脚本 set -e 的 fail-fast 设计一致。
echo "[$(ts)] === git pull $DRAFT_DIR ==="
pull_or_warn "$DRAFT_DIR"
git -C "$DRAFT_DIR" log -1 --format='  HEAD: %h %ci %s'

echo "[$(ts)] === git pull $PRODUCTION_DIR ==="
if [ -d "$PRODUCTION_DIR/.git" ]; then
    pull_or_warn "$PRODUCTION_DIR"
else
    echo "  首次运行：克隆 production 仓"
    git clone --depth 1 https://github.com/open-guji/book-index.git "$PRODUCTION_DIR"
fi
git -C "$PRODUCTION_DIR" log -1 --format='  HEAD: %h %ci %s'

echo "[$(ts)] === git pull $TEXT_DIR ==="
if [ -d "$TEXT_DIR/.git" ]; then
    pull_or_warn "$TEXT_DIR"
else
    echo "  首次运行：克隆 book-text 仓（约 130 MB）"
    # 上海机直连 GitHub 不通（2026-09-06 实测 60s 超时），走与另两仓 origin 相同的
    # gh-proxy.com 前缀；换代理时用 TEXT_REPO_URL 覆盖
    git clone --depth 1 "${TEXT_REPO_URL:-https://gh-proxy.com/https://github.com/open-guji/book-text.git}" "$TEXT_DIR"
fi
git -C "$TEXT_DIR" log -1 --format='  HEAD: %h %ci %s'

echo "[$(ts)] === full-reindex.mjs 开始 ==="
REINDEX_LOG="$(mktemp /tmp/reindex-log.XXXXXX)"
trap 'rm -f "$REINDEX_LOG"' EXIT
node full-reindex.mjs "$@" 2>&1 | tee "$REINDEX_LOG"
echo "[$(ts)] === full-reindex.mjs 完成 ==="

# 兜底（overview#556）：每个 swap 生效的索引前面都该有一行「📏 下限闸通过」。
# 缺了＝闸没跑（脚本过期、被 --allow-shrink 绕过等）；09-27 起脚本过期 10 天没人发现，就是靠这行缺失才看得出来。
# --allow-shrink 是人明确要求缩减，那次不查。
GATE_MISSING=0
case " $* " in
    *" --allow-shrink "*) ;;
    *)
        SWAPPED=$(grep -c "已 swap 生效" "$REINDEX_LOG" || true)
        GATED=$(grep -c "下限闸通过" "$REINDEX_LOG" || true)
        if [ "$SWAPPED" -gt 0 ] && [ "$GATED" -lt "$SWAPPED" ]; then
            GATE_MISSING=1
            echo "❌ [$(ts)] 日志里「下限闸通过」只有 $GATED 行，但有 $SWAPPED 个索引 swap 生效：下限闸没有对每个索引都跑" >&2
        fi
        ;;
esac

echo "[$(ts)] === purge-edgeone.mjs 开始 ==="
node purge-edgeone.mjs
echo "[$(ts)] === purge-edgeone.mjs 完成 ==="

if [ "$GATE_MISSING" = 1 ]; then
    echo "[$(ts)] ❌ 重建完成但下限闸行缺失，按失败处理（退出码 4）" >&2
    exit 4
fi
if [ -n "$STALE_REPOS" ]; then
    echo "[$(ts)] ⚠️ 重建完成，但这些仓没拉到最新、用的是本地陈旧 checkout：$STALE_REPOS（退出码 3）" >&2
    exit 3
fi
echo "[$(ts)] ✅ all done"
