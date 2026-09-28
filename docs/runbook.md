# 开源古籍网站排障手册（runbook）

内测期线上出问题时照这本走：**先定版本 → 按症状查 → 处理 → 不行就回滚**。
每一步都写了看哪个接口／哪个 workflow、怎么判断、怎么处理。命令都能直接复制。

三个站：

| 站 | 地址 | 托管方式 | 数据指针 |
|---|---|---|---|
| 正式站 | https://www.kaiyuanguji.com | 静态导出，推 `edgeone-release` 分支由 EdgeOne Pages 发布 | `https://data.kaiyuanguji.com/latest.json` |
| 测试站 | https://staging.kaiyuanguji.com | 全栈，CLI 直传 `kyg-staging` | `https://data.kaiyuanguji.com/staging/latest.json` |
| 双跑站 | https://ssr-test.kaiyuanguji.com | 全栈，CLI 直传 `kyg-ssr-spike`（正式站每次发布同版本同数据再发一份） | 同正式站 |

> 读数据指针**必须带随机串**：`curl -s "https://data.kaiyuanguji.com/latest.json?cb=$RANDOM$RANDOM"`。
> 不带会拿到 EdgeOne 节点上的旧副本，看到的「线上版本」是错的。

---

## 0. 第一步永远是：线上现在是哪一版

```bash
for s in www staging ssr-test; do
  echo "== $s"; curl -s "https://$s.kaiyuanguji.com/api/version" | python3 -m json.tool
done
```

`/api/version` 公开、不缓存（`no-store`），返回：

| 字段 | 含义 | 来源 |
|---|---|---|
| `web` | 网站代码 commit | 构建时写入（CI 的 `next build` 把它写进 `edge-functions/api/version.js`） |
| `bimUi` | 打进产物的 book-index-ui 版本 | 构建时写入 |
| `data` | 数据指针 `latest.json` 的 `commitId`（book-index-draft 短 commit） | 运行时读 COS |
| `dataPointer` | 指针全文：三仓 commit、`bundleDate`、`webCommitId` | 运行时读 COS |
| `builtAt` | 构建时间 | 构建时写入 |
| `target` | `production` / `staging` / `ssr-test` | 构建时写入 |
| `webMatchesPointer` | `web` 是否等于指针里记的 `webCommitId` | — |

怎么读：

- **`web` 是不是你以为的那版？** 对照 `git log origin/main`。正式站只有 promote 才会变（push 到 main 只发测试站）。
- **`builtAt` 很旧、`web` 不对** → 新版本没发上去：看 Actions 里最近一次 `Deploy to EdgeOne` 哪一步红了。
- **`webMatchesPointer: false`** 不一定是故障：`promote=data`（只换数据，每天 04:30 自动跑）时代码不动、指针记的是上次 promote 用的代码；
  但如果刚手动 promote 过 `code+data` 还是 false，就是「代码发了、指针没刷新」或反过来——看 §6 CDN。
- **接口 404** → 这版产物早于 `/api/version`（2026-09 DBG 之前），改看 `<meta name="bim-ui-version">` 与数据指针的 `webCommitId`。
- **`dataError`** → 数据 CDN 读不到，本身就是一条线索（§2、§4）。
- **`note: 构建时未写入版本信息`** → 产物不是 CI 构建的（手工发布／本地 build），版本不可信。

### 错误出在哪一版

前端每条错误上报都带 `web`（代码 commit）和 `data`（数据 commitId）：

- 成员登录后打开 **/admin/errors**，「版本」下拉或「按版本」表：每个 (代码, 数据) 组合的条数和最多的错误。
  新版本发布后某个组合突然冒出一堆同类错误 → 就是它引入的。
- 老记录（DBG 之前）只有数据版本，代码版本显示「未知」。
- 监控汇总（`/api/track-error?summary=1`，monitor.yml 每小时读）只给计数与 top 5 消息，不分版本；分版本看 /admin/errors。

---

## 1. 白屏／页面报错

| 看什么 | 怎么判断 |
|---|---|
| 浏览器控制台 | `ChunkLoadError` / `Loading chunk … failed` → HTML 与 JS chunk 版本不一致（CDN 给了旧 HTML 或新 HTML 配旧 chunk），转 §6 |
| /admin/errors 按版本表 | 新 `web` 版本下出现大量 `js`/`react` 错误 → 代码回归，准备回滚 |
| `/api/version` 的 `bimUi` | 与 `nextjs/package-lock.json` 里 book-index-ui 版本不一致 → 发布顺序错了（UI 包没发就 bump） |
| open-guji-monitor 的 A 探测／本仓 `monitor` 标签 issue | 是否整站 5xx，还是只有部分页面 |

处理：

1. 只影响个别用户、强刷能好 → CDN／浏览器缓存问题，§6。
2. 新版本引入、所有人都复现 → **回滚**（§8），再在 main 上修。
3. 只有测试站坏 → 不影响读者，在 main 上修即可；**不要 promote**。

## 2. 条目 404（「条目不存在」）

| 看什么 | 怎么判断 |
|---|---|
| /admin/errors 筛 `fetch` + HTTP 404 | 消息 `entry 不存在 (404)`，`资源` 列是条目 ID |
| `curl -sI "https://data.kaiyuanguji.com/current/entry/<ID>.json"` | 404 → 数据里真没有这个条目；200 → 前端或缓存问题 |
| 数据指针 `productionCommitId` | 正式条目（丛编等）来自 book-index 仓，打包时没带上会整批 404 |

处理：

- 单个 ID 404、且来自 e2e／perf 的故意坏 ID（`nonexistent000` 等）→ 不用管（自动化浏览器本就不上报）。
- 一批正式条目 404 → 多半是 book-index 仓没进产物。看最近一次 deploy 的「Verify production entries bundled」步骤；
  重发一次：Actions → Deploy to EdgeOne → `target=staging`，verify 绿后 `target=production promote=data`。
- 条目被升格／改 ID → 旧 ID 应有 tombstone 重定向；没有就是数据仓的问题，找数据侧。

## 3. 搜索全挂

搜索两层：L1 = Meilisearch（上海，`https://api.kaiyuanguji.com`），L2 = 浏览器内 MiniSearch 分片（COS `v/<commit>/search/`）兜底。

| 看什么 | 怎么判断 |
|---|---|
| `curl -s https://api.kaiyuanguji.com/health` | 非 `{"status":"available"}` → L1 挂了，读者会退到 L2（慢但能用） |
| deploy 的「Degradable deps」步骤／`e2e/degradable/search-l1.spec.ts` | 只 L1 红不拦发布，日志里写了哪个索引、哪项 settings 不对 |
| L2 也没结果 | `curl -s -o /dev/null -w "%{http_code}" "https://data.kaiyuanguji.com/v/<data 短 commit>/search/meta.json"`——404 说明 search 分片没传上去（sync-to-cos 半途失败）；`<data 短 commit>` 即 `/api/version` 的 `data` |
| 搜索 401 | 构建时 `NEXT_PUBLIC_MEILI_KEY` 为空（2026-08 事故），看 deploy 日志 |

处理：

- 上海机器整机不可达 → Actions → **Shanghai CVM rescue**（`describe` 先看状态，再按需重启）。
- 索引 settings 丢了 → 按 degradable 用例的提示上机 PATCH settings；索引重建见 `indexer/`。
- L2 分片缺失 → 重发一次数据（同 §2 的重发）。

## 4. 数据没更新

| 看什么 | 怎么判断 |
|---|---|
| 数据指针（带随机串） | `fullCommitId`／`productionCommitId`／`textCommitId` 对比三仓 main HEAD（`git ls-remote https://github.com/open-guji/<仓>.git refs/heads/main`） |
| `/api/version` 的 `data` | 与上一行一致即站点读到的就是这版 |
| Actions → Deploy to EdgeOne 最近的定时运行 | `check` job 写着「数据无变化，跳过」还是「执行部署」 |
| 测试站指针 vs 正式站指针 | 测试站已新、正式站没新 → 自动 promote 没跑或被关 |

处理：

- 数据仓 push 后**不一定会自动发**（有 `repository_dispatch: data-updated` 跨仓 webhook，但依赖跨仓 PAT，不可靠）：等北京 04:30 定时，或手动 `Deploy to EdgeOne`（`target=staging`）。
- 测试站已是新数据、正式站没跟上：
  - 仓库变量 `AUTO_PROMOTE_DATA` 是否被设成 `false`（回滚后常会这样设，记得改回）；
  - 自动 promote 只在 **定时／repository_dispatch** 触发且 verify 绿时跑；手动 staging 发布不会自动 promote——手动跑 `target=production promote=data`。
- 指针新了、页面还是旧的 → §6。

## 5. 登录 503（/api/auth/*）

503 都带原因，直接看：`curl -s https://www.kaiyuanguji.com/api/auth/me`（换成对应站）。

| 回包 error | 原因 | 处理 |
|---|---|---|
| `服务未配置 AUTH_JWT_SECRET` / `AUTH_ADMIN_TOKEN` | 该站 Pages 项目没配这个环境变量 | 正式站（静态、分支托管）：控制台配好即生效。全栈站（staging／ssr-test）：**配了还要重新构建**——`makers build` 把变量烘进函数，运行时不再读控制台（E1）。用 Actions → **EdgeOne env sync**（`list` → `dry-run` → `set`/`sync`）写变量，然后重发该站 |
| `KV 未绑定` | 项目的 KV 命名空间没绑定为全局变量 | 控制台绑定（没有写接口） |
| `/api/track-error` 读接口 503 | `ERROR_VIEW_TOKEN` 没配 | 同第一行；这是故意 fail-closed 的 |

全栈站构建时会用 `--require AUTH_JWT_SECRET --require ERROR_VIEW_TOKEN` 检查，缺了构建直接红，所以全栈站 503 多半是新加的变量没重发。

## 6. CDN 缓存旧

症状：`/api/version` 的 `web` 已是新版，但页面还是旧的；或数据指针带随机串是新的、不带是旧的；或 ChunkLoadError。

| 看什么 | 怎么判断 |
|---|---|
| `curl -sI https://www.kaiyuanguji.com/ \| grep -i -E 'etag\|last-modified\|age'` | 与 edgeone-release 最新提交时间对比 |
| 指针带／不带随机串各读一次 | 不一致 → 节点缓存了旧指针 |
| h1 指针 `h1/manifest-root.json` | 曾被节点缓存 18.7 小时（源站 max-age 被无视） |

处理：

- 按 URL 清：Actions → **EdgeOne purge URLs**（默认清四个 h1 指针；可填任意完整 https URL，空格分隔）。例如清正式站数据指针：
  `https://data.kaiyuanguji.com/latest.json`。
- 整站清：正式站每次发布都会 `purge_host kaiyuanguji.com`；手动整站清可跑 `ops/rollback-purge.py`（需要 TENCENT_SECRET_* 与 EDGEONE_ZONE_ID，一般通过 Rollback workflow 的 release-branch 路间接执行）。
- 测试站域名不在 zone 的加速域名里，`purge_url`／`purge_host` 都清不到；它是 CLI 直传，重发一次就是新版本。条目页走按需失效（deploy 里 W2-3 那几步）。

## 7. 监控在哪

| 工具 | 管什么 |
|---|---|
| 公开仓 `open-guji/open-guji-monitor`（每 15 分钟 A 探测、每 6 小时 C 契约冒烟） | 各站可达、关键页面与接口 |
| 本仓 **Monitor (private half)**（每小时） | A1 部署停更、B1 前端错误突增（读 `/api/track-error?summary=1`）、B2 反馈量、B3 三数据仓新鲜度；告警开在本仓 `monitor` 标签 issue，并推 IM |
| Deploy 的 `verify` job | 每次发布后的契约＋UI e2e（staging／www），双跑站契约 |
| `/api/version` | 线上是哪一版（§0） |
| /admin/errors | 错误明细，按版本分组（§0） |

---

## 8. 回滚

**什么时候回滚**：新版本上线后正式站出现读者可见的回归，且修复不能在 30 分钟内发出。
只是测试站坏了不用回滚——测试站本来就是用来坏的。

入口：Actions → **Rollback**。`dry_run` 默认勾着，先跑一遍看计划：

| 输入 | 说明 |
|---|---|
| `target` | `staging` = 在测试站演练；`production` = 真回滚正式站 |
| `web_commit` | 退回到哪个网站 commit；空 = 上一次正式发布的那版（从 edgeone-release 历史推出） |
| `method` | `promote`（首选）／`release-branch`（快） |
| `stage` | 只对 promote 路：`start`（测试站重建）→ `promote`（发正式站，仅 production）→ `check`（核对）。每段手动跑一次，`promote`/`check` 必须填 `web_commit` |
| `dry_run` | 只出计划。计划写在运行摘要里：当前版本、目标版本、对应的发布产物、数据指针、将执行的步骤、注意事项 |

两条路怎么选：

| | promote（首选） | release-branch |
|---|---|---|
| 做什么 | 分三段：`start` 目标 commit 在测试站重建（deploy.yml `target=staging`，完整 verify）；绿了跑 `promote`（`target=production promote=code+data`）；再跑 `check` | edgeone-release 新建一个提交＝当时那版产物的树；清 CDN |
| 耗时 | 约 20 分钟 | 约 2 分钟 |
| 数据 | 换成测试站重建时的数据（三仓 main HEAD） | 不动 |
| 发布后 e2e | 有（deploy.yml 的 verify） | 没有，只核对 `/api/version` |
| 会被冲掉吗 | 不会（指针的 webCommitId 也回到了目标） | **会**：正式站指针的 webCommitId 没变，每天 04:30 自动 `promote=data` 按它重建代码。回滚后先把仓库变量 `AUTO_PROMOTE_DATA` 设成 `false`，修好再改回 |
| 限制 | 目标 commit 的 deploy.yml 须已有 target/promote 输入（2026-09-27 T1 之后）；早于改自托管 runner（overview#184）的目标，托管额度用完时测试站重建排不上，只能走 release-branch | 目标 commit 须正式发布过；只能用于正式站 |

步骤：

1. `target=production`、`dry_run` 勾着跑一次，读计划。计划里有 ❌ 就不能执行，按提示换 method 或 commit。
2. 读者正受影响、等不了 20 分钟 → 先 `release-branch` 止血，再设 `AUTO_PROMOTE_DATA=false`。
3. 否则走 promote，取消 `dry_run`，按段跑：
   - `stage=start`：摘要里给出测试站重建那次运行的链接和目标 commit；
   - 那次运行绿了 → `stage=promote`，`web_commit` 填摘要里那个 commit；
   - promote 那次运行绿了 → `stage=check`，同一个 `web_commit`。
   为什么分段：runner 是自托管的，各 job 共用一台机器；一个 job 占着 runner 等 deploy.yml，deploy.yml 就排不上（死锁）。所以每段只发起、不等待。
4. 跑完看摘要里的链接与核对结果；自己再 `curl https://www.kaiyuanguji.com/api/version` 看一眼。
5. 在 main 上修（revert 或 fix），正常发版；回滚期间改过 `AUTO_PROMOTE_DATA` 的记得改回。

**数据坏了**：本 workflow 不回退数据（deploy.yml 暂不支持指定数据 commit）。数据仓是 git——在数据仓 `git revert` 那次坏提交并 push，
再手动 `Deploy to EdgeOne`（`target=staging`），verify 绿后 `target=production promote=data`。

**promote 的已知风险**：`target=production` 的 promote 读的是测试站指针「此刻」的 webCommitId。如果回滚途中 main 正好有 push，
测试站会被改写成新代码，promote 就会发新代码（main 有 push 还会直接取消进行中的测试站重建）。`stage=promote` 先确认那次重建是 completed success、
dispatch 前再核一次测试站指针，`stage=check` 再核正式站指针，不一致会红——看到红了先看正式站 `/api/version` 实际是哪版。
根治方案见 PR「DBG」描述里的「promote 安全方案」（`verifiedWebCommitId`）。

**演练或回滚后测试站指针停在旧 commit**：`staging/latest.json` 的 `webCommitId` 会一直是回滚目标，直到下一次 push 到 main（或手动 `target=staging`）重建测试站。
这段时间里**别手动 `promote=code+data`**——它读的正是这个指针，会把旧代码（或演练用的版本）当成「测试站验过的」发上正式站。

**目标早于 E1 或 deploy.yml 与 main 不同**：promote 路的测试站按目标 commit 自己的 deploy.yml 重建，正式站按 main 的 deploy.yml 构建，两次不是同一套流程；
早于 E1（没有 `ops/edgeone-fullstack-build.py`）时测试站 `/api/auth/*` 会 503、正式站发布时 ssr-test 双跑失败（不拦发布）。计划里会有对应警告。

演练：每次改到回滚相关文件后，在测试站跑一次 `target=staging method=promote dry_run=false`（`stage=start`，绿后 `stage=check`），
确认测试站 `/api/version` 回到目标版本，再正常发一次 main 把测试站拉回来。
