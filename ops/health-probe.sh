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
