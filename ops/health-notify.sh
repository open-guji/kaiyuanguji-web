#!/usr/bin/env bash
# 主动推送探活失败到 IM webhook（飞书/钉钉/Telegram 等通用 webhook 或自定义服务）。
# 与 ops/health-alert.sh 并存：issue 是留痕，webhook 是“推到人眼前”的一跳。
# 设计要点：
# - 跑在 GitHub 托管 runner 上，与被监控对象解耦（同 health-check.yml 注释）
# - 无 HEALTH_NOTIFY_WEBHOOK 时静默跳过，不影响原有 issue 链路
# - 失败不阻断 workflow（curl 失败不 set -e 退出）
# - 支持飞书/钉钉/通用 JSON：直接 POST 文本，接收端自行格式化
set -uo pipefail

WEBHOOK="${HEALTH_NOTIFY_WEBHOOK:-}"
if [ -z "$WEBHOOK" ]; then
  echo "HEALTH_NOTIFY_WEBHOOK 未配置，跳过主动推送（仅 issue 告警）"
  exit 0
fi

REPORT="${REPORT:-（无报告）}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-open-guji/kaiyuanguji-web}/actions/runs/${GITHUB_RUN_ID:-unknown}"

# 兼容飞书 card 与通用 webhook：同时发 text 与 markdown 字段
title="🔴 生产探活失败：搜索 L1 / 站点端点不可达"
body_text="${title}
时间：$(date -u '+%Y-%m-%d %H:%M UTC')
Run: ${RUN_URL}

${REPORT}"

# 转 JSON：优先用 jq（GitHub runner 自带），本地无 jq 时退回 python3
json_text() {
  if command -v jq >/dev/null 2>&1; then
    jq -Rs -n --arg t "$1" '{text:$t}'
  else
    python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$1"
  fi
}
json_feishu() {
  if command -v jq >/dev/null 2>&1; then
    jq -Rs -n --arg t "$1" '{msg_type:"text",content:{text:$t}}'
  else
    python3 -c 'import json,sys; print(json.dumps({"msg_type":"text","content":{"text": sys.argv[1]}}))' "$1"
  fi
}

# 尝试通用 JSON POST，5 秒超时，失败仅警告
set +e
# 1) 通用：{"text": "..."}
curl -s --max-time 5 -X POST -H "Content-Type: application/json" \
  -d "$(json_text "$body_text")" \
  "$WEBHOOK" >/dev/null 2>&1
code=$?
# 2) 飞书兼容：{"msg_type":"text","content":{"text":"..."}} — 若通用已成功则此为冗余但无害，失败则尝试飞书格式
if [ $code -ne 0 ]; then
  curl -s --max-time 5 -X POST -H "Content-Type: application/json" \
    -d "$(json_feishu "$body_text")" \
    "$WEBHOOK" >/dev/null 2>&1 || true
fi
set -e

echo "已尝试推送到 HEALTH_NOTIFY_WEBHOOK"
