#!/usr/bin/env bash
# 受限重建：把 reindex 关进 cgroup，保证它压不垮整机。
#
# 起因（2026-09-04）：直接跑 ./reindex-and-purge.sh 做全量重建，把上海云
# （2 核 / 2GB / 无 swap）压到失去响应——SSH 握不上手、/health 返 000、
# 速率从 600/s 掉到 194/s。机器上还跑着 Meilisearch 本体，重建进程和它
# 抢内存，谁都别想好过。
#
# 本脚本用 systemd-run 建一个临时 scope，给 CPU 和内存都上硬上限：
#   - MemoryMax   触顶时**只杀这个 scope 里的进程**，不会波及 Meili / sshd
#   - MemoryHigh  软上限，先触发回收+限速，尽量别走到 Max
#   - CPUQuota    留出核给 Meili 和 sshd，保证你还能 SSH 进来看情况
#
# 用法：
#   ./reindex-limited.sh                    # 用默认保守值
#   MEM_MAX=500M CPU_QUOTA=40% ./reindex-limited.sh
#   ./reindex-limited.sh --only works       # 参数原样透传给 full-reindex
set -euo pipefail
cd "$(dirname "$0")"

MEM_HIGH="${MEM_HIGH:-400M}"
MEM_MAX="${MEM_MAX:-600M}"
CPU_QUOTA="${CPU_QUOTA:-50%}"
# 批量压小：批越大 Meili 单次 indexing 峰值内存越高
export BATCH_SIZE="${BATCH_SIZE:-200}"
export MAX_CONCURRENT="${MAX_CONCURRENT:-1}"
# 给 Node 自己的堆也设上限，别等 cgroup 来杀
NODE_HEAP="${NODE_HEAP:-320}"

if ! command -v systemd-run >/dev/null 2>&1; then
    echo "⚠️  没有 systemd-run，退回 nice/ionice（只能降优先级，没有硬上限）" >&2
    exec nice -n 19 ionice -c3 env \
        NODE_OPTIONS="--max-old-space-size=${NODE_HEAP}" \
        ./reindex-and-purge.sh "$@"
fi

echo "=== 受限重建 ==="
echo "  MemoryHigh   : ${MEM_HIGH}   (软上限，先限速)"
echo "  MemoryMax    : ${MEM_MAX}    (硬上限，超了只杀本 scope)"
echo "  CPUQuota     : ${CPU_QUOTA}"
echo "  BATCH_SIZE   : ${BATCH_SIZE}"
echo "  MAX_CONCURRENT: ${MAX_CONCURRENT}"
echo "  Node heap    : ${NODE_HEAP}MB"
echo

# --scope 前台跑，日志直接进当前终端；-p 传 cgroup 属性
exec systemd-run --scope --quiet \
    --unit="kyg-reindex-$(date +%s)" \
    -p "MemoryHigh=${MEM_HIGH}" \
    -p "MemoryMax=${MEM_MAX}" \
    -p "MemorySwapMax=0" \
    -p "CPUQuota=${CPU_QUOTA}" \
    -p "IOWeight=10" \
    --setenv=BATCH_SIZE="${BATCH_SIZE}" \
    --setenv=MAX_CONCURRENT="${MAX_CONCURRENT}" \
    --setenv=NODE_OPTIONS="--max-old-space-size=${NODE_HEAP}" \
    ./reindex-and-purge.sh "$@"
