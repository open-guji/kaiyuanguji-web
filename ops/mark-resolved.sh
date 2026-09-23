#!/usr/bin/env bash
# 批量标 resolved（17）
# 用法： TOKEN 从 /root/.config/kaiyuanguji/error_view_token 或环境变量 ERROR_VIEW_TOKEN 读取
# 默认 dry-run，--execute 才真写
set -uo pipefail
TOKEN="${ERROR_VIEW_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "/root/.config/kaiyuanguji/error_view_token" ]; then
  TOKEN=$(cat /root/.config/kaiyuanguji/error_view_token)
fi
if [ -z "$TOKEN" ]; then echo "缺少 ERROR_VIEW_TOKEN"; exit 1; fi
EXEC=0; [ "${1:-}" = "--execute" ] && EXEC=1
API="https://www.kaiyuanguji.com/api/track-error"
# 取全量
TMP=$(mktemp)
node --input-type=module - "$TOKEN" "$TMP" <<'JS'
import fs from 'fs';
const token=process.argv[2], tmp=process.argv[3];
let cursor=""; let all=[];
while(true){
  const url=`https://www.kaiyuanguji.com/api/track-error?limit=200&token=${encodeURIComponent(token)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`;
  const r=await fetch(url); const j=await r.json();
  if(!j.success){console.error(j);process.exit(1)}
  all.push(...j.items);
  if(!j.hasMore) break; cursor=j.cursor;
}
fs.writeFileSync(tmp, JSON.stringify(all));
console.log(`fetched ${all.length}`);
JS
echo "fetched $(jq length "$TMP" 2>/dev/null || python3 -c "import json;print(len(json.load(open('$TMP'))))")"
# 筛 e2e+perf
IDS=$(node --input-type=module - "$TMP" <<'JS'
import fs from 'fs';
const all=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const ids=all.filter(x=>x.state==="open" && (x.resource==="nonexistent000" || x.resource==="aTNoXY45BGY3")).map(x=>x.id);
console.log(ids.join("\n"));
JS
)
COUNT=$(echo "$IDS" | grep -c . || true)
echo "target $COUNT ids (e2e nonexistent000 + perf aTNo)"
if [ "$COUNT" -eq 0 ]; then echo "无待标"; exit 0; fi
if [ $EXEC -eq 0 ]; then echo "dry-run，--execute 才真写"; echo "$IDS" | head -n 5; exit 0; fi
echo "$IDS" | xargs -P 10 -I {} bash -c 'curl -s -X POST "https://www.kaiyuanguji.com/api/track-error" -H "Content-Type: application/json" -d "{\"action\":\"update\",\"id\":\"{}\",\"state\":\"resolved\",\"token\":\"'"$TOKEN"'\"}" | grep -q success.*true && echo "ok {}" || echo "fail {}"'
