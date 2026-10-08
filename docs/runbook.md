# 开源古籍网站排障手册（runbook）

内测期线上出问题时照这本走：**先定版本 → 按症状查 → 处理 → 不行就回滚**。
每一步都写了看哪个接口／哪个 workflow、怎么判断、怎么处理。命令都能直接复制。

三个站：

| 站 | 地址 | 托管方式 | 数据指针 |
|---|---|---|---|
| 正式站 | https://www.kaiyuanguji.com | 全栈，CLI 直传 `kyg-ssr-spike`（2026-09-28 切站，CUT2 起 deploy 直接发这里） | `https://data.kaiyuanguji.com/latest.json` |
| 测试站 | https://staging.kaiyuanguji.com | 全栈，CLI 直传 `kyg-staging` | `https://data.kaiyuanguji.com/staging/latest.json` |

`ssr-test.kaiyuanguji.com` 也挂在 `kyg-ssr-spike` 上，与 www 是同一份部署。旧静态项目 `kaiyuanguji`（原 www，推 `edgeone-release` 分支发布）
切站后不再发布，保留到 2026-10-26 前后作回滚目标（`docs/cutover.md`「切站后的发布与回滚」）。

> 读数据指针**必须带随机串**：`curl -s "https://data.kaiyuanguji.com/latest.json?cb=$RANDOM$RANDOM"`。
> 不带会拿到 EdgeOne 节点上的旧副本，看到的「线上版本」是错的。

---

## 0. 第一步永远是：线上现在是哪一版

```bash
for s in www staging; do
  echo "== $s"; curl -s "https://$s.kaiyuanguji.com/api/version" | python3 -m json.tool
done
```

`/api/version` 公开、不缓存（`no-store`），返回：

| 字段 | 含义 | 来源 |
|---|---|---|
| `web` | 网站代码 commit | 构建时写入（CI 的 `next build` 把它写进 `edge-functions/api/version.js`） |
| `bimUi` | 打进产物的 book-index-ui 版本 | 构建时写入 |
| `data` | 数据指针 `latest.json` 的 `commitId`（book-index 短 commit；2026-10-06 前是 book-index-draft 的） | 运行时读 COS |
| `dataPointer` | 指针全文：数据仓 commit、`bundleDate`、`webCommitId` | 运行时读 COS |
| `builtAt` | 构建时间 | 构建时写入 |
| `target` | `production` / `staging`（切站前 kyg-ssr-spike 双跑的构建记为 `ssr-test`） | 构建时写入 |
| `webMatchesPointer` | `web` 是否等于指针里记的 `webCommitId` | — |
| `webPointer` | 代码指针 `web.json`（正式站在根、测试站在 `staging/`）：`webCommitId`／`deployedAt`／`runId`；读不到（旧产物、还没写过）是 `null` | 运行时读 COS；部署成功后由 CI 写（overview#470 P1） |

怎么读：

- **`web` 是不是你以为的那版？** 对照 `git log origin/main`。正式站只有 promote 才会变（push 到 main 只发测试站）。
- **`builtAt` 很旧、`web` 不对** → 新版本没发上去：看 Actions 里最近一次 `Deploy to EdgeOne` 哪一步红了。
- **`webMatchesPointer: false`** 不一定是故障：`promote=data`（只换数据，每天 04:30 自动跑）时代码不动、指针记的是上次 promote 用的代码；
  但如果刚手动 promote 过 `code` 或 `code+data` 还是 false，就是「代码发了、指针没刷新」或反过来——看 §6 CDN。
- **`webPointer` 与 `dataPointer.webCommitId`**：过渡期两个都有，`webMatchesPointer` 仍只比 `latest.json` 那个（晋升、回滚读的也是它）；`webPointer` 是部署成功后单独写的代码指针，将来数据流程独立后会取代前者。两者不同通常是回滚到了早于 P1 的旧 commit（旧流程只更新 `latest.json`），下一次正常部署会对齐。
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
| 数据指针（带随机串） | `productionCommitId`／`textCommitId` 对比 book-index、book-text 的 main HEAD（`fullCommitId` 自 overview#432 起与 `productionCommitId` 相同；草稿仓不参与部署）（`git ls-remote https://github.com/open-guji/<仓>.git refs/heads/main`） |
| `/api/version` 的 `data` | 与上一行一致即站点读到的就是这版 |
| Actions → Deploy to EdgeOne 最近的定时运行 | `check` job 写着「数据无变化，跳过」还是「执行部署」 |
| 测试站指针 vs 正式站指针 | 测试站已新、正式站没新 → 自动 promote 没跑或被关 |

处理：

- 数据仓 push 后**不一定会自动发**（有 `repository_dispatch: data-updated` 跨仓 webhook，但依赖跨仓 PAT，不可靠）：等北京 04:30 定时，或手动 `Deploy to EdgeOne`（`target=staging`）。
- 测试站已是新数据、正式站没跟上：
  - 仓库变量 `AUTO_PROMOTE_DATA` 是否被设成 `false`（回滚后常会这样设，记得改回）；
  - 自动 promote 只在 **定时／repository_dispatch** 触发且 verify 绿时跑；手动 staging 发布不会自动 promote——手动跑 `target=production promote=data`。
- 指针新了、页面还是旧的 → §6。

### 数据流程 data.yml（overview#470 P1，拆分进行中）

`data.yml`（Actions → Data package check and publish）默认**只检查**，每晚 UTC 21:10 跑，不写任何东西。它能不能上传由第一步 **Publish gate** 决定，规则写在那一步的注释里，摘要里也会列出本次的结论：

| 怎么跑 | 结果 |
|---|---|
| 定时／手动默认（`target=production`），仓库变量 `SPLIT_DATA_FLOW` 没设 | 只检查，不上传（现在 deploy.yml 仍是正式前缀的写者） |
| 同上但 `SPLIT_DATA_FLOW=true`，`prod_ref`／`text_ref` 都是 main | 上传到正式前缀：current/、h1 条目、条目 sitemap |
| `target=staging`（演练），refs 都是 main | 整条流水线写 `staging/` 前缀，不碰正式前缀，不看开关；和 deploy.yml 的测试站构建共用一把锁，不会同时写 |
| `only_sitemaps=true` | 只生成并上传条目 sitemap 到 `[前缀/]sitemaps/`（新目录，不动已有对象），不看开关 |
| `prod_ref`／`text_ref` 不是 main（**含 staging**） | 只检查；回滚重发上一版数据、用新格式分支演练都要勾 `allow_ref_override`（正式前缀另外还需要开关或 `only_sitemaps`）。原因：上传步骤带 COS 密钥，同 job 里跑的是所选 ref 的 `build_derived.py`，只给可信分支 |

要点：
- **翻开关（`SPLIT_DATA_FLOW`）之前**：先 `target=staging` 把整条流水线演练一遍；再手动 `only_sitemaps=true` 把 sitemap 传到正式前缀的 `sitemaps/`（路由代理要从那里取）；翻开关的那一刻**不能有在跑的 deploy.yml**（它开始时读的是旧值，仍会写数据）。
- **代码指针的读法（`codePointer` 标记，方案 A）**：开关打开后的 data.yml 上传会在 `latest.json` 里多写 `"codePointer": "web.json"`（演练可勾 `mark_code_pointer`，只对 staging 生效）。读者——回滚计划／核对（`ops/rollback-plan.py`、`rollback-check.py`）、`ops/cutover-check.mjs`、`/api/version` 的 `webMatchesPointer`、deploy.yml 里 `promote=data`／`code+data` 读线上代码是哪一版——统一按这条规则：**有标记 ⇒ 以 `web.json` 为准**（`web.json` 读不到或不合法时退回 `latest.json.webCommitId` 并明说）；**没有标记 ⇒ 仍以 `latest.json.webCommitId` 为准**（开关没翻前的现行行为；也让回滚到 #282 之前的旧 commit 不会读错，因为旧 deploy.yml 只更新 `latest.json`）。两处 commit 不一致时不悄悄选一个：核对输出和 `/api/version` 的 `codeSource` 会写出选了哪个。关开关后下一次 deploy.yml 重写 `latest.json`，标记随之消失，读者自动回到老口径。规则在 `ops/code_pointer.py`、`ops/code-pointer.mjs`、`edge-functions/api/version.js`、deploy.yml 的 `code_commit` 四处各一份，`ops/tests/test_code_pointer.py` 与 `code-pointer.test.mjs` 用同一张用例表（`ops/tests/fixtures/code-pointer-cases.json`）对拍。
- 打包出来的 `latest.json` 没有 `webCommitId`；上传前从线上现行 `latest.json` 带过来，读它的人（`promote=data`、回滚计划、`/api/version`）切到 `web.json` 之前还在用。开关打开后代码流程不再写 `latest.json`，这个值会停在最后一次代码发布时的版本，所以**读者切到 `web.json` 要在翻开关之前或同时完成**。
- 开关打开后，定时触发不再按「commit 没变就跳过」：一律跑，由 package 里的同步标记判是否真要传（commit 之外还看打包脚本指纹和上次同步是否完整，所以不会重传，但能补上半途失败的）。
- sitemap 传完（分片→索引→回读）后最后写 `[前缀/]sitemaps/_meta.json`（记录两个数据 commit）；它不对外提供，也不会被清旧分片动到。
- 上传的 state 缓存键与 deploy.yml 的正式站键相同，第一次接管时继承 deploy.yml 最后一次的 state。
- 上传成功（current/ 同步成功）之后还有三个任务，都在 data.yml 里：
  - `refresh`：清数据指针的 CDN 缓存（`latest.json`、h1 两个根、`sitemaps/sitemap-index.xml`，只清这几个地址，不清整站；脚本 `ops/purge-urls.py` 只认数据域名）；条目页按改动失效并核对（正式前缀对 www 和 staging 各一次）。都不拦：失效没生效最坏是条目页按 s-maxage 一小时自然过期。
  - `verify-live`：上线后抽查，复用 `verify.yml`（`target=production`，contract＋UI 冒烟＋`read_links`；e2e 取线上现在跑的代码 commit，读 `web.json`）。演练（`staging/` 前缀）验测试站。
  - `alert-data`：正式前缀的上传失败、上传成功后 package 里后续步骤（sitemap 等）失败、抽查没过、或 `refresh` 里清缓存／条目页失效没通过，开（或续）一张 `data-alert` issue（正文按"数据到底有没有换上线"分别说明），写明新旧数据 commit 和**回滚做法**：Run workflow，`target=production`，`prod_ref`／`text_ref` 填发布前线上的两个 commit，勾 `allow_ref_override`（约 10 分钟；第一期不自动回滚）。
  - 落后告警：定时的 `check` 里，开关打开之后，数据仓 main 的 HEAD 与线上对不上、且那个提交已过 36 小时，开（或续）`data-alert` issue——定时会被 GitHub 延迟甚至偶尔丢掉，上传也可能连着几晚失败。
- `h1-text`（单独任务，不拦、失败只警告、不进告警）：package 的同步成功之后与 `refresh`／`verify-live` 并行。它读的是整个 `items/`，所以按 package 用的**同一对 commit** 重新克隆＋build_derived＋打包（缓存命中约 +3～4 分钟）。只在线上 h1 文本指针（`h1/text-manifest-root.json`）记的 book-text commit 与这次不同时才做，读不到指针（首次、404）一律做；演练勾 `force_sync`（只 staging 生效）则一定做。COS 密钥只在“Sync h1 text”这一步的 env，打包和泄漏检查在它前面。生产暂无 h1 文本读者。

## 5. 登录 503（/api/auth/*）

503 都带原因，直接看：`curl -s https://www.kaiyuanguji.com/api/auth/me`（换成对应站）。

| 回包 error | 原因 | 处理 |
|---|---|---|
| `服务未配置 AUTH_JWT_SECRET` / `AUTH_ADMIN_TOKEN` | 该站 Pages 项目没配这个环境变量 | 两站都是全栈：**配了还要重新构建**——`makers build` 把变量烘进函数，运行时不再读控制台（E1）。用 Actions → **EdgeOne env sync**（`list` → `dry-run` → `set`/`sync`）写变量，然后重发该站 |
| `KV 未绑定` | 项目的 KV 命名空间没绑定为全局变量 | 控制台绑定（没有写接口） |
| `/api/track-error` 读接口 503 | `ERROR_VIEW_TOKEN` 没配 | 同第一行；这是故意 fail-closed 的 |

全栈站构建时会用 `--require AUTH_JWT_SECRET --require ERROR_VIEW_TOKEN` 检查，缺了构建直接红，所以全栈站 503 多半是新加的变量没重发。

## 6. CDN 缓存旧

症状：`/api/version` 的 `web` 已是新版，但页面还是旧的；或数据指针带随机串是新的、不带是旧的；或 ChunkLoadError。

| 看什么 | 怎么判断 |
|---|---|
| `curl -sI https://www.kaiyuanguji.com/ \| grep -i -E 'etag\|last-modified\|age'` | 与 `/api/version` 的 `builtAt`、Actions 里最近一次正式发布的时间对比 |
| 指针带／不带随机串各读一次 | 不一致 → 节点缓存了旧指针 |
| h1 指针 `h1/manifest-root.json` | 曾被节点缓存 18.7 小时（源站 max-age 被无视） |

处理：

- 按 URL 清：Actions → **EdgeOne purge URLs**（默认清四个 h1 指针；可填任意完整 https URL，空格分隔）。例如清正式站数据指针：
  `https://data.kaiyuanguji.com/latest.json`。
- 整站：www 和测试站一样是 Pages 项目的自定义域名，不在 zone 的加速域名里，`purge_host kaiyuanguji.com` 只清得到裸域那条 301，清不到 www 的页面。
  两站都是 CLI 直传，重发一次就是新版本；条目页走按需失效（deploy 里 W2-3 那几步，正式站打 www）。

## 7. 监控在哪

| 工具 | 管什么 |
|---|---|
| 公开仓 `open-guji/open-guji-monitor`（每 15 分钟 A 探测、每 6 小时 C 契约冒烟） | 各站可达、关键页面与接口 |
| 本仓 **Monitor (private half)**（每小时） | A1 部署停更、B1 前端错误突增（读 `/api/track-error?summary=1`）、B2 反馈量、B3 三数据仓新鲜度；告警开在本仓 `monitor` 标签 issue，并推 IM |
| Deploy 的 `verify` job | 每次发布后的契约＋UI e2e（staging／www，都按全栈 `SITE_ARCH=fullstack` 验） |
| `/api/version` | 线上是哪一版（§0） |
| /admin/errors | 错误明细，按版本分组（§0） |

---

## 8. 回滚

**什么时候回滚**：新版本上线后正式站出现读者可见的回归，且修复不能在 30 分钟内发出。

**自动上正式站（overview#341）**：push 到 main 后，测试站 verify 全绿且正式站产物构建成功，deploy.yml 的 `auto-promote-code` 会自动派 `target=production promote=code from_run=<那次 run>`——**只发代码**：直接部署那次存的正式站产物，数据一个字节都不动（只把线上 `latest.json` 的 `webCommitId` 在部署成功后改成新代码；写失败会重试 3 次，仍失败时 job 不变红，但摘要里有 ⚠️——这时**不要发 `promote=data`**，先用同一个 `from_run` 再派一次 `promote=code` 补指针）；那次没有可用的正式站产物就报错，不会退回重新构建。数据上线另走：每晚定时的 `promote=data`，或有人确认后手动选 `promote=code+data`（2026-10-07 之前自动晋升派的是 `code+data`，会把没人确认的数据带上正式站，已改）。正式站发布或验收失败时，`alert-production` 在本仓开一张 `deploy-alert` 告警 issue（已有未关的就续评论），写明 run 与回滚步骤。回滚前先把仓库变量 `AUTO_PROMOTE_CODE` 设成 `false`，否则下一次 push 会把新版再发上去。
只是测试站坏了不用回滚——测试站本来就是用来坏的。

入口：Actions → **Rollback**。`dry_run` 默认勾着，先跑一遍看计划：

| 输入 | 说明 |
|---|---|
| `target` | `staging` = 在测试站演练；`production` = 真回滚正式站 |
| `web_commit` | 退回到哪个网站 commit；空 = 上一次正式发布的那版（从 `release-log` 分支推出，更早的接切站前 `edgeone-release` 的历史） |
| `stage` | `start`（测试站重建）→ `promote`（发正式站，仅 production）→ `check`（核对）。每段手动跑一次，`promote`/`check` 必须填 `web_commit` |
| `dry_run` | 只出计划。计划写在运行摘要里：当前版本、目标版本、对应的发布记录、数据指针、将执行的步骤、注意事项 |

回滚路怎么选（2026-09-28 切站、CUT2 之后）：

| | Rollback workflow（首选） | 控制台回退 kyg-ssr-spike | 换绑回旧项目 kaiyuanguji |
|---|---|---|---|
| 做什么 | 分三段：`start` 目标 commit 在测试站重建（deploy.yml `target=staging`，完整 verify）；绿了跑 `promote`（`target=production promote=code+data`，部署到 kyg-ssr-spike）；再跑 `check` | EdgeOne 控制台 → Pages → kyg-ssr-spike → 部署记录，用上一次成功的生产部署重新发布 | www 从 kyg-ssr-spike 换绑回旧静态项目，DNS 的 `www` CNAME 改回去（`docs/cutover.md`） |
| 耗时 | 约 20 分钟 | 几分钟 | 约 5 分钟＋DNS 生效 |
| 数据 | 换成测试站重建时的数据（book-index、book-text 的 main HEAD） | 不动 | 不动 |
| 发布后 e2e | 有（deploy.yml 的 verify） | 没有，自己看 `/api/version` | 没有，跑 cutover-check |
| 会被冲掉吗 | 不会（指针的 webCommitId 也回到了目标）；但下一次 push 到 main 验过后会自动上正式站，回滚期间先把 `AUTO_PROMOTE_CODE` 设成 `false` | **会**：指针的 webCommitId 没变，每天 04:30 自动 `promote=data` 按它重建代码；下一次 push 验过后也会自动 `promote=code+data`。先把仓库变量 `AUTO_PROMOTE_DATA`、`AUTO_PROMOTE_CODE` 都设成 `false`，修好再改回 | 不会被冲，但也**收不到任何新发布**（CI 不再推旧项目） |
| 什么时候用 | 默认 | 读者正受影响、等不了 20 分钟 | 新项目整个坏了（不是某一版代码的问题）；只在旧项目保留期内（到 2026-10-26 前后） |
| 限制 | 目标 commit 的 deploy.yml 须已有 target/promote 输入（2026-09-27 T1 之后）；早于改自托管 runner（overview#184）的目标，托管额度用完时测试站重建排不上 | 控制台能否回退、保留多少条部署记录以控制台为准 | 旧项目停在切站前最后一版，没有全栈功能 |

原来的 `method=release-branch`（把 `edgeone-release` 恢复成当时那版产物）已随 CUT2 去掉：那条分支发的是旧项目，www 已经不在上面，恢复它对读者没有任何效果。

步骤：

1. `target=production`、`dry_run` 勾着跑一次，读计划。计划里有 ❌ 就不能执行，按提示换 commit 或改走控制台。
2. 读者正受影响、等不了 20 分钟 → 先在控制台回退 kyg-ssr-spike 止血，再设 `AUTO_PROMOTE_DATA=false`，然后照常走下面的 workflow 把 webCommitId 也对上。
3. 取消 `dry_run`，按段跑：
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
overview#341 起手动 promote 可以填 `from_run`（测试站那次部署的 run 编号）：代码与数据都钉成那次验过的，不读指针「此刻」的值；
那次是 push 触发的（存了正式站产物 `prod-edgeone`，工件留 3 天）且 `promote=code` 或 `code+data` 时，直接部署那份产物、不重新构建
（`promote=code` 必须填 `from_run` 且必须有这份产物，没有就报错，不退回重新构建；`promote` 输入默认就是 `code`）。
resolve 会先核对那次的验收任务全绿，不绿就拒绝。

**演练或回滚后测试站指针停在旧 commit**：`staging/latest.json` 的 `webCommitId` 会一直是回滚目标，直到下一次 push 到 main（或手动 `target=staging`）重建测试站。
这段时间里**别手动发不带 `from_run` 的 `promote=code+data`**——它读的正是这个指针，会把旧代码（或演练用的版本）当成「测试站验过的」发上正式站。

**目标早于 E1 或 deploy.yml 与 main 不同**：promote 路的测试站按目标 commit 自己的 deploy.yml 重建，正式站按 main 的 deploy.yml 构建，两次不是同一套流程；
早于 E1（没有 `ops/edgeone-fullstack-build.py`）时：测试站演练只出警告（重建后 `/api/auth/*` 会 503）；**正式站回滚直接报错**——正式站构建检出目标 commit、调用它自己的构建脚本，
早于 E1 必失败。请选 `81f71f4` 或更新的版本，或走控制台把 www 换绑回旧项目（上表第三列）。

演练：每次改到回滚相关文件后，在测试站跑一次 `target=staging method=promote dry_run=false`（`stage=start`，绿后 `stage=check`），
确认测试站 `/api/version` 回到目标版本，再正常发一次 main 把测试站拉回来。
