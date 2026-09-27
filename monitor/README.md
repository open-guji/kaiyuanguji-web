# monitor/ — 线上监控与告警

跑在 GitHub Actions（`.github/workflows/monitor.yml`）上，与被监控对象解耦。零依赖，Node ≥ 20。
取代了原来的 `health-check.yml`＋`ops/health-probe.sh`／`health-alert.sh`（原探活项已全部并入 A2）。

| 类 | 频率 | 内容 |
|---|---|---|
| **A** 主动探测 | 每 15 分钟 | 纯 HTTP，单次 < 2 分钟 |
| **B** 数据监测 | 每小时 | 在 A 的 job 里「距上次满 55 分钟」那一轮顺带跑 |
| **C** 契约冒烟 | 每 6 小时 | `e2e` 的 contract 项目打正式站，结果折成一项 |

## 告警怎么发

- 每个检查项（下表的 ID）至多一张 open 的 issue，标签 `monitor`，正文首行藏 `<!-- monitor-check:ID -->`（**别删**，靠它认单）。
- **连续 2 次失败才开单**；已开的单，失败内容（哪些子项挂了）变了立刻评论一次，否则每 6 小时提醒一次；
  **恢复即自动关单**，评论恢复时间与持续时长。
- `warn`（例：正式站还没 promote 新版本、OAuth 未配置）不开单；`skip`（缺 secret）既不开单也不关单。
- 邮件：GitHub 的 issue 通知（仓主默认收到；见文末「要用户配的」）。另外开单／变化／恢复时推一次 IM webhook（未配就跳过）。
- 检查失败不会让 workflow 变红（免得每 15 分钟多一封「run failed」邮件）；**workflow 红 = 告警链路自己坏了**，要看。
- 状态（连续失败数、issue 号、搜索命中基线）存 Actions cache；丢了会从 open 的 monitor 单找回，最坏晚一轮开单。
- 人手关掉一张还在失败的单：下一次失败会重新开（状态机当它是新故障）。想让某项闭嘴，调阈值或在 `checks/` 里把它去掉，别靠关单。

## 检查项

每项由若干子项组成，报告里每个子项都列「实测／阈值」。阈值都能用环境变量覆盖（`config.mjs`）。

### A1-home 正式站首页
- `https://www.kaiyuanguji.com/` 200，且 HTML 带 `<meta name="bim-ui-version">`（丢了 e2e 的版本门禁会静默跳过一批用例）。
- 误报：几乎不会；连续两次（≥15 分钟）打不开就是真挂。

### A1-deploy-lag 部署停更
- main 的 `nextjs/package.json` 要求 `book-index-ui ≥ X`。测试站（push main 自动部署）须在 **3 小时**内跟上，
  正式站（人手 promote）须在 **72 小时**内跟上；宽限期内只记 warn。改动时间取 `git log -- nextjs/package.json`。
- 调：`MON_STAGING_LAG_HOURS`、`MON_PROD_LAG_HOURS`。promote 节奏变慢就调大后者。

### A2-search-l1 搜索 L1（Meilisearch）
- `/health` 200；照前端形态（带 `filter: is_draft = false`）搜「史記」：200、有命中、**耗时 < 3 s**、
  **命中数 ≥ 基线 × 90%**（基线 = 最近 48 次正常值的中位数，头 3 次只攒不判；塌缩值不进基线）；
  四个索引带过滤的空查询都 ≥ 1 条（2026-09-14 三索引被清空、09-21 works 丢 filterable 两次事故）。
- 注意 `estimatedTotalHits` 被 `maxTotalHits`（默认 1000）封顶，只能防塌缩、不是真实文档数。
- 调：`MON_SEARCH_MAX_MS`（上海机偶发慢时可放到 5000）、`MON_SEARCH_BASELINE_RATIO`、`MON_SEARCH_Q`。
  重建索引后命中数正当变少 → 基线会在 1 天内自动跟上；急用可删 Actions cache `monitor-state-probe-*` 重置。
- 修法（搬自旧 `health-probe.sh`）：只 `/health` 挂 → L1 中断，前端降级 L2，见 overview 仓
  `项目进展/古籍索引网站/故障-2026-09-03-上海服务器IP变更.md`；某索引条数塌 → 多半重建时带了 `--only` 漏建，
  上机 `/opt/indexer/reindex-limited.sh --only <索引>` 补（先停 `/opt/meili-watchdog.sh`），见 `进度/G-工具分发与网站/11-L1三索引为空.md`；
  带过滤 400 → settings 丢了，`PATCH /indexes/<索引>/settings`（取值见 `indexer/full-reindex.mjs` 的 `SETTINGS`）。

### A2-search-l2 搜索 L2（分片兜底）
- `data/v/<commitId>/search/meta.json` 可取，work／book／collection／entity 四类 docCount > 0。L1 挂时它是唯一的搜索。

### A3-data-bucket 数据桶
- `latest.json`（有 commitId）、`current/version.json`（与 latest 同版本，否则 CDN 未刷新）、
  锚点条目 `current/entry/<id>.json`（锚点取 `e2e/fixtures/anchors.ts` 的 work／entity，且不许是墓碑）、
  `h1/manifest-root.json`，全部 200 且 JSON 可解析。
- 误报：部署切换的几分钟里 version 与 latest 可能短暂不一致——连续 2 次才开单足以滤掉。锚点被升格／合并时换 anchors.ts。

### A4-item-pages 条目页
- 正式站 `/book-index?id=<史記>` 200；测试站 SSR `/item/<史記>` 200 且 HTML 含「史記」（SSR 回退成空壳时会缺）。

### A5-edge 边缘函数
- `GET /api/feedback` 200 且公开列表**无邮箱／手机号**（F1 脱敏回归；只报「条目 id.字段」，不回显内容）；
- `GET /api/auth/me` 未登录 401；
- `GET /oauth/authorize`（无参数）400／302 为正常；生产没配 OAuth 变量时是 503 `temporarily_unavailable`，记 **warn** 不开单。
- 误报：用户把邮箱写进反馈正文且脱敏规则漏了 → 这是真问题（去 feedback.js 补规则），不是误报。

### A6-staging 测试站
- 首页 200；`robots.txt` 的 `User-agent: *` 组里有 `Disallow: /`（测试站不许被收录）。

### A7-tls TLS 证书
- www／data／api／staging 四个域名证书剩余 **> 14 天**。调：`MON_TLS_MIN_DAYS`、`MON_TLS_HOSTS`。

### B1-errors 前端错误数
- 读 `GET /api/track-error?summary=1&window=1h`（本 PR 新增，要 `ERROR_VIEW_TOKEN`；只回计数＋前 5 种消息摘要，不回 IP／stack／UA／页面）。
- 规则：最近 1 小时 > **max(20, 前 23 小时每小时均值 × 5)** 就报。均值刻意不含本小时。
- 缺 GitHub secret → skip（「未配置」）；生产没配变量（503）→ skip；两边 token 不一致（401）→ fail。
- 调：`MON_ERROR_FLOOR`、`MON_ERROR_FACTOR`。某种已知噪音错误刷量 → 标 resolved 不减计数（计数按 key 数），
  应在前端上报侧过滤掉它。

### B2-feedback-rate 反馈量
- 最近 1 小时新反馈 **> 20 条**就报（防刷）。有 `FEEDBACK_ADMIN_TOKEN` 时读 `GET /api/feedback?summary=1`（本 PR 新增，只回条数）；
  没有就退回数公开列表（只数得到公开可见的，是下界，报告里注明）。调：`MON_FEEDBACK_MAX_PER_HOUR`。

### B3-freshness 数据新鲜度
- 正式站 `latest.json` 记的三仓 commit（draft／production／text）与各仓 main 比（GitHub compare API）：
  main 上有、线上没收的提交里**最早那条超过 36 小时**就报（管线卡住，如 2026-08 跨仓 PAT 失效 5 天没上线）。
- 仓读不到（403／404）→ skip。调：`MON_FRESHNESS_MAX_HOURS`。

### C1-contract e2e 契约冒烟（正式站）
- `npx playwright test --project=contract`（纯 HTTP，不装浏览器），有用例挂即 fail；重试后才过记 warn。报告作 artifact 留 7 天。

## 本地跑

```bash
cd monitor && npm test                        # 单测＋故障注入（本地假服务器＋假 GitHub API，不打线上）
node monitor/run.mjs --suite probe --dry-run  # 真打线上，只出报告不碰 issue（在仓根目录跑）
MON_STAGING=https://x.invalid node monitor/run.mjs --suite probe --only A6-staging --dry-run   # 手动注入
```

故障注入：`test/fault-injection.test.mjs` 对 A 类每一项注入一种故障，断言「第 1 轮不开单 → 第 2 轮开且只开这一张 →
第 3 轮不刷评论 → 恢复后自动关并写持续时长」。真 issue 的演示：给改监控的 PR 打 `monitor-demo` 标签，
workflow 的 `demo` job 会用标签 `monitor-test`、标题前缀「[演示]」开一张再关掉。

## Actions 用量（仓是私有仓，按分钟计费）

| | 次/天 | 单次计费 | 分钟/月（30 天） |
|---|---|---|---|
| A（+B） | 96 | 1 分钟（实测墙钟见 PR 的 selftest Summary） | ≈ 2,880 |
| C | 4 | ≈ 2 分钟 | ≈ 240 |
| 合计 | | | **≈ 3,100** |

原 health-check 约 120 分钟/月，删掉了。GitHub Free 组织私有仓每月 2,000 分钟、Team 3,000——**若额度不够，
把 A 的 cron 改成 `*/30`（≈ 1,440＋240）**。额度用尽且没设付费上限时，整个仓的 Actions（含 deploy）都会停，
所以合并前要确认计划额度。

另：本仓历史上 `health-check.yml` 的 `0 */6 * * *` 实际触发比预定晚 2～5 小时（09-26～27 五次实测），
GitHub 定时在负载高时会延迟甚至丢弃。15 分钟一轮的真实间隔要合并后实测；若长期 > 30 分钟，再上 Cloudflare Worker cron 作第二观察点。
