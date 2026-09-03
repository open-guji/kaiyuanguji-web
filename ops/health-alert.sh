#!/usr/bin/env bash
# 探活失败时维护一个 open 的告警 issue。
# 每 6 小时跑一次，若每次都新开 issue 会刷屏，所以复用同一个：
# 已有 open 的就追加评论，没有才新建。恢复后由人工关闭。
set -euo pipefail

TITLE="🔴 生产探活失败：搜索 L1 / 站点端点不可达"
LABEL="incident"

# 确保 label 存在，否则 issue create 会失败
gh label create "$LABEL" --color b60205 --description "生产故障" 2>/dev/null || true

existing=$(gh issue list --state open --label "$LABEL" --search "$TITLE" \
  --json number,title --jq "[.[] | select(.title==\"$TITLE\")][0].number // empty")

body="探活时间：$(date -u '+%Y-%m-%d %H:%M UTC')
Run: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}

${REPORT}"

if [ -n "$existing" ]; then
  gh issue comment "$existing" --body "$body"
  echo "已在 issue #${existing} 追加评论"
else
  num=$(gh issue create --title "$TITLE" --label "$LABEL" --body "$body" \
    | grep -oE '[0-9]+$')
  echo "已新建 issue #${num}"
fi
