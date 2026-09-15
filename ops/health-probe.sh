#!/usr/bin/env bash
# 生产端点探活。只探不修，结果写进 GITHUB_OUTPUT 供告警步骤使用。
#
# 分层设计对应 2026-09-03 故障的教训：搜索是 L1(Meili)/L2(分片) 两层，
# L1 全挂用户也感知不到，所以 L1 必须单独探，不能只看"网站能不能打开"。
set -uo pipefail

failed=0
report=""

note() {
  echo "$1"
  report="${report}${1}"$'\n'
}

# probe <名称> <URL> <期望状态码> <是否关键>
probe() {
  local name="$1" url="$2" want="$3" critical="$4"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null || echo 000)
  if [ "$code" = "$want" ]; then
    note "✅ ${name} — ${code}"
  else
    note "❌ ${name} — 期望 ${want}，实得 ${code}  (${url})"
    # 000 = 连不上/超时；522 = EdgeOne 回源超时（源站机器不可达）
    [ "$critical" = "yes" ] && failed=$((failed + 1))
  fi
}

note "## 搜索 L1（上海 Meilisearch）"
probe "Meili /health" "https://api.kaiyuanguji.com/health" 200 yes

# 索引非空检查。2026-09-14 撞见 books/collections/entities 三个 index 文档数为 0
# ——起因是重建时带了 `--only works`，其余索引从此留空。
# 这种故障 /health 探不出来：服务活着、返回 200、搜索返回 0 条也是"正常的空结果"，
# 前端拿到空结果走 L2 兜底，于是既无告警也无人报障。空索引只有主动探才发现得了。
#
# 用公开只读搜索 key（本就随 JS 发给每个浏览器，非机密；GET /stats 需管理权限，
# 公开 key 是 403，所以改用空查询 POST /search 读 estimatedTotalHits）。
#
# ⚠️ 注意 estimatedTotalHits 被索引的 maxTotalHits 封顶（默认 1000），
# 拿不到真实文档数——所以这里只判"非空/是否骤降到极低"，不做精确计数。
# 想要精确数得用 master key 读 /stats，但那不该放进 CI。
MEILI_PUBLIC_KEY="${MEILI_PUBLIC_KEY:-1b0b438f7eadd34e1a6b53c76d63bd3614822d3ec9856251c9340a78456c5465}"

# probe_index <index名> <最少文档数>
probe_index() {
  local idx="$1" min="$2" hits
  hits=$(curl -s -X POST "https://api.kaiyuanguji.com/indexes/${idx}/search" \
      -H "Authorization: Bearer ${MEILI_PUBLIC_KEY}" \
      -H 'Content-Type: application/json' \
      -d '{"q":"","limit":0}' --max-time 20 2>/dev/null \
    | grep -o '"estimatedTotalHits":[0-9]*' | cut -d: -f2)

  if [ -z "$hits" ]; then
    # 拿不到计数有两种情形：L1 整体挂了（上一项已计失败，这里不重复计），
    # 或该索引被整个删除（404）——后者同样要告警，否则删掉比清空还安静。
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15             https://api.kaiyuanguji.com/health 2>/dev/null)" = "200" ]; then
      note "❌ 索引 ${idx} — 查询不到（L1 健康，**该索引可能已被删除**）"
      failed=$((failed + 1))
    else
      note "⚠️ 索引 ${idx} — 查询失败（L1 已中断，见上一项）"
    fi
    return
  fi
  if [ "$hits" -ge "$min" ]; then
    # 1000 是 maxTotalHits 封顶值，标注出来免得被当成真实文档数
    if [ "$hits" -ge 1000 ]; then
      note "✅ 索引 ${idx} — 非空（≥1000，封顶值）"
    else
      note "✅ 索引 ${idx} — ${hits} 条"
    fi
  else
    note "❌ 索引 ${idx} — ${hits} 条**索引已空，该类内容搜不到**"
    failed=$((failed + 1))
  fi
}

# 阈值只为抓"空掉"。四个索引实际规模远大于此（works 9.1万 / books 2.0万 /
# entities 3.1万 / collections 84），但 estimatedTotalHits 封顶 1000，
# 所以阈值取 1 即可：0 条 = 索引空了，这正是 2026-09-14 那次故障的形态。
probe_index works       1
probe_index books       1
probe_index entities    1
probe_index collections 1

note ""
note "## 站点与数据（不依赖上海机器）"
probe "网站首页"        "https://www.kaiyuanguji.com/book-index" 200 yes
probe "数据版本指针"    "https://data.kaiyuanguji.com/latest.json?t=$(date +%s)" 200 yes

note ""
if [ "$failed" -gt 0 ]; then
  note "**${failed} 项关键探活失败。**"
  note ""
  note "若失败项只有 Meili /health：搜索 L1 中断，前端自动降级 L2，"
  note "用户仍能搜索但更慢、结果不再随每日 cron 更新。参见 overview 仓"
  note "\`项目进展/古籍索引网站/故障-2026-09-03-上海服务器IP变更.md\`。"
  note ""
  note "若失败项是某个**索引文档数偏低**：L1 活着但该类内容搜不到（用户搜书/丛编/"
  note "人物会零结果）。多半是重建时带了 \`--only\` 漏掉该索引，或重建中途失败。"
  note "上机 \`/opt/indexer/reindex-limited.sh --only <索引名>\` 补建；"
  note "重建前先停 \`/opt/meili-watchdog.sh\`（资源紧张时它是负反馈）。"
  note "参见 overview 仓 \`进度/G-工具分发与网站/11-L1三索引为空.md\`。"
else
  note "全部通过。"
fi

{
  echo "failed=${failed}"
  echo "report<<REPORT_EOF"
  echo "${report}"
  echo "REPORT_EOF"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"

exit 0
