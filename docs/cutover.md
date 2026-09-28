# 切站：www 从静态项目换到全栈项目

把 `www.kaiyuanguji.com` 和 `kaiyuanguji.com` 两个域名从旧的静态项目 **kaiyuanguji** 换绑到全栈项目 **kyg-ssr-spike**（现挂在 `ssr-test.kaiyuanguji.com`）。
切站在凌晨做，由**用户在 EdgeOne 控制台**解绑、换绑域名。出了问题就回滚，也就是把域名绑回旧项目，约 5 分钟。

判断成没成只看一个检查：**cutover-check**。

**当晚一律在 GitHub Actions 里手动运行 Cutover check**：`domain` 参数默认 `www.kaiyuanguji.com`，演练填 `ssr-test.kaiyuanguji.com`，结果写在 job 摘要里。
workflow 固定检出最新的 `main`，所以「UI 期望版本」取的一定是 main 的 package-lock。

本地只作备用。本地跑之前**必须**先切到最新的 main，否则 UI 期望版本会取成当前分支的，结论不可信：

```bash
git fetch && git checkout --detach origin/main
node ops/cutover-check.mjs                 # 默认查 www.kaiyuanguji.com
node ops/cutover-check.mjs ssr-test.kaiyuanguji.com
```

这个检查全程只读：只发 GET 请求，不带凭证，也不碰 EdgeOne 配置。
退出码 0 表示回滚项全部通过，1 表示有回滚项失败。下文写「跑 cutover-check」都指上面这个 Actions。

## 两个角色

| 谁 | 做什么 |
|---|---|
| **用户**（EdgeOne 控制台） | 解绑、换绑域名，看域名和证书状态，登录做手测 |
| **网站总管**（会话） | 冻结／恢复发布，跑检查，读结果，清缓存，喊「成」或「回滚」 |

网站总管**不操作**域名。这份文档和脚本也都不改任何 EdgeOne 域名配置；网站总管只做清缓存。

## 检查项与回滚线

**回滚项**失败显示 ❌，看到就回滚（先重跑一次确认，见下文）。
**关注项**失败显示 ⚠️，不回滚，记下来第二天处理。

| 检查 | 档 | 失败说明什么 |
|---|---|---|
| 首页 200 | 回滚 | 站打不开 |
| bim-ui-version 与 main 一致 | 回滚 | 新项目跑的是别的版本。如果页面版本≠main，但与 latest.json 记录的 promote 版本一致，就降为 ⚠️：说明 main 刚升了 UI，还没 promote，这不算问题 |
| 没有 noindex | 回滚 | 绑上去的是测试站构建，会被搜索引擎除名 |
| 没有测试站角标 | 回滚 | 同上 |
| robots.txt 允许收录 | 回滚 | 同上。有 `Allow: /` 或空的 `Disallow:` 算允许，有 `Disallow: /` 算禁止；行尾 `#` 注释忽略 |
| 3 个 `/item/<id>` 返回 200 且带书名 | 回滚 | 旧静态站上这 3 页是 404。它们失败说明域名还指向旧项目，或者条目页渲染坏了 |
| `/book-index?id=` 308 跳到 `/item/<id>` | 回滚 | 中间件没生效，旧链接进不了新地址 |
| `/api/feedback` 200 | 回滚 | 边缘函数没部署上 |
| `/api/auth/me` 401 | 回滚 | 返回 **503** 说明控制台的环境变量（AUTH_JWT_SECRET 等）没带进边缘函数，登录会全坏 |
| `/api/version` | 关注 | 接口存在才测，现在没有，显示 ⏭️ |
| sitemap-index.xml 可取 | 关注 | 只影响收录，不影响访问 |
| latest.json 与页面版本一致 | 关注 | latest.json 里 `webCommitId` 那版代码的 UI 版本应该等于页面上的版本；不等说明新项目上的代码不是 promote 的那版 |
| 证书有效 | 回滚（过期或握手失败）／关注（剩不到 14 天） | |
| http → https 跳转 | 关注 | 旧站**现在也没开**（`http://www` 直接返回 200），不算回归 |
| kaiyuanguji.com → www 跳转 | 回滚（目标是 www 时） | 裸域打不开或不跳转 |

## 切站当晚逐分钟清单

T 表示用户开始解绑的那一刻。「跑 cutover-check」一律指在 Actions 里运行 Cutover check（见文首）。

### 前一天（必须全部做完才能约时间）

| 谁 | 做什么 | 看到什么算过 |
|---|---|---|
| 网站总管 | 确认 kyg-ssr-spike 已经带上 E1（#78）重新部署过，也就是 `main` 合入 E1 之后跑过一次 production promote | 下一行的 auth 检查为 ✅ |
| 网站总管 | 跑 cutover-check，`domain` 填 `ssr-test.kaiyuanguji.com` | **回滚项全部 ✅**。裸域跳转和 http→https 在演练时只是关注项。**2026-09-28 演练时 `/api/auth/me` 是 503**，见文末 |
| 用户 | 在控制台确认 kyg-ssr-spike 的**生产环境**变量已配置（AUTH_JWT_SECRET、ERROR_VIEW_TOKEN 等，与旧项目 kaiyuanguji 对齐） | 与旧项目逐项一致 |
| 用户 | 查清 `kaiyuanguji.com → www` 的 301 现在配在哪里：是站点层规则，还是旧项目里的重定向。换绑后这条规则要在新项目上依然生效 | 知道换绑后裸域由谁负责跳转 |
| 用户 | 截图旧项目 kaiyuanguji 的域名绑定页（域名、证书、回源设置），回滚时照着绑 | 截图已保存 |

### 当晚

| 时刻 | 谁 | 做什么 | 看到什么 → 怎么办 |
|---|---|---|---|
| T−30 | 网站总管 | **冻结发布**：把仓库变量 `AUTO_PROMOTE_DATA` 设为 `false`；在 Actions 里确认没有正在跑的 deploy（Deploy 工作流没有排队或运行中的 run） | 变量已是 `false`，没有在跑的 deploy。从现在到「窗口结束」：**不 promote、不合 main、不发数据** |
| T−15 | 网站总管 | 跑基线：跑 cutover-check，`domain` 用默认的 www（这时查的还是旧站） | 应该**正好** 4 个 ❌：3 个 `/item/` 返回 404，`/book-index` 返回 200，这是旧站的特征。其余项与文末「基线」一致。多出任何其他 ❌ 都**不切**，先查原因 |
| T−10 | 网站总管 | 跑 cutover-check，`domain` 填 `ssr-test.kaiyuanguji.com` | 回滚项全部 ✅ 才继续，否则**不切** |
| T−5 | 网站总管 | 在群里喊「可以切」 | |
| T+0 | 用户 | 在旧项目 **kaiyuanguji** 上解绑 `www.kaiyuanguji.com` 和 `kaiyuanguji.com` | |
| T+1 | 用户 | 在 **kyg-ssr-spike** 上绑定这两个域名，等域名状态变为「已生效」、证书变为「已部署」 | 迟迟不生效：按 T+4 的「还没生效」处理 |
| T+1.5 | 用户 | **改 DNS**：站点 kaiyuanguji.com → 域名服务 → DNS 记录，把主机记录 `www` 的 CNAME 改成 kyg-ssr-spike 域名管理里 www 那一行显示的 CNAME。**这一步不做，旧项目一解绑 www 就 NXDOMAIN、整站打不开**（2026-09-28 实际切站时漏了这步，断了约 30 分钟） | `dig www.kaiyuanguji.com` 解析到与 ssr-test 相同的 IP |
| T+2 | 网站总管 | **清缓存**，见下文「清缓存」 | 返回 `DomainNotFound`：**不回滚**，说明换绑还没生效，按 T+4 的「还没生效」处理 |
| T+3 | 网站总管 | 跑 cutover-check | 结论为 ✅：进入 T+6。结论为 ❌：进入 T+4 |
| T+4 | 网站总管 | 只有 T+3 出现 ❌ 时才做：先看 ❌ 属于哪一类，见下表「T+4 分类」 | 新站故障：**立即回滚**。还没生效：按 TTL 等，每 2 分钟重跑 |
| T+6 | 用户 | 用无痕窗口打开 www：首页、搜索一本书、打开详情页、打开一本书的**全文页**、打开 `/admin/errors`，然后**登录一次** | 任何一页打不开，或登不上：回滚 |
| T+8 | 网站总管 | 再跑一次 cutover-check，结果贴到看板卡 | 仍然 ✅：**切站完成**，进入「窗口结束：恢复发布」 |
| T+10 起 | 网站总管 | 盯 30 分钟监控：私有仓的 Monitor，以及公开仓 open-guji-monitor 的 A 探测 | 错误突增：回滚 |

#### T+4 分类

| 类别 | 特征 | 怎么办 |
|---|---|---|
| **新站故障** | 任一项：`/api/auth/me` 返回 503；出现 noindex；出现测试站角标；robots 禁止收录；任何 5xx；证书握手失败 | 不是延迟造成的，**不用等，立即回滚** |
| **还没生效** | 3 个 `/item/` **都**返回 404，**且** `/book-index?id=` 返回 200。这就是 T−15 基线里的旧站特征，说明请求还落在旧项目上 | **不回滚**，按 TTL 等：每 2 分钟重跑一次 cutover-check，并重做一次 T+2 清缓存。等到 TTL 过去仍是旧站特征，再回滚 |

两类都不像（比如只有 1 个 `/item/` 404，或 `/api/feedback` 失败），按新站故障处理：先重跑一次确认，仍然 ❌ 就回滚。

### 清缓存（T+2、R+2，网站总管执行）

- **首选** `purge_host`，目标 `kaiyuanguji.com`（EdgeOne `CreatePurgeTask`，`Type=purge_host`，`Targets=["kaiyuanguji.com"]`；与 deploy.yml 正式站发布后那一步相同）。这会清整站，www 也在内。
- **备选** 在 Actions 里手动运行 **EdgeOne purge URLs**，`urls` 填要清的完整 URL。
- 目标**不要写 www**：zone 里注册的加速域名是裸域 `kaiyuanguji.com`，用 `www.kaiyuanguji.com` 的 URL 做目标会进 `FailedList`，等于没清。
- 换绑后清缓存可能返回 `DomainNotFound`（域名在换绑过程中暂时不在 zone 的加速域名里）。这种情况**不回滚**，按「还没生效」处理：等几分钟再清一次。

### 回滚（约 5 分钟）

| 时刻 | 谁 | 做什么 | 看到什么算回滚完成 |
|---|---|---|---|
| R+0 | 用户 | 在 kyg-ssr-spike 上解绑两个域名 | |
| R+1 | 用户 | 照截图把两个域名绑回旧项目 kaiyuanguji | 状态为「已生效」 |
| R+2 | 网站总管 | **清缓存**，同 T+2（见「清缓存」） | 返回 `DomainNotFound` 不算失败，等几分钟再清一次 |
| R+3 | 网站总管 | 跑 cutover-check | 回到 T−15 的基线：正好那 4 个旧站特征项 ❌，其余项和基线一样 |
| R+5 | 网站总管 | 把失败的检查表贴到看板卡，写明原因和下次切站的前置条件，然后进入「窗口结束：恢复发布」 | |

### 窗口结束：恢复发布

切站完成（T+8 仍然 ✅、T+10 起的 30 分钟监控没有异常）或回滚完成（R+5）之后，由网站总管做：

1. 把仓库变量 `AUTO_PROMOTE_DATA` 改回 `true`，或者删掉这个变量（默认就是开）。
2. 在看板卡上写明「发布已恢复」和时间。
3. 窗口里压下的 promote、合 main、数据发布从这时起照常进行。切站成功的话，下一次 production promote 之后再跑一次 cutover-check，确认新项目还是 ✅。

## 切完以后（不在当晚做）

- ~~现在 `deploy.yml` 的正式站发布仍然推送到旧项目 kaiyuanguji……~~ **已由 CUT2（overview#241）改完**：正式站发布（`promote=code+data` 和 `promote=data`）只全栈部署到 **kyg-ssr-spike**，条目页失效、实测、预热和发布后 e2e 的对象都是 `https://www.kaiyuanguji.com`。W2b 双跑（静态主路＋ssr-test 镜像）已去掉，只剩一路。详见下面「切站后的发布与回滚」。
- 旧项目 kaiyuanguji 和 `edgeone-release` 分支**至少保留 4 周**（与 33 卡一致，到 2026-10-26 前后），不要删，留作回滚目标。CI 不再往 `edgeone-release` 推送，旧项目停在切站前最后一版。
- 关注项里的 http→https：切站稳定后，在控制台给新项目打开强制 HTTPS。

### 切站后的发布与回滚

**发布**（`deploy.yml`，staging 那一路不变）：

| | 测试站 | 正式站 |
|---|---|---|
| Pages 项目 | kyg-staging | **kyg-ssr-spike**（www） |
| 构建 | 全栈，`ops/edgeone-fullstack-build.py -n kyg-staging` | 全栈，`ops/edgeone-fullstack-build.py -n kyg-ssr-spike`，`/api/version` 的 `target` 记 `production` |
| 部署 | `makers deploy .edgeone -n kyg-staging` | `makers deploy .edgeone -n kyg-ssr-spike`，然后在 `release-log` 分支记一笔 |
| 条目页失效／实测／预热 | staging.kaiyuanguji.com | www.kaiyuanguji.com |
| 发布后 e2e | staging（`SITE_ARCH=fullstack`） | www（`SITE_ARCH=fullstack`） |

- `ssr-test.kaiyuanguji.com` 仍挂在 kyg-ssr-spike 上，和 www 是同一份部署，不再单独测。
- `EDGEONE_API_TOKEN` 现在是两站发布的前提：缺了 deploy 在 resolve 一步就报错，不再有「跳过测试站、直接推 edgeone-release」的 fallback。
- `release-log` 分支：每次正式发布追加一个空提交（树为空，不含产物），提交信息 `Released to kyg-ssr-spike from @ open-guji/kaiyuanguji-web@<sha> 🚀 (promote=…, run …)`。Rollback 据此推算「上一次正式发布」，更早的接切站前 `edgeone-release` 的历史。这个分支只由 CI 写，别手动改。

**回滚**，按快慢从上往下选：

1. **Rollback workflow（首选，约 20 分钟）**：Actions → Rollback，`start → promote → check` 三段，见 `docs/runbook.md` §8。目标 commit 在测试站重建、verify 绿了再 promote 到 kyg-ssr-spike，发布后 e2e 照跑。`web_commit` 留空＝上一次正式发布。
2. **控制台回退 kyg-ssr-spike 的上一次部署（几分钟，不走 CI）**：EdgeOne 控制台 → Pages → kyg-ssr-spike → 部署记录，找上一次成功的生产部署，用它重新发布／回滚。注意：
   - 数据指针 `latest.json` 不变，代码回去了、`webCommitId` 还是新的；每天 04:30 的自动 `promote=data` 会按指针里的 `webCommitId` 重建代码，把回退冲掉——回退后先把仓库变量 `AUTO_PROMOTE_DATA` 设为 `false`，修好再改回。
   - 控制台上的部署记录是否带「回滚」按钮、能保留多少条，以控制台为准；没有就走第 1 条。
3. **换绑回旧项目 kaiyuanguji（最后手段，只在保留期内）**：新项目整个坏掉（不是某一版代码的问题）时用。做法同上面「回滚（约 5 分钟）」：在 kyg-ssr-spike 删掉 www → 旧项目加回 www → DNS 的 `www` CNAME 改回旧项目那一行显示的值 → 清缓存 → 跑 cutover-check（应回到旧站基线）。旧项目停在切站前最后一版、没有全栈功能（`/item/` 404、`/api/auth/*` 按旧项目环境变量），**CI 不会给它发新版**；换绑回去后要恢复发布，得先修好新项目再换绑回来。

## 附：2026-09-28 演练记录

`node ops/cutover-check.mjs ssr-test.kaiyuanguji.com`：

| | 检查 | 档 | 详情 |
|---|---|---|---|
| ✅ | 首页 200 | 回滚项 | HTTP 200 |
| ✅ | bim-ui-version 与 main 一致 | 回滚项 | 0.9.8 |
| ✅ | 没有 noindex | 回滚项 | 无 meta robots noindex、无 X-Robots-Tag |
| ✅ | 没有测试站角标 | 回滚项 | 无 staging-badge |
| ✅ | robots.txt 允许收录 | 回滚项 | Allow: /，带 Sitemap |
| ✅ | /item/d59f20aowb9c 带「史記」 | 回滚项 | `<title>`史記 - 开源古籍 |
| ✅ | /item/d59f2htm01du 带「直齋書錄解題」 | 回滚项 | `<title>`直齋書錄解題 - 开源古籍 |
| ✅ | /item/hixhd2h9bk4b 带「孔子」 | 回滚项 | `<title>`孔子（春秋） - 开源古籍 |
| ✅ | /book-index?id= 308 跳转 | 回滚项 | 308 → /item/d59f20aowb9c |
| ✅ | /api/feedback 200 | 回滚项 | 200，success=true |
| ❌ | /api/auth/me 401 | 回滚项 | 503：服务未配置 AUTH_JWT_SECRET |
| ⏭️ | /api/version | 关注项 | 404，本版没有此接口 |
| ✅ | sitemap-index.xml 可取 | 关注项 | 6 个分片，指向 www.kaiyuanguji.com |
| ✅ | latest.json 与页面版本一致 | 关注项 | 数据 501935e5be70，代码 3a1faa63e048，UI 0.9.8 与页面一致 |
| ✅ | 证书有效 | 回滚项 | 到 2026-12-24，剩 87 天 |
| ⚠️ | http → https 跳转 | 关注项 | HTTP 200，没跳 https |
| ✅ | kaiyuanguji.com → www 跳转 | 关注项 | 301 → https://www.kaiyuanguji.com/ |

`/api/auth/me` 返回 503 的原因：ssr-test 最后一次部署在 2026-09-27 21:53 UTC，早于 E1（#78，2026-09-28 01:06 UTC 合入）。E1 之前构建时没有带上控制台环境变量。**合入 E1 后需要跑一次 production promote，让 kyg-ssr-spike 重新部署**，然后再演练。这一步没过就不能切站。

**基线**：同一时间对当前的 www（旧静态项目）跑 `node ops/cutover-check.mjs`，结果是 3 个 `/item/` 返回 404，`/book-index?id=` 返回 200（不是 308）。这 4 个 ❌ 就是旧站的特征。另有两个 ⚠️：sitemap-index.xml 返回 404，http 不跳 https。其余项全部 ✅，裸域 301 到 www，证书到 2026-12-04。

## 附：2026-09-28 实际切站记录

- 只换了 `www`：裸域 `kaiyuanguji.com` 是站点加速域名，301 由规则引擎（HOST=kaiyuanguji.com → 访问 URL 重定向到 www）负责，不在 Pages 项目上，不用换绑。
- 约 18:10Z 用户在旧项目删掉 www；DNS 的 `www` 仍 CNAME 到旧项目的 `www.kaiyuanguji.com.pages.dnsoe8.com`（已 NXDOMAIN），www 打不开。
- 约 18:42Z 用户在 kyg-ssr-spike 加上 www、并把 DNS 的 www 记录改成新 CNAME，恢复。
- 18:43Z cutover-check（www）回滚项全过；用户无痕手测通过；`AUTO_PROMOTE_DATA` 已改回 true。
- 旧项目 kaiyuanguji 保留至少 4 周作回滚目标。DNS 第 2 页还有一条 `@ → www...dnsoe8.com` 的旧 CNAME（仅 DNS、未加速），与加速的 `@` 并存，待清理。
