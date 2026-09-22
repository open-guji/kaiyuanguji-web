#!/usr/bin/env bash
# 主动推送探活失败到 IM webhook（飞书/钉钉/Telegram 等通用 webhook 或自定义服务）。
# 与 ops/health-alert.sh 并存：issue 是留痕，webhook 是“推到人眼前”的一跳。
# 设计要点：
# - 跑在 GitHub 托管 runner 上，与被监控对象解耦（同 health-check.yml 注释）
# - 无 HEALTH_NOTIFY_WEBHOOK 时静默跳过，不影响原有 issue 链路
# - 失败不阻断 workflow（curl 失败不 set -e 退出），但失败会以 ::warning:: 打印到 Actions 日志
# - 需显式配置 HEALTH_NOTIFY_FORMAT：generic | feishu | dingtalk（默认 generic），避免“猜格式、失败再换”导致静默丢弃
set -uo pipefail

WEBHOOK="${HEALTH_NOTIFY_WEBHOOK:-}"
if [ -z "$WEBHOOK" ]; then
  echo "HEALTH_NOTIFY_WEBHOOK 未配置，跳过主动推送（仅 issue 告警）"
  exit 0
fi

# 显式格式：generic（通用 {"text":...}）| feishu | dingtalk | slack
FORMAT="${HEALTH_NOTIFY_FORMAT:-generic}"

REPORT="${REPORT:-（无报告）}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-open-guji/kaiyuanguji-web}/actions/runs/${GITHUB_RUN_ID:-unknown}"

title="🔴 生产探活失败：搜索 L1 / 站点端点不可达"
body_text="${title}
时间：$(date -u '+%Y-%m-%d %H:%M UTC')
Run: ${RUN_URL}

${REPORT}"

# 构造 payload：jq 优先（runner 自带），无 jq 时退回 python3；修正 -Rs 与 -n 混用
build_payload() {
  local fmt="$1" text="$2"
  if command -v jq >/dev/null 2>&1; then
    case "$fmt" in
      feishu)   jq -n --arg t "$text" '{msg_type:"text",content:{text:$t}}' ;;
      dingtalk) jq -n --arg t "$text" '{msgtype:"text",text:{content:$t}}' ;;
      slack)    jq -n --arg t "$text" '{text:$t}' ;;
      *)        jq -n --arg t "$text" '{text:$t}' ;;
    esac
  else
    case "$fmt" in
      feishu)   python3 -c 'import json,sys; print(json.dumps({"msg_type":"text","content":{"text": sys.argv[1]}}))' "$text" ;;
      dingtalk) python3 -c 'import json,sys; print(json.dumps({"msgtype":"text","text":{"content": sys.argv[1]}}))' "$text" ;;
      *)        python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$text" ;;
    esac
  fi
}

payload=$(build_payload "$FORMAT" "$body_text")

# 发送并检查 HTTP 状态与业务码；失败仅 warning，不阻断 workflow
set +e
resp=$(curl -sS --max-time 10 -w '\n%{http_code}' -H "Content-Type: application/json" -d "$payload" "$WEBHOOK" 2>&1)
curl_code=$?
http_code=$(echo "$resp" | tail -n1)
body=$(echo "$resp" | sed '$d')
set -e

if [ $curl_code -ne 0 ]; then
  echo "::warning::健康告警推送失败（curl $curl_code），webhook 可能不可达：$WEBHOOK"
  echo "::warning::响应：$body"
  exit 0
fi

# HTTP 非 2xx 即失败
if ! echo "$http_code" | grep -qE '^2[0-9][0-9]$'; then
  echo "::warning::健康告警推送 HTTP $http_code，payload 格式 $FORMAT 可能不匹配（body: $body）"
  exit 0
fi

# 飞书/钉钉业务码检查（返回 body 里含 code/errcode 非 0 即失败）
if [ "$FORMAT" = "feishu" ]; then
  if echo "$body" | grep -q '"code":0'; then
    echo "已推送到飞书 webhook（HTTP $http_code）"
  else
    echo "::warning::飞书推送 HTTP $http_code 但业务码非 0（body: $body），请检查 webhook 是否为飞书类型"
  fi
elif [ "$FORMAT" = "dingtalk" ]; then
  if echo "$body" | grep -q '"errcode":0'; then
    echo "已推送到钉钉 webhook（HTTP $http_code）"
  else
    echo "::warning::钉钉推送 HTTP $http_code 但 errcode 非 0（body: $body），请检查 webhook 类型"
  fi
else
  echo "已推送到 webhook（HTTP $http_code，格式 $FORMAT）"
fi
